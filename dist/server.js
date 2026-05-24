import express from 'express';
import { config } from './config.js';
import { generateDraft } from './ai.js';
import { approveMessageTemplate, createAppointmentIfExtracted, createKnowledgeItem, findMessageTemplates, findRelevantKnowledge, getMonthlyRulesForReply, getOrCreateConversation, getRecentMessages, importPastTalkExamples, listKnowledgeCandidates, listMessageTemplates, promoteApprovedRepliesToKnowledge, saveDraft, saveIncomingMessage, upsertMessageTemplate, upsertMonthlyRule, upsertStudent } from './db.js';
import { extractLineEvents, findLineDisplayName, verifyLineSignature } from './line.js';
import { handleSlackInteraction, postApprovalMessage, postFormResponseMatchNotification, postLineIdentityNotification, postWorkflowNotification, verifySlackSignature } from './slack.js';
import { rebuildWorkflowJobs, runWorkflowTick, processWorkflowReply, WORKFLOW_STATUSES } from './workflow.js';
import { linkLineUserFromSheets, syncFormResponseSheets, syncSheetsToSupabase, writeApplicationsToSheets } from './sheets.js';
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
    const dryRun = Boolean(body?.dryRun);
    for (const event of events) {
        const displayName = event.displayName ?? await findLineDisplayName(event.lineUserId) ?? undefined;
        const eventWithProfile = { ...event, displayName };
        const student = await upsertStudent(eventWithProfile);
        const conversation = await getOrCreateConversation(student.id);
        const incoming = await saveIncomingMessage(eventWithProfile, student.id, conversation.id);
        try {
            const identityLink = await linkLineUserFromSheets({ event: eventWithProfile, dryRun });
            if (identityLink.status === 'multiple' || identityLink.status === 'unmatched') {
                await postLineIdentityNotification(identityLink, eventWithProfile, student);
            }
        }
        catch (err) {
            // Identity linking is an operator convenience. It must not block LINE intake.
            console.warn('LINE identity linking skipped:', errorMessage(err));
        }
        try {
            const workflow = await processWorkflowReply({ student, event: eventWithProfile, dryRun });
            if (workflow.handled) {
                const workflowForSlack = { ...workflow, incomingMessageId: incoming.id };
                const slackMessage = await postWorkflowNotification(workflowForSlack, eventWithProfile, student);
                results.push({
                    studentId: student.id,
                    conversationId: conversation.id,
                    messageId: incoming.id,
                    workflow: workflowForSlack,
                    slackTs: slackMessage?.ts,
                });
                continue;
            }
        }
        catch (err) {
            // Missing workflow tables should not break the pre-existing Slack approval flow during rollout.
            console.warn('workflow auto-processing skipped:', errorMessage(err));
        }
        const history = await getRecentMessages(conversation.id);
        const category = /支払|支払い|入金|報酬|料金|返金|契約|条件/.test(eventWithProfile.text)
            ? 'payment'
            : /日程|予定|面談|いつ|何時|都合|空い|空き|予約|リスケ|変更/.test(eventWithProfile.text)
                ? 'schedule'
                : undefined;
        const [knowledge, monthlyRules, templates] = await Promise.all([
            findRelevantKnowledge(eventWithProfile.text, category),
            getMonthlyRulesForReply(eventWithProfile.text),
            findMessageTemplates(category),
        ]);
        const draftResult = await generateDraft({ text: eventWithProfile.text, history, student, knowledge, monthlyRules, templates, today: new Date().toISOString() });
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
app.post('/knowledge/import-approved-replies', async (req, res, next) => {
    try {
        if (!requireAdmin(req, res))
            return;
        res.json(await promoteApprovedRepliesToKnowledge({
            limit: req.body?.limit ? Number(req.body.limit) : 50,
            dryRun: Boolean(req.body?.dryRun),
        }));
    }
    catch (err) {
        next(err);
    }
});
app.post('/knowledge/import-examples', async (req, res, next) => {
    try {
        if (!requireAdmin(req, res))
            return;
        res.json(await importPastTalkExamples({
            examples: Array.isArray(req.body?.examples) ? req.body.examples : [],
            dryRun: Boolean(req.body?.dryRun),
        }));
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
app.get('/message-templates', async (req, res, next) => {
    try {
        if (!requireAdmin(req, res))
            return;
        const limit = req.query.limit ? Number(req.query.limit) : 50;
        res.json(await listMessageTemplates(limit));
    }
    catch (err) {
        next(err);
    }
});
app.post('/message-templates', async (req, res, next) => {
    try {
        if (!requireAdmin(req, res))
            return;
        const template = await upsertMessageTemplate(req.body);
        res.status(201).json({ ok: true, template });
    }
    catch (err) {
        next(err);
    }
});
app.post('/message-templates/:key/approve', async (req, res, next) => {
    try {
        if (!requireAdmin(req, res))
            return;
        const template = await approveMessageTemplate(req.params.key, req.body ?? {});
        res.json({ ok: true, template });
    }
    catch (err) {
        next(err);
    }
});
app.post('/sheets/sync', async (req, res, next) => {
    try {
        if (!requireAdmin(req, res))
            return;
        const result = await syncSheetsToSupabase({
            rows: req.body?.rows,
            dryRun: Boolean(req.body?.dryRun),
            offset: req.body?.offset,
            limit: req.body?.limit,
        });
        const applicationIds = result.results
            .map((item) => item.applicationRefId)
            .filter((id) => typeof id === 'string' && id.length > 0);
        const jobs = !result.dryRun && applicationIds.length > 0
            ? await rebuildWorkflowJobs({ applicationIds })
            : null;
        res.json({ ...result, jobs });
    }
    catch (err) {
        next(err);
    }
});
app.post('/sheets/writeback', async (req, res, next) => {
    try {
        if (!requireAdmin(req, res))
            return;
        const applicationIds = Array.isArray(req.body?.applicationIds) ? req.body.applicationIds : undefined;
        res.json(await writeApplicationsToSheets({ applicationIds, dryRun: Boolean(req.body?.dryRun) }));
    }
    catch (err) {
        next(err);
    }
});
app.post('/sheets/sync-form-responses', async (req, res, next) => {
    try {
        if (!requireAdmin(req, res))
            return;
        const result = await syncFormResponseSheets({
            postRows: req.body?.postRows,
            bankRows: req.body?.bankRows,
            dryRun: Boolean(req.body?.dryRun),
            startDate: typeof req.body?.startDate === 'string' ? req.body.startDate : undefined,
        });
        if (req.body?.notifySlack !== false) {
            try {
                await postFormResponseMatchNotification(result);
            }
            catch (err) {
                console.warn('form response Slack notification skipped:', errorMessage(err));
            }
        }
        res.json(result);
    }
    catch (err) {
        next(err);
    }
});
app.get('/workflow/statuses', async (req, res) => {
    if (!requireAdmin(req, res))
        return;
    res.json({ ok: true, statuses: WORKFLOW_STATUSES });
});
app.post('/workflow/rebuild-jobs', async (req, res, next) => {
    try {
        if (!requireAdmin(req, res))
            return;
        const applicationIds = Array.isArray(req.body?.applicationIds) ? req.body.applicationIds : undefined;
        res.json(await rebuildWorkflowJobs({ applicationIds, dryRun: Boolean(req.body?.dryRun) }));
    }
    catch (err) {
        next(err);
    }
});
app.post('/workflow/tick', async (req, res, next) => {
    try {
        if (!requireAdmin(req, res))
            return;
        const limit = req.body?.limit ? Number(req.body.limit) : 20;
        res.json(await runWorkflowTick({ limit, dryRun: Boolean(req.body?.dryRun) }));
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
