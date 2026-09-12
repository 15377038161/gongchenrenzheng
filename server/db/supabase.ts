// ABOUTME: 服务端 Supabase 客户端 — 数据库代理专用
// ABOUTME: 浏览器无法直连 Supabase 内网地址，所有表操作经由 /api/db/* 转发
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** 数据库表结构类型（与 src/db/schema.ts 保持一致） */
export interface Database {
  public: {
    Tables: {
      conversations: {
        Row: {
          id: string;
          client_key: string;
          title: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          client_key?: string;
          title?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          title?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      messages: {
        Row: {
          id: string;
          conversation_id: string;
          role: string;
          content: string;
          thoughts: string[] | null;
          attachments: unknown[] | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          conversation_id: string;
          role?: string;
          content?: string;
          thoughts?: string[] | null;
          attachments?: unknown[] | null;
          created_at?: string;
        };
        Update: {
          conversation_id?: string;
          role?: string;
          content?: string;
          thoughts?: string[] | null;
          attachments?: unknown[] | null;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
}

let _client: SupabaseClient<Database> | null = null;
const _clients = new Map<string, SupabaseClient<Database>>();

/**
 * 获取服务端 Supabase 客户端（按 client_key 隔离实例）。
 * 登录用户使用 UID 命名空间，访客使用浏览器匿名标识，RLS 沿用同一套 x-client-key 隔离策略。
 */
export function getServerSupabase(clientKey: string): SupabaseClient<Database> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientKey)) {
    throw new Error('invalid client key');
  }
  const cached = _clients.get(clientKey);
  if (cached) return cached;

  const url = process.env.CODER_SUPABASE_URL;
  const anonKey = process.env.CODER_SUPABASE_ANON_KEY;
  const tenantId = process.env.CODER_SUPABASE_TENANT_ID;
  if (!url || !anonKey || !tenantId) {
    throw new Error('Supabase environment is incomplete');
  }
  const client = createClient<Database>(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        'X-Instance-ID': tenantId,
        'x-client-key': clientKey,
      },
    },
  });
  _clients.set(clientKey, client);
  if (!_client) _client = client;
  return client;
}

/** 从请求解析 client_key（header 优先，兼容查询参数） */
export function resolveClientKey(req: { headers: Record<string, unknown>; query?: unknown }): string {
  const h = req.headers as Record<string, string | string[] | undefined>;
  const raw = h['x-client-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (typeof key === 'string' && key.length > 0) return key;
  const q = (req as { query?: { client_key?: unknown } }).query;
  const qk = q && typeof q === 'object' ? (q as { client_key?: unknown }).client_key : undefined;
  if (typeof qk === 'string' && qk.length > 0) return qk;
  throw new Error('missing client key');
}
