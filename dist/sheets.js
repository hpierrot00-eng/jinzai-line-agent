import crypto from 'node:crypto';
import { config } from './config.js';
import { supabase, upsertStudent } from './db.js';
export const DEFAULT_SHEETS_COLUMN_MAP = {
    applicationId: 'application_id',
    externalStudentId: 'student_id',
    lineUserId: 'LINEユーザーID',
    studentName: '学生名',
    agentName: '提携エージェント名',
    participationScheduledAt: '参加予定日時',
    currentStatus: '現在ステータス',
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
function nowIso() {
    return new Date().toISOString();
}
export function sheetsColumnMap() {
    if (!config.SHEETS_COLUMN_MAP_JSON)
        return { ...DEFAULT_SHEETS_COLUMN_MAP };
    const parsed = JSON.parse(config.SHEETS_COLUMN_MAP_JSON);
    return { ...DEFAULT_SHEETS_COLUMN_MAP, ...parsed };
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
    return raw || 'interested';
}
function rowsFromValues(values) {
    const [headerRow, ...bodyRows] = values;
    if (!headerRow)
        return [];
    const headers = headerRow.map((header) => String(header ?? '').trim());
    return bodyRows.map((row, index) => {
        const object = { __rowNumber: index + 2 };
        headers.forEach((header, columnIndex) => {
            if (header)
                object[header] = row[columnIndex] ?? '';
        });
        return object;
    });
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
async function googleSheetsFetch(path, init) {
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
    if (!res.ok)
        throw new Error(`Google Sheets API failed: ${res.status} ${await res.text()}`);
    return res.json();
}
async function readSheetRows() {
    const range = `${encodeURIComponent(config.GOOGLE_SHEETS_TAB_NAME)}!A1:ZZ`;
    const json = await googleSheetsFetch(`/values/${range}?majorDimension=ROWS`);
    return rowsFromValues(json.values ?? []);
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
async function headerIndexes(map) {
    const range = `${encodeURIComponent(config.GOOGLE_SHEETS_TAB_NAME)}!A1:ZZ1`;
    const json = await googleSheetsFetch(`/values/${range}?majorDimension=ROWS`);
    const headers = (json.values?.[0] ?? []).map((header) => String(header ?? '').trim());
    const indexes = new Map();
    Object.values(map).forEach((header) => {
        const index = headers.indexOf(header);
        if (index >= 0)
            indexes.set(header, index);
    });
    return indexes;
}
function normalizeRow(row, map) {
    return {
        rowNumber: row.__rowNumber,
        applicationId: textValue(row, map, 'applicationId'),
        externalStudentId: textValue(row, map, 'externalStudentId'),
        lineUserId: textValue(row, map, 'lineUserId'),
        studentName: textValue(row, map, 'studentName'),
        agentName: textValue(row, map, 'agentName'),
        participationScheduledAt: parseDateTime(textValue(row, map, 'participationScheduledAt')),
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
export async function syncSheetsToSupabase(input = {}) {
    const map = sheetsColumnMap();
    const sourceRows = input.rows ?? await readSheetRows();
    const normalized = sourceRows.map((row) => normalizeRow(row, map));
    const results = [];
    for (const row of normalized) {
        if (!row.applicationId) {
            results.push({ ok: false, skipped: true, rowNumber: row.rowNumber, error: 'Missing application_id' });
            continue;
        }
        if (!row.lineUserId) {
            results.push({ ok: false, skipped: true, applicationId: row.applicationId, rowNumber: row.rowNumber, error: 'Missing LINE user id' });
            continue;
        }
        if (input.dryRun) {
            results.push({ ok: true, dryRun: true, applicationId: row.applicationId, rowNumber: row.rowNumber });
            continue;
        }
        const inbound = {
            lineUserId: row.lineUserId,
            displayName: row.studentName ?? undefined,
            text: '',
            rawPayload: { source: 'sheets_sync', applicationId: row.applicationId },
            messageType: 'sync',
        };
        const student = await upsertStudent(inbound);
        if (row.externalStudentId) {
            const { error } = await supabase.from('students').update({
                external_student_id: row.externalStudentId,
                updated_at: nowIso(),
            }).eq('id', student.id);
            if (error)
                throw error;
        }
        const { data: application, error } = await supabase.from('referral_applications').upsert({
            client_id: config.DEFAULT_CLIENT_ID,
            application_id: row.applicationId,
            student_id: student.id,
            external_student_id: row.externalStudentId,
            line_user_id: row.lineUserId,
            student_name: row.studentName,
            agent_name: row.agentName,
            participation_scheduled_at: row.participationScheduledAt,
            current_status: row.currentStatus,
            auto_send_enabled: row.autoSendEnabled,
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
        results.push({ ok: true, applicationId: row.applicationId, applicationRefId: application.id, studentId: student.id, rowNumber: row.rowNumber });
    }
    return { ok: true, dryRun: Boolean(input.dryRun), rows: results.length, results };
}
function applicationToSheetValues(application, map) {
    const student = application.students ?? {};
    return {
        [map.externalStudentId]: application.external_student_id ?? student.external_student_id ?? '',
        [map.lineUserId]: application.line_user_id ?? student.line_user_id ?? '',
        [map.studentName]: application.student_name ?? student.display_name ?? '',
        [map.agentName]: application.agent_name ?? '',
        [map.participationScheduledAt]: application.participation_scheduled_at ?? '',
        [map.currentStatus]: application.current_status ?? '',
        [map.autoSendEnabled]: application.auto_send_enabled ? 'TRUE' : 'FALSE',
        [map.humanRequired]: application.human_required ? 'TRUE' : 'FALSE',
        [map.sameDayReminderSentAt]: application.same_day_reminder_sent_at ?? '',
        [map.postParticipationFormSentAt]: application.post_participation_form_sent_at ?? '',
        [map.postParticipationFormAnsweredAt]: application.post_participation_form_answered_at ?? '',
        [map.bankFormSentAt]: application.bank_form_sent_at ?? student.bank_form_sent_at ?? '',
        [map.bankFormAnsweredAt]: application.bank_form_answered_at ?? student.bank_form_answered_at ?? '',
        [map.lastLineSentAt]: application.last_line_sent_at ?? '',
        [map.slackNotifiedAt]: application.slack_notified_at ?? '',
        [map.errorMessage]: application.error_message ?? '',
        [map.notes]: application.notes ?? '',
    };
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
    if (input.dryRun || config.SHEETS_WRITE_DRY_RUN || !config.GOOGLE_SHEETS_SPREADSHEET_ID) {
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
    });
    return { ok: true, dryRun: false, updatedCells: json.totalUpdatedCells ?? 0, updatedRanges: dataUpdates.length };
}
