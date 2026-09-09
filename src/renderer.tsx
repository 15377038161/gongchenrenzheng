import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MarkdownView } from './components/MarkdownView';
import { AgentProgress } from './components/AgentProgress';
import { BackgroundEffect } from './components/BackgroundEffect';
import {
  type ConversationRow,
  type MessageRow,
  listConversations,
  listMessages,
  createConversation,
  updateConversationTitle,
  touchConversation,
  insertMessage,
  deleteConversation,
} from './lib/chat-store';

/** 智能体会话（chaoxing 侧，多轮上下文载体） */
interface RobotSession {
  visitorId: string;
  visitorVc: string;
  conversationId: string;
}

/** 前端渲染消息模型 */
interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thoughts: string[];
  streaming: boolean;
}

const PAGE = {
  brand: '碧水智言',
  brandSub: '华中科技大学环境科学与工程学院 · 智能对话',
  newChat: '新建对话',
  history: '历史会话',
  welcomeTitle: '碧水之畔，问学喻家',
  welcomeDesc: '面向环境科学与工程领域的智能问答助手，支持多轮对话与历史记录，由超星智能体驱动。',
  agentLabel: '环境智能体',
  placeholder: '输入你的问题，Enter 发送',
  deleteLabel: '删除',
  confirmDelete: '确定删除该会话？',
  footer: '内容由 AI 生成，仅供参考',
  loadFail: '历史加载失败',
} as const;

const SUGGESTIONS = [
  '环境工程专业的主要研究方向有哪些？',
  '水污染控制工程的核心技术是什么？',
  '如何开展环境质量评价？',
  '大气污染物的主要来源与治理思路',
];

/** 从 localStorage 读取智能体会话映射（本地对话 → chaoxing 会话） */
function loadRobotSessions(): Record<string, RobotSession> {
  try {
    return JSON.parse(localStorage.getItem('envchat_robot_sessions') ?? '{}') as Record<string, RobotSession>;
  } catch {
    return {};
  }
}

function saveRobotSessions(map: Record<string, RobotSession>): void {
  localStorage.setItem('envchat_robot_sessions', JSON.stringify(map));
}

let nextTempId = 1;

function App() {
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [activeThought, setActiveThought] = useState('');
  const [loadError, setLoadError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const robotSessionsRef = useRef<Record<string, RobotSession>>({});

  /** 初始化：加载会话列表 */
  useEffect(() => {
    robotSessionsRef.current = loadRobotSessions();
    (async () => {
      try {
        const rows = await listConversations();
        setConversations(rows);
        if (rows.length > 0) setActiveId(rows[0].id);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : PAGE.loadFail);
      }
    })();
  }, []);

  /** 切换会话：加载消息 */
  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const rows = await listMessages(activeId);
        if (cancelled) return;
        setMessages(
          rows.map((r: MessageRow) => ({
            id: r.id,
            role: r.role,
            content: r.content,
            thoughts: Array.isArray(r.thoughts) ? r.thoughts : [],
            streaming: false,
          }))
        );
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : PAGE.loadFail);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  /** 自动滚动到底 */
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, activeThought]);

  const autoGrow = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  }, []);

  /** 获取（或申请）某个本地对话对应的智能体会话 */
  const ensureRobotSession = useCallback(async (convId: string): Promise<RobotSession> => {
    const cached = robotSessionsRef.current[convId];
    if (cached) return cached;
    const res = await fetch('/api/chat/session', { method: 'POST' });
    const data = (await res.json()) as { success?: boolean; session?: RobotSession };
    if (!data.success || !data.session) {
      throw new Error('申请智能体会话失败');
    }
    robotSessionsRef.current[convId] = data.session;
    saveRobotSessions(robotSessionsRef.current);
    return data.session;
  }, []);

  /** 新建对话 */
  const newChat = useCallback(async () => {
    try {
      const row = await createConversation();
      setConversations((prev) => [row, ...prev]);
      setActiveId(row.id);
      setSidebarOpen(false);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '新建会话失败');
    }
  }, []);

  /** 删除对话 */
  const removeChat = useCallback(async (id: string) => {
    if (!window.confirm(PAGE.confirmDelete)) return;
    try {
      await deleteConversation(id);
      const { [id]: _removed, ...rest } = robotSessionsRef.current;
      robotSessionsRef.current = rest;
      saveRobotSessions(rest);
      setConversations((prev) => {
        const next = prev.filter((c) => c.id !== id);
        if (activeId === id) setActiveId(next[0]?.id ?? null);
        return next;
      });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '删除会话失败');
    }
  }, [activeId]);

  /** 发送消息：完整多轮链路（持久化 + SSE 流式） */
  const send = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || sending) return;

      let convId = activeId;
      let convTitle: string | null = null;

      // 1. 确保本地会话存在（首次发言自动建会话并以问题为标题）
      if (!convId) {
        try {
          const row = await createConversation();
          convId = row.id;
          convTitle = q.slice(0, 24);
          await updateConversationTitle(row.id, convTitle);
          setConversations((prev) => [{ ...row, title: convTitle ?? row.title }, ...prev]);
          setActiveId(row.id);
        } catch (err) {
          setLoadError(err instanceof Error ? err.message : '新建会话失败');
          return;
        }
      } else {
        const isNewTitle = messages.length === 0;
        if (isNewTitle) {
          convTitle = q.slice(0, 24);
          try {
            await updateConversationTitle(convId, convTitle);
            setConversations((prev) =>
              prev.map((c) => (c.id === convId ? { ...c, title: convTitle ?? c.title } : c))
            );
          } catch {
            // 标题更新失败不阻断对话
          }
        }
      }

      // 2. 保存用户消息（DB）
      const userMsg: UiMessage = { id: `tmp-u-${nextTempId++}`, role: 'user', content: q, thoughts: [], streaming: false };
      const agentMsg: UiMessage = { id: `tmp-a-${nextTempId++}`, role: 'assistant', content: '', thoughts: [], streaming: true };
      setMessages((prev) => [...prev, userMsg, agentMsg]);
      setInput('');
      setSending(true);
      if (taRef.current) taRef.current.style.height = 'auto';

      const patch = (fn: (m: UiMessage) => UiMessage) => {
        setMessages((prev) => prev.map((m) => (m.id === agentMsg.id ? fn(m) : m)));
      };

      try {
        // 3. 获取智能体会话（同一会话复用同一 chaoxing conversation，天然保持多轮上下文）
        const robot = await ensureRobotSession(convId);

        // 4. SSE 流式请求
        const url =
          `/api/chat/stream?q=${encodeURIComponent(q)}` +
          `&visitorId=${encodeURIComponent(robot.visitorId)}` +
          `&visitorVc=${encodeURIComponent(robot.visitorVc)}` +
          `&conversationId=${encodeURIComponent(robot.conversationId)}`;
        const res = await fetch(url);
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finalText = '';
        let lastThoughts: string[] = [];

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            let eventName = '';
            let dataRaw = '';
            for (const line of frame.split('\n')) {
              if (line.startsWith('event: ')) eventName = line.slice(7).trim();
              else if (line.startsWith('data: ')) dataRaw = line.slice(6);
            }
            if (!dataRaw) continue;

            if (eventName === 'thought') {
              const { description } = JSON.parse(dataRaw) as { description?: string };
              if (description) {
                setActiveThought(description);
                patch((m) => ({ ...m, thoughts: [...m.thoughts, description] }));
                lastThoughts = [...lastThoughts, description];
              }
            } else if (eventName === 'delta') {
              const { text } = JSON.parse(dataRaw) as { text?: string };
              if (text) {
                setActiveThought('');
                finalText += text;
                patch((m) => ({ ...m, content: m.content + text }));
              }
            } else if (eventName === 'final') {
              const { text } = JSON.parse(dataRaw) as { text?: string };
              if (text && text.length >= finalText.length) {
                finalText = text;
                patch((m) => ({ ...m, content: text }));
              }
            } else if (eventName === 'error') {
              const { message } = JSON.parse(dataRaw) as { message?: string };
              finalText = finalText || message || '回复失败，请重试';
              patch((m) => ({ ...m, content: finalText, streaming: false }));
            }
          }
        }
        patch((m) => ({ ...m, streaming: false }));

        // 5. 持久化（用户消息 + 智能体消息）
        try {
          await insertMessage(convId, 'user', q, []);
          if (finalText) {
            await insertMessage(convId, 'assistant', finalText, lastThoughts);
          }
          await touchConversation(convId);
          setConversations((prev) => {
            const others = prev.filter((c) => c.id !== convId);
            const cur = prev.find((c) => c.id === convId);
            return cur ? [cur, ...others] : others;
          });
        } catch (err) {
          setLoadError(err instanceof Error ? err.message : '消息保存失败');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : '回复失败，请重试';
        patch((m) => ({ ...m, content: m.content || msg, streaming: false }));
      } finally {
        setActiveThought('');
        setSending(false);
      }
    },
    [activeId, sending, messages.length, ensureRobotSession]
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input);
    }
  };

  const canSend = input.trim().length > 0 && !sending;
  const activeTitle = conversations.find((c) => c.id === activeId)?.title ?? PAGE.brand;

  return (
    <div className="relative flex h-full min-h-screen">
      <BackgroundEffect />

      {/* 移动端遮罩 */}
      {sidebarOpen && (
        <button
          type="button"
          aria-label="关闭侧栏"
          className="fixed inset-0 z-20 bg-black/20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* 左侧边栏 */}
      <aside
        className={`fixed inset-y-0 left-0 z-30 flex w-[260px] flex-col border-r border-hairline bg-white/80 backdrop-blur-md transition-transform duration-200 lg:static lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* 品牌区 */}
        <div className="flex items-center gap-3 border-b border-hairline px-4 py-4">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-lake-deep font-serif-sc text-[15px] font-bold text-white select-none"
          >
            环
          </span>
          <div className="flex flex-col leading-tight">
            <span className="font-serif-sc text-[15px] font-semibold text-ink">{PAGE.brand}</span>
            <span className="mt-0.5 text-[10px] leading-3 text-ink-faint">HUST · 环境学院</span>
          </div>
        </div>

        {/* 新建对话 */}
        <div className="px-3 py-3">
          <button
            type="button"
            onClick={() => void newChat()}
            className="flex w-full items-center justify-center gap-2 rounded-[8px] bg-lake-deep px-4 py-2.5 text-[13px] font-medium text-white transition-colors duration-200 hover:bg-[#2f5689] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-deep"
          >
            <span aria-hidden="true">＋</span>
            {PAGE.newChat}
          </button>
        </div>

        {/* 历史会话列表 */}
        <div className="px-4 pb-2 pt-1 text-[11px] font-medium tracking-[0.14em] text-ink-faint uppercase">
          {PAGE.history}
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {conversations.length === 0 && (
            <p className="px-3 py-4 text-[12px] leading-6 text-ink-faint">暂无历史会话</p>
          )}
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`group mb-0.5 flex items-center rounded-[8px] transition-colors duration-150 ${
                c.id === activeId ? 'bg-lake-pale' : 'hover:bg-lake-mist/60'
              }`}
            >
              <button
                type="button"
                onClick={() => {
                  setActiveId(c.id);
                  setSidebarOpen(false);
                }}
                className="min-w-0 flex-1 truncate px-3 py-2.5 text-left text-[13px] text-ink focus-visible:outline-none"
                title={c.title}
              >
                {c.title}
              </button>
              <button
                type="button"
                aria-label={PAGE.deleteLabel}
                onClick={() => void removeChat(c.id)}
                className="mr-1 hidden h-6 w-6 shrink-0 items-center justify-center rounded-md text-[13px] text-ink-faint hover:bg-white hover:text-lake-deep group-hover:flex focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep"
              >
                ×
              </button>
            </div>
          ))}
        </nav>

        {/* 底部说明 */}
        <div className="border-t border-hairline px-4 py-3 text-[10px] leading-4 text-ink-faint">
          {PAGE.brandSub}
        </div>
      </aside>

      {/* 主对话区 */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏 */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-hairline bg-white/60 px-4 backdrop-blur-sm sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              aria-label="打开侧栏"
              onClick={() => setSidebarOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-hairline text-ink-soft lg:hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep"
            >
              ☰
            </button>
            <h1 className="truncate text-[14px] font-medium text-ink">{activeTitle}</h1>
          </div>
          <div className="flex items-center gap-2 text-[12px] text-ink-faint">
            <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-lake-deep" />
            在线
          </div>
        </header>

        {/* 错误提示 */}
        {loadError && (
          <div className="mx-4 mt-3 rounded-[8px] border border-lake-soft bg-lake-pale px-4 py-2 text-[12px] text-ink-soft sm:mx-6">
            {loadError}
            <button type="button" className="ml-3 text-lake-deep underline" onClick={() => setLoadError('')}>
              忽略
            </button>
          </div>
        )}

        {/* 消息流 */}
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-5 py-8">
            {messages.length === 0 && (
              <div className="flex flex-1 flex-col items-start justify-center gap-5 py-14">
                <p className="text-[12px] tracking-[0.2em] text-lake-deep">HUST · 环境科学与工程学院</p>
                <h2 className="font-serif-sc text-[2.1rem] leading-[1.35] font-semibold text-ink">
                  {PAGE.welcomeTitle}
                </h2>
                <p className="max-w-md text-[14px] leading-7 text-ink-soft">{PAGE.welcomeDesc}</p>
                <div className="mt-2 flex flex-wrap gap-2.5">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      disabled={sending}
                      onClick={() => void send(s)}
                      className="rounded-full border border-hairline bg-white/70 px-4 py-2 text-[13px] text-ink-soft transition-colors duration-200 hover:border-lake-deep hover:text-lake-deep disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-deep"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m) =>
              m.role === 'user' ? (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-[14px] rounded-br-[4px] bg-lake-soft/50 px-4 py-2.5 text-[14px] leading-7 text-ink">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={m.id} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline gap-2">
                    <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-lake-deep" />
                    <span className="text-[12px] font-medium text-ink-soft">{PAGE.agentLabel}</span>
                  </div>

                  <AgentProgress
                    thoughts={m.thoughts}
                    active={m.streaming ? activeThought : ''}
                    streaming={m.streaming}
                  />

                  {m.content && (
                    <div className="text-ink">
                      <MarkdownView content={m.content} />
                      {m.streaming && (
                        <span
                          aria-hidden="true"
                          className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-lake-deep"
                        />
                      )}
                    </div>
                  )}

                  {!m.content && m.streaming && m.thoughts.length === 0 && !activeThought && (
                    <div className="flex items-center gap-2 text-[12px] text-ink-faint">
                      <span
                        aria-hidden="true"
                        className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-hairline border-t-lake-deep"
                      />
                      正在连接智能体…
                    </div>
                  )}
                </div>
              )
            )}
          </div>
        </div>

        {/* 输入区 */}
        <footer className="shrink-0 border-t border-hairline bg-white/70 backdrop-blur-sm">
          <div className="mx-auto w-full max-w-3xl px-5 py-4">
            <div className="flex items-end gap-3 rounded-[12px] border border-hairline bg-white px-3 py-2.5 focus-within:border-lake-deep">
              <textarea
                ref={taRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  autoGrow();
                }}
                onKeyDown={onKeyDown}
                rows={1}
                placeholder={PAGE.placeholder}
                disabled={sending}
                className="max-h-[140px] min-h-[28px] flex-1 resize-none bg-transparent text-[14px] leading-7 text-ink outline-none placeholder:text-ink-faint disabled:opacity-60"
              />
              <button
                type="button"
                disabled={!canSend}
                onClick={() => void send(input)}
                className="shrink-0 rounded-lg bg-lake-deep px-4 py-1.5 text-[13px] font-medium text-white transition-colors duration-200 hover:bg-[#2f5689] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-deep"
              >
                发送
              </button>
            </div>
            <p className="mt-2 text-center text-[11px] text-ink-faint">{PAGE.footer}</p>
          </div>
        </footer>
      </main>
    </div>
  );
}

let root: ReturnType<typeof createRoot> | null = null;

/** 首页渲染 */
export function renderHome() {
  const app = document.getElementById('app');

  if (!app) {
    throw new Error('App element not found');
  }

  if (!root) {
    root = createRoot(app);
  }

  root.render(<App />);
}
