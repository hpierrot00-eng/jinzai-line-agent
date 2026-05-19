# Codex handoff: apply Jinzai LINE ops-hardening migration

Goal: finish the Jinzai LINE Agent ops-hardening rollout by applying the Supabase DB migration and verifying the deployed/local app still works.

Repo: `jinzai-line-agent/`

## Context

The code changes are already implemented and local validation passed earlier:

- `npm run typecheck`
- `npm run build`
- `npm run smoke:start`

New/changed feature scope:

- Slack approval/failure logs
- LINE `delivery_attempts`
- Slack failed-send retry button: `同じ文面で再送`
- `reply_drafts.status = send_failed`
- `reply_drafts.extracted_data.last_send_error` and `last_failed_text`
- admin-managed `message_templates`
- `GET /message-templates`
- `POST /message-templates`

Important files:

- `src/db.ts`
- `src/slack.ts`
- `src/server.ts`
- `src/ai.ts`
- `src/types.ts`
- `supabase/schema.sql`
- `supabase/ops-hardening-2026-05-19.sql`
- `README.md`
- `MVP_TEST_PLAN.md`

## Task

1. Inspect current git diff/status.
2. Verify the repo still passes:
   ```bash
   npm run typecheck
   npm run build
   npm run smoke:start
   ```
3. Apply the additive Supabase migration to the real project:
   - Preferred file: `supabase/ops-hardening-2026-05-19.sql`
   - Use Supabase SQL Editor or Supabase CLI if project credentials are already configured.
   - Do **not** print or commit secrets.
   - Do **not** replace the whole schema if this is an existing DB; run the additive migration only.
4. Confirm DB objects exist:
   - table `delivery_attempts`
   - table `message_templates`
   - index `idx_delivery_attempts_draft_created`
   - index `idx_message_templates_lookup`
   - seed templates:
     - `payment_handoff`
     - `schedule_confirm`
     - `general_ack`
5. Run or guide a minimal deployed-app verification:
   - `GET /health` returns `{ ok: true, service: 'jinzai-line-agent', mode: 'draft_only' }`
   - `GET /message-templates` with `Authorization: Bearer $ADMIN_API_KEY` returns templates.
   - Optional but ideal: send a pseudo LINE inbound to `/line-harness/inbound` and confirm Slack approval card appears.
6. If LINE send can be tested safely:
   - approve a test Slack card and confirm `delivery_attempts.status = success` and `reply_drafts.status = sent`.
   - for failure path, temporarily use a safe broken/unknown test recipient or broken send config, confirm Slack shows `同じ文面で再送`, `delivery_attempts.status = failed`, and `reply_drafts.status = send_failed`.

## Acceptance criteria

Report back with:

- migration applied: yes/no
- validation commands and results
- deployed health result
- `/message-templates` result summary
- whether Slack/LINE success path was tested
- whether failed-send retry path was tested
- any blockers, with exact missing credential/access if blocked

## Safety

- Never expose `SUPABASE_SERVICE_ROLE_KEY`, Slack tokens, LINE tokens, or `.env` contents.
- If credentials are missing, stop and ask for access rather than inventing values.
- If running in production, use test LINE users/messages only.
