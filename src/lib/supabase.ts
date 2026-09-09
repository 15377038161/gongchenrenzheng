// src/lib/supabase.ts — Vite 前端专用（环境学院智能对话）
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
          created_at: string;
        };
        Insert: {
          id?: string;
          conversation_id: string;
          role: string;
          content: string;
          thoughts?: string[] | null;
          created_at?: string;
        };
        Update: {
          conversation_id?: string;
          role?: string;
          content?: string;
          thoughts?: string[] | null;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
}

let _supabase: SupabaseClient<Database> | null = null;
let _clientKey: string | null = null;

/** 浏览器端匿名标识（localStorage 持久化），作为 RLS 隔离边界 */
export function getClientKey(): string {
  if (_clientKey) return _clientKey;
  let key = localStorage.getItem('envchat_client_key');
  if (!key) {
    // crypto.randomUUID 更安全，兜底用随机拼接
    key = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
    localStorage.setItem('envchat_client_key', key);
  }
  _clientKey = key;
  return key;
}

export function getSupabase(): SupabaseClient<Database> {
  if (_supabase) return _supabase;
  const url = import.meta.env.CODER_SUPABASE_URL;
  const anonKey = import.meta.env.CODER_SUPABASE_ANON_KEY;
  const tenantId = import.meta.env.CODER_SUPABASE_TENANT_ID;
  if (!url || !anonKey || !tenantId) {
    throw new Error('Supabase environment is incomplete');
  }
  _supabase = createClient<Database>(url, anonKey, {
    auth: { autoRefreshToken: true, persistSession: true },
    global: {
      headers: {
        'X-Instance-ID': tenantId,
        'x-client-key': getClientKey(),
      },
    },
  });
  return _supabase;
}
