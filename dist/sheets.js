import crypto from 'node:crypto';
import { config } from './config.js';
import { supabase } from './db.js';
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
};
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const DEFAULT_POST_PARTICIPATION_RESPONSE_COLUMN_MAP = {
    timestamp: 'タイムスタンプ',
    studentName: '名前',
    studentFurigana: 'フリガナ',
    agentName: '案件名称',
    participationDate: '参加日',
    participationScheduledAt: '参加日時',
};
const DEFAULT_BANK_ACCOUNT_RESPONSE_COLUMN_MAP = {
    timestamp: 'タイムスタンプ',
    studentName: '名前',
    studentFurigana: 'フリガナ',
    universityName: '大学名',
};
const SHEETS_HEADER_ALIASES = {
    applicationId: ['申込ID', '顧客ID'],
    lineUserId: ['Line ユーザーID', 'LINE ユーザーID', 'LINEユーザーID', 'ラインユーザーID'],
    studentFurigana: ['（フリガナ）', 'フリガナ', 'ふりがな', 'カナ'],
};
function nowIso() {
    return new Date().toISOString();
}
export function sheetsColumnMap() {
    if (!config.SHEETS_COLUMN_MAP_JSON)
        return { ...DEFAULT_SHEETS_COLUMN_MAP };
    const parsed = JSON.parse(config.SHEETS_COLUMN_MAP_JSON);
    return { ...DEFAULT_SHEETS_COLUMN_MAP, ...parsed };
}
function postParticipationResponseColumnMap() {
    if (!config.POST_PARTICIPATION_RESPONSE_COLUMN_MAP_JSON)
        return { ...DEFAULT_POST_PARTICIPATION_RESPONSE_COLUMN_MAP };
    const parsed = JSON.parse(config.POST_PARTICIPATION_RESPONSE_COLUMN_MAP_JSON);
    return { ...DEFAULT_POST_PARTICIPATION_RESPONSE_COLUMN_MAP, ...parsed };
}
function bankAccountResponseColumnMap() {
    if (!config.BANK_ACCOUNT_RESPONSE_COLUMN_MAP_JSON)
        return { ...DEFAULT_BANK_ACCOUNT_RESPONSE_COLUMN_MAP };
    const parsed = JSON.parse(config.BANK_ACCOUNT_RESPONSE_COLUMN_MAP_JSON);
    return { ...DEFAULT_BANK_ACCOUNT_RESPONSE_COLUMN_MAP, ...parsed };
}
function mainSheetSource() {
    return { spreadsheetId: config.GOOGLE_SHEETS_SPREADSHEET_ID, tabName: config.GOOGLE_SHEETS_TAB_NAME, headerRow: config.GOOGLE_SHEETS_HEADER_ROW };
}
function responseSheetSource(kind) {
    if (kind === 'postParticipation') {
        const spreadsheetId = config.POST_PARTICIPATION_RESPONSES_SPREADSHEET_ID || config.GOOGLE_SHEETS_SPREADSHEET_ID;
        const tabName = config.POST_PARTICIPATION_RESPONSES_TAB_NAME;
        return spreadsheetId && tabName ? { spreadsheetId, tabName, headerRow: config.POST_PARTICIPATION_RESPONSES_HEADER_ROW } : null;
    }
    const spreadsheetId = config.BANK_ACCOUNT_RESPONSES_SPREADSHEET_ID || config.GOOGLE_SHEETS_SPREADSHEET_ID;
    const tabName = config.BANK_ACCOUNT_RESPONSES_TAB_NAME;
    return spreadsheetId && tabName ? { spreadsheetId, tabName, headerRow: config.BANK_ACCOUNT_RESPONSES_HEADER_ROW } : null;
}
function value(row, map, key) {
    const mapped = map[key];
    return row[mapped] ?? row[key];
}
function textValue(row, map, key) {
    const raw = value(row, map, key);
    const text = raw === undefined || raw === null ? '' : String(raw).trim();
    return text || null;
}
function effectiveSheetsDryRun(inputDryRun) {
    return Boolean(inputDryRun || config.SHEETS_DRY_RUN || config.SHEETS_WRITE_DRY_RUN);
}
function fallbackTextValue(row, map, key, fallbacks) {
    const mapped = textValue(row, map, key);
    if (mapped)
        return mapped;
    for (const fallback of fallbacks) {
        const raw = row[fallback];
        const text = raw === undefined || raw === null ? '' : String(raw).trim();
        if (text)
            return text;
    }
    return null;
}
function boolValue(row, map, key, defaultValue = false) {
    const raw = textValue(row, map, key);
    if (!raw)
        return defaultValue;
    return /^(1|true|yes|y|on|対象|する|送信|送信する|自動|auto)$/i.test(raw);
}
function parseDateTime(raw) {
    if (!raw)
        return null;
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
    if (Number.isNaN(date.getTime()))
        return null;
    return date.toISOString();
}
function zonedDateTimeToUtcIso(input) {
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
    const pick = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    const representedAsUtc = Date.UTC(pick('year'), pick('month') - 1, pick('day'), pick('hour'), pick('minute'), pick('second'));
    const offset = representedAsUtc - utcGuess;
    return new Date(utcGuess - offset).toISOString();
}
function applicationStatus(raw) {
    if (!raw)
        return 'interested';
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
    if (known.includes(raw))
        return raw;
    if (/要対応|人間|例外|確認必要/.test(normalized))
        return 'human_required';
    if (/支払|支払い|入金準備|精算/.test(normalized))
        return 'payment_ready';
    if (/口座|銀行|TS|登録/.test(normalized))
        return 'bank_account_waiting';
    if (/参加確認|参加後|フォーム/.test(normalized))
        return 'post_participation_form_waiting';
    if (/当日|リマインド/.test(normalized))
        return 'same_day_reminder_pending';
    if (/注意事項.*確認済|確認済/.test(normalized))
        return 'pre_caution_confirmed';
    if (/注意事項|事前案内/.test(normalized))
        return 'pre_caution_confirmation_waiting';
    if (/予約|日程|確定|予定/.test(normalized))
        return 'schedule_pending';
    if (/情報|回収|申込/.test(normalized))
        return 'application_info_collecting';
    return 'interested';
}
function participationDateTime(row, map) {
    const direct = textValue(row, map, 'participationScheduledAt');
    if (direct)
        return parseDateTime(direct);
    const date = textValue(row, map, 'reservationDate');
    const time = textValue(row, map, 'reservationTime');
    if (!date && !time)
        return null;
    return parseDateTime(`${date ?? ''} ${time ?? '00:00'}`.trim());
}
function headerRowNumber(source) {
    return Math.max(1, Number(source.headerRow ?? 1));
}
function rowsFromValues(values, headerRow = 1) {
    const [headerValues, ...bodyRows] = values;
    if (!headerValues)
        return [];
    const headers = headerValues.map((header) => String(header ?? '').trim());
    return bodyRows.map((row, index) => {
        const object = { __rowNumber: headerRow + index + 1 };
        headers.forEach((header, columnIndex) => {
            if (header)
                object[header] = row[columnIndex] ?? '';
        });
        return object;
    });
}
export function rowsFromSheetValuesForSmoke(values, headerRow = 1) {
    return rowsFromValues(values, headerRow);
}
function normalizeIdentityText(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[ぁ-ゖ]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0x60))
        .replace(/[\s　・･、。,.，．!！?？:：;；'"“”‘’「」『』（）()[\]{}<>＜＞\-ー_]/g, '');
}
function usableIdentityText(value) {
    const normalized = normalizeIdentityText(value);
    return normalized.length >= 2 ? normalized : null;
}
function uniqueStrings(values) {
    return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))];
}
export function extractStudentNameCandidates(text, displayName) {
    const candidates = new Set();
    if (displayName)
        candidates.add(displayName);
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
            if (usableIdentityText(value))
                candidates.add(value);
        }
    }
    return uniqueStrings([...candidates]);
}
function base64url(input) {
    return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
let cachedGoogleToken = null;
async function googleAccessToken() {
    if (cachedGoogleToken && cachedGoogleToken.expiresAt > Date.now() + 60_000)
        return cachedGoogleToken.token;
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
    if (!res.ok)
        throw new Error(`Google token request failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    cachedGoogleToken = { token: json.access_token, expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000 };
    return cachedGoogleToken.token;
}
async function googleSheetsFetch(path, init, source = mainSheetSource()) {
    if (!source.spreadsheetId || !source.tabName) {
        throw new Error('Set Google Sheets spreadsheet id and tab name for access');
    }
    const token = await googleAccessToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheetId)}${path}`;
    const res = await fetch(url, {
        ...init,
        headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            ...(init?.headers ?? {}),
        },
    });
    if (!res.ok)
        throw new Error(`Google Sheets API failed: ${res.status} ${await res.text()}`);
    return res.json();
}
async function readSheetRows(source = mainSheetSource()) {
    const headerRow = headerRowNumber(source);
    const range = `${encodeURIComponent(source.tabName)}!A${headerRow}:ZZ`;
    const json = await googleSheetsFetch(`/values/${range}?majorDimension=ROWS`, undefined, source);
    return rowsFromValues(json.values ?? [], headerRow);
}
function columnName(index) {
    let n = index + 1;
    let name = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        name = String.fromCharCode(65 + rem) + name;
        n = Math.floor((n - rem) / 26);
    }
    return name;
}
async function headerIndexes(map, source = mainSheetSource()) {
    const headerRow = headerRowNumber(source);
    const range = `${encodeURIComponent(source.tabName)}!A${headerRow}:ZZ${headerRow}`;
    const json = await googleSheetsFetch(`/values/${range}?majorDimension=ROWS`, undefined, source);
    const headers = (json.values?.[0] ?? []).map((header) => String(header ?? '').trim());
    const indexes = new Map();
    Object.entries(map).forEach(([key, header]) => {
        if (!header)
            return;
        const candidates = [header, ...(SHEETS_HEADER_ALIASES[key] ?? [])].map((candidate) => candidate.trim());
        const index = candidates.map((candidate) => headers.indexOf(candidate)).find((candidateIndex) => candidateIndex >= 0) ?? -1;
        if (index >= 0) {
            indexes.set(header, index);
            indexes.set(headers[index], index);
        }
    });
    return indexes;
}
function normalizeRow(row, map) {
    return {
        rowNumber: row.__rowNumber,
        applicationId: fallbackTextValue(row, map, 'applicationId', ['申込ID', '顧客ID']),
        externalStudentId: textValue(row, map, 'externalStudentId'),
        lineUserId: fallbackTextValue(row, map, 'lineUserId', ['Line ユーザーID', 'LINE ユーザーID', 'LINEユーザーID', 'ラインユーザーID']),
        studentName: fallbackTextValue(row, map, 'studentName', ['名前', '氏名']),
        studentFurigana: fallbackTextValue(row, map, 'studentFurigana', ['（フリガナ）', 'フリガナ', 'ふりがな', 'カナ']),
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
export function normalizeSheetRowForSmoke(row, map = sheetsColumnMap()) {
    return normalizeRow(row, map);
}
function rowIdentityKey(row) {
    const external = usableIdentityText(row.externalStudentId);
    if (external)
        return `external:${external}`;
    const name = usableIdentityText(row.studentName);
    if (name)
        return `name:${name}`;
    const lineName = usableIdentityText(row.lineDisplayName);
    if (lineName)
        return `line:${lineName}`;
    return `row:${row.rowNumber ?? row.applicationId ?? 'unknown'}`;
}
function sameIdentity(row, candidate) {
    const external = usableIdentityText(row.externalStudentId);
    const name = usableIdentityText(row.studentName);
    const lineName = usableIdentityText(row.lineDisplayName);
    return Boolean((candidate.externalStudentId && external && external === usableIdentityText(candidate.externalStudentId))
        || (candidate.studentName && name && name === usableIdentityText(candidate.studentName))
        || (candidate.lineDisplayName && lineName && lineName === usableIdentityText(candidate.lineDisplayName)));
}
function buildLineIdentityCandidates(input) {
    const nameCandidates = extractStudentNameCandidates(input.event.text, input.event.displayName);
    const normalizedNameCandidates = nameCandidates.map(usableIdentityText).filter((value) => Boolean(value));
    const normalizedText = normalizeIdentityText(input.event.text);
    const normalizedDisplayName = usableIdentityText(input.event.displayName);
    const groups = new Map();
    for (const row of input.rows) {
        if (row.lineUserId && row.lineUserId !== input.event.lineUserId)
            continue;
        const key = rowIdentityKey(row);
        const existing = groups.get(key) ?? [];
        existing.push(row);
        groups.set(key, existing);
    }
    const candidates = [];
    for (const [matchKey, rows] of groups) {
        let score = 0;
        const reasons = new Set();
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
async function writeLineUserIdToRows(input) {
    const map = sheetsColumnMap();
    const rowNumbers = [...new Set(input.rows.map((row) => Number(row.rowNumber)).filter((rowNumber) => Number.isFinite(rowNumber)))];
    if (rowNumbers.length === 0)
        return { ok: true, dryRun: true, updatedCells: 0, rowNumbers };
    if (effectiveSheetsDryRun(input.dryRun) || !config.GOOGLE_SHEETS_SPREADSHEET_ID) {
        return { ok: true, dryRun: true, updatedCells: 0, rowNumbers };
    }
    const indexes = await headerIndexes(map);
    const lineUserIdIndex = indexes.get(map.lineUserId);
    if (lineUserIdIndex === undefined)
        throw new Error(`Google Sheets header not found for ${map.lineUserId}`);
    const data = rowNumbers.map((rowNumber) => ({
        range: `${config.GOOGLE_SHEETS_TAB_NAME}!${columnName(lineUserIdIndex)}${rowNumber}`,
        values: [[input.lineUserId]],
    }));
    const json = await googleSheetsFetch('/values:batchUpdate', {
        method: 'POST',
        body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
    }, mainSheetSource());
    return { ok: true, dryRun: false, updatedCells: json.totalUpdatedCells ?? 0, rowNumbers };
}
async function syncLinkedRowsToSupabase(input) {
    if (input.dryRun)
        return { ok: true, dryRun: true, rows: input.rows.length, results: [] };
    const map = sheetsColumnMap();
    const rows = input.rows.map((row) => ({
        ...row.raw,
        __rowNumber: row.rowNumber,
        [map.lineUserId]: input.lineUserId,
        [map.lineDisplayName]: row.lineDisplayName ?? input.displayName ?? '',
    }));
    return syncSheetsToSupabase({ rows });
}
function rowsForCandidate(rows, candidate) {
    const selected = rows.filter((row) => sameIdentity(row, candidate));
    return selected.length > 0 ? selected : rows.filter((row) => candidate.rowNumbers.includes(Number(row.rowNumber)));
}
export async function findLineIdentityCandidates(input) {
    if (!config.GOOGLE_SHEETS_SPREADSHEET_ID && !input.rows) {
        return { ok: true, status: 'disabled', reason: 'GOOGLE_SHEETS_SPREADSHEET_ID is not set', candidates: [], nameCandidates: [] };
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
        return { ok: true, status: 'existing', candidates: candidate ? [candidate] : [], rows: candidateRows, nameCandidates };
    }
    const candidates = buildLineIdentityCandidates({ event: input.event, rows });
    if (candidates.length === 0)
        return { ok: true, status: 'unmatched', candidates, rows, nameCandidates };
    if (candidates.length === 1)
        return { ok: true, status: 'unique', candidates, rows, nameCandidates };
    return { ok: true, status: 'multiple', candidates, rows, nameCandidates };
}
export async function linkLineUserFromSheets(input) {
    const found = await findLineIdentityCandidates({ event: input.event });
    if (found.status === 'disabled' || found.status === 'unmatched' || found.status === 'multiple')
        return found;
    const candidate = found.candidates[0];
    if (!candidate)
        return { ...found, status: 'unmatched' };
    const rows = rowsForCandidate(found.rows ?? [], candidate);
    const [sheetWrite, supabaseSync] = await Promise.all([
        writeLineUserIdToRows({ rows, lineUserId: input.event.lineUserId, dryRun: input.dryRun }),
        syncLinkedRowsToSupabase({ rows, lineUserId: input.event.lineUserId, displayName: input.event.displayName, dryRun: input.dryRun }),
    ]);
    return { ...found, status: found.status === 'existing' ? 'existing' : 'linked', candidate, linkedRows: rows.length, sheetWrite, supabaseSync };
}
export async function confirmLineIdentityLink(input) {
    const event = { lineUserId: input.lineUserId, displayName: input.displayName, text: input.eventText, messageType: 'text' };
    const found = await findLineIdentityCandidates({ event });
    const candidate = found.candidates.find((item) => item.matchKey === input.matchKey);
    if (!candidate || !('rows' in found))
        return { ok: false, status: 'candidate_not_found', candidates: found.candidates };
    const rows = rowsForCandidate(found.rows ?? [], candidate);
    const [sheetWrite, supabaseSync] = await Promise.all([
        writeLineUserIdToRows({ rows, lineUserId: input.lineUserId, dryRun: input.dryRun }),
        syncLinkedRowsToSupabase({ rows, lineUserId: input.lineUserId, displayName: input.displayName, dryRun: input.dryRun }),
    ]);
    return { ok: true, status: 'linked', candidate, linkedRows: rows.length, sheetWrite, supabaseSync };
}
async function findExistingSheetStudent(row) {
    if (row.lineUserId) {
        const { data, error } = await supabase
            .from('students')
            .select('*')
            .eq('client_id', config.DEFAULT_CLIENT_ID)
            .eq('line_user_id', row.lineUserId)
            .maybeSingle();
        if (error)
            throw error;
        if (data)
            return data;
    }
    if (row.externalStudentId) {
        const { data, error } = await supabase
            .from('students')
            .select('*')
            .eq('client_id', config.DEFAULT_CLIENT_ID)
            .eq('external_student_id', row.externalStudentId)
            .maybeSingle();
        if (error)
            throw error;
        if (data)
            return data;
    }
    if (row.studentName) {
        let query = supabase
            .from('students')
            .select('*')
            .eq('client_id', config.DEFAULT_CLIENT_ID)
            .eq('name', row.studentName)
            .limit(1);
        if (row.studentFurigana)
            query = query.eq('furigana', row.studentFurigana);
        const { data, error } = await query.maybeSingle();
        if (error)
            throw error;
        if (data)
            return data;
    }
    return null;
}
async function upsertStudentFromSheet(row) {
    const now = nowIso();
    const existing = await findExistingSheetStudent(row);
    const patch = {
        client_id: config.DEFAULT_CLIENT_ID,
        updated_at: now,
    };
    if (row.lineUserId)
        patch.line_user_id = row.lineUserId;
    if (row.externalStudentId)
        patch.external_student_id = row.externalStudentId;
    if (row.studentName) {
        patch.name = row.studentName;
        if (!existing?.display_name)
            patch.display_name = row.lineDisplayName ?? row.studentName;
    }
    if (row.studentFurigana)
        patch.furigana = row.studentFurigana;
    if (row.lineDisplayName)
        patch.line_display_name = row.lineDisplayName;
    if (row.universityName)
        patch.school_name = row.universityName;
    if (row.graduationYear)
        patch.graduation_year = row.graduationYear;
    if (existing) {
        const { data, error } = await supabase.from('students').update(patch).eq('id', existing.id).select('*').single();
        if (error)
            throw error;
        return data;
    }
    const { data, error } = await supabase.from('students').insert({
        ...patch,
        line_user_id: row.lineUserId ?? null,
        created_at: now,
    }).select('*').single();
    if (error)
        throw error;
    return data;
}
export async function syncSheetsToSupabase(input = {}) {
    const map = sheetsColumnMap();
    const sourceRows = input.rows ?? await readSheetRows();
    const offset = Math.max(0, Number(input.offset ?? 0));
    const limit = input.limit && Number(input.limit) > 0 ? Number(input.limit) : undefined;
    const selectedRows = input.rows ? sourceRows : sourceRows.slice(offset, limit ? offset + limit : undefined);
    const normalized = selectedRows.map((row) => normalizeRow(row, map));
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
        if (error)
            throw error;
        const { error: stateError } = await supabase.from('application_workflow_states').upsert({
            client_id: config.DEFAULT_CLIENT_ID,
            application_ref_id: application.id,
            status: row.humanRequired ? 'human_required' : row.currentStatus,
            metadata: { source: 'sheets_sync' },
            updated_at: nowIso(),
        }, { onConflict: 'client_id,application_ref_id' });
        if (stateError)
            throw stateError;
        results.push({ ok: true, applicationId: row.applicationId, applicationRefId: application.id, studentId: student.id, rowNumber: row.rowNumber, lineUserLinked: Boolean(row.lineUserId ?? student.line_user_id) });
    }
    return { ok: true, dryRun: Boolean(input.dryRun), rows: results.length, totalRows: sourceRows.length, offset, limit: limit ?? null, results };
}
function applicationToSheetValues(application, map) {
    const student = application.students ?? {};
    const values = {};
    const set = (header, valueToWrite) => {
        if (header)
            values[header] = valueToWrite ?? '';
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
export async function writeApplicationsToSheets(input = {}) {
    const map = sheetsColumnMap();
    let query = supabase
        .from('referral_applications')
        .select('*, students(line_user_id,display_name,external_student_id,bank_form_sent_at,bank_form_answered_at)')
        .eq('client_id', config.DEFAULT_CLIENT_ID)
        .not('sheet_row_number', 'is', null)
        .order('updated_at', { ascending: false })
        .limit(500);
    if (input.applicationIds?.length)
        query = query.in('id', input.applicationIds);
    const { data, error } = await query;
    if (error)
        throw error;
    const applications = data ?? [];
    if (effectiveSheetsDryRun(input.dryRun) || !config.GOOGLE_SHEETS_SPREADSHEET_ID) {
        return {
            ok: true,
            dryRun: true,
            updates: applications.map((application) => ({
                applicationId: application.application_id,
                rowNumber: application.sheet_row_number,
                values: applicationToSheetValues(application, map),
            })),
        };
    }
    const indexes = await headerIndexes(map);
    const dataUpdates = [];
    for (const application of applications) {
        const rowNumber = Number(application.sheet_row_number);
        const values = applicationToSheetValues(application, map);
        for (const [header, valueToWrite] of Object.entries(values)) {
            const index = indexes.get(header);
            if (index === undefined)
                continue;
            dataUpdates.push({
                range: `${config.GOOGLE_SHEETS_TAB_NAME}!${columnName(index)}${rowNumber}`,
                values: [[valueToWrite ?? '']],
            });
        }
    }
    if (dataUpdates.length === 0)
        return { ok: true, dryRun: false, updatedCells: 0 };
    const json = await googleSheetsFetch('/values:batchUpdate', {
        method: 'POST',
        body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: dataUpdates }),
    }, mainSheetSource());
    return { ok: true, dryRun: false, updatedCells: json.totalUpdatedCells ?? 0, updatedRanges: dataUpdates.length };
}
function rawText(row, header) {
    const raw = row[header];
    const text = raw === undefined || raw === null ? '' : String(raw).trim();
    return text || null;
}
function responseTextValue(row, map, key) {
    return rawText(row, map[key]);
}
function localDateKey(value) {
    if (!value)
        return null;
    const iso = parseDateTime(value);
    if (!iso)
        return null;
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: config.WORKFLOW_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date(iso));
    const pick = (type) => parts.find((part) => part.type === type)?.value;
    return `${pick('year')}-${pick('month')}-${pick('day')}`;
}
function appDateKey(application) {
    if (!application.participation_scheduled_at)
        return null;
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: config.WORKFLOW_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date(application.participation_scheduled_at));
    const pick = (type) => parts.find((part) => part.type === type)?.value;
    return `${pick('year')}-${pick('month')}-${pick('day')}`;
}
function sameIdentityValue(a, b) {
    const left = usableIdentityText(a);
    const right = usableIdentityText(b);
    return Boolean(left && right && left === right);
}
function sameLooseValue(a, b) {
    const left = usableIdentityText(a);
    const right = usableIdentityText(b);
    return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}
function applicationName(application) {
    return application.student_name ?? application.students?.name ?? application.students?.display_name ?? null;
}
function applicationFurigana(application) {
    return application.student_furigana ?? application.students?.furigana ?? null;
}
function applicationUniversity(application) {
    return application.university_name ?? application.students?.school_name ?? null;
}
function normalizePostParticipationResponse(row, map = postParticipationResponseColumnMap()) {
    const participationDate = responseTextValue(row, map, 'participationDate') ?? responseTextValue(row, map, 'participationScheduledAt');
    return {
        rowNumber: row.__rowNumber,
        timestamp: responseTextValue(row, map, 'timestamp'),
        studentName: responseTextValue(row, map, 'studentName'),
        studentFurigana: responseTextValue(row, map, 'studentFurigana'),
        agentName: responseTextValue(row, map, 'agentName'),
        participationDate,
        participationDateKey: localDateKey(participationDate),
        raw: row,
    };
}
function normalizeBankAccountResponse(row, map = bankAccountResponseColumnMap()) {
    return {
        rowNumber: row.__rowNumber,
        timestamp: responseTextValue(row, map, 'timestamp'),
        studentName: responseTextValue(row, map, 'studentName'),
        studentFurigana: responseTextValue(row, map, 'studentFurigana'),
        universityName: responseTextValue(row, map, 'universityName'),
        raw: row,
    };
}
async function applicationPoolForFormMatching() {
    const { data, error } = await supabase
        .from('referral_applications')
        .select('*, students(id,name,display_name,furigana,school_name,line_user_id,bank_form_sent_at,bank_form_answered_at)')
        .eq('client_id', config.DEFAULT_CLIENT_ID)
        .order('updated_at', { ascending: false })
        .limit(5000);
    if (error)
        throw error;
    return data ?? [];
}
async function studentPoolForFormMatching() {
    const { data, error } = await supabase
        .from('students')
        .select('*')
        .eq('client_id', config.DEFAULT_CLIENT_ID)
        .order('updated_at', { ascending: false })
        .limit(5000);
    if (error)
        throw error;
    return data ?? [];
}
function uniqueById(items) {
    const seen = new Set();
    return items.filter((item) => {
        if (!item.id || seen.has(item.id))
            return false;
        seen.add(item.id);
        return true;
    });
}
function chooseUniqueMatch(rules) {
    for (const rule of rules) {
        const matches = uniqueById(rule.matches);
        if (matches.length === 1)
            return { status: 'matched', priority: rule.priority, rule: rule.label, match: matches[0], candidates: matches };
        if (matches.length > 1)
            return { status: 'multiple', priority: rule.priority, rule: rule.label, candidates: matches };
    }
    return { status: 'unmatched', priority: null, rule: null, candidates: [] };
}
function matchPostParticipationResponse(response, applications) {
    const hasDate = Boolean(response.participationDateKey);
    const rules = [
        {
            priority: 1,
            label: '名前 + 案件名称 + 参加日',
            matches: applications.filter((application) => (sameIdentityValue(response.studentName, applicationName(application))
                && sameLooseValue(response.agentName, application.agent_name)
                && hasDate
                && response.participationDateKey === appDateKey(application))),
        },
        {
            priority: 2,
            label: '名前 + 参加日',
            matches: applications.filter((application) => (sameIdentityValue(response.studentName, applicationName(application))
                && hasDate
                && response.participationDateKey === appDateKey(application))),
        },
        {
            priority: 3,
            label: 'フリガナ + 案件名称 + 参加日',
            matches: applications.filter((application) => (sameIdentityValue(response.studentFurigana, applicationFurigana(application))
                && sameLooseValue(response.agentName, application.agent_name)
                && hasDate
                && response.participationDateKey === appDateKey(application))),
        },
        {
            priority: 4,
            label: '名前 + 案件名称',
            matches: applications.filter((application) => (sameIdentityValue(response.studentName, applicationName(application))
                && sameLooseValue(response.agentName, application.agent_name))),
        },
    ];
    return chooseUniqueMatch(rules);
}
function matchBankAccountResponse(response, students) {
    const rules = [
        {
            priority: 1,
            label: '名前 + フリガナ',
            matches: students.filter((student) => sameIdentityValue(response.studentName, student.name ?? student.display_name) && sameIdentityValue(response.studentFurigana, student.furigana)),
        },
        {
            priority: 2,
            label: '名前 + 大学名',
            matches: students.filter((student) => sameIdentityValue(response.studentName, student.name ?? student.display_name) && sameLooseValue(response.universityName, student.school_name)),
        },
        {
            priority: 3,
            label: 'フリガナ + 大学名',
            matches: students.filter((student) => sameIdentityValue(response.studentFurigana, student.furigana) && sameLooseValue(response.universityName, student.school_name)),
        },
        {
            priority: 4,
            label: '名前のみ',
            matches: students.filter((student) => sameIdentityValue(response.studentName, student.name ?? student.display_name)),
        },
    ];
    return chooseUniqueMatch(rules);
}
export function matchPostParticipationResponseForSmoke(row, applications) {
    return matchPostParticipationResponse(normalizePostParticipationResponse(row), applications);
}
export function matchBankAccountResponseForSmoke(row, students) {
    return matchBankAccountResponse(normalizeBankAccountResponse(row), students);
}
async function markPostParticipationAnswered(application, response, matchRule, dryRun) {
    const answeredAt = response.timestamp ? parseDateTime(response.timestamp) ?? nowIso() : nowIso();
    if (dryRun)
        return { ok: true, dryRun: true, applicationId: application.application_id, answeredAt };
    const { error } = await supabase.from('referral_applications').update({
        current_status: 'bank_form_send_pending',
        post_participation_form_answered_at: answeredAt,
        post_participation_form_response_row_number: response.rowNumber ?? null,
        post_participation_form_response_values: response.raw,
        sheet_values: { ...(application.sheet_values ?? {}), post_participation_form_match_rule: matchRule },
        updated_at: nowIso(),
    }).eq('id', application.id);
    if (error)
        throw error;
    await writeApplicationsToSheets({ applicationIds: [application.id], dryRun: effectiveSheetsDryRun(dryRun) });
    return { ok: true, dryRun: false, applicationId: application.application_id, answeredAt };
}
async function markBankAccountAnswered(student, response, matchRule, dryRun) {
    const answeredAt = response.timestamp ? parseDateTime(response.timestamp) ?? nowIso() : nowIso();
    if (dryRun)
        return { ok: true, dryRun: true, studentId: student.id, answeredAt };
    const { error: studentError } = await supabase.from('students').update({ bank_form_answered_at: answeredAt, updated_at: nowIso() }).eq('id', student.id);
    if (studentError)
        throw studentError;
    const { error: registrationError } = await supabase.from('student_registration_states').upsert({
        client_id: config.DEFAULT_CLIENT_ID,
        student_id: student.id,
        bank_form_answered_at: answeredAt,
        bank_form_response_row_number: response.rowNumber ?? null,
        bank_form_response_values: response.raw,
        metadata: { match_rule: matchRule },
        updated_at: nowIso(),
    }, { onConflict: 'client_id,student_id' });
    if (registrationError && !/student_registration_states|relation .* does not exist/i.test(registrationError.message ?? ''))
        throw registrationError;
    const { data: applications, error: appReadError } = await supabase
        .from('referral_applications')
        .select('id')
        .eq('client_id', config.DEFAULT_CLIENT_ID)
        .eq('student_id', student.id);
    if (appReadError)
        throw appReadError;
    const applicationIds = (applications ?? []).map((application) => application.id);
    if (applicationIds.length > 0) {
        const { error: appUpdateError } = await supabase.from('referral_applications').update({
            current_status: 'payment_ready',
            bank_form_answered_at: answeredAt,
            updated_at: nowIso(),
        }).in('id', applicationIds);
        if (appUpdateError)
            throw appUpdateError;
        await writeApplicationsToSheets({ applicationIds, dryRun: effectiveSheetsDryRun(dryRun) });
    }
    return { ok: true, dryRun: false, studentId: student.id, answeredAt, applicationIds };
}
export async function syncPostParticipationFormResponses(input = {}) {
    const source = responseSheetSource('postParticipation');
    if (!source && !input.rows)
        return { ok: true, status: 'disabled', results: [] };
    const rows = input.rows ?? await readSheetRows(source);
    const responses = rows.map((row) => normalizePostParticipationResponse(row));
    const applications = await applicationPoolForFormMatching();
    const results = [];
    for (const response of responses) {
        const match = matchPostParticipationResponse(response, applications);
        if (match.status === 'matched') {
            const update = await markPostParticipationAnswered(match.match, response, match.rule, input.dryRun);
            results.push({ ok: true, status: 'matched', response, matchRule: match.rule, application: match.match, update });
        }
        else {
            results.push({ ok: false, status: match.status, response, matchRule: match.rule, candidates: match.candidates });
        }
    }
    return { ok: true, dryRun: Boolean(input.dryRun), type: 'post_participation', results };
}
export async function syncBankAccountFormResponses(input = {}) {
    const source = responseSheetSource('bankAccount');
    if (!source && !input.rows)
        return { ok: true, status: 'disabled', results: [] };
    const rows = input.rows ?? await readSheetRows(source);
    const responses = rows.map((row) => normalizeBankAccountResponse(row));
    const students = await studentPoolForFormMatching();
    const results = [];
    for (const response of responses) {
        const match = matchBankAccountResponse(response, students);
        if (match.status === 'matched') {
            const update = await markBankAccountAnswered(match.match, response, match.rule, input.dryRun);
            results.push({ ok: true, status: 'matched', response, matchRule: match.rule, student: match.match, update });
        }
        else {
            results.push({ ok: false, status: match.status, response, matchRule: match.rule, candidates: match.candidates });
        }
    }
    return { ok: true, dryRun: Boolean(input.dryRun), type: 'bank_account', results };
}
export async function syncFormResponseSheets(input = {}) {
    const [postParticipation, bankAccount] = await Promise.all([
        syncPostParticipationFormResponses({ rows: input.postRows, dryRun: input.dryRun }),
        syncBankAccountFormResponses({ rows: input.bankRows, dryRun: input.dryRun }),
    ]);
    return { ok: true, dryRun: Boolean(input.dryRun), postParticipation, bankAccount };
}
