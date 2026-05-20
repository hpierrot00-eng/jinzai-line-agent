-- Application-based workflow automation for referral LINE operations.
-- Supabase is the source of truth; Google Sheets is the operator ledger.

create extension if not exists pgcrypto;

alter table students add column if not exists external_student_id text;
alter table students alter column line_user_id drop not null;
alter table students add column if not exists furigana text;
alter table students add column if not exists line_display_name text;
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

alter table referral_applications alter column line_user_id drop not null;
alter table referral_applications add column if not exists student_furigana text;
alter table referral_applications add column if not exists line_display_name text;
alter table referral_applications add column if not exists university_name text;
alter table referral_applications add column if not exists graduation_year text;
alter table referral_applications add column if not exists participation_purpose text;
alter table referral_applications add column if not exists post_participation_form_response_row_number integer;
alter table referral_applications add column if not exists post_participation_form_response_values jsonb not null default '{}';

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

alter table student_registration_states add column if not exists bank_form_response_row_number integer;
alter table student_registration_states add column if not exists bank_form_response_values jsonb not null default '{}';

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
alter table workflow_jobs add column if not exists template_version integer;
alter table workflow_jobs add column if not exists rendered_text text;
alter table workflow_jobs add column if not exists approved_text text;
alter table workflow_jobs add column if not exists approval_slack_channel_id text;
alter table workflow_jobs add column if not exists approval_slack_message_ts text;
alter table workflow_jobs add column if not exists approved_by_slack_user_id text;
alter table workflow_jobs add column if not exists approved_at timestamptz;

alter table delivery_attempts add column if not exists application_id uuid references referral_applications(id) on delete set null;
alter table delivery_attempts add column if not exists template_key text;
alter table delivery_attempts add column if not exists template_version integer;

alter table message_templates add column if not exists version integer not null default 1;
alter table message_templates add column if not exists send_mode text not null default 'approval_required';
alter table message_templates add column if not exists updated_by text;
alter table message_templates add column if not exists approved_by text;
alter table message_templates add column if not exists approved_at timestamptz;

create index if not exists idx_referral_applications_student on referral_applications(student_id, updated_at desc);
create index if not exists idx_referral_applications_line_user on referral_applications(client_id, line_user_id, updated_at desc);
create index if not exists idx_referral_applications_status on referral_applications(client_id, current_status, updated_at desc);
create index if not exists idx_application_workflow_states_status on application_workflow_states(client_id, status, updated_at desc);
create index if not exists idx_student_registration_states_student on student_registration_states(student_id, updated_at desc);
create index if not exists idx_workflow_jobs_due on workflow_jobs(client_id, status, due_at);
create index if not exists idx_workflow_jobs_application on workflow_jobs(application_id, created_at desc);
create index if not exists idx_workflow_jobs_student on workflow_jobs(student_id, created_at desc);
create index if not exists idx_delivery_attempts_application_created on delivery_attempts(application_id, created_at desc);

insert into message_templates (client_id, key, title, category, body, priority, send_mode, version, approved_by, approved_at)
values
  ('00000000-0000-0000-0000-000000000001', 'confirm_ack_reply', '確認しました自動返信', 'workflow', 'ご確認ありがとうございます！\nまた、わからない事などありましたら気軽に仰ってください！\n\n引き続きよろしくお願い致します！', 220, 'auto_send', 1, 'seed', now()),
  ('00000000-0000-0000-0000-000000000001', 'answered_ack_reply', '回答しました自動返信', 'workflow', 'ご回答ありがとうございます！\n\n引き続きよろしくお願い致します！', 215, 'auto_send', 1, 'seed', now()),
  ('00000000-0000-0000-0000-000000000001', 'pre_participation_caution', '参加前注意事項', 'workflow', '面談のお時間が近づいてきましたね！\n面談参加にあたっての注意事項だけ共有しておきます！\n※面談参加中、参加後について\n\n- オンライン面談は画面オン、マイクオンでの参加お願いいたします！\n- 参加する姿勢\n\n姿勢としては就活に興味あるけどどうしたらいいか分からない。\n\n自分の力だけだときついから良いエージェントさんを探してる。\n\nなどのような感じで受けてもらえればと思います！\n\n- 就活が終わっていても終わりました！はNGでお願いいたします！\n\n（まだ続けてます！でお願いいたします。うまく濁してもらえれば大丈夫です）\n- 就活支援金がもらえるから参加したは絶対にNGでお願いいたします！\n- 今回どこで知ってくれたのかと聞かれた場合「就活に力を入れてる友達から紹介してもらいました！名前を聞かれたら佐藤ゆうと」とご回答ください！\n- 2回目までの面談参加。基本1回目の面談の際に次の面談の日時を再度調整されるので、そこで日時の調整をしていただいて、2回目の面談も参加していただけたらと思います！！\n3回目以降はそのまま使い続けたいなと感じられたら参加していただけたらと思います！\n\n３回目以降に関しては興味があれば出ていただければ幸いです！\n\nもし、参加したエージェントが合わなかった場合はブロックなどはせずに、キャンセルしていただいても大丈夫です！\n\n※就活支援金(2500円）について\n\n就活支援金は弊社よりお支払いいたしますので、\n面談時に就活支援金についてお話しいただく必要はございません！\n就活支援金の入金は翌々月の２０日です！\n\n（非承認になってしまった場合報酬が支払われないので、ご了承ください）\n\n上記注意事項を徹底に守っていただくことや2回目参加などして企業紹介など受けていただければ基本承認になるのでご安心ください！☺️確実に承認にしたい場合は2回目を出ていただき、企業紹介など受けてもらえると確率が圧倒的に高くなります！\n\n分からない事などありましたら気軽にご連絡ください！\n\n確認できましたら「確認できました」と送っていただけると助かります！\n\n引き続きよろしくお願いいたします！', 210, 'approval_required', 1, 'seed', now()),
  ('00000000-0000-0000-0000-000000000001', 'same_day_reminder', '参加当日リマインド', 'workflow', '参加当日になりました！再度、注意事項なども確認してご参加いただければと思います！\n引き続きよろしくお願いいたします！', 170, 'auto_send', 1, 'seed', now()),
  ('00000000-0000-0000-0000-000000000001', 'post_participation_form', '参加後確認フォーム送信', 'workflow', '面談ご参加お疲れ様です！\n\n我々としても参加された方にはできる限り就活支援金をお渡ししたいので、以下の回答フォームへのご入力をお願いいたします！\nhttps://docs.google.com/forms/d/e/1FAIpQLScLAZZZsnpU1jl_g6sB862tBWS2YUAQRNYSoZfHO2qR9RQVrg/viewform\n\nお手数ですが、よろしくお願いいたします！', 160, 'auto_send', 1, 'seed', now()),
  ('00000000-0000-0000-0000-000000000001', 'bank_account_form', 'TS/銀行口座フォーム送信', 'workflow', 'この度は面談ご参加ありがとうございます！\n就活支援金のお渡しは銀行振り込みで対応させて頂きます！\n\n下記のフォームのご回答よろしくお願いいたします！\n入金は翌々月の20日になります！\n\nhttps://docs.google.com/forms/d/e/1FAIpQLSd8lxdv0KGsyuK_KRpP0aRst2b-IrMh4vfmAT-IFAEf_d0H0g/viewform?usp=header', 150, 'auto_send', 1, 'seed', now())
on conflict (client_id, key) do update set
  title = excluded.title,
  category = excluded.category,
  body = excluded.body,
  version = greatest(message_templates.version, excluded.version),
  priority = excluded.priority,
  status = 'active',
  send_mode = excluded.send_mode,
  approved_by = coalesce(message_templates.approved_by, excluded.approved_by),
  approved_at = coalesce(message_templates.approved_at, excluded.approved_at),
  updated_at = now();
