import crypto from 'node:crypto';
import { config } from './config.js';
import { supabase } from './db.js';
import type { InboundLineMessage } from './types.js';

export const DEFAULT_SHEETS_COLUMN_MAP = {
  applicationId: '顧客ID',
  externalStudentId: '',
  lineUserId: 'LINEユーザーID',
  studentName: '名前',
  studentFurigana: 'フリガナ',
  lineDisplayName: 'LINE名',
  universityName: '大学名',
  graduationYear: '卒業予定年度',
  agentName: '案件名称',
  participationPurpose: '着座目的',
  reservationDate: '予約日',
  reservationTime: '予約時間',
  participationScheduledAt: '',
  currentStatus: '進捗状況',
  autoSendEnabled: '自動送信対象',
  humanRequired: '人間対応フラグ',
  sameDayReminderSentAt: '当日リマインド送信日時',
  postParticipationFormSentAt: '参加確認フォーム送信日時',
  postParticipationFormAnsweredAt: '参加確認フォーム回答日時',
  bankFormSentAt: 'TS/銀行口座フォーム送信日時',
  bankFormAnsweredAt: 'TS/銀行口座フォーム回答日時',
  lastLineSentAt: '最終LINE送信日時',
  slackNotifiedAt: 'Slack通知日時',
  errorMessage: 'エラー内容',
  notes: '備考',
} as const;

export type SheetsColumnKey = keyof typeof DEFAULT_SHEETS_COLUMN_MAP;
export type SheetsColumnMap = Record<SheetsColumnKey, string>;

type SheetRow = Record<string, unknown> & { __rowNumber?: number };

type NormalizedSheetRow = ReturnType<typeof normalizeRow>;

export type LineIdentityCandidate = {
  matchKey: string;
  score: number;
  reasons: string[];
  rowNumbers: number[];
  applicationIds: string[];
  studentName: string | null;
  studentFurigana: string | null;
  lineDisplayName: string | null;
  externalStudentId: string | null;
};

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function nowIso() {
  return new Date().toISOString();
}

export function sheetsColumnMap(): SheetsColumnMap {
  if (!config.SHEETS_COLUMN_MAP_JSON) return { ...DEFAULT_SHEETS_COLUMN_MAP };
  const parsed = JSON.parse(config.SHEETS_COLUMN_MAP_JSON) as Partial<SheetsColumnMap>;
  return { ...DEFAULT_SHEETS_COLUMN_MAP, ...parsed };
}

function value(row: SheetRow, map: SheetsColumnMap, key: SheetsColumnKey) {
  const mapped = map[key];
  return row[mapped] ?? row[key];
}

function textValue(row: SheetRow, map: SheetsColumnMap, key: SheetsColumnKey) {
  const raw = value(row, map, key);
  const text = raw === undefined || raw === null ? '' : String(raw).trim();
  return text || null;
}

function effectiveSheetsDryRun(inputDryRun?: boolean) {
  return Boolean(inputDryRun || config.SHEETS_DRY_RUN || config.SHEETS_WRITE_DRY_RUN);
}

function fallbackTextValue(row: SheetRow, map: SheetsColumnMap, key: SheetsColumnKey, fallbacks: string[]) {
  const mapped = textValue(row, map, key);
  if (mapped) return mapped;
  for (const fallback of fallbacks) {
    const raw = row[fallback];
    const text = raw === undefined || raw === null ? '' : String(raw).trim();
    if (text) return text;
  }
  return null;
}

function boolValue(row: SheetRow, map: SheetsColumnMap, key: SheetsColumnKey, defaultValue = false) {
  const raw = textValue(row, map, key);
  if (!raw) return defaultValue;
  return /^(1|true|yes|y|on|対象|する|送信|送信する|自動|auto)$/i.test(raw);
}

function parseDateTime(raw: string | null) {
  if (!raw) return null;
  const normalized = raw
    .replace(/\//g, '-')
    .replace(/年|月/g, '-')
    .replace(/日/g, '')
    .trim();
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized)) {
    const explicit = new Date(normalized);
    return Number.isNaN(explicit.getTime()) ? null : explicit.toISOString();
  }
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2})(?::(\d{1,2}))?)?/);
  if (match) {
    const [, year, month, day, hour = '0', minute = '0'] = match;
    return zonedDateTimeToUtcIso({
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      timeZone: config.WORKFLOW_TIMEZONE,
    });
  }
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function zonedDateTimeToUtcIso(input: { year: number; month: number; day: number; hour: number; minute: number; timeZone: string }) {
  const utcGuess = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: input.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(utcGuess));
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const representedAsUtc = Date.UTC(pick('year'), pick('month') - 1, pick('day'), pick('hour'), pick('minute'), pick('second'));
  const offset = representedAsUtc - utcGuess;
  return new Date(utcGuess - offset).toISOString();
}

function applicationStatus(raw: string | null) {
  if (!raw) return 'interested';
  const normalized = raw.normalize('NFKC').replace(/\s+/g, '');
  const known = [
    'interested',
    'schedule_pending',
    'application_info_collecting',
    'pre_caution_sent',
    'pre_caution_confirmation_waiting',
    'pre_caution_confirmed',
    'same_day_reminder_pending',
    'same_day_reminder_sent',
    'post_participation_form_waiting',
    'bank_form_send_pending',
    'bank_account_waiting',
    'payment_ready',
    'human_required',
  ];
  if (known.includes(raw)) return raw;
  if (/要対応|人間|例外|確認必要/.test(normalized)) return 'human_required';
  if (/支払|支払い|入金準備|精算/.test(normalized)) return 'payment_ready';
  if (/口座|銀行|TS|登録/.test(normalized)) return 'bank_account_waiting';
  if (/参加確認|参加後|フォーム/.test(normalized)) return 'post_participation_form_waiting';
  if (/当日|リマインド/.test(normalized)) return 'same_day_reminder_pending';
  if (/注意事項.*確認済|確認済/.test(normalized)) return 'pre_caution_confirmed';
  if (/注意事項|事前案内/.test(normalized)) return 'pre_caution_confirmation_waiting';
  if (/予約|日程|確定|予定/.test(normalized)) return 'schedule_pending';
  if (/情報|回収|申込/.test(normalized)) return 'application_info_collecting';
  return 'interested';
}

function participationDateTime(row: SheetRow, map: SheetsColumnMap) {
  const direct = textValue(row, map, 'participationScheduledAt');
  if (direct) return parseDateTime(direct);
  const date = textValue(row, map, 'reservationDate');
  const time = textValue(row, map, 'reservationTime');
  if (!date && !time) return null;
  return parseDateTime(`${date ?? ''} ${time ?? '00:00'}`.trim());
}

function rowsFromValues(values: unknown[][]): SheetRow[] {
  const [headerRow, ...bodyRows] = values;
  if (!headerRow) return [];
  const headers = headerRow.map((header) => String(header ?? '').trim());
  return bodyRows.map((row, index) => {
    const object: SheetRow = { __rowNumber: index + 2 };
    headers.forEach((header, columnIndex) => {
      if (header) object[header] = row[columnIndex] ?? '';
    });
    return object;
  });
}

function normalizeIdentityText(value: string | null | undefined) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ぁ-ゖ]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0x60))
    .replace(/[\s　・･、。,.，．!！?？:：;；'"“”‘’「」『』（）()[\]{}<>＜＞\-ー_]/g, '');
}

function usableIdentityText(value: string | null | undefined) {
  const normalized = normalizeIdentityText(value);
  return normalized.length >= 2 ? normalized : null;
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))];
}

export function extractStudentNameCandidates(text: string, displayName?: string) {
  const candidates = new Set<string>();
  if (displayName) candidates.add(displayName);
  const source = String(text ?? '').normalize('NFKC');
  const patterns = [
    /(?:名前|氏名|なまえ|LINE名|ライン名|私は|わたしは|僕は|ぼくは|自分は)\s*(?:は|:|：)?\s*([一-龠々〆ヵヶぁ-んァ-ヶーA-Za-zＡ-Ｚａ-ｚ\s　]{2,30})/g,
    /([一-龠々〆ヵヶぁ-んァ-ヶーA-Za-zＡ-Ｚａ-ｚ\s　]{2,24})(?:です|と申します|といいます|と言います|になります)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const value = String(match[1] ?? '')
        .replace(/(です|と申します|といいます|と言います|になります).*$/, '')
        .trim();
      if (usableIdentityText(value)) candidates.add(value);
    }
  }
  return uniqueStrings([...candidates]);
}

function base64url(input: string | Buffer) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

let cachedGoogleToken: { token: string; expiresAt: number } | null = null;

async function googleAccessToken() {
  if (cachedGoogleToken && cachedGoogleToken.expiresAt > Date.now() + 60_000) return cachedGoogleToken.token;
  if (!config.GOOGLE_SERVICE_ACCOUNT_EMAIL || !config.GOOGLE_PRIVATE_KEY) {
    throw new Error('Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY for Google Sheets access');
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: config.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: GOOGLE_SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: issuedAt,
    exp: issuedAt + 3600,
  }));
  const unsigned = `${header}.${payload}`;
  const privateKey = config.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(privateKey);
  const assertion = `${unsigned}.${base64url(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`Google token request failed: ${res.status} ${await res.text()}`);
  const json = await res.json() as any;
  cachedGoogleToken = { token: json.access_token, expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000 };
  return cachedGoogleToken.token;
}

async function googleSheetsFetch(path: string, init?: RequestInit) {
  if (!config.GOOGLE_SHEETS_SPREADSHEET_ID || !config.GOOGLE_SHEETS_TAB_NAME) {
    throw new Error('Set GOOGLE_SHEETS_SPREADSHEET_ID and GOOGLE_SHEETS_TAB_NAME for Google Sheets access');
  }
  const token = await googleAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.GOOGLE_SHEETS_SPREADSHEET_ID)}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`Google Sheets API failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function readSheetRows() {
  const range = `${encodeURIComponent(config.GOOGLE_SHEETS_TAB_NAME)}!A1:ZZ`;
  const json = await googleSheetsFetch(`/values/${range}?majorDimension=ROWS`) as any;
  return rowsFromValues(json.values ?? []);
}

function columnName(index: number) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - rem) / 26);
  }
  return name;
}

async function headerIndexes(map: SheetsColumnMap) {
  const range = `${encodeURIComponent(config.GOOGLE_SHEETS_TAB_NAME)}!A1:ZZ1`;
  const json = await googleSheetsFetch(`/values/${range}?majorDimension=ROWS`) as any;
  const headers = (json.values?.[0] ?? []).map((header: unknown) => String(header ?? '').trim());
  const indexes = new Map<string, number>();
  Object.values(map).forEach((header) => {
    if (!header) return;
    const index = headers.indexOf(header);
    if (index >= 0) indexes.set(header, index);
  });
  return indexes;
}

function normalizeRow(row: SheetRow, map: SheetsColumnMap) {
  return {
    rowNumber: row.__rowNumber,
    applicationId: textValue(row, map, 'applicationId'),
    externalStudentId: textValue(row, map, 'externalStudentId'),
    lineUserId: textValue(row, map, 'lineUserId'),
    studentName: fallbackTextValue(row, map, 'studentName', ['名前', '氏名']),
    studentFurigana: fallbackTextValue(row, map, 'studentFurigana', ['ふりがな', 'カナ']),
    lineDisplayName: fallbackTextValue(row, map, 'lineDisplayName', ['LINE表示名', 'ライン名']),
    universityName: textValue(row, map, 'universityName'),
    graduationYear: textValue(row, map, 'graduationYear'),
    agentName: textValue(row, map, 'agentName'),
    participationPurpose: textValue(row, map, 'participationPurpose'),
    reservationDate: textValue(row, map, 'reservationDate'),
    reservationTime: textValue(row, map, 'reservationTime'),
    participationScheduledAt: participationDateTime(row, map),
    currentStatus: applicationStatus(textValue(row, map, 'currentStatus')),
    autoSendEnabled: boolValue(row, map, 'autoSendEnabled', true),
    humanRequired: boolValue(row, map, 'humanRequired', false),
    notes: textValue(row, map, 'notes'),
    raw: row,
  };
}

export function normalizeSheetRowForSmoke(row: SheetRow, map: SheetsColumnMap = sheetsColumnMap()) {
  return normalizeRow(row, map);
}

function rowIdentityKey(row: NormalizedSheetRow) {
  const external = usableIdentityText(row.externalStudentId);
  if (external) return `external:${external}`;
  const name = usableIdentityText(row.studentName);
  if (name) return `name:${name}`;
  const lineName = usableIdentityText(row.lineDisplayName);
  if (lineName) return `line:${lineName}`;
  return `row:${row.rowNumber ?? row.applicationId ?? 'unknown'}`;
}

function sameIdentity(row: NormalizedSheetRow, candidate: LineIdentityCandidate) {
  const external = usableIdentityText(row.externalStudentId);
  const name = usableIdentityText(row.studentName);
  const lineName = usableIdentityText(row.lineDisplayName);
  return Boolean(
    (candidate.externalStudentId && external && external === usableIdentityText(candidate.externalStudentId))
    || (candidate.studentName && name && name === usableIdentityText(candidate.studentName))
    || (candidate.lineDisplayName && lineName && lineName === usableIdentityText(candidate.lineDisplayName)),
  );
}

function buildLineIdentityCandidates(input: { event: InboundLineMessage; rows: NormalizedSheetRow[] }) {
  const nameCandidates = extractStudentNameCandidates(input.event.text, input.event.displayName);
  const normalizedNameCandidates = nameCandidates.map(usableIdentityText).filter((value): value is string => Boolean(value));
  const normalizedText = normalizeIdentityText(input.event.text);
  const normalizedDisplayName = usableIdentityText(input.event.displayName);
  const groups = new Map<string, NormalizedSheetRow[]>();

  for (const row of input.rows) {
    if (row.lineUserId && row.lineUserId !== input.event.lineUserId) continue;
    const key = rowIdentityKey(row);
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }

  const candidates: LineIdentityCandidate[] = [];
  for (const [matchKey, rows] of groups) {
    let score = 0;
    const reasons = new Set<string>();
    for (const row of rows) {
      const external = usableIdentityText(row.externalStudentId);
      const name = usableIdentityText(row.studentName);
      const furigana = usableIdentityText(row.studentFurigana);
      const lineName = usableIdentityText(row.lineDisplayName);

      if (row.lineUserId === input.event.lineUserId) {
        score = Math.max(score, 120);
        reasons.add('Sheetsに同じLINEユーザーIDが既にあります');
      }
      if (external && normalizedText.includes(external)) {
        score = Math.max(score, 100);
        reasons.add('本文にstudent_idが含まれています');
      }
      if (lineName && normalizedDisplayName && lineName === normalizedDisplayName) {
        score = Math.max(score, 100);
        reasons.add('LINE表示名が一致しました');
      }
      if (lineName && normalizedNameCandidates.includes(lineName)) {
        score = Math.max(score, 95);
        reasons.add('LINE名候補が一致しました');
      }
      if (name && normalizedNameCandidates.includes(name)) {
        score = Math.max(score, 95);
        reasons.add('名前候補が一致しました');
      }
      if (furigana && normalizedNameCandidates.includes(furigana)) {
        score = Math.max(score, 90);
        reasons.add('フリガナ候補が一致しました');
      }
      if (name && name.length >= 3 && normalizedText.includes(name)) {
        score = Math.max(score, 82);
        reasons.add('本文に名前が含まれています');
      }
      if (lineName && lineName.length >= 3 && normalizedText.includes(lineName)) {
        score = Math.max(score, 82);
        reasons.add('本文にLINE名が含まれています');
      }
      if (furigana && furigana.length >= 3 && normalizedText.includes(furigana)) {
        score = Math.max(score, 80);
        reasons.add('本文にフリガナが含まれています');
      }
    }

    if (score >= 80) {
      candidates.push({
        matchKey,
        score,
        reasons: [...reasons],
        rowNumbers: rows.map((row) => Number(row.rowNumber)).filter((rowNumber) => Number.isFinite(rowNumber)),
        applicationIds: uniqueStrings(rows.map((row) => row.applicationId)),
        studentName: rows.find((row) => row.studentName)?.studentName ?? null,
        studentFurigana: rows.find((row) => row.studentFurigana)?.studentFurigana ?? null,
        lineDisplayName: rows.find((row) => row.lineDisplayName)?.lineDisplayName ?? null,
        externalStudentId: rows.find((row) => row.externalStudentId)?.externalStudentId ?? null,
      });
    }
  }

  return candidates.sort((a, b) => b.score - a.score || b.rowNumbers.length - a.rowNumbers.length);
}

async function writeLineUserIdToRows(input: { rows: NormalizedSheetRow[]; lineUserId: string; dryRun?: boolean }) {
  const map = sheetsColumnMap();
  const rowNumbers = [...new Set(input.rows.map((row) => Number(row.rowNumber)).filter((rowNumber) => Number.isFinite(rowNumber)))];
  if (rowNumbers.length === 0) return { ok: true, dryRun: true, updatedCells: 0, rowNumbers };
  if (effectiveSheetsDryRun(input.dryRun) || !config.GOOGLE_SHEETS_SPREADSHEET_ID) {
    return { ok: true, dryRun: true, updatedCells: 0, rowNumbers };
  }

  const indexes = await headerIndexes(map);
  const lineUserIdIndex = indexes.get(map.lineUserId);
  if (lineUserIdIndex === undefined) throw new Error(`Google Sheets header not found for ${map.lineUserId}`);
  const data = rowNumbers.map((rowNumber) => ({
    range: `${config.GOOGLE_SHEETS_TAB_NAME}!${columnName(lineUserIdIndex)}${rowNumber}`,
    values: [[input.lineUserId]],
  }));
  const json = await googleSheetsFetch('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
  }) as any;
  return { ok: true, dryRun: false, updatedCells: json.totalUpdatedCells ?? 0, rowNumbers };
}

async function syncLinkedRowsToSupabase(input: { rows: NormalizedSheetRow[]; lineUserId: string; displayName?: string; dryRun?: boolean }) {
  if (input.dryRun) return { ok: true, dryRun: true, rows: input.rows.length, results: [] };
  const map = sheetsColumnMap();
  const rows = input.rows.map((row) => ({
    ...row.raw,
    __rowNumber: row.rowNumber,
    [map.lineUserId]: input.lineUserId,
    [map.lineDisplayName]: row.lineDisplayName ?? input.displayName ?? '',
  }));
  return syncSheetsToSupabase({ rows });
}

function rowsForCandidate(rows: NormalizedSheetRow[], candidate: LineIdentityCandidate) {
  const selected = rows.filter((row) => sameIdentity(row, candidate));
  return selected.length > 0 ? selected : rows.filter((row) => candidate.rowNumbers.includes(Number(row.rowNumber)));
}

export async function findLineIdentityCandidates(input: { event: InboundLineMessage; rows?: SheetRow[] }) {
  if (!config.GOOGLE_SHEETS_SPREADSHEET_ID && !input.rows) {
    return { ok: true, status: 'disabled' as const, reason: 'GOOGLE_SHEETS_SPREADSHEET_ID is not set', candidates: [], nameCandidates: [] };
  }
  const map = sheetsColumnMap();
  const sourceRows = input.rows ?? await readSheetRows();
  const rows = sourceRows.map((row) => normalizeRow(row, map));
  const existingRows = rows.filter((row) => row.lineUserId === input.event.lineUserId);
  const nameCandidates = extractStudentNameCandidates(input.event.text, input.event.displayName);
  if (existingRows.length > 0) {
    const candidateRows = rows.filter((row) => existingRows.some((existing) => sameIdentity(row, {
      matchKey: rowIdentityKey(existing),
      score: 120,
      reasons: [],
      rowNumbers: [Number(existing.rowNumber)],
      applicationIds: existing.applicationId ? [existing.applicationId] : [],
      studentName: existing.studentName,
      studentFurigana: existing.studentFurigana,
      lineDisplayName: existing.lineDisplayName,
      externalStudentId: existing.externalStudentId,
    })));
    const candidate = buildLineIdentityCandidates({ event: input.event, rows: candidateRows })[0];
    return { ok: true, status: 'existing' as const, candidates: candidate ? [candidate] : [], rows: candidateRows, nameCandidates };
  }
  const candidates = buildLineIdentityCandidates({ event: input.event, rows });
  if (candidates.length === 0) return { ok: true, status: 'unmatched' as const, candidates, rows, nameCandidates };
  if (candidates.length === 1) return { ok: true, status: 'unique' as const, candidates, rows, nameCandidates };
  return { ok: true, status: 'multiple' as const, candidates, rows, nameCandidates };
}

export async function linkLineUserFromSheets(input: { event: InboundLineMessage; dryRun?: boolean }) {
  const found = await findLineIdentityCandidates({ event: input.event });
  if (found.status === 'disabled' || found.status === 'unmatched' || found.status === 'multiple') return found;
  const candidate = found.candidates[0];
  if (!candidate) return { ...found, status: 'unmatched' as const };
  const rows = rowsForCandidate(found.rows ?? [], candidate);
  const [sheetWrite, supabaseSync] = await Promise.all([
    writeLineUserIdToRows({ rows, lineUserId: input.event.lineUserId, dryRun: input.dryRun }),
    syncLinkedRowsToSupabase({ rows, lineUserId: input.event.lineUserId, displayName: input.event.displayName, dryRun: input.dryRun }),
  ]);
  return { ...found, status: found.status === 'existing' ? 'existing' as const : 'linked' as const, candidate, linkedRows: rows.length, sheetWrite, supabaseSync };
}

export async function confirmLineIdentityLink(input: { matchKey: string; lineUserId: string; displayName?: string; eventText: string; dryRun?: boolean }) {
  const event = { lineUserId: input.lineUserId, displayName: input.displayName, text: input.eventText, messageType: 'text' };
  const found = await findLineIdentityCandidates({ event });
  const candidate = found.candidates.find((item) => item.matchKey === input.matchKey);
  if (!candidate || !('rows' in found)) return { ok: false, status: 'candidate_not_found' as const, candidates: found.candidates };
  const rows = rowsForCandidate(found.rows ?? [], candidate);
  const [sheetWrite, supabaseSync] = await Promise.all([
    writeLineUserIdToRows({ rows, lineUserId: input.lineUserId, dryRun: input.dryRun }),
    syncLinkedRowsToSupabase({ rows, lineUserId: input.lineUserId, displayName: input.displayName, dryRun: input.dryRun }),
  ]);
  return { ok: true, status: 'linked' as const, candidate, linkedRows: rows.length, sheetWrite, supabaseSync };
}

async function findExistingSheetStudent(row: NormalizedSheetRow) {
  if (row.lineUserId) {
    const { data, error } = await supabase
      .from('students')
      .select('*')
      .eq('client_id', config.DEFAULT_CLIENT_ID)
      .eq('line_user_id', row.lineUserId)
      .maybeSingle();
    if (error) throw error;
    if (data) return data;
  }

  if (row.externalStudentId) {
    const { data, error } = await supabase
      .from('students')
      .select('*')
      .eq('client_id', config.DEFAULT_CLIENT_ID)
      .eq('external_student_id', row.externalStudentId)
      .maybeSingle();
    if (error) throw error;
    if (data) return data;
  }

  if (row.studentName) {
    let query = supabase
      .from('students')
      .select('*')
      .eq('client_id', config.DEFAULT_CLIENT_ID)
      .eq('name', row.studentName)
      .limit(1);
    if (row.studentFurigana) query = query.eq('furigana', row.studentFurigana);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    if (data) return data;
  }

  return null;
}

async function upsertStudentFromSheet(row: NormalizedSheetRow) {
  const now = nowIso();
  const existing = await findExistingSheetStudent(row);
  const patch: Record<string, unknown> = {
    client_id: config.DEFAULT_CLIENT_ID,
    updated_at: now,
  };
  if (row.lineUserId) patch.line_user_id = row.lineUserId;
  if (row.externalStudentId) patch.external_student_id = row.externalStudentId;
  if (row.studentName) {
    patch.name = row.studentName;
    patch.display_name = row.lineDisplayName ?? row.studentName;
  }
  if (row.studentFurigana) patch.furigana = row.studentFurigana;
  if (row.lineDisplayName) patch.line_display_name = row.lineDisplayName;
  if (row.universityName) patch.school_name = row.universityName;
  if (row.graduationYear) patch.graduation_year = row.graduationYear;

  if (existing) {
    const { data, error } = await supabase.from('students').update(patch).eq('id', existing.id).select('*').single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase.from('students').insert({
    ...patch,
    line_user_id: row.lineUserId ?? null,
    created_at: now,
  }).select('*').single();
  if (error) throw error;
  return data;
}

export async function syncSheetsToSupabase(input: { rows?: SheetRow[]; dryRun?: boolean } = {}) {
  const map = sheetsColumnMap();
  const sourceRows = input.rows ?? await readSheetRows();
  const normalized = sourceRows.map((row) => normalizeRow(row, map));
  const results = [];

  for (const row of normalized) {
    if (!row.applicationId) {
      results.push({ ok: false, skipped: true, rowNumber: row.rowNumber, error: 'Missing application_id' });
      continue;
    }
    if (input.dryRun) {
      results.push({ ok: true, dryRun: true, applicationId: row.applicationId, rowNumber: row.rowNumber, lineUserLinked: Boolean(row.lineUserId) });
      continue;
    }

    const student = await upsertStudentFromSheet(row);

    const { data: application, error } = await supabase.from('referral_applications').upsert({
      client_id: config.DEFAULT_CLIENT_ID,
      application_id: row.applicationId,
      student_id: student.id,
      external_student_id: row.externalStudentId ?? student.external_student_id ?? null,
      line_user_id: row.lineUserId ?? student.line_user_id ?? null,
      student_name: row.studentName,
      student_furigana: row.studentFurigana,
      line_display_name: row.lineDisplayName,
      university_name: row.universityName,
      graduation_year: row.graduationYear,
      agent_name: row.agentName,
      participation_purpose: row.participationPurpose,
      participation_scheduled_at: row.participationScheduledAt,
      current_status: row.currentStatus,
      auto_send_enabled: Boolean((row.lineUserId ?? student.line_user_id) && row.participationScheduledAt && row.autoSendEnabled && !row.humanRequired),
      human_required: row.humanRequired,
      sheet_row_number: row.rowNumber,
      sheet_values: row.raw,
      notes: row.notes,
      updated_at: nowIso(),
    }, { onConflict: 'client_id,application_id' }).select('*').single();
    if (error) throw error;

    const { error: stateError } = await supabase.from('application_workflow_states').upsert({
      client_id: config.DEFAULT_CLIENT_ID,
      application_ref_id: application.id,
      status: row.humanRequired ? 'human_required' : row.currentStatus,
      metadata: { source: 'sheets_sync' },
      updated_at: nowIso(),
    }, { onConflict: 'client_id,application_ref_id' });
    if (stateError) throw stateError;

    results.push({ ok: true, applicationId: row.applicationId, applicationRefId: application.id, studentId: student.id, rowNumber: row.rowNumber, lineUserLinked: Boolean(row.lineUserId ?? student.line_user_id) });
  }

  return { ok: true, dryRun: Boolean(input.dryRun), rows: results.length, results };
}

function applicationToSheetValues(application: any, map: SheetsColumnMap) {
  const student = application.students ?? {};
  const values: Record<string, unknown> = {};
  const set = (header: string, valueToWrite: unknown) => {
    if (header) values[header] = valueToWrite ?? '';
  };
  set(map.lineUserId, application.line_user_id ?? student.line_user_id ?? '');
  set(map.currentStatus, application.current_status ?? '');
  set(map.sameDayReminderSentAt, application.same_day_reminder_sent_at ?? '');
  set(map.postParticipationFormSentAt, application.post_participation_form_sent_at ?? '');
  set(map.postParticipationFormAnsweredAt, application.post_participation_form_answered_at ?? '');
  set(map.bankFormSentAt, application.bank_form_sent_at ?? student.bank_form_sent_at ?? '');
  set(map.bankFormAnsweredAt, application.bank_form_answered_at ?? student.bank_form_answered_at ?? '');
  set(map.lastLineSentAt, application.last_line_sent_at ?? '');
  set(map.slackNotifiedAt, application.slack_notified_at ?? '');
  set(map.errorMessage, application.error_message ?? '');
  set(map.notes, application.notes ?? '');
  return values;
}

export async function writeApplicationsToSheets(input: { applicationIds?: string[]; dryRun?: boolean } = {}) {
  const map = sheetsColumnMap();
  let query = supabase
    .from('referral_applications')
    .select('*, students(line_user_id,display_name,external_student_id,bank_form_sent_at,bank_form_answered_at)')
    .eq('client_id', config.DEFAULT_CLIENT_ID)
    .not('sheet_row_number', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(500);

  if (input.applicationIds?.length) query = query.in('id', input.applicationIds);
  const { data, error } = await query;
  if (error) throw error;

  const applications = data ?? [];
  if (effectiveSheetsDryRun(input.dryRun) || !config.GOOGLE_SHEETS_SPREADSHEET_ID) {
    return {
      ok: true,
      dryRun: true,
      updates: applications.map((application: any) => ({
        applicationId: application.application_id,
        rowNumber: application.sheet_row_number,
        values: applicationToSheetValues(application, map),
      })),
    };
  }

  const indexes = await headerIndexes(map);
  const dataUpdates = [];
  for (const application of applications as any[]) {
    const rowNumber = Number(application.sheet_row_number);
    const values = applicationToSheetValues(application, map);
    for (const [header, valueToWrite] of Object.entries(values)) {
      const index = indexes.get(header);
      if (index === undefined) continue;
      dataUpdates.push({
        range: `${config.GOOGLE_SHEETS_TAB_NAME}!${columnName(index)}${rowNumber}`,
        values: [[valueToWrite ?? '']],
      });
    }
  }

  if (dataUpdates.length === 0) return { ok: true, dryRun: false, updatedCells: 0 };
  const json = await googleSheetsFetch('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: dataUpdates }),
  }) as any;
  return { ok: true, dryRun: false, updatedCells: json.totalUpdatedCells ?? 0, updatedRanges: dataUpdates.length };
}
