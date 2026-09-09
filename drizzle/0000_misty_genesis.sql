CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_key" varchar(64) NOT NULL,
	"title" varchar(120) DEFAULT '新对话' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"content" text NOT NULL,
	"thoughts" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_client_key_idx" ON "conversations" USING btree ("client_key");--> statement-breakpoint
CREATE INDEX "conversations_updated_at_idx" ON "conversations" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_id_idx" ON "messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "messages_created_at_idx" ON "messages" USING btree ("created_at");--> statement-breakpoint
CREATE POLICY "conversations_client_select" ON "conversations" AS PERMISSIVE FOR SELECT TO "anon" USING ("conversations"."client_key" = (current_setting('request.headers', true)::json->>'x-client-key'));--> statement-breakpoint
CREATE POLICY "conversations_client_insert" ON "conversations" AS PERMISSIVE FOR INSERT TO "anon" WITH CHECK ("conversations"."client_key" = (current_setting('request.headers', true)::json->>'x-client-key'));--> statement-breakpoint
CREATE POLICY "conversations_client_update" ON "conversations" AS PERMISSIVE FOR UPDATE TO "anon" USING ("conversations"."client_key" = (current_setting('request.headers', true)::json->>'x-client-key')) WITH CHECK ("conversations"."client_key" = (current_setting('request.headers', true)::json->>'x-client-key'));--> statement-breakpoint
CREATE POLICY "conversations_client_delete" ON "conversations" AS PERMISSIVE FOR DELETE TO "anon" USING ("conversations"."client_key" = (current_setting('request.headers', true)::json->>'x-client-key'));--> statement-breakpoint
CREATE POLICY "messages_client_select" ON "messages" AS PERMISSIVE FOR SELECT TO "anon" USING (EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.id = "messages"."conversation_id"
          AND c.client_key = (current_setting('request.headers', true)::json->>'x-client-key')
      ));--> statement-breakpoint
CREATE POLICY "messages_client_insert" ON "messages" AS PERMISSIVE FOR INSERT TO "anon" WITH CHECK (EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.id = "messages"."conversation_id"
          AND c.client_key = (current_setting('request.headers', true)::json->>'x-client-key')
      ));--> statement-breakpoint
CREATE POLICY "messages_client_delete" ON "messages" AS PERMISSIVE FOR DELETE TO "anon" USING (EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.id = "messages"."conversation_id"
          AND c.client_key = (current_setting('request.headers', true)::json->>'x-client-key')
      ));

-- === managed grants ===
REVOKE ALL ON TABLE conversations FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE conversations TO anon;

REVOKE ALL ON TABLE messages FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE messages TO anon;