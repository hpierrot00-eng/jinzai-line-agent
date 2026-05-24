process.env.PORT ||= '8798';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'smoke-test-key';
process.env.SLACK_BOT_TOKEN ||= 'xoxb-smoke-test';
process.env.SLACK_SIGNING_SECRET ||= 'smoke-test-secret';
process.env.SLACK_APPROVAL_CHANNEL_ID ||= 'C0123456789';
process.env.LINE_CHANNEL_ACCESS_TOKEN ||= 'smoke-test-line-token';
process.env.LINE_SEND_DRY_RUN ||= 'true';
process.env.SHEETS_DRY_RUN ||= 'true';
process.env.SHEETS_WRITE_DRY_RUN ||= 'true';
process.env.POST_PARTICIPATION_FORM_URL ||= 'https://example.com/post-form';
process.env.BANK_ACCOUNT_FORM_URL ||= 'https://example.com/bank-form';
process.env.WORKFLOW_TIMEZONE ||= 'Asia/Tokyo';
process.env.SAME_DAY_REMINDER_OFFSET_HOURS ||= '2';
process.env.POST_FORM_DELAY_HOURS ||= '2';

const sheets = await import('../dist/sheets.js');
const workflow = await import('../dist/workflow.js');
const line = await import('../dist/line.js');
const ai = await import('../dist/ai.js');
const db = await import('../dist/db.js');

const row = sheets.normalizeSheetRowForSmoke({
  顧客ID: 'app-001',
  LINEユーザーID: 'Utest001',
  名前: 'テスト学生',
  フリガナ: 'テストガクセイ',
  LINE名: 'テスト学生',
  大学名: 'テスト大学',
  卒業予定年度: '2027',
  案件名称: 'Vire',
  予約日: '2026-05-20',
  予約時間: '18:00',
  進捗状況: 'interested',
});

if (row.applicationId !== 'app-001') throw new Error('application_id mapping failed');
if (row.lineUserId !== 'Utest001') throw new Error('LINE user id mapping failed');
if (row.participationScheduledAt !== '2026-05-20T09:00:00.000Z') throw new Error(`Asia/Tokyo date parsing failed: ${row.participationScheduledAt}`);
if (row.autoSendEnabled !== true) throw new Error('auto-send boolean mapping failed');
if (row.humanRequired !== false) throw new Error('human flag boolean mapping failed');

const headerOffsetRows = sheets.rowsFromSheetValuesForSmoke([
  ['顧客ID ', 'Line ユーザーID', '進捗状況', '名前', '（フリガナ）', 'LINE名', '予約日', '予約時間', '案件名称'],
  ['A001', 'Uoffset001', 'interested', '小間響', 'コマヒビキ', 'ひびきん', '2026/05/20', '18:00', 'Vire'],
], 3);
const offsetRow = sheets.normalizeSheetRowForSmoke(headerOffsetRows[0]);
if (headerOffsetRows[0].__rowNumber !== 4) throw new Error(`header-row offset should preserve sheet row number: ${headerOffsetRows[0].__rowNumber}`);
if (offsetRow.applicationId !== 'A001') throw new Error('header-row offset application id mapping failed');
if (offsetRow.lineUserId !== 'Uoffset001') throw new Error('Line user id alias mapping failed');
if (offsetRow.studentFurigana !== 'コマヒビキ') throw new Error('furigana alias mapping failed');

const scheduledAt = '2026-05-20T09:00:00.000Z';
const jobs = workflow.planWorkflowJobsForSmoke(scheduledAt, row.applicationId);
if (jobs.length !== 3) throw new Error('workflow job planning should create three jobs');
if (jobs[0].jobType !== 'pre_participation_caution') throw new Error('missing pre-participation caution job');
if (jobs[1].jobType !== 'same_day_participation_reminder') throw new Error('missing same-day reminder job');
if (jobs[2].jobType !== 'post_participation_form') throw new Error('missing post-participation form job');
if (jobs[1].dueAt !== '2026-05-20T07:00:00.000Z') throw new Error(`same-day dueAt mismatch: ${jobs[1].dueAt}`);
if (jobs[2].dueAt !== '2026-05-20T11:00:00.000Z') throw new Error(`post-form dueAt mismatch: ${jobs[2].dueAt}`);

const confirmation = workflow.classifyWorkflowReply('確認できました');
if (confirmation.intent !== 'confirmation' || confirmation.risk !== 'low') throw new Error('confirmation classification failed');

const answered = workflow.classifyWorkflowReply('回答しました');
if (answered.intent !== 'form_answered' || answered.risk !== 'low') throw new Error('form answered classification failed');

const human = workflow.classifyWorkflowReply('支払いはいつですか？');
if (human.intent !== 'human_required') throw new Error('human-required classification failed');

const rendered = workflow.renderWorkflowTemplate(workflow.WORKFLOW_TEMPLATE_BODIES.same_day_reminder, {
  agent_name: 'Vire',
  participation_time: '18:00',
});
if (!rendered.includes('参加当日')) throw new Error('template rendering failed');

const approvalBlocks = workflow.workflowApprovalBlocksForSmoke({
  lineDisplayName: 'LINE山田',
  lineUserId: 'Usmoke001',
  studentName: '山田太郎',
  text: '参加前注意事項本文',
});
const approvalBlockText = JSON.stringify(approvalBlocks);
if (!approvalBlockText.includes('誰に送る？')) throw new Error('approval card should lead with recipient');
if (!approvalBlockText.includes('LINE山田') || !approvalBlockText.includes('Usmoke001') || !approvalBlockText.includes('山田太郎')) throw new Error('approval card should show LINE recipient details');
if (approvalBlockText.includes('対象申込') || approvalBlockText.includes('申込ID') || approvalBlockText.includes('案件:')) throw new Error('approval card should not lead with application details');

const nameCandidates = sheets.extractStudentNameCandidates('山田太郎です。確認しました', '山田太郎');
if (!nameCandidates.includes('山田太郎')) throw new Error('student name extraction failed');

const identity = await sheets.findLineIdentityCandidates({
  event: { lineUserId: 'Unew001', displayName: '山田太郎', text: '山田太郎です。確認しました', markAsReadToken: 'read-token-001' },
  rows: [
    { __rowNumber: 2, 顧客ID: 'app-a', 名前: '山田太郎', フリガナ: 'ヤマダタロウ', LINE名: '山田太郎' },
    { __rowNumber: 3, 顧客ID: 'app-b', 名前: '山田太郎', フリガナ: 'ヤマダタロウ', LINE名: '山田太郎' },
    { __rowNumber: 4, 顧客ID: 'app-c', 名前: '佐藤花子', フリガナ: 'サトウハナコ', LINE名: 'hanako' },
  ],
});
if (identity.status !== 'unique') throw new Error(`identity match should be unique: ${identity.status}`);
if (identity.candidates[0].applicationIds.length !== 2) throw new Error('identity match should include all same-student application rows');

const nativeLineEvents = line.extractLineEvents({
  events: [{
    type: 'message',
    source: { userId: 'Uread001' },
    message: { type: 'text', text: '確認できました', markAsReadToken: 'read-token-002' },
  }],
});
if (nativeLineEvents[0]?.markAsReadToken !== 'read-token-002') throw new Error('native LINE markAsReadToken extraction failed');

const normalizedLineEvents = line.extractLineEvents({
  lineUserId: 'Uread002',
  text: '回答しました',
  rawPayload: { message: { markAsReadToken: 'read-token-003' } },
});
if (normalizedLineEvents[0]?.markAsReadToken !== 'read-token-003') throw new Error('normalized markAsReadToken extraction failed');

const markReadDryRun = await line.markLineMessageAsRead('read-token-004');
if (!markReadDryRun.dryRun) throw new Error('mark-as-read should respect LINE_SEND_DRY_RUN in smoke');

const postResponseMatch = sheets.matchPostParticipationResponseForSmoke(
  { 名前: '山田太郎', フリガナ: 'ヤマダタロウ', 案件名称: 'Vire', 参加日: '2026-05-20' },
  [
    { id: 'app-a', application_id: 'app-a', student_name: '山田太郎', student_furigana: 'ヤマダタロウ', agent_name: 'Vire', participation_scheduled_at: '2026-05-20T09:00:00.000Z' },
    { id: 'app-b', application_id: 'app-b', student_name: '山田太郎', student_furigana: 'ヤマダタロウ', agent_name: 'Other', participation_scheduled_at: '2026-05-20T09:00:00.000Z' },
  ],
);
if (postResponseMatch.status !== 'matched' || postResponseMatch.match.application_id !== 'app-a') throw new Error('post-participation response matching failed');

const bankResponseMatch = sheets.matchBankAccountResponseForSmoke(
  { 名前: '山田太郎', フリガナ: 'ヤマダタロウ', 大学名: 'テスト大学' },
  [
    { id: 'student-a', name: '山田太郎', furigana: 'ヤマダタロウ', school_name: 'テスト大学' },
    { id: 'student-b', name: '山田太郎', furigana: 'ヤマダジロウ', school_name: '別大学' },
  ],
);
if (bankResponseMatch.status !== 'matched' || bankResponseMatch.match.id !== 'student-a') throw new Error('bank-account response matching failed');

if (sheets.formResponsePassesStartDateForSmoke('2026/05/23 23:59:59', '2026-05-24')) {
  throw new Error('form response start date should skip older rows');
}
if (!sheets.formResponsePassesStartDateForSmoke('2026/05/24 00:00:00', '2026-05-24')) {
  throw new Error('form response start date should include rows on the start date');
}

const knowledgeTerms = ai.knowledgeSearchTerms('支払いはいつですか？2回目参加は必要ですか？');
if (!knowledgeTerms.includes('支払い') || !knowledgeTerms.includes('2回目')) throw new Error('knowledge search term extraction failed');

const knowledgeBody = db.buildKnowledgeBody({
  incomingText: 'U123456789012345678901234567890 090-1234-5678 支払いはいつですか？',
  replyText: '入金予定を確認します。',
});
if (knowledgeBody.includes('090-1234-5678') || knowledgeBody.includes('U123456789012345678901234567890')) {
  throw new Error('knowledge body should mask sensitive identifiers');
}
if (!knowledgeBody.includes('問い合わせ:') || !knowledgeBody.includes('返信例:')) throw new Error('knowledge body format failed');

console.log('Workflow smoke passed');
