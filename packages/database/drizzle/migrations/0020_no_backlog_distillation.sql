--> Start session distillation from now, not from the beginning of history.
--> Migration 0019 added the column with a null default, which made every
--> conversation ever held look like it owed a distillation. On the pilot that
--> queued 17 sessions going back before the feature existed, and the first one
--> it read was a conference rundown whose panel titles became always-injected
--> "facts" about the person. Conversations already idle when this runs are
--> marked read; anything still live is left to distil normally.
UPDATE "ChatConversation"
   SET "memoryDistilledAt" = now()
 WHERE "memoryDistilledAt" IS NULL
   AND "lastMessageAt" IS NOT NULL
   AND "lastMessageAt" < now() - interval '10 minutes';
