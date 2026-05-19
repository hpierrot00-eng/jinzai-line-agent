-- Additive migration for real-operations hardening.
-- Safe to run on an existing Supabase project after the original schema.sql.

create table if not exists delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  reply_draft_id uuid references reply_drafts(id) on delete cascade,
  line_user_id text not null,
  channel text not null default 'line',
  status text not null,
  error_message text,
  provider_response jsonb not null default '{}',
  attempted_by_slack_user_id text,
  action text not null,
  message_text text not null,
  created_at timestamptz not null default now()
);

create table if not exists message_templates (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  key text not null,
  title text not null,
  category text not null default 'general',
  body text not null,
  priority integer not null default 0,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(client_id, key)
);

create index if not exists idx_delivery_attempts_draft_created on delivery_attempts(reply_draft_id, created_at desc);
create index if not exists idx_message_templates_lookup on message_templates(client_id, status, category, priority desc);

insert into message_templates (client_id, key, title, category, body, priority)
values
  ('00000000-0000-0000-0000-000000000001', 'payment_handoff', '支払い・条件確認の担当者引き継ぎ', 'payment', 'ご連絡ありがとうございます。内容を担当者が確認し、個別にご案内いたします。正確な確認が必要な内容のため、このまま担当者対応に切り替えます。', 100),
  ('00000000-0000-0000-0000-000000000001', 'schedule_confirm', '日程確認の基本返信', 'schedule', 'ご連絡ありがとうございます。日程について確認いたします。候補日時やご希望があれば、あわせてお送りください。', 80),
  ('00000000-0000-0000-0000-000000000001', 'general_ack', '一般問い合わせの受付返信', 'general', 'ご連絡ありがとうございます。内容を確認いたしました。担当より確認のうえ、順次ご案内いたします。', 10)
on conflict (client_id, key) do update set
  title = excluded.title,
  category = excluded.category,
  body = excluded.body,
  priority = excluded.priority,
  status = 'active',
  updated_at = now();
