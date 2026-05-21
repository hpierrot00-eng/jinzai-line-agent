import { config } from './config.js';
import { markLineMessageAsRead, sendLineMessage, syncLineHarnessTags } from './line.js';
import { getMessageMarkAsReadToken, supabase } from './db.js';
import { writeApplicationsToSheets } from './sheets.js';
import type { InboundLineMessage } from './types.js';
import { WebClient } from '@slack/web-api';

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
export type TemplateSendMode = 'auto_send' | 'approval_required' | 'disabled';

const workflowSlack = new WebClient(config.SLACK_BOT_TOKEN);

export const WORKFLOW_TEMPLATE_BODIES: Record<string, string> = {
  confirm_ack_reply: 'ご確認ありがとうございます！\nまた、わからない事などありましたら気軽に仰ってください！\n\n引き続きよろしくお願い致します！',
  answered_ack_reply: 'ご回答ありがとうございます！\n\n引き続きよろしくお願い致します！',
  pre_participation_caution: `面談のお時間が近づいてきましたね！
面談参加にあたっての注意事項だけ共有しておきます！
※面談参加中、参加後について

- オンライン面談は画面オン、マイクオンでの参加お願いいたします！
- 参加する姿勢

姿勢としては就活に興味あるけどどうしたらいいか分からない。

自分の力だけだときついから良いエージェントさんを探してる。

などのような感じで受けてもらえればと思います！

- 就活が終わっていても終わりました！はNGでお願いいたします！

（まだ続けてます！でお願いいたします。うまく濁してもらえれば大丈夫です）
- 就活支援金がもらえるから参加したは絶対にNGでお願いいたします！
- 今回どこで知ってくれたのかと聞かれた場合「就活に力を入れてる友達から紹介してもらいました！名前を聞かれたら佐藤ゆうと」とご回答ください！
- 2回目までの面談参加。基本1回目の面談の際に次の面談の日時を再度調整されるので、そこで日時の調整をしていただいて、2回目の面談も参加していただけたらと思います！！
3回目以降はそのまま使い続けたいなと感じられたら参加していただけたらと思います！

３回目以降に関しては興味があれば出ていただければ幸いです！

もし、参加したエージェントが合わなかった場合はブロックなどはせずに、キャンセルしていただいても大丈夫です！

※就活支援金(2500円）について

就活支援金は弊社よりお支払いいたしますので、
面談時に就活支援金についてお話しいただく必要はございません！
就活支援金の入金は翌々月の２０日です！

（非承認になってしまった場合報酬が支払われないので、ご了承ください）

上記注意事項を徹底に守っていただくことや2回目参加などして企業紹介など受けていただければ基本承認になるのでご安心ください！☺️確実に承認にしたい場合は2回目を出ていただき、企業紹介など受けてもらえると確率が圧倒的に高くなります！

分からない事などありましたら気軽にご連絡ください！

確認できましたら「確認できました」と送っていただけると助かります！

引き続きよろしくお願いいたします！`,
  same_day_reminder: '参加当日になりました！再度、注意事項なども確認してご参加いただければと思います！\n引き続きよろしくお願いいたします！',
  post_participation_form: '面談ご参加お疲れ様です！\n\n我々としても参加された方にはできる限り就活支援金をお渡ししたいので、以下の回答フォームへのご入力をお願いいたします！\n{{post_participation_form_url}}\n\nお手数ですが、よろしくお願いいたします！',
  bank_account_form: 'この度は面談ご参加ありがとうございます！\n就活支援金のお渡しは銀行振り込みで対応させて頂きます！\n\n下記のフォームのご回答よろしくお願いいたします！\n入金は翌々月の20日になります！\n\n{{bank_account_form_url}}',
  confirmation_ack: 'ご確認ありがとうございます！\nまた、わからない事などありましたら気軽に仰ってください！\n\n引き続きよろしくお願い致します！',
  form_answered_ack: 'ご回答ありがとうございます！\n\n引き続きよろしくお願い致します！',
  same_day_participation_reminder: '参加当日になりました！再度、注意事項なども確認してご参加いただければと思います！\n引き続きよろしくお願いいたします！',
};

const DEFAULT_TEMPLATE_SEND_MODES: Record<string, TemplateSendMode> = {
  pre_participation_caution: 'approval_required',
  same_day_reminder: 'auto_send',
  post_participation_form: 'auto_send',
  bank_account_form: 'auto_send',
  confirm_ack_reply: 'auto_send',
  answered_ack_reply: 'auto_send',
  same_day_participation_reminder: 'auto_send',
  confirmation_ack: 'auto_send',
  form_answered_ack: 'auto_send',
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
  line_display_name?: string | null;
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
  template_version?: number | null;
  due_at: string;
  attempts?: number | null;
  metadata: Record<string, unknown> | null;
  rendered_text?: string | null;
  approved_text?: string | null;
  approved_by_slack_user_id?: string | null;
  approved_at?: string | null;
  referral_applications?: ReferralApplication | null;
};

type WorkflowTemplate = {
  key: string;
  title: string;
  body: string;
  version: number;
  sendMode: TemplateSendMode;
  status: string;
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
  if (/確認しました|確認できました|確認出来ました|確認済|確認いたしました|了解です|承知しました|見ました|大丈夫です/.test(normalized)) {
    return { intent: 'confirmation', risk: 'low', reason: '参加前注意事項などの確認完了を示す定型返信。' };
  }
  if (/支払|支払い|報酬|給与|謝礼|入金|返金|キャンセル|辞退|変更|日程変更|リスケ|遅刻|欠席|クレーム|苦情|無理|できない|わからない|分からない|\?|\？/.test(normalized)) {
    return { intent: 'human_required', risk: 'high', reason: '支払い・キャンセル・日程変更・苦情・判断不能の可能性がある返信。' };
  }
  return { intent: 'human_required', risk: 'high', reason: '自動処理対象の定型返信として確信できない返信。' };
}

function fallbackTemplate(key: string): WorkflowTemplate {
  const body = WORKFLOW_TEMPLATE_BODIES[key];
  if (!body) throw new Error(`Missing workflow template: ${key}`);
  return {
    key,
    title: key,
    body,
    version: 1,
    sendMode: DEFAULT_TEMPLATE_SEND_MODES[key] ?? 'approval_required',
    status: 'active',
  };
}

async function getWorkflowTemplate(key: string): Promise<WorkflowTemplate> {
  const { data, error } = await supabase
    .from('message_templates')
    .select('key,title,body,version,status,send_mode')
    .eq('client_id', config.DEFAULT_CLIENT_ID)
    .eq('key', key)
    .eq('status', 'active')
    .maybeSingle();
  if (error) {
    if (/message_templates|relation .* does not exist/i.test(error.message ?? '')) return fallbackTemplate(key);
    if (/version|send_mode|schema cache/i.test(error.message ?? '')) {
      const legacy = await supabase
        .from('message_templates')
        .select('key,title,body,status')
        .eq('client_id', config.DEFAULT_CLIENT_ID)
        .eq('key', key)
        .eq('status', 'active')
        .maybeSingle();
      if (legacy.error || !legacy.data) return fallbackTemplate(key);
      return {
        key: legacy.data.key,
        title: legacy.data.title ?? legacy.data.key,
        body: legacy.data.body ?? fallbackTemplate(key).body,
        version: 1,
        sendMode: DEFAULT_TEMPLATE_SEND_MODES[key] ?? 'approval_required',
        status: legacy.data.status ?? 'active',
      };
    }
    throw error;
  }
  if (!data) return fallbackTemplate(key);
  return {
    key: data.key,
    title: data.title ?? data.key,
    body: data.body ?? fallbackTemplate(key).body,
    version: Number(data.version ?? 1),
    sendMode: (data.send_mode as TemplateSendMode | null) ?? DEFAULT_TEMPLATE_SEND_MODES[key] ?? 'approval_required',
    status: data.status ?? 'active',
  };
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
  templateKey?: string;
  templateVersion?: number;
  attemptedBySlackUserId?: string;
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
    template_key: input.templateKey ?? null,
    template_version: input.templateVersion ?? null,
    attempted_by_slack_user_id: input.attemptedBySlackUserId ?? null,
  };
  const { error } = await supabase.from('delivery_attempts').insert(payload);
  if (!error) return;
  if (/delivery_attempts|relation .* does not exist/i.test(error.message ?? '')) return;
  if (/application_id|schema cache/i.test(error.message ?? '')) {
    delete payload.application_id;
    delete payload.template_key;
    delete payload.template_version;
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

async function sendWorkflowMessage(application: ReferralApplication, text: string, action: string, dryRun: boolean, template?: { key: string; version: number }, attemptedBySlackUserId?: string, markAsReadToken?: string) {
  if (!application.line_user_id) throw new Error(`Missing LINE user id for application ${application.application_id}`);
  if (dryRun) {
    await insertDeliveryAttempt({ applicationId: application.id, lineUserId: application.line_user_id, text, status: 'dry_run', action, templateKey: template?.key, templateVersion: template?.version, attemptedBySlackUserId });
    return { dryRun: true };
  }
  try {
    const providerResponse = await sendLineMessage(application.line_user_id, text);
    const markAsRead = markAsReadToken ? await markWorkflowMessageAsRead(markAsReadToken) : undefined;
    await insertDeliveryAttempt({ applicationId: application.id, lineUserId: application.line_user_id, text, status: 'success', action, providerResponse: { lineSend: providerResponse, markAsRead }, templateKey: template?.key, templateVersion: template?.version, attemptedBySlackUserId });
    await recordOutgoing(application, text, action);
    return { dryRun: false, markAsRead };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await insertDeliveryAttempt({ applicationId: application.id, lineUserId: application.line_user_id, text, status: 'failed', errorMessage: message, action, templateKey: template?.key, templateVersion: template?.version, attemptedBySlackUserId });
    await setApplicationStatus(application, 'human_required', { error_message: message });
    throw err;
  }
}

async function markWorkflowMessageAsRead(markAsReadToken: string) {
  try {
    return await markLineMessageAsRead(markAsReadToken);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('LINE workflow mark-as-read skipped:', message);
    return { ok: false, error: message };
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
        template_key: 'same_day_reminder',
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

function applicationCustomerLabel(application: ReferralApplication) {
  const displayName = application.students?.display_name ?? application.line_display_name ?? application.student_name ?? null;
  const lineId = application.line_user_id ?? application.students?.line_user_id ?? null;
  if (displayName && lineId) return `${displayName}\nLINE ID: ${lineId}`;
  if (displayName) return displayName;
  if (lineId) return `LINE ID: ${lineId}`;
  return '不明';
}

function workflowApprovalBlocks(job: WorkflowJob, application: ReferralApplication, template: WorkflowTemplate, text: string) {
  const scheduled = application.participation_scheduled_at
    ? new Intl.DateTimeFormat('ja-JP', {
      timeZone: config.WORKFLOW_TIMEZONE,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(application.participation_scheduled_at))
    : '日時未設定';
  return [
    { type: 'header', text: { type: 'plain_text', text: '参加前注意事項 承認待ち', emoji: true } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*顧客:*\n${applicationCustomerLabel(application)}` },
      { type: 'mrkdwn', text: `*申込:*\n${application.application_id} / ${application.agent_name ?? '案件未設定'} / ${scheduled}` },
      { type: 'mrkdwn', text: `*template:*\n${template.key} v${template.version}` },
      { type: 'mrkdwn', text: `*send_mode:*\n${template.sendMode}` },
    ] },
    { type: 'section', text: { type: 'mrkdwn', text: `*送信予定文面:*\n${text.slice(0, 2900)}` } },
    { type: 'actions', elements: [
      { type: 'button', text: { type: 'plain_text', text: '承認して送信' }, style: 'primary', action_id: 'workflow_approve_send', value: job.id },
      { type: 'button', text: { type: 'plain_text', text: '編集して送信' }, action_id: 'workflow_edit_send', value: job.id },
      { type: 'button', text: { type: 'plain_text', text: '人間対応' }, action_id: 'workflow_escalate', value: job.id },
    ] },
  ];
}

async function postWorkflowApprovalCard(job: WorkflowJob, application: ReferralApplication, template: WorkflowTemplate, text: string) {
  const result = await workflowSlack.chat.postMessage({
    channel: config.SLACK_APPROVAL_CHANNEL_ID,
    text: `参加前注意事項 承認待ち: ${application.students?.display_name ?? application.line_display_name ?? application.student_name ?? application.line_user_id ?? application.application_id}`,
    blocks: workflowApprovalBlocks(job, application, template, text) as any,
  });
  if (!result.ok || !result.ts || !result.channel) throw new Error(`Slack workflow approval failed: ${result.error}`);
  await markJob(job.id, {
    status: 'approval_pending',
    template_version: template.version,
    rendered_text: text,
    approval_slack_channel_id: result.channel,
    approval_slack_message_ts: result.ts,
    error_message: null,
  });
  return result;
}

export async function getWorkflowApprovalDraft(jobId: string) {
  const { data, error } = await supabase
    .from('workflow_jobs')
    .select('*, referral_applications(*, students(id,line_user_id,display_name,bank_form_sent_at,bank_form_answered_at))')
    .eq('client_id', config.DEFAULT_CLIENT_ID)
    .eq('id', jobId)
    .single();
  if (error) throw error;
  const job = data as WorkflowJob;
  const application = job.referral_applications;
  if (!application) throw new Error('Missing referral application for workflow job');
  const template = await getWorkflowTemplate(job.template_key);
  const text = job.approved_text ?? job.rendered_text ?? renderWorkflowTemplate(template.body, { ...templateValues(application), ...(job.metadata ?? {}) });
  return { job, application, template, text };
}

export async function approveWorkflowJob(input: { jobId: string; userId: string; text?: string; dryRun?: boolean }) {
  const { job, application, template, text: currentText } = await getWorkflowApprovalDraft(input.jobId);
  const text = input.text ?? currentText;
  const dryRun = input.dryRun ?? config.LINE_SEND_DRY_RUN;
  if (!application.line_user_id) throw new Error(`Missing LINE user id for application ${application.application_id}`);

  await markJob(job.id, {
    status: dryRun ? 'approval_dry_run' : 'processing',
    approved_by_slack_user_id: input.userId,
    approved_at: nowIso(),
    approved_text: text,
    template_version: template.version,
    attempts: Number(job.attempts ?? 0) + 1,
  });

  if (dryRun) {
    await sendWorkflowMessage(application, text, job.job_type, true, { key: template.key, version: template.version }, input.userId);
    return { ok: true, dryRun: true, job, application, template, text };
  }

  try {
    await sendWorkflowMessage(application, text, job.job_type, false, { key: template.key, version: template.version }, input.userId);
    const { status, patch } = statusPatchForJob(job);
    if (status) await setApplicationStatus(application, status, patch);
    await markJob(job.id, { status: 'sent', sent_at: nowIso(), error_message: null });
    await writeApplicationsToSheets({ applicationIds: [application.id], dryRun: config.SHEETS_WRITE_DRY_RUN });
    return { ok: true, dryRun: false, job, application, template, text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markJob(job.id, { status: 'failed', error_message: message });
    throw err;
  }
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
    const template = await getWorkflowTemplate(job.template_key);
    const text = renderWorkflowTemplate(template.body, values);
    if (dryRun) {
      results.push({ id: job.id, ok: true, dryRun: true, applicationId: application.application_id, jobType: job.job_type, templateKey: template.key, templateVersion: template.version, sendMode: template.sendMode, text });
      continue;
    }

    if (template.sendMode === 'disabled') {
      await markJob(job.id, { status: 'skipped', error_message: 'Template send_mode is disabled', template_version: template.version, rendered_text: text });
      results.push({ id: job.id, ok: true, skipped: true, applicationId: application.application_id, jobType: job.job_type, templateKey: template.key });
      continue;
    }

    if (template.sendMode === 'approval_required') {
      try {
        const approval = await postWorkflowApprovalCard(job, application, template, text);
        results.push({ id: job.id, ok: true, approvalRequired: true, slackTs: approval.ts, applicationId: application.application_id, jobType: job.job_type, templateKey: template.key, templateVersion: template.version });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await markJob(job.id, { status: 'failed', error_message: message, template_version: template.version, rendered_text: text });
        results.push({ id: job.id, ok: false, applicationId: application.application_id, error: message });
      }
      continue;
    }

    await markJob(job.id, { status: 'processing', locked_at: nowIso(), attempts: Number(job.attempts ?? 0) + 1 });
    try {
      await sendWorkflowMessage(application, text, job.job_type, false, { key: template.key, version: template.version });
      const { status, patch } = statusPatchForJob(job);
      if (status) await setApplicationStatus(application, status, patch);
      await markJob(job.id, { status: 'sent', sent_at: nowIso(), error_message: null, template_version: template.version, rendered_text: text });
      await writeApplicationsToSheets({ applicationIds: [application.id], dryRun: config.SHEETS_WRITE_DRY_RUN });
      results.push({ id: job.id, ok: true, dryRun: false, applicationId: application.application_id, jobType: job.job_type, templateKey: template.key, templateVersion: template.version });
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
  const template = await getWorkflowTemplate('bank_account_form');
  const text = renderWorkflowTemplate(template.body, templateValues(application));
  await sendWorkflowMessage(application, text, 'bank_account_form', dryRun, { key: template.key, version: template.version });
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
    const template = await getWorkflowTemplate('confirm_ack_reply');
    const text = renderWorkflowTemplate(template.body, templateValues(application));
    await sendWorkflowMessage(application, text, 'confirm_ack_reply', dryRun, { key: template.key, version: template.version }, undefined, input.event.markAsReadToken);
    sentTexts.push(text);
    if (!dryRun) await setApplicationStatus(application, 'pre_caution_confirmed', { pre_caution_confirmed_at: nowIso(), last_line_sent_at: nowIso() });
  }

  if (input.intent === 'form_answered') {
    const template = await getWorkflowTemplate('answered_ack_reply');
    const text = renderWorkflowTemplate(template.body, templateValues(application));
    await sendWorkflowMessage(application, text, 'answered_ack_reply', dryRun, { key: template.key, version: template.version }, undefined, input.event.markAsReadToken);
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

export async function selectWorkflowApplication(input: { applicationRefId: string; intent: Exclude<WorkflowIntent, 'human_required'>; eventText: string; incomingMessageId?: string; dryRun?: boolean }) {
  const { data, error } = await supabase
    .from('referral_applications')
    .select('*, students(id,line_user_id,display_name,bank_form_sent_at,bank_form_answered_at)')
    .eq('client_id', config.DEFAULT_CLIENT_ID)
    .eq('id', input.applicationRefId)
    .single();
  if (error) throw error;
  const application = data as ReferralApplication;
  let markAsReadToken: string | null = null;
  try {
    markAsReadToken = await getMessageMarkAsReadToken(input.incomingMessageId);
  } catch (err) {
    console.warn('LINE workflow selection mark-as-read lookup skipped:', err instanceof Error ? err.message : err);
  }
  return processWorkflowReplyForApplication({
    application,
    intent: input.intent,
    event: { lineUserId: application.line_user_id ?? '', text: input.eventText, messageType: 'text', markAsReadToken: markAsReadToken ?? undefined },
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
