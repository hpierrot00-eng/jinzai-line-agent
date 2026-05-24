import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';
import { knowledgeSearchTerms } from './ai.js';
import { extractMarkAsReadToken } from './line.js';
import type { DraftResult, InboundLineMessage, KnowledgeItem, MessageTemplate, MonthlyRule } from './types.js';

export const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function single<T>(data: T | T[] | null): T {
  if (!data) throw new Error('Supabase returned no row');
  return Array.isArray(data) ? data[0] : data;
}

function errorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function sanitizeKnowledgeText(text: unknown) {
  return String(text ?? '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\bU[a-f0-9]{20,}\b/gi, '[line_user_id]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[uuid]')
    .replace(/\b0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}\b/g, '[phone]')
    .replace(/\b\d{6,8}\b/g, '[number]')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function knowledgeHash(input: string) {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 16);
}

function approvedKnowledgeSource(approvalId: string) {
  return `approved_reply:${approvalId}`;
}

export function buildKnowledgeBody(input: { incomingText?: string | null; replyText: string; note?: string | null }) {
  const incoming = sanitizeKnowledgeText(input.incomingText);
  const reply = sanitizeKnowledgeText(input.replyText);
  const note = sanitizeKnowledgeText(input.note);
  return [
    incoming ? `問い合わせ:\n${incoming}` : null,
    `返信例:\n${reply}`,
    note ? `運用メモ:\n${note}` : null,
  ].filter(Boolean).join('\n\n');
}

export async function upsertStudent(input: InboundLineMessage) {
  const payload: Record<string, unknown> = {
    client_id: config.DEFAULT_CLIENT_ID,
    line_user_id: input.lineUserId,
    updated_at: new Date().toISOString(),
  };
  if (input.displayName) payload.display_name = input.displayName;

  const { data, error } = await supabase
    .from('students')
    .upsert(payload, { onConflict: 'client_id,line_user_id' })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function getOrCreateConversation(studentId: string) {
  const existing = await supabase
    .from('conversations')
    .select('*')
    .eq('client_id', config.DEFAULT_CLIENT_ID)
    .eq('student_id', studentId)
    .in('status', ['open', 'waiting_approval', 'waiting_customer', 'revision_requested'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return existing.data;

  const { data, error } = await supabase
    .from('conversations')
    .insert({ client_id: config.DEFAULT_CLIENT_ID, student_id: studentId, status: 'open', last_message_at: new Date().toISOString() })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function saveIncomingMessage(input: InboundLineMessage, studentId: string, conversationId: string) {
  const rawPayload = normalizeIncomingRawPayload(input);
  const { data, error } = await supabase
    .from('messages')
    .insert({
      client_id: config.DEFAULT_CLIENT_ID,
      conversation_id: conversationId,
      student_id: studentId,
      direction: 'incoming',
      channel: 'line',
      sender_type: 'customer',
      sender_id: input.lineUserId,
      content: input.text,
      message_type: input.messageType ?? 'text',
      raw_payload: rawPayload,
    })
    .select('*')
    .single();
  if (error) throw error;

  await supabase.from('conversations').update({ last_message_at: new Date().toISOString(), status: 'waiting_approval', updated_at: new Date().toISOString() }).eq('id', conversationId);
  return data;
}

function normalizeIncomingRawPayload(input: InboundLineMessage) {
  if (!input.markAsReadToken) return input.rawPayload ?? {};
  const raw = input.rawPayload;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { ...(raw as Record<string, unknown>), markAsReadToken: input.markAsReadToken };
  }
  return { rawPayload: raw ?? null, markAsReadToken: input.markAsReadToken };
}

export async function getMessageMarkAsReadToken(messageId?: string | null) {
  if (!messageId) return null;
  const { data, error } = await supabase
    .from('messages')
    .select('raw_payload')
    .eq('id', messageId)
    .maybeSingle();
  if (error) throw error;
  return extractMarkAsReadToken(data?.raw_payload);
}

export async function getReplyDraftMarkAsReadToken(replyDraftId: string) {
  const { data, error } = await supabase
    .from('reply_drafts')
    .select('trigger_message_id')
    .eq('id', replyDraftId)
    .maybeSingle();
  if (error) throw error;
  return getMessageMarkAsReadToken(data?.trigger_message_id);
}

export async function getRecentMessages(conversationId: string) {
  const { data, error } = await supabase
    .from('messages')
    .select('direction,sender_type,content,created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(20);
  if (error) throw error;
  return data ?? [];
}

export async function saveDraft(conversationId: string, triggerMessageId: string, draft: DraftResult) {
  const { data, error } = await supabase
    .from('reply_drafts')
    .insert({
      client_id: config.DEFAULT_CLIENT_ID,
      conversation_id: conversationId,
      trigger_message_id: triggerMessageId,
      draft_text: draft.reply_text,
      category: draft.category,
      confidence: draft.confidence,
      risk_level: draft.risk_level,
      needs_human_review: true,
      extracted_data: draft.extracted_data,
      reason: draft.reason,
      status: 'drafted',
      prompt_version: 'mvp-2026-05-15',
      model_name: config.OPENCLAW_MODEL_NAME,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function getDraftWithContext(replyDraftId: string) {
  const { data, error } = await supabase
    .from('reply_drafts')
    .select('*, conversations(*, students(*))')
    .eq('id', replyDraftId)
    .single();
  if (error) throw error;
  return single<any>(data);
}

export async function recordOutgoingAndApproval(replyDraftId: string, action: string, approverSlackUserId: string, finalText: string, comment?: string) {
  const draft = await getDraftWithContext(replyDraftId);
  const conversation = draft.conversations;
  const student = conversation.students;

  const approval = await supabase.from('approvals').insert({
    client_id: config.DEFAULT_CLIENT_ID,
    reply_draft_id: replyDraftId,
    approver_slack_user_id: approverSlackUserId,
    action,
    comment: comment ?? null,
    before_text: draft.draft_text,
    after_text: finalText,
  }).select('*').single();
  if (approval.error) throw approval.error;

  const message = await supabase.from('messages').insert({
    client_id: config.DEFAULT_CLIENT_ID,
    conversation_id: conversation.id,
    student_id: student.id,
    direction: 'outgoing',
    channel: 'line',
    sender_type: 'human',
    sender_id: approverSlackUserId,
    content: finalText,
    message_type: 'text',
    raw_payload: { replyDraftId, action },
  }).select('*').single();
  if (message.error) throw message.error;

  await supabase.from('reply_drafts').update({ status: 'sent', updated_at: new Date().toISOString() }).eq('id', replyDraftId);
  await supabase.from('conversations').update({ status: 'waiting_customer', last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', conversation.id);
  await createKnowledgeFromApprovedReply({
    approvalId: approval.data.id,
    replyDraft: draft,
    finalText,
    action,
  }).catch((err) => {
    console.warn('approved reply knowledge capture skipped:', errorMessage(err));
  });

  return { draft, conversation, student, approval: approval.data, message: message.data };
}

export async function recordApprovalAction(replyDraftId: string, action: string, approverSlackUserId: string, comment?: string, afterText?: string) {
  const draft = await getDraftWithContext(replyDraftId);
  const { data, error } = await supabase.from('approvals').insert({
    client_id: config.DEFAULT_CLIENT_ID,
    reply_draft_id: replyDraftId,
    approver_slack_user_id: approverSlackUserId,
    action,
    comment: comment ?? null,
    before_text: draft.draft_text,
    after_text: afterText ?? null,
  }).select('*').single();
  if (error) throw error;
  return data;
}

export async function recordDeliveryAttempt(input: { replyDraftId: string; lineUserId: string; text: string; status: 'success' | 'failed'; errorMessage?: string; providerResponse?: unknown; attemptedBySlackUserId?: string; action: string }) {
  const { error } = await supabase.from('delivery_attempts').insert({
    client_id: config.DEFAULT_CLIENT_ID,
    reply_draft_id: input.replyDraftId,
    line_user_id: input.lineUserId,
    channel: 'line',
    status: input.status,
    error_message: input.errorMessage ?? null,
    provider_response: input.providerResponse ?? {},
    attempted_by_slack_user_id: input.attemptedBySlackUserId ?? null,
    action: input.action,
    message_text: input.text,
  });
  // Do not turn an already-successful LINE send into a false failure if the DB migration has not been applied yet.
  if (error && /delivery_attempts|relation .* does not exist/i.test(error.message ?? '')) return;
  if (error) throw error;
}

export async function markDraftSendFailed(replyDraftId: string, errorMessage: string, failedText: string) {
  const draft = await getDraftWithContext(replyDraftId);
  const extractedData = typeof draft.extracted_data === 'object' && draft.extracted_data !== null ? draft.extracted_data : {};
  const { error } = await supabase
    .from('reply_drafts')
    .update({ status: 'send_failed', extracted_data: { ...extractedData, last_send_error: errorMessage, last_failed_text: failedText }, updated_at: new Date().toISOString() })
    .eq('id', replyDraftId);
  if (error) throw error;
}

export async function saveSlackReview(replyDraftId: string, channel: string, ts: string, threadTs?: string) {
  const { error } = await supabase.from('slack_reviews').insert({
    client_id: config.DEFAULT_CLIENT_ID,
    reply_draft_id: replyDraftId,
    slack_channel_id: channel,
    slack_message_ts: ts,
    slack_thread_ts: threadTs ?? ts,
    status: 'posted',
  });
  if (error) throw error;
  await supabase.from('reply_drafts').update({ status: 'posted_to_slack', updated_at: new Date().toISOString() }).eq('id', replyDraftId);
}

export async function createAppointmentIfExtracted(studentId: string, conversationId: string, extractedData: Record<string, unknown>) {
  const appointmentType = typeof extractedData.appointment_type === 'string' ? extractedData.appointment_type : null;
  const scheduledAt = typeof extractedData.scheduled_at === 'string' ? extractedData.scheduled_at : null;
  const dateText = typeof extractedData.date_text === 'string' ? extractedData.date_text : null;
  const timeText = typeof extractedData.time_text === 'string' ? extractedData.time_text : null;

  if (!appointmentType && !scheduledAt && !dateText && !timeText) return null;

  const { data, error } = await supabase.from('appointments').insert({
    client_id: config.DEFAULT_CLIENT_ID,
    student_id: studentId,
    conversation_id: conversationId,
    appointment_type: appointmentType ?? 'other',
    scheduled_at: scheduledAt,
    status: scheduledAt ? 'confirmed' : 'pending',
  }).select('*').single();
  if (error) throw error;
  return data;
}

export async function findRelevantKnowledge(text: string, category?: string, limit = 6): Promise<KnowledgeItem[]> {
  const terms = knowledgeSearchTerms(text);

  let query = supabase
    .from('knowledge_items')
    .select('id,title,category,body,priority,effective_from,effective_until')
    .eq('client_id', config.DEFAULT_CLIENT_ID)
    .eq('status', 'active')
    .order('priority', { ascending: false })
    .limit(limit);

  if (category) query = query.in('category', [category, 'general']);
  if (terms.length > 0) {
    const like = terms.map((term) => `title.ilike.%${term}%,body.ilike.%${term}%`).join(',');
    query = query.or(like);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as KnowledgeItem[];
}

export async function getMonthlyRulesForReply(text: string, today = new Date()): Promise<MonthlyRule[]> {
  const months = monthsToCheck(text, today);
  const { data, error } = await supabase
    .from('monthly_rules')
    .select('id,rule_month,category,label,value,notes')
    .eq('client_id', config.DEFAULT_CLIENT_ID)
    .in('rule_month', months)
    .eq('status', 'active')
    .order('rule_month', { ascending: true });
  if (error) throw error;
  return (data ?? []) as MonthlyRule[];
}

function monthsToCheck(text: string, today: Date) {
  const current = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const next = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
  const previous = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const months = new Set<string>([monthKey(current)]);
  if (/来月|次月|翌月/.test(text)) months.add(monthKey(next));
  if (/先月|前月/.test(text)) months.add(monthKey(previous));
  const explicit = text.match(/(20\d{2})年\s*(\d{1,2})月|(?<!\d)(\d{1,2})月/g) ?? [];
  for (const match of explicit) {
    const yearMatch = match.match(/(20\d{2})年\s*(\d{1,2})月/);
    const monthOnly = match.match(/(?<!\d)(\d{1,2})月/);
    const year = yearMatch ? Number(yearMatch[1]) : today.getUTCFullYear();
    const month = yearMatch ? Number(yearMatch[2]) : monthOnly ? Number(monthOnly[1]) : null;
    if (month && month >= 1 && month <= 12) months.add(`${year}-${String(month).padStart(2, '0')}`);
  }
  return Array.from(months);
}

function monthKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function listKnowledgeCandidates(limit = 30) {
  const { data, error } = await supabase
    .from('approvals')
    .select('id,action,before_text,after_text,comment,created_at, reply_drafts(category,risk_level,reason)')
    .eq('client_id', config.DEFAULT_CLIENT_ID)
    .in('action', ['approve', 'edit_and_approve'])
    .not('after_text', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return {
    ok: true,
    candidates: (data ?? []).map((row: any) => ({
      approvalId: row.id,
      category: row.reply_drafts?.category ?? 'general',
      source: row.action === 'edit_and_approve' ? 'human_edited_reply' : 'approved_reply',
      title: `${row.reply_drafts?.category ?? 'general'} response ${row.created_at}`,
      body: row.after_text,
      humanEditDelta: row.before_text && row.before_text !== row.after_text ? { before: row.before_text, after: row.after_text } : null,
      reason: row.reply_drafts?.reason ?? null,
      createdAt: row.created_at,
    })),
  };
}

export async function findMessageTemplates(category?: string, limit = 5): Promise<MessageTemplate[]> {
  let query = supabase
    .from('message_templates')
    .select('id,key,title,category,body,version,priority,status,send_mode,updated_by,approved_by,approved_at')
    .eq('client_id', config.DEFAULT_CLIENT_ID)
    .eq('status', 'active')
    .order('priority', { ascending: false })
    .limit(limit);

  if (category) query = query.in('category', [category, 'general']);
  const { data, error } = await query;
  if (error) {
    // Keep older deployments alive until the new schema migration is applied.
    if (/message_templates|relation .* does not exist/i.test(error.message ?? '')) return [];
    if (/version|send_mode|updated_by|approved_by|approved_at|schema cache/i.test(error.message ?? '')) {
      let legacyQuery = supabase
        .from('message_templates')
        .select('id,key,title,category,body,priority,status')
        .eq('client_id', config.DEFAULT_CLIENT_ID)
        .eq('status', 'active')
        .order('priority', { ascending: false })
        .limit(limit);
      if (category) legacyQuery = legacyQuery.in('category', [category, 'general']);
      const legacy = await legacyQuery;
      if (legacy.error) throw legacy.error;
      return (legacy.data ?? []) as MessageTemplate[];
    }
    throw error;
  }
  return (data ?? []) as MessageTemplate[];
}

export async function listMessageTemplates(limit = 50) {
  const { data, error } = await supabase
    .from('message_templates')
    .select('*')
    .eq('client_id', config.DEFAULT_CLIENT_ID)
    .order('priority', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return { ok: true, templates: data ?? [] };
}

export async function upsertMessageTemplate(input: {
  key: string;
  title: string;
  category?: string;
  body: string;
  priority?: number;
  status?: string;
  sendMode?: 'auto_send' | 'approval_required' | 'disabled';
  send_mode?: 'auto_send' | 'approval_required' | 'disabled';
  updatedBy?: string;
  updated_by?: string;
}) {
  const existing = await supabase
    .from('message_templates')
    .select('version,send_mode')
    .eq('client_id', config.DEFAULT_CLIENT_ID)
    .eq('key', input.key)
    .maybeSingle();
  if (existing.error) throw existing.error;
  const nextVersion = Number(existing.data?.version ?? 0) + 1;
  const { data, error } = await supabase.from('message_templates').upsert({
    client_id: config.DEFAULT_CLIENT_ID,
    key: input.key,
    title: input.title,
    category: input.category ?? 'general',
    body: input.body,
    version: nextVersion,
    priority: input.priority ?? 0,
    status: input.status ?? 'active',
    send_mode: input.sendMode ?? input.send_mode ?? existing.data?.send_mode ?? 'approval_required',
    updated_by: input.updatedBy ?? input.updated_by ?? 'admin_api',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'client_id,key' }).select('*').single();
  if (error) throw error;
  return data;
}

export async function approveMessageTemplate(key: string, input: { approvedBy?: string; approved_by?: string; status?: string }) {
  const { data, error } = await supabase
    .from('message_templates')
    .update({
      status: input.status ?? 'active',
      approved_by: input.approvedBy ?? input.approved_by ?? 'admin_api',
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('client_id', config.DEFAULT_CLIENT_ID)
    .eq('key', key)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function createKnowledgeItem(input: { title: string; category?: string; body: string; source?: string; priority?: number; effectiveFrom?: string; effectiveUntil?: string }) {
  const { data, error } = await supabase.from('knowledge_items').insert({
    client_id: config.DEFAULT_CLIENT_ID,
    title: input.title,
    category: input.category ?? 'general',
    body: input.body,
    source: input.source ?? 'manual',
    priority: input.priority ?? 0,
    effective_from: input.effectiveFrom ?? null,
    effective_until: input.effectiveUntil ?? null,
  }).select('*').single();
  if (error) throw error;
  return data;
}

async function getIncomingTextForDraft(replyDraft: any) {
  const messageId = replyDraft?.trigger_message_id;
  if (!messageId) return null;
  const { data, error } = await supabase
    .from('messages')
    .select('content')
    .eq('id', messageId)
    .maybeSingle();
  if (error) throw error;
  return data?.content ?? null;
}

export async function createKnowledgeFromApprovedReply(input: { approvalId: string; replyDraft: any; finalText: string; action?: string; dryRun?: boolean }) {
  if (!input.finalText?.trim()) return { ok: false, status: 'empty_reply' as const };
  const source = approvedKnowledgeSource(input.approvalId);
  const existing = await supabase
    .from('knowledge_items')
    .select('id')
    .eq('client_id', config.DEFAULT_CLIENT_ID)
    .eq('source', source)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return { ok: true, status: 'exists' as const, source, itemId: existing.data.id };

  const incomingText = await getIncomingTextForDraft(input.replyDraft);
  const category = input.replyDraft?.category ?? 'general';
  const risk = input.replyDraft?.risk_level ?? 'unknown';
  const body = buildKnowledgeBody({
    incomingText,
    replyText: input.finalText,
    note: `Slack承認済み返信。action=${input.action ?? 'approve'} / risk=${risk}`,
  });
  const title = `承認済み返信例: ${category}`;
  if (input.dryRun) return { ok: true, dryRun: true, status: 'would_create' as const, source, title, category, body };
  const item = await createKnowledgeItem({
    title,
    category,
    body,
    source,
    priority: input.action === 'edit_and_approve' ? 85 : 75,
  });
  return { ok: true, status: 'created' as const, source, item };
}

export async function promoteApprovedRepliesToKnowledge(input: { limit?: number; dryRun?: boolean } = {}) {
  const limit = Math.min(Math.max(Number(input.limit ?? 50), 1), 200);
  const { data, error } = await supabase
    .from('approvals')
    .select('id,action,after_text,created_at,reply_draft_id,reply_drafts(id,trigger_message_id,category,risk_level,reason)')
    .eq('client_id', config.DEFAULT_CLIENT_ID)
    .in('action', ['approve', 'edit_and_approve'])
    .not('after_text', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  const results = [];
  for (const approval of data ?? []) {
    results.push(await createKnowledgeFromApprovedReply({
      approvalId: approval.id,
      replyDraft: (approval as any).reply_drafts,
      finalText: approval.after_text,
      action: approval.action,
      dryRun: input.dryRun,
    }));
  }
  return { ok: true, dryRun: Boolean(input.dryRun), scanned: data?.length ?? 0, created: results.filter((item: any) => item.status === 'created' || item.status === 'would_create').length, results };
}

export async function importPastTalkExamples(input: { examples: Array<{ incomingText?: string; question?: string; replyText?: string; reply?: string; category?: string; title?: string; source?: string; priority?: number; note?: string }>; dryRun?: boolean }) {
  const examples = Array.isArray(input.examples) ? input.examples.slice(0, 200) : [];
  const results = [];
  for (const example of examples) {
    const incomingText = example.incomingText ?? example.question ?? '';
    const replyText = example.replyText ?? example.reply ?? '';
    if (!replyText.trim()) {
      results.push({ ok: false, status: 'empty_reply' as const });
      continue;
    }
    const body = buildKnowledgeBody({ incomingText, replyText, note: example.note ?? '過去トーク取り込み' });
    const source = example.source ?? `past_talk_import:${knowledgeHash(`${incomingText}\n${replyText}`)}`;
    const existing = await supabase
      .from('knowledge_items')
      .select('id')
      .eq('client_id', config.DEFAULT_CLIENT_ID)
      .eq('source', source)
      .maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) {
      results.push({ ok: true, status: 'exists' as const, source, itemId: existing.data.id });
      continue;
    }
    const payload = {
      title: example.title ?? `過去対応例: ${example.category ?? 'general'}`,
      category: example.category ?? 'general',
      body,
      source,
      priority: example.priority ?? 60,
    };
    if (input.dryRun) {
      results.push({ ok: true, dryRun: true, status: 'would_create' as const, ...payload });
      continue;
    }
    const item = await createKnowledgeItem(payload);
    results.push({ ok: true, status: 'created' as const, source, item });
  }
  return { ok: true, dryRun: Boolean(input.dryRun), received: examples.length, created: results.filter((item: any) => item.status === 'created' || item.status === 'would_create').length, results };
}

export async function upsertMonthlyRule(input: { ruleMonth: string; category: string; label: string; value: string; notes?: string; status?: string }) {
  const { data, error } = await supabase.from('monthly_rules').upsert({
    client_id: config.DEFAULT_CLIENT_ID,
    rule_month: input.ruleMonth,
    category: input.category,
    label: input.label,
    value: input.value,
    notes: input.notes ?? null,
    status: input.status ?? 'active',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'client_id,rule_month,category,label' }).select('*').single();
  if (error) throw error;
  return data;
}
