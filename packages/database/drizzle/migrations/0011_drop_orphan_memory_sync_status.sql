--> The only table that ever used this type, DocumentMemoryPublication, was
--> dropped in 0003. Nothing has referenced it since, so this removes the last
--> trace of the external memory service from the schema.
DROP TYPE IF EXISTS "public"."MemorySyncStatus";
