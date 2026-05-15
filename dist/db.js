import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';
export const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
});
function single(data) {
    if (!data)
        throw new Error('Supabase returned no row');
    return Array.isArray(data) ? data[0] : data;
}
export async function upsertStudent(input) {
    const { data, error } = await supabase
        .from('students')
        .upsert({
        client_id: config.DEFAULT_CLIENT_ID,
        line_user_id: input.lineUserId,
        display_name: input.displayName ?? null,
        updated_at: new Date().toISOString(),
    }, { onConflict: 'client_id,line_user_id' })
        .select('*')
        .single();
    if (error)
        throw error;
    return data;
}
export async function getOrCreateConversation(studentId) {
    const existing = await supabase
        .from('conversations')
        .select('*')
        .eq('client_id', config.DEFAULT_CLIENT_ID)
        .eq('student_id', studentId)
        .in('status', ['open', 'waiting_approval', 'waiting_customer', 'revision_requested'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (existing.error)
        throw existing.error;
    if (existing.data)
        return existing.data;
    const { data, error } = await supabase
        .from('conversations')
        .insert({ client_id: config.DEFAULT_CLIENT_ID, student_id: studentId, status: 'open', last_message_at: new Date().toISOString() })
        .select('*')
        .single();
    if (error)
        throw error;
    return data;
}
export async function saveIncomingMessage(input, studentId, conversationId) {
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
        raw_payload: input.rawPayload ?? {},
    })
        .select('*')
        .single();
    if (error)
        throw error;
    await supabase.from('conversations').update({ last_message_at: new Date().toISOString(), status: 'waiting_approval', updated_at: new Date().toISOString() }).eq('id', conversationId);
    return data;
}
export async function getRecentMessages(conversationId) {
    const { data, error } = await supabase
        .from('messages')
        .select('direction,sender_type,content,created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(20);
    if (error)
        throw error;
    return data ?? [];
}
export async function saveDraft(conversationId, triggerMessageId, draft) {
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
    if (error)
        throw error;
    return data;
}
export async function getDraftWithContext(replyDraftId) {
    const { data, error } = await supabase
        .from('reply_drafts')
        .select('*, conversations(*, students(*))')
        .eq('id', replyDraftId)
        .single();
    if (error)
        throw error;
    return single(data);
}
export async function recordOutgoingAndApproval(replyDraftId, action, approverSlackUserId, finalText, comment) {
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
    if (approval.error)
        throw approval.error;
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
    if (message.error)
        throw message.error;
    await supabase.from('reply_drafts').update({ status: 'sent', updated_at: new Date().toISOString() }).eq('id', replyDraftId);
    await supabase.from('conversations').update({ status: 'waiting_customer', last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', conversation.id);
    return { draft, conversation, student, approval: approval.data, message: message.data };
}
export async function saveSlackReview(replyDraftId, channel, ts, threadTs) {
    const { error } = await supabase.from('slack_reviews').insert({
        client_id: config.DEFAULT_CLIENT_ID,
        reply_draft_id: replyDraftId,
        slack_channel_id: channel,
        slack_message_ts: ts,
        slack_thread_ts: threadTs ?? ts,
        status: 'posted',
    });
    if (error)
        throw error;
    await supabase.from('reply_drafts').update({ status: 'posted_to_slack', updated_at: new Date().toISOString() }).eq('id', replyDraftId);
}
export async function createAppointmentIfExtracted(studentId, conversationId, extractedData) {
    const appointmentType = typeof extractedData.appointment_type === 'string' ? extractedData.appointment_type : null;
    const scheduledAt = typeof extractedData.scheduled_at === 'string' ? extractedData.scheduled_at : null;
    const dateText = typeof extractedData.date_text === 'string' ? extractedData.date_text : null;
    const timeText = typeof extractedData.time_text === 'string' ? extractedData.time_text : null;
    if (!appointmentType && !scheduledAt && !dateText && !timeText)
        return null;
    const { data, error } = await supabase.from('appointments').insert({
        client_id: config.DEFAULT_CLIENT_ID,
        student_id: studentId,
        conversation_id: conversationId,
        appointment_type: appointmentType ?? 'other',
        scheduled_at: scheduledAt,
        status: scheduledAt ? 'confirmed' : 'pending',
    }).select('*').single();
    if (error)
        throw error;
    return data;
}
export async function findRelevantKnowledge(text, category, limit = 6) {
    const terms = text
        .split(/[\s、。！？!?,.]+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2)
        .slice(0, 8);
    let query = supabase
        .from('knowledge_items')
        .select('id,title,category,body,priority,effective_from,effective_until')
        .eq('client_id', config.DEFAULT_CLIENT_ID)
        .eq('status', 'active')
        .order('priority', { ascending: false })
        .limit(limit);
    if (category)
        query = query.in('category', [category, 'general']);
    if (terms.length > 0) {
        const like = terms.map((term) => `title.ilike.%${term}%,body.ilike.%${term}%`).join(',');
        query = query.or(like);
    }
    const { data, error } = await query;
    if (error)
        throw error;
    return (data ?? []);
}
export async function getMonthlyRulesForReply(text, today = new Date()) {
    const months = monthsToCheck(text, today);
    const { data, error } = await supabase
        .from('monthly_rules')
        .select('id,rule_month,category,label,value,notes')
        .eq('client_id', config.DEFAULT_CLIENT_ID)
        .in('rule_month', months)
        .eq('status', 'active')
        .order('rule_month', { ascending: true });
    if (error)
        throw error;
    return (data ?? []);
}
function monthsToCheck(text, today) {
    const current = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const next = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
    const previous = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    const months = new Set([monthKey(current)]);
    if (/来月|次月|翌月/.test(text))
        months.add(monthKey(next));
    if (/先月|前月/.test(text))
        months.add(monthKey(previous));
    const explicit = text.match(/(20\d{2})年\s*(\d{1,2})月|(?<!\d)(\d{1,2})月/g) ?? [];
    for (const match of explicit) {
        const yearMatch = match.match(/(20\d{2})年\s*(\d{1,2})月/);
        const monthOnly = match.match(/(?<!\d)(\d{1,2})月/);
        const year = yearMatch ? Number(yearMatch[1]) : today.getUTCFullYear();
        const month = yearMatch ? Number(yearMatch[2]) : monthOnly ? Number(monthOnly[1]) : null;
        if (month && month >= 1 && month <= 12)
            months.add(`${year}-${String(month).padStart(2, '0')}`);
    }
    return Array.from(months);
}
function monthKey(date) {
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
    if (error)
        throw error;
    return {
        ok: true,
        candidates: (data ?? []).map((row) => ({
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
export async function createKnowledgeItem(input) {
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
    if (error)
        throw error;
    return data;
}
export async function upsertMonthlyRule(input) {
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
    if (error)
        throw error;
    return data;
}
