// 会话与消息的持久化存储（Supabase，RLS 以 client_key 隔离）
import { getClientKey, getSupabase } from './supabase';

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
  thoughts: string[];
  created_at: string;
}

/** 加载历史会话列表（按更新时间倒序） */
export async function listConversations(): Promise<ConversationRow[]> {
  const { data, error } = await getSupabase()
    .from('conversations')
    .select('id, title, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(`加载会话列表失败: ${error.message}`);
  return (data ?? []) as ConversationRow[];
}

/** 加载某个会话的全部消息（按时间正序） */
export async function listMessages(conversationId: string): Promise<MessageRow[]> {
  const { data, error } = await getSupabase()
    .from('messages')
    .select('id, conversation_id, role, content, thoughts, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(1000);
  if (error) throw new Error(`加载消息失败: ${error.message}`);
  return (data ?? []) as MessageRow[];
}

/** 新建会话，返回新行 */
export async function createConversation(title = '新对话'): Promise<ConversationRow> {
  const { data, error } = await getSupabase()
    .from('conversations')
    .insert({ title, client_key: getClientKey() })
    .select('id, title, created_at, updated_at')
    .maybeSingle();
  if (error) throw new Error(`新建会话失败: ${error.message}`);
  if (!data) throw new Error('新建会话失败：无返回数据');
  return data as ConversationRow;
}

/** 更新会话标题（首条消息触发） */
export async function updateConversationTitle(id: string, title: string): Promise<void> {
  const { error } = await getSupabase()
    .from('conversations')
    .update({ title })
    .eq('id', id);
  if (error) throw new Error(`更新会话标题失败: ${error.message}`);
}

/** 触碰会话更新时间（新消息时调用） */
export async function touchConversation(id: string): Promise<void> {
  const { error } = await getSupabase()
    .from('conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`更新会话时间失败: ${error.message}`);
}

/** 插入一条消息 */
export async function insertMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  thoughts: string[] = []
): Promise<MessageRow> {
  const { data, error } = await getSupabase()
    .from('messages')
    .insert({ conversation_id: conversationId, role, content, thoughts })
    .select('id, conversation_id, role, content, thoughts, created_at')
    .maybeSingle();
  if (error) throw new Error(`保存消息失败: ${error.message}`);
  if (!data) throw new Error('保存消息失败：无返回数据');
  return data as MessageRow;
}

/** 删除会话（消息级联删除） */
export async function deleteConversation(id: string): Promise<void> {
  const { error } = await getSupabase()
    .from('conversations')
    .delete()
    .eq('id', id);
  if (error) throw new Error(`删除会话失败: ${error.message}`);
}
