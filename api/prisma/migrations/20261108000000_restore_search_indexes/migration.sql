-- Restore the trigram indexes that 20261002183005_notification_inbox_fields dropped by mistake
-- (they were missing from schema.prisma, so Prisma treated them as drift). They are now declared
-- in the schema, so later migrations keep them.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Channel_name_trgm_idx" ON "Channel" USING GIN ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Project_name_trgm_idx" ON "Project" USING GIN ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Task_title_trgm_idx" ON "Task" USING GIN ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "User_name_trgm_idx" ON "User" USING GIN ("name" gin_trgm_ops);
