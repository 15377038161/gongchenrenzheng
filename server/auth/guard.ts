// ABOUTME: 服务端登录态校验 — 聊天接口强制身份认证
// ABOUTME: 前端发 Authorization: Bearer <token>，经平台 Nginx 重命名为 X-Sandbox-Authorization
// ABOUTME: 服务端只读 x-sandbox-authorization（authorization 头到达时恒为空），校验后关联用户身份
import { createClient } from '@supabase/supabase-js';

/** 校验通过的用户身份（请求日志与业务关联使用） */
export interface AuthedUser {
  uid: string;
  email: string;
  realname: string;
}

/**
 * 从请求头解析并校验登录态：
 * 1. 只从 x-sandbox-authorization 读取 Bearer token（协议不对称，见技能 verify-session.md）
 * 2. 用 token 创建带用户身份的 Supabase 客户端调用 auth.getUser() 校验有效性
 * 3. 返回 null 表示未登录/无效（匿名请求），调用方必须返回 401 拦截
 */
export async function requireAuthedUser(req: {
  headers: Record<string, unknown>;
}): Promise<AuthedUser | null> {
  const h = req.headers as Record<string, string | string[] | undefined>;
  const raw = h['x-sandbox-authorization'];
  const headerVal = Array.isArray(raw) ? raw[0] : raw;
  const token = typeof headerVal === 'string' ? headerVal.replace(/^Bearer\s+/i, '').trim() : '';
  if (!token) return null;

  const url = process.env.CODER_SUPABASE_URL;
  const anonKey = process.env.CODER_SUPABASE_ANON_KEY;
  const tenantId = process.env.CODER_SUPABASE_TENANT_ID;
  if (!url || !anonKey || !tenantId) return null;

  // 每次请求新建实例（后端不缓存带用户身份的客户端）
  const supabase = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      headers: {
        'X-Instance-ID': tenantId,
        Authorization: `Bearer ${token}`,
      },
    },
  });

  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return null;

  const meta = (data.user.user_metadata ?? {}) as Record<string, unknown>;
  return {
    uid: data.user.id,
    email: data.user.email ?? '',
    realname:
      typeof meta.realname === 'string' && meta.realname.length > 0
        ? meta.realname
        : typeof meta.name === 'string' && meta.name.length > 0
          ? meta.name
          : data.user.email?.split('@')[0] ?? '用户',
  };
}
