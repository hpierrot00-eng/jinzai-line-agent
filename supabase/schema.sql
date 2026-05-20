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
  line_user_id text,
  external_student_id text,
  display_name text,
  name text,
  furigana text,
  line_display_name text,
  school_name text,
  graduation_year text,
  academic_profile jsonb not null default '{}',
  tags text[] not null default '{}',
  bank_form_sent_at timestamptz,
  bank_form_answered_at timestamptz,
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

create table if not exists referral_applications (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  application_id text not null,
  student_id uuid not null references students(id) on delete cascade,
  external_student_id text,
  line_user_id text,
  student_name text,
  student_furigana text,
  line_display_name text,
  university_name text,
  graduation_year text,
  agent_name text,
  participation_purpose text,
  participation_scheduled_at timestamptz,
  current_status text not null default 'interested',
  auto_send_enabled boolean not null default true,
  human_required boolean not null default false,
  pre_caution_confirmed_at timestamptz,
  same_day_reminder_sent_at timestamptz,
  post_participation_form_sent_at timestamptz,
  post_participation_form_answered_at timestamptz,
  post_participation_form_response_row_number integer,
  post_participation_form_response_values jsonb not null default '{}',
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

create table if not exists student_registration_states (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  student_id uuid not null references students(id) on delete cascade,
  ts_form_sent_at timestamptz,
  ts_form_answered_at timestamptz,
  bank_form_sent_at timestamptz,
  bank_form_answered_at timestamptz,
  bank_form_response_row_number integer,
  bank_form_response_values jsonb not null default '{}',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(client_id, student_id)
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
  application_id uuid references referral_applications(id) on delete set null,
  line_user_id text not null,
  channel text not null default 'line',
  status text not null,
  error_message text,
  provider_response jsonb not null default '{}',
  attempted_by_slack_user_id text,
  action text not null,
  message_text text not null,
  template_key text,
  template_version integer,
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

create table if not exists student_workflow_states (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  student_id uuid not null references students(id) on delete cascade,
  status text not null default 'interested',
  participation_scheduled_at timestamptz,
  second_meeting_at timestamptz,
  pre_caution_confirmed_at timestamptz,
  post_form_sent_at timestamptz,
  bank_form_sent_at timestamptz,
  last_reminded_at timestamptz,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(client_id, student_id)
);

create table if not exists workflow_jobs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  application_id uuid references referral_applications(id) on delete cascade,
  student_id uuid references students(id) on delete cascade,
  job_type text not null,
  template_key text not null,
  template_version integer,
  due_at timestamptz not null,
  status text not null default 'scheduled',
  attempts integer not null default 0,
  locked_at timestamptz,
  sent_at timestamptz,
  error_message text,
  rendered_text text,
  approved_text text,
  approval_slack_channel_id text,
  approval_slack_message_ts text,
  approved_by_slack_user_id text,
  approved_at timestamptz,
  idempotency_key text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(client_id, idempotency_key)
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
  version integer not null default 1,
  priority integer not null default 0,
  status text not null default 'active',
  send_mode text not null default 'approval_required',
  updated_by text,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(client_id, key)
);

create index if not exists idx_messages_conversation_created on messages(conversation_id, created_at);
create index if not exists idx_reply_drafts_status on reply_drafts(status);
create index if not exists idx_delivery_attempts_draft_created on delivery_attempts(reply_draft_id, created_at desc);
create index if not exists idx_delivery_attempts_application_created on delivery_attempts(application_id, created_at desc);
create index if not exists idx_knowledge_items_lookup on knowledge_items(client_id, status, category, priority desc);
create index if not exists idx_monthly_rules_lookup on monthly_rules(client_id, status, rule_month, category);
create index if not exists idx_message_templates_lookup on message_templates(client_id, status, category, priority desc);
create index if not exists idx_referral_applications_student on referral_applications(student_id, updated_at desc);
create index if not exists idx_referral_applications_line_user on referral_applications(client_id, line_user_id, updated_at desc);
create index if not exists idx_referral_applications_status on referral_applications(client_id, current_status, updated_at desc);
create index if not exists idx_application_workflow_states_status on application_workflow_states(client_id, status, updated_at desc);
create index if not exists idx_student_registration_states_student on student_registration_states(student_id, updated_at desc);
create index if not exists idx_student_workflow_states_status on student_workflow_states(client_id, status, updated_at desc);
create index if not exists idx_workflow_jobs_due on workflow_jobs(client_id, status, due_at);
create index if not exists idx_workflow_jobs_application on workflow_jobs(application_id, created_at desc);
create index if not exists idx_workflow_jobs_student on workflow_jobs(student_id, created_at desc);
-- Optional seed. Replace UUID or set DEFAULT_CLIENT_ID to this value.
insert into clients (id, name, auto_reply_mode)
values ('00000000-0000-0000-0000-000000000001', 'default', 'draft_only')
on conflict (id) do nothing;

insert into message_templates (client_id, key, title, category, body, priority, send_mode, version, approved_by, approved_at)
values
  ('00000000-0000-0000-0000-000000000001', 'payment_handoff', '支払い・条件確認の担当者引き継ぎ', 'payment', 'ご連絡ありがとうございます。内容を担当者が確認し、個別にご案内いたします。正確な確認が必要な内容のため、このまま担当者対応に切り替えます。', 100, 'approval_required', 1, 'seed', now()),
  ('00000000-0000-0000-0000-000000000001', 'schedule_confirm', '日程確認の基本返信', 'schedule', 'ご連絡ありがとうございます。日程について確認いたします。候補日時やご希望があれば、あわせてお送りください。', 80, 'approval_required', 1, 'seed', now()),
  ('00000000-0000-0000-0000-000000000001', 'general_ack', '一般問い合わせの受付返信', 'general', 'ご連絡ありがとうございます。内容を確認いたしました。担当より確認のうえ、順次ご案内いたします。', 10, 'approval_required', 1, 'seed', now()),
  ('00000000-0000-0000-0000-000000000001', 'confirm_ack_reply', '確認しました自動返信', 'workflow', 'ご確認ありがとうございます！\nまた、わからない事などありましたら気軽に仰ってください！\n\n引き続きよろしくお願い致します！', 220, 'auto_send', 1, 'seed', now()),
  ('00000000-0000-0000-0000-000000000001', 'answered_ack_reply', '回答しました自動返信', 'workflow', 'ご回答ありがとうございます！\n\n引き続きよろしくお願い致します！', 215, 'auto_send', 1, 'seed', now()),
  ('00000000-0000-0000-0000-000000000001', 'pre_participation_caution', '参加前注意事項', 'workflow', '面談のお時間が近づいてきましたね！\n面談参加にあたっての注意事項だけ共有しておきます！\n※面談参加中、参加後について\n\n- オンライン面談は画面オン、マイクオンでの参加お願いいたします！\n- 参加する姿勢\n\n姿勢としては就活に興味あるけどどうしたらいいか分からない。\n\n自分の力だけだときついから良いエージェントさんを探してる。\n\nなどのような感じで受けてもらえればと思います！\n\n- 就活が終わっていても終わりました！はNGでお願いいたします！\n\n（まだ続けてます！でお願いいたします。うまく濁してもらえれば大丈夫です）\n- 就活支援金がもらえるから参加したは絶対にNGでお願いいたします！\n- 今回どこで知ってくれたのかと聞かれた場合「就活に力を入れてる友達から紹介してもらいました！名前を聞かれたら佐藤ゆうと」とご回答ください！\n- 2回目までの面談参加。基本1回目の面談の際に次の面談の日時を再度調整されるので、そこで日時の調整をしていただいて、2回目の面談も参加していただけたらと思います！！\n3回目以降はそのまま使い続けたいなと感じられたら参加していただけたらと思います！\n\n３回目以降に関しては興味があれば出ていただければ幸いです！\n\nもし、参加したエージェントが合わなかった場合はブロックなどはせずに、キャンセルしていただいても大丈夫です！\n\n※就活支援金(2500円）について\n\n就活支援金は弊社よりお支払いいたしますので、\n面談時に就活支援金についてお話しいただく必要はございません！\n就活支援金の入金は翌々月の２０日です！\n\n（非承認になってしまった場合報酬が支払われないので、ご了承ください）\n\n上記注意事項を徹底に守っていただくことや2回目参加などして企業紹介など受けていただければ基本承認になるのでご安心ください！☺️確実に承認にしたい場合は2回目を出ていただき、企業紹介など受けてもらえると確率が圧倒的に高くなります！\n\n分からない事などありましたら気軽にご連絡ください！\n\n確認できましたら「確認できました」と送っていただけると助かります！\n\n引き続きよろしくお願いいたします！', 210, 'approval_required', 1, 'seed', now()),
  ('00000000-0000-0000-0000-000000000001', 'same_day_reminder', '参加当日リマインド', 'workflow', '参加当日になりました！再度、注意事項なども確認してご参加いただければと思います！\n引き続きよろしくお願いいたします！', 170, 'auto_send', 1, 'seed', now()),
  ('00000000-0000-0000-0000-000000000001', 'post_participation_form', '参加後確認フォーム送信', 'workflow', '面談ご参加お疲れ様です！\n\n我々としても参加された方にはできる限り就活支援金をお渡ししたいので、以下の回答フォームへのご入力をお願いいたします！\nhttps://docs.google.com/forms/d/e/1FAIpQLScLAZZZsnpU1jl_g6sB862tBWS2YUAQRNYSoZfHO2qR9RQVrg/viewform\n\nお手数ですが、よろしくお願いいたします！', 160, 'auto_send', 1, 'seed', now()),
  ('00000000-0000-0000-0000-000000000001', 'bank_account_form', 'TS/銀行口座フォーム送信', 'workflow', 'この度は面談ご参加ありがとうございます！\n就活支援金のお渡しは銀行振り込みで対応させて頂きます！\n\n下記のフォームのご回答よろしくお願いいたします！\n入金は翌々月の20日になります！\n\nhttps://docs.google.com/forms/d/e/1FAIpQLSd8lxdv0KGsyuK_KRpP0aRst2b-IrMh4vfmAT-IFAEf_d0H0g/viewform?usp=header', 150, 'auto_send', 1, 'seed', now())
on conflict (client_id, key) do nothing;
