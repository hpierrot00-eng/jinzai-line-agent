-- Add lookup support for approved-reply and imported historical knowledge.
-- Safe to run multiple times.

create index if not exists idx_knowledge_items_source on knowledge_items(client_id, source);
