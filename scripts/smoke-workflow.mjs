process.env.PORT ||= '8798';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'smoke-test-key';
process.env.SLACK_BOT_TOKEN ||= 'xoxb-smoke-test';
process.env.SLACK_SIGNING_SECRET ||= 'smoke-test-secret';
process.env.SLACK_APPROVAL_CHANNEL_ID ||= 'C0123456789';
process.env.LINE_CHANNEL_ACCESS_TOKEN ||= 'smoke-test-line-token';
process.env.LINE_SEND_DRY_RUN ||= 'true';
process.env.SHEETS_WRITE_DRY_RUN ||= 'true';
process.env.POST_PARTICIPATION_FORM_URL ||= 'https://example.com/post-form';
process.env.BANK_ACCOUNT_FORM_URL ||= 'https://example.com/bank-form';
process.env.WORKFLOW_TIMEZONE ||= 'Asia/Tokyo';
process.env.SAME_DAY_REMINDER_OFFSET_HOURS ||= '2';
process.env.POST_FORM_DELAY_HOURS ||= '2';

const sheets = await import('../dist/sheets.js');
const workflow = await import('../dist/workflow.js');

const row = sheets.normalizeSheetRowForSmoke({
  application_id: 'app-001',
  student_id: 'student-001',
  LINEユーザーID: 'Utest001',
  学生名: 'テスト学生',
  提携エージェント名: 'Vire',
  参加予定日時: '2026-05-20 18:00',
  現在ステータス: 'interested',
  自動送信対象: 'TRUE',
  人間対応フラグ: 'FALSE',
});

if (row.applicationId !== 'app-001') throw new Error('application_id mapping failed');
if (row.lineUserId !== 'Utest001') throw new Error('LINE user id mapping failed');
if (row.participationScheduledAt !== '2026-05-20T09:00:00.000Z') throw new Error(`Asia/Tokyo date parsing failed: ${row.participationScheduledAt}`);
if (row.autoSendEnabled !== true) throw new Error('auto-send boolean mapping failed');
if (row.humanRequired !== false) throw new Error('human flag boolean mapping failed');

const scheduledAt = '2026-05-20T09:00:00.000Z';
const jobs = workflow.planWorkflowJobsForSmoke(scheduledAt, row.applicationId);
if (jobs.length !== 2) throw new Error('workflow job planning should create two jobs');
if (jobs[0].jobType !== 'same_day_participation_reminder') throw new Error('missing same-day reminder job');
if (jobs[1].jobType !== 'post_participation_form') throw new Error('missing post-participation form job');
if (jobs[0].dueAt !== '2026-05-20T07:00:00.000Z') throw new Error(`same-day dueAt mismatch: ${jobs[0].dueAt}`);
if (jobs[1].dueAt !== '2026-05-20T11:00:00.000Z') throw new Error(`post-form dueAt mismatch: ${jobs[1].dueAt}`);

const confirmation = workflow.classifyWorkflowReply('確認しました');
if (confirmation.intent !== 'confirmation' || confirmation.risk !== 'low') throw new Error('confirmation classification failed');

const answered = workflow.classifyWorkflowReply('回答しました');
if (answered.intent !== 'form_answered' || answered.risk !== 'low') throw new Error('form answered classification failed');

const human = workflow.classifyWorkflowReply('支払いはいつですか？');
if (human.intent !== 'human_required') throw new Error('human-required classification failed');

const rendered = workflow.renderWorkflowTemplate(workflow.WORKFLOW_TEMPLATE_BODIES.same_day_participation_reminder, {
  agent_name: 'Vire',
  participation_time: '18:00',
});
if (!rendered.includes('Vire') || !rendered.includes('18:00')) throw new Error('template rendering failed');

console.log('Workflow smoke passed');
