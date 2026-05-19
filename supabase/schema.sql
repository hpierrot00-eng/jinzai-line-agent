create extension if not exists pgcrypto;

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  line_channel_id text,
  slack_channel_id text,
  auto_reply_mode text not null default 'draft_only',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists students (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  line_user_id text not null,
  display_name text,
  name text,
  school_name text,
  graduation_year text,
  academic_profile jsonb not null default '{}',
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(client_id, line_user_id)
);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  student_id uuid references students(id) on delete set null,
  status text not null default 'open',
  last_message_at timestamptz,
  assigned_to text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete cascade,
  student_id uuid references students(id) on delete set null,
  direction text not null,
  channel text not null,
  sender_type text not null,
  sender_id text,
  content text not null,
  message_type text not null default 'text',
  raw_payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists reply_drafts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete cascade,
  trigger_message_id uuid references messages(id) on delete set null,
  draft_text text not null,
  category text,
  confidence numeric,
  risk_level text,
  needs_human_review boolean not null default true,
  extracted_data jsonb not null default '{}',
  reason text,
  status text not null default 'drafted',
  prompt_version text,
  model_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists approvals (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  reply_draft_id uuid references reply_drafts(id) on delete cascade,
  approver_slack_user_id text,
  action text not null,
  comment text,
  before_text text,
  after_text text,
  created_at timestamptz not null default now()
);

create table if not exists slack_reviews (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  reply_draft_id uuid references reply_drafts(id) on delete cascade,
  slack_channel_id text not null,
  slack_message_ts text not null,
  slack_thread_ts text,
  status text not null default 'posted',
  created_at timestamptz not null default now()
);

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

create table if not exists appointments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  student_id uuid references students(id) on delete set null,
  conversation_id uuid references conversations(id) on delete cascade,
  appointment_type text not null,
  scheduled_at timestamptz,
  meeting_url text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists knowledge_items (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  title text not null,
  category text not null default 'general',
  body text not null,
  source text not null default 'manual',
  priority integer not null default 0,
  status text not null default 'active',
  effective_from date,
  effective_until date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists monthly_rules (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  rule_month text not null,
  category text not null,
  label text not null,
  value text not null,
  notes text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(client_id, rule_month, category, label)
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

create index if not exists idx_messages_conversation_created on messages(conversation_id, created_at);
create index if not exists idx_reply_drafts_status on reply_drafts(status);
create index if not exists idx_delivery_attempts_draft_created on delivery_attempts(reply_draft_id, created_at desc);
create index if not exists idx_knowledge_items_lookup on knowledge_items(client_id, status, category, priority desc);
create index if not exists idx_monthly_rules_lookup on monthly_rules(client_id, status, rule_month, category);
create index if not exists idx_message_templates_lookup on message_templates(client_id, status, category, priority desc);
-- Optional seed. Replace UUID or set DEFAULT_CLIENT_ID to this value.
insert into clients (id, name, auto_reply_mode)
values ('00000000-0000-0000-0000-000000000001', 'default', 'draft_only')
on conflict (id) do nothing;

insert into message_templates (client_id, key, title, category, body, priority)
values
  ('00000000-0000-0000-0000-000000000001', 'payment_handoff', '支払い・条件確認の担当者引き継ぎ', 'payment', 'ご連絡ありがとうございます。内容を担当者が確認し、個別にご案内いたします。正確な確認が必要な内容のため、このまま担当者対応に切り替えます。', 100),
  ('00000000-0000-0000-0000-000000000001', 'schedule_confirm', '日程確認の基本返信', 'schedule', 'ご連絡ありがとうございます。日程について確認いたします。候補日時やご希望があれば、あわせてお送りください。', 80),
  ('00000000-0000-0000-0000-000000000001', 'general_ack', '一般問い合わせの受付返信', 'general', 'ご連絡ありがとうございます。内容を確認いたしました。担当より確認のうえ、順次ご案内いたします。', 10)
on conflict (client_id, key) do nothing;
