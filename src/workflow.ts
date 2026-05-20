import { config } from './config.js';
import { sendLineMessage, syncLineHarnessTags } from './line.js';
import { supabase } from './db.js';
import { writeApplicationsToSheets } from './sheets.js';
import type { InboundLineMessage } from './types.js';

export const WORKFLOW_STATUSES = [
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
] as const;

export type WorkflowStatus = typeof WORKFLOW_STATUSES[number];
export type WorkflowIntent = 'confirmation' | 'form_answered' | 'human_required';

export const WORKFLOW_TEMPLATE_BODIES: Record<string, string> = {
  confirmation_ack: 'ご確認ありがとうございます。当日はよろしくお願いいたします。',
  form_answered_ack: 'ご回答ありがとうございます。内容を確認いたします。',
  pre_participation_caution: 'ご参加前の注意事項をお送りします。\n\n{{caution_text}}\n\n確認できましたら「確認しました」とご返信ください。',
  same_day_participation_reminder: '本日、{{agent_name}}のご参加予定日です。開始時間は{{participation_time}}です。忘れずにご参加ください。',
  post_participation_form: 'ご参加ありがとうございました。参加確認のため、以下のフォームにご回答をお願いいたします。\n{{post_participation_form_url}}',
  bank_account_form: 'ご回答ありがとうございます。謝礼金のお支払いに必要な情報入力をお願いいたします。\n{{bank_account_form_url}}',
};

const STATUS_TO_TAG: Record<string, string> = {
  interested: '興味あり',
  schedule_pending: '日程確定待ち',
  application_info_collecting: '申込情報回収中',
  pre_caution_sent: '参加前注意事項送信済み',
  pre_caution_confirmation_waiting: '参加前確認待ち',
  pre_caution_confirmed: '参加前確認済み',
  same_day_reminder_pending: '当日リマインド待ち',
  same_day_reminder_sent: '当日リマインド済み',
  post_participation_form_waiting: '参加後フォーム待ち',
  bank_form_send_pending: '口座フォーム送信待ち',
  bank_account_waiting: '口座フォーム待ち',
  payment_ready: '支払い準備完了',
  human_required: '要人間対応',
};

type ReferralApplication = {
  id: string;
  application_id: string;
  student_id: string;
  line_user_id?: string | null;
  student_name?: string | null;
  agent_name?: string | null;
  participation_scheduled_at?: string | null;
  current_status: WorkflowStatus;
  auto_send_enabled: boolean;
  human_required: boolean;
  post_participation_form_sent_at?: string | null;
  post_participation_form_answered_at?: string | null;
  bank_form_sent_at?: string | null;
  bank_form_answered_at?: string | null;
  students?: {
    id: string;
    line_user_id?: string | null;
    display_name?: string | null;
    bank_form_sent_at?: string | null;
    bank_form_answered_at?: string | null;
  } | null;
};

type WorkflowJob = {
  id: string;
  application_id: string;
  student_id: string;
  job_type: string;
  template_key: string;
  due_at: string;
  attempts?: number | null;
  metadata: Record<string, unknown> | null;
  referral_applications?: ReferralApplication | null;
};

function nowIso() {
  return new Date().toISOString();
}

function addHours(dateIso: string, hours: number) {
  const date = new Date(dateIso);
  return new Date(date.getTime() + hours * 60 * 60 * 1000).toISOString();
}

function formatParticipationTime(dateIso?: string | null) {
  if (!dateIso) return '';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: config.WORKFLOW_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(dateIso));
}

export function renderWorkflowTemplate(body: string, values: Record<string, unknown>) {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    const value = values[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

export function classifyWorkflowReply(text: string): { intent: WorkflowIntent; risk: 'low' | 'high'; reason: string } {
  const normalized = text.replace(/\s+/g, '').toLowerCase();
  if (/回答しました|回答済|入力しました|入力済|送信しました|提出しました|フォーム.*(回答|入力|送信|提出)/.test(normalized)) {
    return { intent: 'form_answered', risk: 'low', reason: 'フォーム回答完了を示す定型返信。' };
  }
  if (/確認しました|確認済|確認いたしました|了解です|承知しました|見ました|大丈夫です/.test(normalized)) {
    return { intent: 'confirmation', risk: 'low', reason: '参加前注意事項などの確認完了を示す定型返信。' };
  }
  if (/支払|支払い|報酬|給与|謝礼|入金|返金|キャンセル|辞退|変更|日程変更|リスケ|遅刻|欠席|クレーム|苦情|無理|できない|わからない|分からない|\?|\？/.test(normalized)) {
    return { intent: 'human_required', risk: 'high', reason: '支払い・キャンセル・日程変更・苦情・判断不能の可能性がある返信。' };
  }
  return { intent: 'human_required', risk: 'high', reason: '自動処理対象の定型返信として確信できない返信。' };
}

async function getTemplateBody(key: string) {
  const { data, error } = await supabase
    .from('message_templates')
    .select('body')
    .eq('client_id', config.DEFAULT_CLIENT_ID)
    .eq('key', key)
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw error;
  return data?.body ?? WORKFLOW_TEMPLATE_BODIES[key];
}

function templateValues(application: ReferralApplication) {
  return {
    agent_name: application.agent_name ?? '',
    participation_time: formatParticipationTime(application.participation_scheduled_at),
    post_participation_form_url: config.POST_PARTICIPATION_FORM_URL,
    bank_account_form_url: config.BANK_ACCOUNT_FORM_URL,
    application_id: application.application_id,
  };
}

async function setApplicationStatus(application: ReferralApplication, status: WorkflowStatus, patch: Record<string, unknown> = {}) {
  const updated = { current_status: status, human_required: status === 'human_required' ? true : application.human_required, ...patch, updated_at: nowIso() };
  const { error } = await supabase.from('referral_applications').update(updated).eq('id', application.id);
  if (error) throw error;
  const { error: stateError } = await supabase.from('application_workflow_states').upsert({
    client_id: config.DEFAULT_CLIENT_ID,
    application_ref_id: application.id,
    status,
    metadata: { updated_by: 'workflow' },
    updated_at: nowIso(),
  }, { onConflict: 'client_id,application_ref_id' });
  if (stateError) throw stateError;
  if (application.line_user_id) await syncLineHarnessTags(application.line_user_id, [STATUS_TO_TAG[status] ?? status]);
}

async function insertDeliveryAttempt(input: {
  applicationId?: string;
  lineUserId: string;
  text: string;
  status: 'success' | 'failed' | 'dry_run';
  errorMessage?: string;
  action: string;
  providerResponse?: unknown;
}) {
  const payload: Record<string, unknown> = {
    client_id: config.DEFAULT_CLIENT_ID,
    application_id: input.applicationId,
    reply_draft_id: null,
    line_user_id: input.lineUserId,
    channel: 'line',
    status: input.status,
    error_message: input.errorMessage ?? null,
    provider_response: input.providerResponse ?? {},
    action: input.action,
    message_text: input.text,
  };
  const { error } = await supabase.from('delivery_attempts').insert(payload);
  if (!error) return;
  if (/delivery_attempts|relation .* does not exist/i.test(error.message ?? '')) return;
  if (/application_id|schema cache/i.test(error.message ?? '')) {
    delete payload.application_id;
    const retry = await supabase.from('delivery_attempts').insert(payload);
    if (!retry.error || /delivery_attempts|relation .* does not exist/i.test(retry.error.message ?? '')) return;
    throw retry.error;
  }
  throw error;
}

async function recordOutgoing(application: ReferralApplication, text: string, action: string) {
  const { data: conversation } = await supabase
    .from('conversations')
    .select('id')
    .eq('client_id', config.DEFAULT_CLIENT_ID)
    .eq('student_id', application.student_id)
    .order('last_message_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const { error } = await supabase.from('messages').insert({
    client_id: config.DEFAULT_CLIENT_ID,
    conversation_id: conversation?.id ?? null,
    student_id: application.student_id,
    direction: 'outgoing',
    channel: 'line',
    sender_type: 'automation',
    sender_id: 'workflow',
    content: text,
    message_type: 'text',
    raw_payload: { applicationId: application.application_id, applicationRefId: application.id, action },
  });
  if (error) throw error;
}

async function sendWorkflowMessage(application: ReferralApplication, text: string, action: string, dryRun: boolean) {
  if (!application.line_user_id) throw new Error(`Missing LINE user id for application ${application.application_id}`);
  if (dryRun) {
    await insertDeliveryAttempt({ applicationId: application.id, lineUserId: application.line_user_id, text, status: 'dry_run', action });
    return { dryRun: true };
  }
  try {
    const providerResponse = await sendLineMessage(application.line_user_id, text);
    await insertDeliveryAttempt({ applicationId: application.id, lineUserId: application.line_user_id, text, status: 'success', action, providerResponse });
    await recordOutgoing(application, text, action);
    return { dryRun: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await insertDeliveryAttempt({ applicationId: application.id, lineUserId: application.line_user_id, text, status: 'failed', errorMessage: message, action });
    await setApplicationStatus(application, 'human_required', { error_message: message });
    throw err;
  }
}

async function getRegistrationState(studentId: string) {
  const { data, error } = await supabase
    .from('student_registration_states')
    .select('*')
    .eq('client_id', config.DEFAULT_CLIENT_ID)
    .eq('student_id', studentId)
    .maybeSingle();
  if (!error) return data;
  if (/student_registration_states|relation .* does not exist/i.test(error.message ?? '')) return null;
  throw error;
}

async function upsertRegistrationState(studentId: string, patch: Record<string, unknown>) {
  const payload = {
    client_id: config.DEFAULT_CLIENT_ID,
    student_id: studentId,
    ...patch,
    updated_at: nowIso(),
  };
  const { error } = await supabase
    .from('student_registration_states')
    .upsert(payload, { onConflict: 'client_id,student_id' });
  if (!error) return;
  if (/student_registration_states|relation .* does not exist/i.test(error.message ?? '')) return;
  throw error;
}

async function candidateApplications(studentId: string, intent: WorkflowIntent) {
  let query = supabase
    .from('referral_applications')
    .select('*, students(id,line_user_id,display_name,bank_form_sent_at,bank_form_answered_at)')
    .eq('client_id', config.DEFAULT_CLIENT_ID)
    .eq('student_id', studentId)
    .eq('auto_send_enabled', true)
    .eq('human_required', false)
    .order('updated_at', { ascending: false })
    .limit(10);

  if (intent === 'confirmation') {
    query = query.in('current_status', ['pre_caution_sent', 'pre_caution_confirmation_waiting']);
  }
  if (intent === 'form_answered') {
    query = query
      .in('current_status', ['post_participation_form_waiting', 'bank_form_send_pending', 'bank_account_waiting', 'payment_ready']);
  }

  const { data, error } = await query;
  if (error) throw error;
  const applications = (data ?? []) as ReferralApplication[];
  if (intent !== 'form_answered') return applications;

  const participationFormCandidates = applications.filter((application) => (
    application.post_participation_form_sent_at && !application.post_participation_form_answered_at
  ));
  if (participationFormCandidates.length > 0) return participationFormCandidates;

  return applications.filter((application) => (
    (application.bank_form_sent_at || application.students?.bank_form_sent_at)
    && !application.bank_form_answered_at
    && !application.students?.bank_form_answered_at
  ));
}

export async function rebuildWorkflowJobs(input: { applicationIds?: string[]; dryRun?: boolean } = {}) {
  let query = supabase
    .from('referral_applications')
    .select('*')
    .eq('client_id', config.DEFAULT_CLIENT_ID)
    .eq('auto_send_enabled', true)
    .eq('human_required', false)
    .not('participation_scheduled_at', 'is', null)
    .order('participation_scheduled_at', { ascending: true })
    .limit(1000);
  if (input.applicationIds?.length) query = query.in('id', input.applicationIds);
  const { data, error } = await query;
  if (error) throw error;

  const jobs = [];
  const missingLineUser = [];
  const now = new Date();
  for (const application of (data ?? []) as ReferralApplication[]) {
    if (!application.line_user_id) {
      missingLineUser.push({ applicationId: application.application_id, applicationRefId: application.id, studentId: application.student_id });
      continue;
    }
    const reminderDueAt = addHours(application.participation_scheduled_at!, -config.SAME_DAY_REMINDER_OFFSET_HOURS);
    const postFormDueAt = addHours(application.participation_scheduled_at!, config.POST_FORM_DELAY_HOURS);
    if (new Date(application.participation_scheduled_at!) > now && !['pre_caution_sent', 'pre_caution_confirmation_waiting', 'pre_caution_confirmed', 'same_day_reminder_sent', 'post_participation_form_waiting', 'payment_ready'].includes(application.current_status)) {
      jobs.push({
        application_id: application.id,
        student_id: application.student_id,
        job_type: 'pre_participation_caution',
        template_key: 'pre_participation_caution',
        due_at: nowIso(),
        idempotency_key: `${application.id}:pre_participation_caution`,
        metadata: templateValues(application),
      });
    }
    if (new Date(reminderDueAt) > now) {
      jobs.push({
        application_id: application.id,
        student_id: application.student_id,
        job_type: 'same_day_participation_reminder',
        template_key: 'same_day_participation_reminder',
        due_at: reminderDueAt,
        idempotency_key: `${application.id}:same_day_participation_reminder`,
        metadata: templateValues(application),
      });
    }
    if (new Date(postFormDueAt) > now) {
      jobs.push({
        application_id: application.id,
        student_id: application.student_id,
        job_type: 'post_participation_form',
        template_key: 'post_participation_form',
        due_at: postFormDueAt,
        idempotency_key: `${application.id}:post_participation_form`,
        metadata: templateValues(application),
      });
    }
  }

  if (!input.dryRun && jobs.length > 0) {
    const { error: upsertError } = await supabase.from('workflow_jobs').upsert(jobs.map((job) => ({
      client_id: config.DEFAULT_CLIENT_ID,
      ...job,
      status: 'scheduled',
      updated_at: nowIso(),
    })), { onConflict: 'client_id,idempotency_key' });
    if (upsertError) throw upsertError;
  }

  return { ok: true, dryRun: Boolean(input.dryRun), applications: data?.length ?? 0, missingLineUser, jobs };
}

async function dueJobs(limit: number) {
  const { data, error } = await supabase
    .from('workflow_jobs')
    .select('*, referral_applications(*, students(id,line_user_id,display_name,bank_form_sent_at,bank_form_answered_at))')
    .eq('client_id', config.DEFAULT_CLIENT_ID)
    .eq('status', 'scheduled')
    .lte('due_at', nowIso())
    .order('due_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as WorkflowJob[];
}

async function markJob(jobId: string, patch: Record<string, unknown>) {
  const { error } = await supabase.from('workflow_jobs').update({ ...patch, updated_at: nowIso() }).eq('id', jobId);
  if (error) throw error;
}

function statusPatchForJob(job: WorkflowJob) {
  const sentAt = nowIso();
  if (job.job_type === 'pre_participation_caution') {
    return { status: 'pre_caution_confirmation_waiting' as WorkflowStatus, patch: { last_line_sent_at: sentAt } };
  }
  if (job.job_type === 'same_day_participation_reminder') {
    return { status: 'same_day_reminder_sent' as WorkflowStatus, patch: { same_day_reminder_sent_at: sentAt, last_line_sent_at: sentAt } };
  }
  if (job.job_type === 'post_participation_form') {
    return { status: 'post_participation_form_waiting' as WorkflowStatus, patch: { post_participation_form_sent_at: sentAt, last_line_sent_at: sentAt } };
  }
  if (job.job_type === 'bank_account_form') {
    return { status: 'bank_account_waiting' as WorkflowStatus, patch: { bank_form_sent_at: sentAt, last_line_sent_at: sentAt } };
  }
  return { status: null, patch: { last_line_sent_at: sentAt } };
}

export async function runWorkflowTick(input: { limit?: number; dryRun?: boolean } = {}) {
  const jobs = await dueJobs(input.limit ?? 20);
  const dryRun = input.dryRun ?? config.LINE_SEND_DRY_RUN;
  const results = [];

  for (const job of jobs) {
    const application = job.referral_applications;
    if (!application?.line_user_id) {
      if (!dryRun) await markJob(job.id, { status: 'failed', error_message: 'Missing application or LINE user id' });
      results.push({ id: job.id, ok: false, dryRun, error: 'Missing application or LINE user id' });
      continue;
    }

    const values = { ...templateValues(application), ...(job.metadata ?? {}) };
    const template = await getTemplateBody(job.template_key);
    const text = renderWorkflowTemplate(template, values);
    if (dryRun) {
      results.push({ id: job.id, ok: true, dryRun: true, applicationId: application.application_id, jobType: job.job_type, text });
      continue;
    }

    await markJob(job.id, { status: 'processing', locked_at: nowIso(), attempts: Number(job.attempts ?? 0) + 1 });
    try {
      await sendWorkflowMessage(application, text, job.job_type, false);
      const { status, patch } = statusPatchForJob(job);
      if (status) await setApplicationStatus(application, status, patch);
      await markJob(job.id, { status: 'sent', sent_at: nowIso(), error_message: null });
      await writeApplicationsToSheets({ applicationIds: [application.id], dryRun: config.SHEETS_WRITE_DRY_RUN });
      results.push({ id: job.id, ok: true, dryRun: false, applicationId: application.application_id, jobType: job.job_type });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markJob(job.id, { status: 'failed', error_message: message });
      results.push({ id: job.id, ok: false, dryRun: false, applicationId: application.application_id, error: message });
    }
  }

  return { ok: true, dryRun, processed: results.length, results };
}

async function maybeSendBankForm(application: ReferralApplication, dryRun: boolean) {
  const student = application.students;
  const registration = await getRegistrationState(application.student_id);
  if (registration?.bank_form_answered_at || student?.bank_form_answered_at) return { alreadyAnswered: true as const };
  if (registration?.bank_form_sent_at || student?.bank_form_sent_at) return { alreadySent: true as const };
  const text = renderWorkflowTemplate(await getTemplateBody('bank_account_form'), templateValues(application));
  await sendWorkflowMessage(application, text, 'bank_account_form', dryRun);
  if (!dryRun) {
    const sentAt = nowIso();
    await supabase.from('students').update({ bank_form_sent_at: sentAt, updated_at: sentAt }).eq('id', application.student_id);
    await upsertRegistrationState(application.student_id, { bank_form_sent_at: sentAt });
    await setApplicationStatus(application, 'bank_account_waiting', { bank_form_sent_at: sentAt, last_line_sent_at: sentAt });
  }
  return { sent: true as const, text };
}

export async function processWorkflowReplyForApplication(input: { application: ReferralApplication; intent: Exclude<WorkflowIntent, 'human_required'>; event: InboundLineMessage; dryRun?: boolean }) {
  const dryRun = input.dryRun ?? config.LINE_SEND_DRY_RUN;
  const application = input.application;
  const sentTexts = [];

  if (input.intent === 'confirmation') {
    const text = await getTemplateBody('confirmation_ack');
    await sendWorkflowMessage(application, text, 'confirmation_ack', dryRun);
    sentTexts.push(text);
    if (!dryRun) await setApplicationStatus(application, 'pre_caution_confirmed', { pre_caution_confirmed_at: nowIso(), last_line_sent_at: nowIso() });
  }

  if (input.intent === 'form_answered') {
    const text = await getTemplateBody('form_answered_ack');
    await sendWorkflowMessage(application, text, 'form_answered_ack', dryRun);
    sentTexts.push(text);

    const registration = await getRegistrationState(application.student_id);
    const bankFormAlreadySent = application.bank_form_sent_at || application.students?.bank_form_sent_at || registration?.bank_form_sent_at;
    const bankFormUnanswered = !application.bank_form_answered_at && !application.students?.bank_form_answered_at && !registration?.bank_form_answered_at;
    if (application.post_participation_form_answered_at && bankFormAlreadySent && bankFormUnanswered) {
      if (!dryRun) {
        const answeredAt = nowIso();
        await supabase.from('students').update({ bank_form_answered_at: answeredAt, updated_at: answeredAt }).eq('id', application.student_id);
        await upsertRegistrationState(application.student_id, { bank_form_answered_at: answeredAt });
        await setApplicationStatus(application, 'payment_ready', { bank_form_answered_at: answeredAt, last_line_sent_at: answeredAt });
      }
      if (!dryRun) await writeApplicationsToSheets({ applicationIds: [application.id], dryRun: config.SHEETS_WRITE_DRY_RUN });
      return { ok: true, dryRun, application, sentTexts };
    }

    if (!dryRun) {
      await setApplicationStatus(application, 'bank_form_send_pending', { post_participation_form_answered_at: nowIso(), last_line_sent_at: nowIso() });
    }
    const bank = await maybeSendBankForm(application, dryRun);
    if (bank && 'text' in bank) sentTexts.push(bank.text);
    if (bank && 'alreadyAnswered' in bank && !dryRun) await setApplicationStatus(application, 'payment_ready');
    if (bank && 'alreadySent' in bank && !dryRun) await setApplicationStatus(application, 'bank_account_waiting');
  }

  if (!dryRun) await writeApplicationsToSheets({ applicationIds: [application.id], dryRun: config.SHEETS_WRITE_DRY_RUN });
  return { ok: true, dryRun, application, sentTexts };
}

export async function processWorkflowReply(input: { student: any; event: InboundLineMessage; dryRun?: boolean }) {
  const classification = classifyWorkflowReply(input.event.text);
  if (classification.intent === 'human_required') {
    return { handled: false as const, classification };
  }

  const applications = await candidateApplications(input.student.id, classification.intent);
  if (applications.length === 0) {
    return { handled: false as const, classification, reason: 'No matching referral application' };
  }
  if (applications.length > 1) {
    return { handled: true as const, needsSelection: true as const, classification, applications };
  }

  const result = await processWorkflowReplyForApplication({
    application: applications[0],
    intent: classification.intent,
    event: input.event,
    dryRun: input.dryRun,
  });
  return { handled: true as const, needsSelection: false as const, classification, ...result };
}

export async function selectWorkflowApplication(input: { applicationRefId: string; intent: Exclude<WorkflowIntent, 'human_required'>; eventText: string; dryRun?: boolean }) {
  const { data, error } = await supabase
    .from('referral_applications')
    .select('*, students(id,line_user_id,display_name,bank_form_sent_at,bank_form_answered_at)')
    .eq('client_id', config.DEFAULT_CLIENT_ID)
    .eq('id', input.applicationRefId)
    .single();
  if (error) throw error;
  const application = data as ReferralApplication;
  return processWorkflowReplyForApplication({
    application,
    intent: input.intent,
    event: { lineUserId: application.line_user_id ?? '', text: input.eventText, messageType: 'text' },
    dryRun: input.dryRun,
  });
}

export function planWorkflowJobsForSmoke(participationScheduledAt: string, applicationId = 'app-smoke') {
  return [
    {
      applicationId,
      jobType: 'pre_participation_caution',
      dueAt: new Date().toISOString(),
    },
    {
      applicationId,
      jobType: 'same_day_participation_reminder',
      dueAt: addHours(participationScheduledAt, -config.SAME_DAY_REMINDER_OFFSET_HOURS),
    },
    {
      applicationId,
      jobType: 'post_participation_form',
      dueAt: addHours(participationScheduledAt, config.POST_FORM_DELAY_HOURS),
    },
  ];
}
