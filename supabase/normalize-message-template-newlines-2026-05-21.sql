update message_templates
set
  body = replace(replace(replace(body, '\r\n', chr(10)), '\n', chr(10)), ':relaxed:', ''),
  updated_by = coalesce(updated_by, 'codex'),
  updated_at = now()
where body like '%\n%'
  or body like '%:relaxed:%';
