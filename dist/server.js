import express from 'express';
import { config } from './config.js';
import { generateDraft } from './ai.js';
import { createAppointmentIfExtracted, createKnowledgeItem, findRelevantKnowledge, getMonthlyRulesForReply, getOrCreateConversation, getRecentMessages, listKnowledgeCandidates, saveDraft, saveIncomingMessage, upsertMonthlyRule, upsertStudent } from './db.js';
import { extractLineEvents, verifyLineSignature } from './line.js';
import { handleSlackInteraction, postApprovalMessage, verifySlackSignature } from './slack.js';
const app = express();
app.use('/webhooks/slack/interactions', express.raw({ type: 'application/x-www-form-urlencoded' }));
app.use('/webhooks/line', express.raw({ type: '*/*' }));
app.use('/line-harness/inbound', express.json({ limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.get('/', (_req, res) => res.json({ ok: true, service: 'jinzai-line-agent', docs: 'Use /health for health checks.' }));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'jinzai-line-agent', mode: 'draft_only' }));
function requireAdmin(req, res) {
    if (!config.ADMIN_API_KEY)
        return true;
    if (req.header('authorization') === `Bearer ${config.ADMIN_API_KEY}`)
        return true;
    res.status(401).json({ ok: false, error: 'invalid admin api key' });
    return false;
}
async function processInbound(body) {
    const events = extractLineEvents(body);
    const results = [];
    for (const event of events) {
        const student = await upsertStudent(event);
        const conversation = await getOrCreateConversation(student.id);
        const incoming = await saveIncomingMessage(event, student.id, conversation.id);
        const history = await getRecentMessages(conversation.id);
        const category = /支払|支払い|入金|報酬|料金|返金|契約|条件/.test(event.text)
            ? 'payment'
            : /日程|予定|面談|いつ|何時|都合|空い|空き|予約|リスケ|変更/.test(event.text)
                ? 'schedule'
                : undefined;
        const [knowledge, monthlyRules] = await Promise.all([
            findRelevantKnowledge(event.text, category),
            getMonthlyRulesForReply(event.text),
        ]);
        const draftResult = await generateDraft({ text: event.text, history, student, knowledge, monthlyRules, today: new Date().toISOString() });
        const appointment = await createAppointmentIfExtracted(student.id, conversation.id, draftResult.extracted_data);
        const draft = await saveDraft(conversation.id, incoming.id, draftResult);
        const slackMessage = await postApprovalMessage(draft.id);
        results.push({ studentId: student.id, conversationId: conversation.id, messageId: incoming.id, appointmentId: appointment?.id, replyDraftId: draft.id, slackTs: slackMessage.ts });
    }
    return results;
}
app.post('/webhooks/line', async (req, res, next) => {
    try {
        const raw = req.body;
        if (!verifyLineSignature(raw, req.header('x-line-signature') ?? undefined))
            return res.status(401).send('invalid line signature');
        const body = JSON.parse(raw.toString('utf8'));
        const results = await processInbound(body);
        res.json({ ok: true, results });
    }
    catch (err) {
        next(err);
    }
});
// Generic endpoint for an already-set-up LINE Harness to forward normalized inbound messages.
app.post('/line-harness/inbound', async (req, res, next) => {
    try {
        const results = await processInbound(req.body);
        res.json({ ok: true, results });
    }
    catch (err) {
        next(err);
    }
});
app.post('/webhooks/slack/interactions', async (req, res, next) => {
    try {
        const raw = req.body;
        if (!verifySlackSignature(raw, req.header('x-slack-request-timestamp') ?? undefined, req.header('x-slack-signature') ?? undefined)) {
            return res.status(401).send('invalid slack signature');
        }
        const params = new URLSearchParams(raw.toString('utf8'));
        const payload = JSON.parse(params.get('payload') || '{}');
        // Slack needs a fast acknowledgement; continue async after ack.
        res.status(200).send('');
        await handleSlackInteraction(payload);
    }
    catch (err) {
        next(err);
    }
});
app.get('/knowledge/candidates', async (req, res, next) => {
    try {
        if (!requireAdmin(req, res))
            return;
        const limit = req.query.limit ? Number(req.query.limit) : 30;
        res.json(await listKnowledgeCandidates(limit));
    }
    catch (err) {
        next(err);
    }
});
app.post('/knowledge-items', async (req, res, next) => {
    try {
        if (!requireAdmin(req, res))
            return;
        const item = await createKnowledgeItem(req.body);
        res.status(201).json({ ok: true, item });
    }
    catch (err) {
        next(err);
    }
});
app.post('/monthly-rules', async (req, res, next) => {
    try {
        if (!requireAdmin(req, res))
            return;
        const rule = await upsertMonthlyRule(req.body);
        res.status(201).json({ ok: true, rule });
    }
    catch (err) {
        next(err);
    }
});
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
app.use((err, _req, res, _next) => {
    console.error(err);
    if (!res.headersSent)
        res.status(500).json({ ok: false, error: errorMessage(err) });
});
app.listen(config.PORT, () => {
    console.log(`jinzai-line-agent listening on :${config.PORT}`);
});
