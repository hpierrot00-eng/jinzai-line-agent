-- Optional MVP seed data for the first LINE support-agent test.
-- Run after schema.sql. Edit the values before production use.

insert into knowledge_items (client_id, title, category, body, source, priority)
values
  (
    '00000000-0000-0000-0000-000000000001',
    '支払い時期の基本回答',
    'payment',
    '支払い時期や条件は案件・契約状況によって変わるため、断定せず担当確認後に案内する。',
    'seed',
    20
  ),
  (
    '00000000-0000-0000-0000-000000000001',
    '面談日程の基本回答',
    'schedule',
    '面談日程は候補日時を確認し、必要に応じて学生の希望日時を聞く。確定前の日程は断定しない。',
    'seed',
    15
  ),
  (
    '00000000-0000-0000-0000-000000000001',
    '面談リンク案内の基本回答',
    'agent_meeting',
    '面談リンク・注意事項・持ち物は、送信前に最新の案内内容を確認する。',
    'seed',
    10
  )
on conflict do nothing;

insert into monthly_rules (client_id, rule_month, category, label, value, notes)
values
  (
    '00000000-0000-0000-0000-000000000001',
    to_char(current_date, 'YYYY-MM'),
    'payment',
    '今月の支払い予定日',
    '担当確認後に案内',
    '本番運用前に正しい支払い予定日に差し替える'
  ),
  (
    '00000000-0000-0000-0000-000000000001',
    to_char(current_date + interval '1 month', 'YYYY-MM'),
    'payment',
    '来月の支払い予定日',
    '担当確認後に案内',
    '本番運用前に正しい支払い予定日に差し替える'
  )
on conflict (client_id, rule_month, category, label) do update set
  value = excluded.value,
  notes = excluded.notes,
  updated_at = now();
