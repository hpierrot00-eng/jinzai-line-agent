import crypto from 'node:crypto';
import { WebClient } from '@slack/web-api';
import { config } from './config.js';
import { generateRevisionDraft } from './ai.js';
import { findRelevantKnowledge, getDraftWithContext, getMonthlyRulesForReply, getRecentMessages, getReplyDraftMarkAsReadToken, markDraftSendFailed, recordApprovalAction, recordDeliveryAttempt, recordOutgoingAndApproval, saveDraft, saveSlackReview, supabase } from './db.js';
import { markLineMessageAsRead, sendLineMessage } from './line.js';
import { approveWorkflowJob, getWorkflowApprovalDraft, selectWorkflowApplication, workflowApprovalResultBlocks } from './workflow.js';
import { confirmLineIdentityLink } from './sheets.js';
export const slack = new WebClient(config.SLACK_BOT_TOKEN);
function errorMessage(err) {
    if (err instanceof Error)
        return err.message;
    if (typeof err === 'string')
        return err;
    try {
        return JSON.stringify(err);
    }
    catch {
        return String(err);
    }
}
export function verifySlackSignature(rawBody, timestamp, signature) {
    if (!timestamp || !signature)
        return false;
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (age > 60 * 5)
        return false;
    const base = `v0:${timestamp}:${rawBody.toString('utf8')}`;
    const expected = `v0=${crypto.createHmac('sha256', config.SLACK_SIGNING_SECRET).update(base).digest('hex')}`;
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
async function sendApprovedReply(input) {
    const draft = await getDraftWithContext(input.replyDraftId);
    const student = draft.conversations.students;
    let providerResponse;
    let markAsReadResult;
    try {
        providerResponse = await sendLineMessage(student.line_user_id, input.text);
        markAsReadResult = await markReplyDraftTriggerAsRead(input.replyDraftId);
    }
    catch (err) {
        const message = errorMessage(err);
        await recordDeliveryAttempt({ replyDraftId: input.replyDraftId, lineUserId: student.line_user_id, text: input.text, status: 'failed', errorMessage: message, attemptedBySlackUserId: input.userId, action: input.action });
        await recordApprovalAction(input.replyDraftId, `${input.action}_send_failed`, input.userId, message, input.text);
        await markDraftSendFailed(input.replyDraftId, message, input.text);
        return { ok: false, draft, student, error: message };
    }
    const readWarning = markAsReadWarning(markAsReadResult);
    try {
        await recordDeliveryAttempt({ replyDraftId: input.replyDraftId, lineUserId: student.line_user_id, text: input.text, status: 'success', providerResponse: { lineSend: providerResponse, markAsRead: markAsReadResult }, attemptedBySlackUserId: input.userId, action: input.action });
        await recordOutgoingAndApproval(input.replyDraftId, input.action, input.userId, input.text);
        return readWarning ? { ok: true, draft, student, warning: readWarning } : { ok: true, draft, student };
    }
    catch (err) {
        const warning = [readWarning, `LINE送信は成功しましたが、DBログ保存に失敗しました: ${errorMessage(err)}`].filter(Boolean).join('\n');
        return { ok: true, draft, student, warning };
    }
}
async function markReplyDraftTriggerAsRead(replyDraftId) {
    try {
        const token = await getReplyDraftMarkAsReadToken(replyDraftId);
        return await markLineMessageAsRead(token);
    }
    catch (err) {
        const message = errorMessage(err);
        console.warn('LINE mark-as-read skipped:', message);
        return { ok: false, error: message };
    }
}
function markAsReadWarning(result) {
    const value = result;
    if (!value || value.ok || value.dryRun)
        return '';
    if (value.skipped && value.reason === 'missing_mark_as_read_token')
        return 'LINE送信は成功しましたが、Webhookに既読トークンが無かったため既読化はスキップしました。';
    if (value.skipped && value.reason === 'missing_line_channel_access_token')
        return 'LINE送信は成功しましたが、LINE_CHANNEL_ACCESS_TOKEN が無いため既読化はスキップしました。';
    if (value.skipped && value.reason === 'line_mark_as_read_disabled')
        return '';
    if (value.error)
        return `LINE送信は成功しましたが、既読化に失敗しました: ${value.error}`;
    return '';
}
function truncateText(value, max = 650) {
    const text = String(value ?? '').trim();
    if (text.length <= max)
        return text || '（本文なし）';
    return `${text.slice(0, max - 1)}…`;
}
function customerLabel(student) {
    const displayName = student?.display_name ?? student?.name ?? null;
    const lineId = student?.line_user_id ?? '不明';
    if (displayName)
        return `${displayName}\nLINE ID: ${lineId}`;
    return `LINE ID: ${lineId}`;
}
function historyLabel(message) {
    if (message.direction === 'incoming')
        return '学生';
    if (message.sender_type === 'human')
        return '担当';
    if (message.sender_type === 'ai')
        return 'AI';
    return message.direction === 'outgoing' ? '担当' : '不明';
}
function formatConversationHistory(messages, currentDraftText) {
    const recent = messages.slice(-5);
    if (recent.length === 0)
        return '*直近のやり取り*\n履歴なし';
    const lines = recent.map((message) => `*${historyLabel(message)}:* ${truncateText(message.content, 420)}`);
    return `*直近のやり取り*\n${lines.join('\n')}\n\n*この返信案で返す内容*\n${truncateText(currentDraftText, 650)}`;
}
function formatApplicationLabel(application) {
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
    return `${application.application_id ?? application.id} / ${application.agent_name ?? 'エージェント未設定'} / ${scheduled}`;
}
function workflowSelectionValue(application, intent, eventText, incomingMessageId) {
    return JSON.stringify({
        applicationRefId: application.id,
        intent,
        eventText: String(eventText ?? '').slice(0, 900),
        incomingMessageId,
    });
}
function workflowSentText(sentTexts) {
    if (sentTexts.length === 0)
        return '送信文なし';
    return sentTexts.map((text, index) => `${index + 1}. ${truncateText(text, 500)}`).join('\n');
}
function identityCandidateLabel(candidate) {
    const parts = [
        candidate.studentName ? `名前: ${candidate.studentName}` : null,
        candidate.studentFurigana ? `フリガナ: ${candidate.studentFurigana}` : null,
        candidate.lineDisplayName ? `LINE名: ${candidate.lineDisplayName}` : null,
        candidate.externalStudentId ? `student_id: ${candidate.externalStudentId}` : null,
        candidate.applicationIds?.length ? `申込: ${candidate.applicationIds.join(', ')}` : null,
    ].filter(Boolean);
    return parts.join(' / ') || candidate.matchKey;
}
function identitySelectionValue(candidate, event) {
    return JSON.stringify({
        matchKey: candidate.matchKey,
        lineUserId: event.lineUserId,
        displayName: event.displayName ?? '',
        eventText: String(event.text ?? '').slice(0, 900),
    });
}
function retryBlocks(replyDraftId, text, error) {
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
export async function postApprovalMessage(replyDraftId) {
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
    if (!result.ok || !result.ts || !result.channel)
        throw new Error(`Slack post failed: ${result.error}`);
    await saveSlackReview(replyDraftId, result.channel, result.ts, result.ts);
    return result;
}
export async function postWorkflowNotification(workflow, event, student) {
    if (workflow.needsSelection) {
        const elements = workflow.applications.slice(0, 5).map((application, index) => ({
            type: 'button',
            text: { type: 'plain_text', text: `候補${index + 1}で処理` },
            action_id: 'workflow_select_application',
            value: workflowSelectionValue(application, workflow.classification.intent, event.text, workflow.incomingMessageId),
        }));
        const blocks = [
            { type: 'header', text: { type: 'plain_text', text: 'LINE自動処理: 申込候補の確認', emoji: true } },
            { type: 'section', fields: [
                    { type: 'mrkdwn', text: `*顧客:*\n${customerLabel(student)}` },
                    { type: 'mrkdwn', text: `*分類:*\n${workflow.classification.intent} / ${workflow.classification.risk}` },
                ] },
            { type: 'section', text: { type: 'mrkdwn', text: `*受信文:*\n${truncateText(event.text, 650)}\n\n*理由:*\n${workflow.classification.reason}` } },
            { type: 'section', text: { type: 'mrkdwn', text: `*候補申込:*\n${workflow.applications.map((application, index) => `${index + 1}. ${formatApplicationLabel(application)} / status: ${application.current_status}`).join('\n')}` } },
            { type: 'actions', elements },
        ];
        const result = await slack.chat.postMessage({
            channel: config.SLACK_APPROVAL_CHANNEL_ID,
            text: `LINE自動処理候補確認: ${student?.display_name ?? student?.line_user_id ?? event.lineUserId}`,
            blocks,
        });
        if (!result.ok)
            throw new Error(`Slack workflow notification failed: ${result.error}`);
        return result;
    }
    const sentTexts = Array.isArray(workflow.sentTexts) ? workflow.sentTexts : [];
    const application = workflow.application;
    const blocks = [
        { type: 'header', text: { type: 'plain_text', text: 'LINE自動処理済み', emoji: true } },
        { type: 'section', fields: [
                { type: 'mrkdwn', text: `*顧客:*\n${customerLabel(student)}` },
                { type: 'mrkdwn', text: `*申込:*\n${application ? formatApplicationLabel(application) : '不明'}` },
                { type: 'mrkdwn', text: `*分類:*\n${workflow.classification?.intent ?? 'unknown'} / ${workflow.classification?.risk ?? 'unknown'}` },
                { type: 'mrkdwn', text: `*dry-run:*\n${workflow.dryRun ? 'true' : 'false'}` },
            ] },
        { type: 'section', text: { type: 'mrkdwn', text: `*受信文:*\n${truncateText(event.text, 650)}\n\n*自動送信した内容:*\n${workflowSentText(sentTexts)}` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `理由: ${truncateText(workflow.classification?.reason ?? 'なし', 250)}` }] },
    ];
    const result = await slack.chat.postMessage({
        channel: config.SLACK_APPROVAL_CHANNEL_ID,
        text: `LINE自動処理済み: ${student?.display_name ?? student?.line_user_id ?? event.lineUserId}`,
        blocks,
    });
    if (!result.ok)
        throw new Error(`Slack workflow notification failed: ${result.error}`);
    if (application?.id) {
        await supabase.from('referral_applications').update({ slack_notified_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', application.id);
    }
    return result;
}
export async function postLineIdentityNotification(result, event, student) {
    if (result.status === 'multiple') {
        const elements = result.candidates.slice(0, 5).map((candidate, index) => ({
            type: 'button',
            text: { type: 'plain_text', text: `候補${index + 1}に紐づけ` },
            action_id: 'line_identity_select',
            value: identitySelectionValue(candidate, event),
        }));
        const blocks = [
            { type: 'header', text: { type: 'plain_text', text: 'LINEユーザー紐づけ候補', emoji: true } },
            { type: 'section', fields: [
                    { type: 'mrkdwn', text: `*受信LINE:*\n${customerLabel(student)}` },
                    { type: 'mrkdwn', text: `*抽出候補:*\n${(result.nameCandidates ?? []).join(', ') || 'なし'}` },
                ] },
            { type: 'section', text: { type: 'mrkdwn', text: `*受信文:*\n${truncateText(event.text, 650)}` } },
            { type: 'section', text: { type: 'mrkdwn', text: `*候補:*\n${result.candidates.map((candidate, index) => `${index + 1}. ${identityCandidateLabel(candidate)} / score: ${candidate.score} / ${candidate.reasons.join(', ')}`).join('\n')}` } },
            { type: 'actions', elements },
        ];
        const slackResult = await slack.chat.postMessage({
            channel: config.SLACK_APPROVAL_CHANNEL_ID,
            text: `LINEユーザー紐づけ候補: ${student?.display_name ?? student?.line_user_id ?? event.lineUserId}`,
            blocks,
        });
        if (!slackResult.ok)
            throw new Error(`Slack identity notification failed: ${slackResult.error}`);
        return slackResult;
    }
    const blocks = [
        { type: 'header', text: { type: 'plain_text', text: 'LINEユーザー未紐づけ', emoji: true } },
        { type: 'section', fields: [
                { type: 'mrkdwn', text: `*受信LINE:*\n${customerLabel(student)}` },
                { type: 'mrkdwn', text: `*抽出候補:*\n${(result.nameCandidates ?? []).join(', ') || 'なし'}` },
            ] },
        { type: 'section', text: { type: 'mrkdwn', text: `*受信文:*\n${truncateText(event.text, 650)}\n\nSheetsの名前・フリガナ・LINE名のいずれにも一意一致しませんでした。` } },
    ];
    const slackResult = await slack.chat.postMessage({
        channel: config.SLACK_APPROVAL_CHANNEL_ID,
        text: `LINEユーザー未紐づけ: ${student?.display_name ?? student?.line_user_id ?? event.lineUserId}`,
        blocks,
    });
    if (!slackResult.ok)
        throw new Error(`Slack identity notification failed: ${slackResult.error}`);
    return slackResult;
}
function formResponseLine(result, kind) {
    const response = result.response ?? {};
    const base = kind === 'post'
        ? `${response.studentName ?? '名前なし'} / ${response.agentName ?? '案件なし'} / ${response.participationDate ?? '参加日なし'}`
        : `${response.studentName ?? '名前なし'} / ${response.studentFurigana ?? 'フリガナなし'} / ${response.universityName ?? '大学名なし'}`;
    const candidates = (result.candidates ?? []).slice(0, 5).map((candidate) => {
        if (kind === 'post')
            return `${candidate.application_id ?? candidate.id} / ${candidate.student_name ?? candidate.students?.name ?? '名前なし'} / ${candidate.agent_name ?? '案件なし'}`;
        return `${candidate.name ?? candidate.display_name ?? candidate.id} / ${candidate.furigana ?? 'フリガナなし'} / ${candidate.school_name ?? '大学名なし'}`;
    });
    return `*回答:* ${base}\n*状態:* ${result.status}${result.matchRule ? ` / ${result.matchRule}` : ''}\n*候補:*\n${candidates.length ? candidates.join('\n') : 'なし'}`;
}
export async function postFormResponseMatchNotification(syncResult) {
    const failures = [
        syncResult.postParticipation?.ok === false ? `参加確認フォーム: ${syncResult.postParticipation.error ?? 'unknown error'}` : null,
        syncResult.bankAccount?.ok === false ? `TS/銀行口座フォーム: ${syncResult.bankAccount.error ?? 'unknown error'}` : null,
    ].filter(Boolean);
    const postIssues = (syncResult.postParticipation?.results ?? []).filter((result) => result.status === 'multiple' || result.status === 'unmatched');
    const bankIssues = (syncResult.bankAccount?.results ?? []).filter((result) => result.status === 'multiple' || result.status === 'unmatched');
    if (failures.length === 0 && postIssues.length === 0 && bankIssues.length === 0)
        return null;
    const blocks = [
        { type: 'header', text: { type: 'plain_text', text: 'フォーム回答の照合確認', emoji: true } },
    ];
    if (failures.length > 0) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*同期エラー:*\n${failures.map((item) => `• ${item}`).join('\n')}` } });
    }
    if (postIssues.length > 0) {
        const skipped = Number(syncResult.postParticipation?.skippedBeforeStart ?? 0);
        const rangeText = syncResult.postParticipation?.syncStartAt ? `\n_対象: ${syncResult.postParticipation.syncStartAt} 以降 / 過去スキップ ${skipped}件_` : '';
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*参加確認フォーム:*${rangeText}\n${postIssues.slice(0, 8).map((result) => formResponseLine(result, 'post')).join('\n\n')}` } });
    }
    if (bankIssues.length > 0) {
        const skipped = Number(syncResult.bankAccount?.skippedBeforeStart ?? 0);
        const rangeText = syncResult.bankAccount?.syncStartAt ? `\n_対象: ${syncResult.bankAccount.syncStartAt} 以降 / 過去スキップ ${skipped}件_` : '';
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*TS/銀行口座フォーム:*${rangeText}\n${bankIssues.slice(0, 8).map((result) => formResponseLine(result, 'bank')).join('\n\n')}` } });
    }
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: failures.length > 0 ? '同期エラーはcronを落とさず通知しています。一意に決まらなかった回答は管理シートまたは回答内容を確認してください。' : '一意に決まらなかった回答だけ表示しています。管理シートまたは回答内容を確認してください。' }] });
    const result = await slack.chat.postMessage({
        channel: config.SLACK_APPROVAL_CHANNEL_ID,
        text: 'フォーム回答の照合確認',
        blocks,
    });
    if (!result.ok)
        throw new Error(`Slack form response notification failed: ${result.error}`);
    return result;
}
export async function handleSlackInteraction(payload) {
    const action = payload?.actions?.[0];
    const actionId = action?.action_id;
    const replyDraftId = action?.value;
    const userId = payload?.user?.id;
    if (payload.type === 'view_submission')
        return handleModalSubmission(payload);
    if (!actionId || !userId)
        return;
    if (actionId === 'workflow_select_application') {
        const selection = JSON.parse(action.value || '{}');
        const result = await selectWorkflowApplication({
            applicationRefId: selection.applicationRefId,
            intent: selection.intent,
            eventText: selection.eventText ?? '',
            incomingMessageId: selection.incomingMessageId,
        });
        await slack.chat.update({
            channel: payload.channel.id,
            ts: payload.message.ts,
            text: '申込選択済み',
            blocks: [
                { type: 'section', text: { type: 'mrkdwn', text: `✅ 選択した申込で自動処理しました\n*送信内容:*\n${workflowSentText(result.sentTexts ?? [])}` } },
            ],
        });
        return;
    }
    if (actionId === 'line_identity_select') {
        const selection = JSON.parse(action.value || '{}');
        const result = await confirmLineIdentityLink({
            matchKey: selection.matchKey,
            lineUserId: selection.lineUserId,
            displayName: selection.displayName || undefined,
            eventText: selection.eventText ?? '',
        });
        if (!result.ok) {
            await slack.chat.update({
                channel: payload.channel.id,
                ts: payload.message.ts,
                text: 'LINE紐づけ失敗',
                blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '⚠️ 候補が見つからず、LINEユーザーIDを紐づけできませんでした。Sheetsの内容を確認してください。' } }],
            });
            return;
        }
        await slack.chat.update({
            channel: payload.channel.id,
            ts: payload.message.ts,
            text: 'LINE紐づけ済み',
            blocks: [{
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `✅ LINEユーザーIDを紐づけました\n*対象:*\n${identityCandidateLabel(result.candidate)}\n*更新行数:*\n${result.linkedRows}\n*Sheets dry-run:*\n${result.sheetWrite?.dryRun ? 'true' : 'false'}`,
                    },
                }],
        });
        return;
    }
    if (actionId === 'workflow_approve_send') {
        const jobId = action.value;
        try {
            const result = await approveWorkflowJob({ jobId, userId });
            await slack.chat.update({
                channel: payload.channel.id,
                ts: payload.message.ts,
                text: result.dryRun ? 'ワークフローdry-run済み' : 'ワークフロー送信済み',
                blocks: workflowApprovalResultBlocks(result),
            });
        }
        catch (err) {
            await slack.chat.update({
                channel: payload.channel.id,
                ts: payload.message.ts,
                text: 'ワークフロー送信失敗',
                blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `⚠️ LINE送信に失敗しました\n*理由:*\n${errorMessage(err)}` } }],
            });
        }
        return;
    }
    if (actionId === 'workflow_edit_send') {
        const jobId = action.value;
        const draft = await getWorkflowApprovalDraft(jobId);
        await slack.views.open({
            trigger_id: payload.trigger_id,
            view: {
                type: 'modal',
                callback_id: 'workflow_edit_send_modal',
                private_metadata: JSON.stringify({ jobId, channel: payload.channel.id, ts: payload.message.ts }),
                title: { type: 'plain_text', text: '編集して送信' },
                submit: { type: 'plain_text', text: 'LINE送信' },
                close: { type: 'plain_text', text: 'キャンセル' },
                blocks: [{ type: 'input', block_id: 'text_block', label: { type: 'plain_text', text: '送信文' }, element: { type: 'plain_text_input', action_id: 'text', multiline: true, initial_value: draft.text } }],
            },
        });
        return;
    }
    if (actionId === 'workflow_escalate') {
        const jobId = action.value;
        await supabase.from('workflow_jobs').update({ status: 'escalated', error_message: 'Escalated from Slack', updated_at: new Date().toISOString() }).eq('id', jobId);
        await slack.chat.update({ channel: payload.channel.id, ts: payload.message.ts, text: '人間対応', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '👤 このワークフロー送信を人間対応に切り替えました' } }] });
        return;
    }
    if (!replyDraftId)
        return;
    if (actionId === 'approve_send' || actionId === 'retry_send') {
        const draft = await getDraftWithContext(replyDraftId);
        const retryText = typeof draft.extracted_data?.last_failed_text === 'string' ? draft.extracted_data.last_failed_text : draft.draft_text;
        const text = actionId === 'retry_send' ? retryText : draft.draft_text;
        const actionName = actionId === 'retry_send' ? 'retry_send' : 'approve';
        const result = await sendApprovedReply({ replyDraftId, action: actionName, userId, text });
        if (result.ok) {
            const warning = 'warning' in result ? `\n\n⚠️ ${result.warning}` : '';
            await slack.chat.update({ channel: payload.channel.id, ts: payload.message.ts, text: '送信済み', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `✅ LINE送信済み${warning}\n*送信文:*\n${text}` } }] });
        }
        else {
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
async function handleModalSubmission(payload) {
    const meta = JSON.parse(payload.view.private_metadata || '{}');
    const userId = payload.user.id;
    if (payload.view.callback_id === 'edit_send_modal') {
        const text = payload.view.state.values.text_block.text.value;
        const result = await sendApprovedReply({ replyDraftId: meta.replyDraftId, action: 'edit_and_approve', userId, text });
        if (result.ok) {
            const warning = 'warning' in result ? `\n\n⚠️ ${result.warning}` : '';
            await slack.chat.update({ channel: meta.channel, ts: meta.ts, text: '編集送信済み', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `✅ 編集後の文面をLINE送信しました${warning}\n*送信文:*\n${text}` } }] });
        }
        else {
            await slack.chat.update({ channel: meta.channel, ts: meta.ts, text: 'LINE送信失敗', blocks: retryBlocks(meta.replyDraftId, text, result.error) });
        }
    }
    if (payload.view.callback_id === 'workflow_edit_send_modal') {
        const text = payload.view.state.values.text_block.text.value;
        try {
            const result = await approveWorkflowJob({ jobId: meta.jobId, userId, text });
            await slack.chat.update({
                channel: meta.channel,
                ts: meta.ts,
                text: result.dryRun ? '編集dry-run済み' : '編集送信済み',
                blocks: workflowApprovalResultBlocks(result, true),
            });
        }
        catch (err) {
            await slack.chat.update({
                channel: meta.channel,
                ts: meta.ts,
                text: 'ワークフロー送信失敗',
                blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `⚠️ LINE送信に失敗しました\n*理由:*\n${errorMessage(err)}\n\n送信文は未送信です。` } }],
            });
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
