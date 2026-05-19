# MVP Test Plan

This is the smallest proof that the LINE support-agent loop works.

## 0. One-time setup

1. Run `supabase/schema.sql` in Supabase SQL Editor.
   - Existing MVP databases can run `supabase/ops-hardening-2026-05-19.sql` instead to add only `delivery_attempts`, `message_templates`, indexes, and starter templates.
2. Run `supabase/seed-mvp.sql` after editing any real monthly values.
3. Fill `.env` from `.env.example`.
4. Build and start the app.

```bash
npm install
npm run typecheck
npm run build
npm run smoke:start
npm run start
```

## 1. Health check

Open:

```text
GET https://YOUR_DOMAIN/health
```

Expected:

```json
{ "ok": true, "service": "jinzai-line-agent", "mode": "draft_only" }
```

## 2. LINE Harness inbound test

Send this to the deployed app:

```bash
curl -X POST https://YOUR_DOMAIN/line-harness/inbound \
  -H "content-type: application/json" \
  -d '{"lineUserId":"Utest001","displayName":"テスト学生","text":"来月の支払いはいつですか？"}'
```

Expected:

- Supabase `students` has `Utest001`.
- Supabase `messages` has the incoming text.
- Supabase `reply_drafts` has a draft.
- Slack approval channel receives a `LINE問い合わせ対応` card.
- Slack card shows customer LINE display name when available plus LINE ID.
- Slack card shows recent conversation history before the proposed reply.
- Draft references the matching monthly rule if configured.

## 3. Slack approval test

On the Slack card:

1. Click `修正依頼`.
2. Enter `もっと短く、断定しないで`.
3. Confirm a new approval card is posted.
4. Click `承認して送信` on the new card.

Expected:

- LINE send is attempted.
- Supabase `approvals` has `request_revision` and `approve` or `edit_and_approve`.
- Supabase `messages` has an outgoing message.
- `reply_drafts.status` becomes `sent` for the approved draft.

## 4. Failed-send retry test

Temporarily break LINE send credentials or use an unknown test LINE user, then click `承認して送信` on a Slack card.

Expected:

- Slack card changes to `LINE送信失敗`.
- Card shows `同じ文面で再送`, `編集して送信`, and `人間対応` buttons.
- Supabase `delivery_attempts.status = failed` when the hardening migration is applied.
- Supabase `approvals.action = approve_send_failed` or `edit_and_approve_send_failed`.
- `reply_drafts.status = send_failed` and `extracted_data.last_failed_text` keeps the unsent text.
- After fixing credentials, click `同じ文面で再送`; successful retry records `approvals.action = retry_send`, `delivery_attempts.status = success`, outgoing `messages`, and `reply_drafts.status = sent`.

## 5. Template management test

Create or update a template:

```bash
curl -X POST https://YOUR_DOMAIN/message-templates \
  -H "authorization: Bearer $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"key":"schedule_confirm","title":"日程確認の基本返信","category":"schedule","body":"ご連絡ありがとうございます。日程について確認いたします。候補日時やご希望があれば、あわせてお送りください。","priority":80}'
```

Expected:

- `GET /message-templates` returns the template.
- Matching future drafts can use the template wording before falling back to generic heuristic text.

## 6. Knowledge candidate test

After one approved reply:

```text
GET https://YOUR_DOMAIN/knowledge/candidates
Authorization: Bearer $ADMIN_API_KEY
```

Expected:

- Approved replies appear as candidates that can be turned into `knowledge_items`.

## 7. Monthly rule test cases

Try messages like:

- `今月の支払いはいつですか？`
- `来月の支払いはいつですか？`
- `6月の面談日はいつですか？`

Expected:

- The app checks `monthly_rules` for the relevant month.
- Sensitive/payment answers still go through Slack approval before sending.

## Current validation status

OpenClaw exec approvals have been configured for the Node/npm MVP validation path. `npm install`, `npm run typecheck`, `npm run build`, and `npm run smoke:start` passed locally. Live Supabase migration/application still requires project DB access or SQL Editor execution.
