// 会话与消息的持久化存储（走服务端 /api/db/* 代理，浏览器无法直连 Supabase）
// client_key 由前端生成，经 x-client-key 请求头传递，服务端按 key 隔离 RLS

export interface Attachment {
  name: string;
  size: number;
  type: string;
  /** 上传到智能体后的文件标识（无则未上传成功） */
  objectId?: string;
}

export interface ConversationRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  thoughts: string[] | null;
  attachments: Attachment[] | null;
  created_at: string;
}

/** 请求头：携带浏览器匿名标识（client_key 隔离边界） */
function dbHeaders(): HeadersInit {
  const key = getClientKey();
  const token = localStorage.getItem('engcert_auth_token');
  return {
    'Content-Type': 'application/json',
    'x-client-key': key,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('服务响应格式错误');
  }
  const r = body as { error?: string; data?: T };
  if (!res.ok) throw new Error(r.error ?? `请求失败（HTTP ${res.status}）`);
  return body as T;
}

/** 加载历史会话列表（按更新时间倒序） */
export async function listConversations(): Promise<ConversationRow[]> {
  const res = await fetch('/api/db/conversations', { headers: dbHeaders() });
  const body = await jsonOrThrow<{ data: ConversationRow[] }>(res);
  return body.data ?? [];
}

/** 加载某个会话的全部消息（按时间正序） */
export async function listMessages(conversationId: string): Promise<MessageRow[]> {
  const res = await fetch(`/api/db/messages?conversation_id=${encodeURIComponent(conversationId)}`, {
    headers: dbHeaders(),
  });
  const body = await jsonOrThrow<{ data: MessageRow[] }>(res);
  return (body.data ?? []).map((r) => ({
    ...r,
    role: r.role === 'user' ? 'user' : 'assistant',
    thoughts: Array.isArray(r.thoughts) ? r.thoughts : [],
    attachments: Array.isArray(r.attachments) ? r.attachments : [],
  }));
}

/** 新建会话，返回新行 */
export async function createConversation(title = '新对话'): Promise<ConversationRow> {
  const res = await fetch('/api/db/conversations', {
    method: 'POST',
    headers: dbHeaders(),
    body: JSON.stringify({ title }),
  });
  const body = await jsonOrThrow<{ data: ConversationRow }>(res);
  return body.data;
}

/** 更新会话标题（首条消息触发） */
export async function updateConversationTitle(id: string, title: string): Promise<void> {
  const res = await fetch(`/api/db/conversations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: dbHeaders(),
    body: JSON.stringify({ title }),
  });
  await jsonOrThrow<unknown>(res);
}

/** 触碰会话更新时间（新消息时调用） */
export async function touchConversation(id: string): Promise<void> {
  const res = await fetch(`/api/db/conversations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: dbHeaders(),
    body: JSON.stringify({ touch: true }),
  });
  await jsonOrThrow<unknown>(res);
}

/** 插入一条消息（含附件元数据） */
export async function insertMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  thoughts: string[] = [],
  attachments: Attachment[] = []
): Promise<MessageRow> {
  const res = await fetch('/api/db/messages', {
    method: 'POST',
    headers: dbHeaders(),
    body: JSON.stringify({ conversation_id: conversationId, role, content, thoughts, attachments }),
  });
  const body = await jsonOrThrow<{ data: MessageRow }>(res);
  return {
    ...body.data,
    role: body.data.role === 'user' ? 'user' : 'assistant',
    thoughts: Array.isArray(body.data.thoughts) ? body.data.thoughts : [],
    attachments: Array.isArray(body.data.attachments) ? body.data.attachments : [],
  };
}

/** 删除会话（消息级联删除） */
export async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`/api/db/conversations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: dbHeaders(),
  });
  await jsonOrThrow<unknown>(res);
}

/**
 * 数据隔离键：登录后按超星 UID 分桶，未登录时使用浏览器匿名桶。
 * 这样教师 A 登出后教师 B 不会继续看到 A 的历史会话；同一教师刷新页面
 * 仍会落到同一个桶。UID 只作为隔离命名空间，不作为鉴权凭证。
 */
export function getClientKey(): string {
  const authUserRaw = localStorage.getItem('engcert_auth_user');
  const authToken = localStorage.getItem('engcert_auth_token');
  if (authUserRaw && authToken) {
    try {
      const authUser = JSON.parse(authUserRaw) as { uid?: unknown };
      if (typeof authUser.uid === 'string' && /^[A-Za-z0-9_-]{1,48}$/.test(authUser.uid)) {
        return `engcert_uid_${authUser.uid}`;
      }
    } catch {
      // 损坏的用户缓存按匿名桶处理，避免阻断页面加载。
    }
  }

  const KEY = 'engcert_client_key';
  let key = localStorage.getItem(KEY);
  if (!key || !/^engcert_[A-Za-z0-9_-]{8,64}$/.test(key)) {
    key = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? `engcert_${crypto.randomUUID().replace(/-/g, '')}`
      : `engcert_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
    localStorage.setItem(KEY, key);
  }
  return key;
}
