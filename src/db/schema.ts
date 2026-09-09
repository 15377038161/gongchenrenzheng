import { sql } from 'drizzle-orm';
import { pgPolicy, pgTable, text, timestamp, uuid, varchar, jsonb, index } from 'drizzle-orm/pg-core';
import { anonRole } from 'drizzle-orm/supabase';

/**
 * RLS 隔离键表达式：请求头 x-client-key（Supabase SDK global.headers 注入）
 * 访客无登录体系，以浏览器 localStorage 生成的匿名 client_key 作为隔离边界
 */
const clientKey = sql`(current_setting('request.headers', true)::json->>'x-client-key')`;

/**
 * 环境学院智能对话 — 会话表
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    /** 浏览器端生成的匿名标识（localStorage），RLS 隔离边界 */
    client_key: varchar('client_key', { length: 64 }).notNull(),
    /** 会话标题（取首条用户消息前 24 字） */
    title: varchar('title', { length: 120 }).notNull().default('新对话'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('conversations_client_key_idx').on(table.client_key),
    index('conversations_updated_at_idx').on(table.updated_at),
    pgPolicy('conversations_client_select', {
      for: 'select',
      to: anonRole,
      using: sql`${table.client_key} = ${clientKey}`,
    }),
    pgPolicy('conversations_client_insert', {
      for: 'insert',
      to: anonRole,
      withCheck: sql`${table.client_key} = ${clientKey}`,
    }),
    pgPolicy('conversations_client_update', {
      for: 'update',
      to: anonRole,
      using: sql`${table.client_key} = ${clientKey}`,
      withCheck: sql`${table.client_key} = ${clientKey}`,
    }),
    pgPolicy('conversations_client_delete', {
      for: 'delete',
      to: anonRole,
      using: sql`${table.client_key} = ${clientKey}`,
    }),
  ]
);

/**
 * 环境学院智能对话 — 消息表（经 conversations.client_key 隔离）
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    conversation_id: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** user | assistant */
    role: varchar('role', { length: 16 }).notNull(),
    /** 消息正文（Markdown 原文） */
    content: text('content').notNull(),
    /** 思考过程步骤（仅 assistant，JSON 数组） */
    thoughts: jsonb('thoughts').default(sql`'[]'::jsonb`),
    /** 附件元数据（仅 user，JSON 数组：name/size/type） */
    attachments: jsonb('attachments').default(sql`'[]'::jsonb`),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('messages_conversation_id_idx').on(table.conversation_id),
    index('messages_created_at_idx').on(table.created_at),
    pgPolicy('messages_client_select', {
      for: 'select',
      to: anonRole,
      using: sql`EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.id = ${table.conversation_id}
          AND c.client_key = ${clientKey}
      )`,
    }),
    pgPolicy('messages_client_insert', {
      for: 'insert',
      to: anonRole,
      withCheck: sql`EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.id = ${table.conversation_id}
          AND c.client_key = ${clientKey}
      )`,
    }),
    pgPolicy('messages_client_delete', {
      for: 'delete',
      to: anonRole,
      using: sql`EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.id = ${table.conversation_id}
          AND c.client_key = ${clientKey}
      )`,
    }),
  ]
);
