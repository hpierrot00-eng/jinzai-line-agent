import crypto from 'node:crypto';
import { WebClient } from '@slack/web-api';
import { config } from './config.js';
import { generateRevisionDraft } from './ai.js';
import { findRelevantKnowledge, getDraftWithContext, getMonthlyRulesForReply, getRecentMessages, markDraftSendFailed, recordApprovalAction, recordDeliveryAttempt, recordOutgoingAndApproval, saveDraft, saveSlackReview, supabase } from './db.js';
import { sendLineMessage } from './line.js';

export const slack = new WebClient(config.SLACK_BOT_TOKEN);

function errorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function verifySlackSignature(rawBody: Buffer, timestamp?: string, signature?: string) {
  if (!timestamp || !signature) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > 60 * 5) return false;
  const base = `v0:${timestamp}:${rawBody.toString('utf8')}`;
  const expected = `v0=${crypto.createHmac('sha256', config.SLACK_SIGNING_SECRET).update(base).digest('hex')}`;
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

async function sendApprovedReply(input: { replyDraftId: string; action: string; userId: string; text: string }) {
  const draft = await getDraftWithContext(input.replyDraftId);
  const student = draft.conversations.students;
  try {
    await sendLineMessage(student.line_user_id, input.text);
  } catch (err) {
    const message = errorMessage(err);
    await recordDeliveryAttempt({ replyDraftId: input.replyDraftId, lineUserId: student.line_user_id, text: input.text, status: 'failed', errorMessage: message, attemptedBySlackUserId: input.userId, action: input.action });
    await recordApprovalAction(input.replyDraftId, `${input.action}_send_failed`, input.userId, message, input.text);
    await markDraftSendFailed(input.replyDraftId, message, input.text);
    return { ok: false as const, draft, student, error: message };
  }

  try {
    await recordDeliveryAttempt({ replyDraftId: input.replyDraftId, lineUserId: student.line_user_id, text: input.text, status: 'success', attemptedBySlackUserId: input.userId, action: input.action });
    await recordOutgoingAndApproval(input.replyDraftId, input.action, input.userId, input.text);
    return { ok: true as const, draft, student };
  } catch (err) {
    return { ok: true as const, draft, student, warning: `LINE送信は成功しましたが、DBログ保存に失敗しました: ${errorMessage(err)}` };
  }
}

function truncateText(value: unknown, max = 650) {
  const text = String(value ?? '').trim();
  if (text.length <= max) return text || '（本文なし）';
  return `${text.slice(0, max - 1)}…`;
}

function customerLabel(student: any) {
  const displayName = student?.display_name ?? student?.name ?? null;
  const lineId = student?.line_user_id ?? '不明';
  if (displayName) return `${displayName}\nLINE ID: ${lineId}`;
  return `LINE ID: ${lineId}`;
}

function historyLabel(message: any) {
  if (message.direction === 'incoming') return '学生';
  if (message.sender_type === 'human') return '担当';
  if (message.sender_type === 'ai') return 'AI';
  return message.direction === 'outgoing' ? '担当' : '不明';
}

function formatConversationHistory(messages: any[], currentDraftText: string) {
  const recent = messages.slice(-5);
  if (recent.length === 0) return '*直近のやり取り*\n履歴なし';
  const lines = recent.map((message) => `*${historyLabel(message)}:* ${truncateText(message.content, 420)}`);
  return `*直近のやり取り*\n${lines.join('\n')}\n\n*この返信案で返す内容*\n${truncateText(currentDraftText, 650)}`;
}

function retryBlocks(replyDraftId: string, text: string, error: string) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `⚠️ LINE送信に失敗しました\n*理由:*\n${error}\n\n返信案はまだ送信されていません。設定確認後に再送できます。` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*未送信の文面*\n${text}` } },
    { type: 'actions', elements: [
      { type: 'button', text: { type: 'plain_text', text: '同じ文面で再送' }, style: 'primary', action_id: 'retry_send', value: replyDraftId },
      { type: 'button', text: { type: 'plain_text', text: '編集して送信' }, action_id: 'edit_send', value: replyDraftId },
      { type: 'button', text: { type: 'plain_text', text: '人間対応' }, action_id: 'escalate', value: replyDraftId },
    ] },
  ];
}

export async function postApprovalMessage(replyDraftId: string) {
  const draft = await getDraftWithContext(replyDraftId);
  const student = draft.conversations?.students;
  const history = await getRecentMessages(draft.conversation_id);
  const result = await slack.chat.postMessage({
    channel: config.SLACK_APPROVAL_CHANNEL_ID,
    text: `LINE返信承認: ${student?.display_name ?? student?.line_user_id ?? draft.category ?? '未分類'}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'LINE問い合わせ対応', emoji: true } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*顧客:*\n${customerLabel(student)}` },
        { type: 'mrkdwn', text: `*ステータス:*\n${draft.status ?? 'posted_to_slack'}` },
        { type: 'mrkdwn', text: `*分類:*\n${draft.category ?? '未分類'}` },
        { type: 'mrkdwn', text: `*リスク:*\n${draft.risk_level ?? 'unknown'} / 信頼度 ${Math.round(Number(draft.confidence ?? 0) * 100)}%` },
      ] },
      { type: 'section', text: { type: 'mrkdwn', text: formatConversationHistory(history, draft.draft_text) } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `理由: ${truncateText(draft.reason ?? 'なし', 250)}` }] },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: '承認して送信' }, style: 'primary', action_id: 'approve_send', value: replyDraftId },
        { type: 'button', text: { type: 'plain_text', text: '編集して送信' }, action_id: 'edit_send', value: replyDraftId },
        { type: 'button', text: { type: 'plain_text', text: '修正依頼' }, action_id: 'request_revision', value: replyDraftId },
        { type: 'button', text: { type: 'plain_text', text: '人間対応' }, action_id: 'escalate', value: replyDraftId },
        { type: 'button', text: { type: 'plain_text', text: '却下' }, style: 'danger', action_id: 'reject', value: replyDraftId },
      ] },
    ],
  });
  if (!result.ok || !result.ts || !result.channel) throw new Error(`Slack post failed: ${result.error}`);
  await saveSlackReview(replyDraftId, result.channel, result.ts, result.ts);
  return result;
}

export async function handleSlackInteraction(payload: any) {
  const action = payload?.actions?.[0];
  const actionId = action?.action_id;
  const replyDraftId = action?.value;
  const userId = payload?.user?.id;

  if (payload.type === 'view_submission') return handleModalSubmission(payload);
  if (!actionId || !replyDraftId || !userId) return;

  if (actionId === 'approve_send' || actionId === 'retry_send') {
    const draft = await getDraftWithContext(replyDraftId);
    const retryText = typeof draft.extracted_data?.last_failed_text === 'string' ? draft.extracted_data.last_failed_text : draft.draft_text;
    const text = actionId === 'retry_send' ? retryText : draft.draft_text;
    const actionName = actionId === 'retry_send' ? 'retry_send' : 'approve';
    const result = await sendApprovedReply({ replyDraftId, action: actionName, userId, text });
    if (result.ok) {
      const warning = 'warning' in result ? `\n\n⚠️ ${result.warning}` : '';
      await slack.chat.update({ channel: payload.channel.id, ts: payload.message.ts, text: '送信済み', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `✅ LINE送信済み${warning}\n*送信文:*\n${text}` } }] });
    } else {
      await slack.chat.update({ channel: payload.channel.id, ts: payload.message.ts, text: 'LINE送信失敗', blocks: retryBlocks(replyDraftId, text, result.error) });
    }
    return;
  }

  if (actionId === 'edit_send') {
    const draft = await getDraftWithContext(replyDraftId);
    await slack.views.open({
      trigger_id: payload.trigger_id,
      view: {
        type: 'modal', callback_id: 'edit_send_modal', private_metadata: JSON.stringify({ replyDraftId, channel: payload.channel.id, ts: payload.message.ts }),
        title: { type: 'plain_text', text: '編集して送信' }, submit: { type: 'plain_text', text: 'LINE送信' }, close: { type: 'plain_text', text: 'キャンセル' },
        blocks: [{ type: 'input', block_id: 'text_block', label: { type: 'plain_text', text: '返信文' }, element: { type: 'plain_text_input', action_id: 'text', multiline: true, initial_value: draft.draft_text } }],
      },
    });
    return;
  }

  if (actionId === 'request_revision') {
    await slack.views.open({
      trigger_id: payload.trigger_id,
      view: {
        type: 'modal', callback_id: 'revision_modal', private_metadata: JSON.stringify({ replyDraftId, channel: payload.channel.id, ts: payload.message.ts }),
        title: { type: 'plain_text', text: '修正依頼' }, submit: { type: 'plain_text', text: '再ドラフト' }, close: { type: 'plain_text', text: 'キャンセル' },
        blocks: [{ type: 'input', block_id: 'comment_block', label: { type: 'plain_text', text: '修正指示' }, element: { type: 'plain_text_input', action_id: 'comment', multiline: true, placeholder: { type: 'plain_text', text: 'もっと短く、支払い表現をぼかす、など' } } }],
      },
    });
    return;
  }

  if (actionId === 'escalate' || actionId === 'reject') {
    await supabase.from('reply_drafts').update({ status: actionId === 'escalate' ? 'escalated' : 'rejected', updated_at: new Date().toISOString() }).eq('id', replyDraftId);
    await recordApprovalAction(replyDraftId, actionId, userId);
    await slack.chat.update({ channel: payload.channel.id, ts: payload.message.ts, text: actionId, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: actionId === 'escalate' ? '👤 人間対応に切り替えました' : '🛑 返信案を却下しました' } }] });
  }
}

async function handleModalSubmission(payload: any) {
  const meta = JSON.parse(payload.view.private_metadata || '{}');
  const userId = payload.user.id;
  if (payload.view.callback_id === 'edit_send_modal') {
    const text = payload.view.state.values.text_block.text.value;
    const result = await sendApprovedReply({ replyDraftId: meta.replyDraftId, action: 'edit_and_approve', userId, text });
    if (result.ok) {
      const warning = 'warning' in result ? `\n\n⚠️ ${result.warning}` : '';
      await slack.chat.update({ channel: meta.channel, ts: meta.ts, text: '編集送信済み', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `✅ 編集後の文面をLINE送信しました${warning}\n*送信文:*\n${text}` } }] });
    } else {
      await slack.chat.update({ channel: meta.channel, ts: meta.ts, text: 'LINE送信失敗', blocks: retryBlocks(meta.replyDraftId, text, result.error) });
    }
  }
  if (payload.view.callback_id === 'revision_modal') {
    const comment = payload.view.state.values.comment_block.comment.value;
    const draft = await getDraftWithContext(meta.replyDraftId);
    const history = await getRecentMessages(draft.conversation_id);
    const [knowledge, monthlyRules] = await Promise.all([
      findRelevantKnowledge(`${draft.draft_text}\n${comment}`, draft.category ?? undefined),
      getMonthlyRulesForReply(`${draft.draft_text}\n${comment}`),
    ]);
    const revised = await generateRevisionDraft({ currentDraftText: draft.draft_text, instruction: comment, history, student: draft.conversations.students, knowledge, monthlyRules, today: new Date().toISOString() });
    const newDraft = await saveDraft(draft.conversation_id, draft.trigger_message_id, revised);

    await recordApprovalAction(meta.replyDraftId, 'request_revision', userId, comment);
    await supabase.from('reply_drafts').update({ status: 'revision_requested', updated_at: new Date().toISOString() }).eq('id', meta.replyDraftId);
    await slack.chat.update({ channel: meta.channel, ts: meta.ts, text: '修正依頼済み', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `🔁 修正依頼を受け付けました\n*指示:*\n${comment}` } }] });
    const review = await postApprovalMessage(newDraft.id);
    await slack.chat.postMessage({ channel: meta.channel, thread_ts: meta.ts, text: `新しい返信案を投稿しました: <#${review.channel}> ${review.ts}` });
  }
}
