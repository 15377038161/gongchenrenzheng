// ABOUTME: /api/db/* 数据库代理路由 — 会话与消息的持久化操作
// ABOUTME: 浏览器无法直连 Supabase，前端 fetch 相对路径至此转发（RLS 以 x-client-key 隔离）
import { Router, type Request, type Response } from 'express';
import { getServerSupabase, resolveClientKey } from '../db/supabase';

const router = Router();

interface Attachment {
  name: string;
  size: number;
  type: string;
  objectId?: string;
}

interface MessagePayload {
  conversation_id?: unknown;
  role?: unknown;
  content?: unknown;
  thoughts?: unknown;
  attachments?: unknown;
}

interface ConversationPayload {
  title?: unknown;
}

/** 统一错误响应（不带内部细节，避免泄漏） */
function fail(res: Response, status: number, message: string) {
  res.status(status).json({ error: message });
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function strArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.every((x) => typeof x === 'string') ? (v as string[]) : null;
}

function attArray(v: unknown): Attachment[] | null {
  if (!Array.isArray(v)) return null;
  return v
    .filter(
      (x): x is Attachment =>
        x !== null && typeof x === 'object' &&
        typeof (x as Attachment).name === 'string' &&
        typeof (x as Attachment).size === 'number' &&
        typeof (x as Attachment).type === 'string'
    )
    .map((x) => ({
      name: x.name,
      size: x.size,
      type: x.type,
      objectId: typeof x.objectId === 'string' ? x.objectId : undefined,
    }));
}

/** 校验 client_key 并取客户端实例 */
function useClient(req: Request, res: Response) {
  try {
    const key = resolveClientKey(req);
    return getServerSupabase(key);
  } catch {
    fail(res, 400, '缺少 client key');
    return null;
  }
}

/** 会话列表（更新时间倒序） */
router.get('/api/db/conversations', async (req, res) => {
  const supabase = useClient(req, res);
  if (!supabase) return;
  try {
    const { data, error } = await supabase
      .from('conversations')
      .select('id, title, created_at, updated_at')
      .order('updated_at', { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    res.json({ data: data ?? [] });
  } catch (err) {
    fail(res, 502, err instanceof Error ? `加载会话列表失败: ${err.message}` : '加载会话列表失败');
  }
});

/** 新建会话（client_key 由服务端写入，满足 RLS withCheck 与 NOT NULL） */
router.post('/api/db/conversations', async (req, res) => {
  let key: string;
  try {
    key = resolveClientKey(req);
  } catch {
    fail(res, 400, '缺少 client key');
    return;
  }
  const supabase = getServerSupabase(key);
  const body = (req.body ?? {}) as ConversationPayload;
  const title = str(body.title, '新对话').slice(0, 120);
  try {
    const { data, error } = await supabase
      .from('conversations')
      .insert({ title, client_key: key })
      .select('id, title, created_at, updated_at')
      .single();
    if (error) throw new Error(error.message);
    res.json({ data });
  } catch (err) {
    fail(res, 502, err instanceof Error ? `新建会话失败: ${err.message}` : '新建会话失败');
  }
});

/** 更新会话标题 / 触碰时间 */
router.patch('/api/db/conversations/:id', async (req, res) => {
  const supabase = useClient(req, res);
  if (!supabase) return;
  const id = req.params.id;
  const body = (req.body ?? {}) as { title?: unknown; touch?: unknown };
  const patch: { title?: string; updated_at?: string } = {};
  if (typeof body.title === 'string' && body.title.length > 0) patch.title = body.title.slice(0, 120);
  if (body.touch === true) patch.updated_at = new Date().toISOString();
  if (Object.keys(patch).length === 0) {
    fail(res, 400, '无可更新字段');
    return;
  }
  try {
    const { error } = await supabase.from('conversations').update(patch).eq('id', id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) {
    fail(res, 502, err instanceof Error ? `更新会话失败: ${err.message}` : '更新会话失败');
  }
});

/** 删除会话（消息级联删除） */
router.delete('/api/db/conversations/:id', async (req, res) => {
  const supabase = useClient(req, res);
  if (!supabase) return;
  try {
    const { error } = await supabase.from('conversations').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) {
    fail(res, 502, err instanceof Error ? `删除会话失败: ${err.message}` : '删除会话失败');
  }
});

/** 消息列表（时间正序） */
router.get('/api/db/messages', async (req, res) => {
  const supabase = useClient(req, res);
  if (!supabase) return;
  const convId = str((req.query as { conversation_id?: unknown }).conversation_id);
  if (!convId) {
    fail(res, 400, '缺少 conversation_id');
    return;
  }
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('id, conversation_id, role, content, thoughts, attachments, created_at')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: true })
      .limit(1000);
    if (error) throw new Error(error.message);
    res.json({ data: data ?? [] });
  } catch (err) {
    fail(res, 502, err instanceof Error ? `加载消息失败: ${err.message}` : '加载消息失败');
  }
});

/** 插入消息 */
router.post('/api/db/messages', async (req, res) => insertMessageHandler(req, res));

async function insertMessageHandler(req: Request, res: Response) {
  const supabase = useClient(req, res);
  if (!supabase) return;
  const body = (req.body ?? {}) as MessagePayload;
  const convId = str(body.conversation_id);
  const role = str(body.role);
  const content = str(body.content);
  if (!convId || (role !== 'user' && role !== 'assistant')) {
    fail(res, 400, '参数不合法');
    return;
  }
  try {
    const { data, error } = await supabase
      .from('messages')
      .insert({
        conversation_id: convId,
        role,
        content,
        thoughts: strArray(body.thoughts) ?? [],
        attachments: attArray(body.attachments) ?? [],
      })
      .select('id, conversation_id, role, content, thoughts, attachments, created_at')
      .single();
    if (error) throw new Error(error.message);
    res.json({ data });
  } catch (err) {
    fail(res, 502, err instanceof Error ? `保存消息失败: ${err.message}` : '保存消息失败');
  }
}

export default router;
