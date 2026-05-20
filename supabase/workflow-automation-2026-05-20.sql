-- Application-based workflow automation for referral LINE operations.
-- Supabase is the source of truth; Google Sheets is the operator ledger.

create extension if not exists pgcrypto;

alter table students add column if not exists external_student_id text;
alter table students add column if not exists bank_form_sent_at timestamptz;
alter table students add column if not exists bank_form_answered_at timestamptz;

create table if not exists referral_applications (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  application_id text not null,
  student_id uuid not null references students(id) on delete cascade,
  external_student_id text,
  line_user_id text not null,
  student_name text,
  agent_name text,
  participation_scheduled_at timestamptz,
  current_status text not null default 'interested',
  auto_send_enabled boolean not null default true,
  human_required boolean not null default false,
  pre_caution_confirmed_at timestamptz,
  same_day_reminder_sent_at timestamptz,
  post_participation_form_sent_at timestamptz,
  post_participation_form_answered_at timestamptz,
  bank_form_sent_at timestamptz,
  bank_form_answered_at timestamptz,
  last_line_sent_at timestamptz,
  slack_notified_at timestamptz,
  error_message text,
  notes text,
  sheet_row_number integer,
  sheet_values jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(client_id, application_id)
);

create table if not exists application_workflow_states (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  application_ref_id uuid not null references referral_applications(id) on delete cascade,
  status text not null default 'interested',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(client_id, application_ref_id)
);

create table if not exists workflow_jobs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  application_id uuid references referral_applications(id) on delete cascade,
  student_id uuid references students(id) on delete cascade,
  job_type text not null,
  template_key text not null,
  due_at timestamptz not null,
  status text not null default 'scheduled',
  attempts integer not null default 0,
  locked_at timestamptz,
  sent_at timestamptz,
  error_message text,
  idempotency_key text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(client_id, idempotency_key)
);

alter table workflow_jobs add column if not exists application_id uuid references referral_applications(id) on delete cascade;
alter table workflow_jobs alter column student_id drop not null;

alter table delivery_attempts add column if not exists application_id uuid references referral_applications(id) on delete set null;

create index if not exists idx_referral_applications_student on referral_applications(student_id, updated_at desc);
create index if not exists idx_referral_applications_line_user on referral_applications(client_id, line_user_id, updated_at desc);
create index if not exists idx_referral_applications_status on referral_applications(client_id, current_status, updated_at desc);
create index if not exists idx_application_workflow_states_status on application_workflow_states(client_id, status, updated_at desc);
create index if not exists idx_workflow_jobs_due on workflow_jobs(client_id, status, due_at);
create index if not exists idx_workflow_jobs_application on workflow_jobs(application_id, created_at desc);
create index if not exists idx_workflow_jobs_student on workflow_jobs(student_id, created_at desc);
create index if not exists idx_delivery_attempts_application_created on delivery_attempts(application_id, created_at desc);

insert into message_templates (client_id, key, title, category, body, priority)
values
  ('00000000-0000-0000-0000-000000000001', 'confirmation_ack', '確認しました自動返信', 'workflow', 'ご確認ありがとうございます。当日はよろしくお願いいたします。', 220),
  ('00000000-0000-0000-0000-000000000001', 'form_answered_ack', '回答しました自動返信', 'workflow', 'ご回答ありがとうございます。内容を確認いたします。', 215),
  ('00000000-0000-0000-0000-000000000001', 'same_day_participation_reminder', '参加当日リマインド', 'workflow', '本日、{{agent_name}}のご参加予定日です。開始時間は{{participation_time}}です。忘れずにご参加ください。', 170),
  ('00000000-0000-0000-0000-000000000001', 'post_participation_form', '参加後確認フォーム送信', 'workflow', 'ご参加ありがとうございました。参加確認のため、以下のフォームにご回答をお願いいたします。\n{{post_participation_form_url}}', 160),
  ('00000000-0000-0000-0000-000000000001', 'bank_account_form', 'TS/銀行口座フォーム送信', 'workflow', 'ご回答ありがとうございます。謝礼金のお支払いに必要な情報入力をお願いいたします。\n{{bank_account_form_url}}', 150)
on conflict (client_id, key) do update set
  title = excluded.title,
  category = excluded.category,
  body = excluded.body,
  priority = excluded.priority,
  status = 'active',
  updated_at = now();
