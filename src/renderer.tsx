import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

/** 智能体会话信息（来自 /api/chat/session） */
interface RobotSession {
  visitorId: string;
  visitorVc: string;
  conversationId: string;
}

/** 消息模型 */
interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  /** 思考过程步骤（仅 assistant） */
  thoughts: string[];
  /** 是否仍在流式接收 */
  streaming: boolean;
}

/** 建议问题（空状态引导） */
const SUGGESTIONS = [
  '请介绍一下工程认证的基本流程',
  '工程认证需要准备哪些材料？',
  '帮我梳理一下专业培养目标怎么写',
  '工程认证自评报告的结构是什么？',
];

const PAGE = {
  brand: '智识',
  brandFull: '智识对话',
  subtitle: '超星智能体 · 自研交互界面',
  welcomeTitle: '提问，即开卷',
  welcomeDesc: '由超星智能体驱动。它正在等待你的第一个问题。',
  agentLabel: '智能体',
  placeholder: '输入问题，Enter 发送',
  thinkingLabel: '正在思考',
  thoughtDone: '已深度思考',
  footer: '内容由 AI 生成，仅供参考',
  errorRetry: '出错了，点击重试',
  sessionRetry: '连接智能体失败，请刷新页面重试',
} as const;

let nextId = 1;

function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [session, setSession] = useState<RobotSession | null>(null);
  const [sessionError, setSessionError] = useState(false);
  const [activeThought, setActiveThought] = useState('');

  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  /** 申请智能体会话（页面加载时一次） */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/chat/session', { method: 'POST' });
        const data = (await res.json()) as { success?: boolean; session?: RobotSession };
        if (!cancelled && data.success && data.session) {
          setSession(data.session);
        } else if (!cancelled) {
          setSessionError(true);
        }
      } catch {
        if (!cancelled) setSessionError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** 消息列表自动滚动到底部 */
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, activeThought]);

  /** textarea 自适应高度 */
  const autoGrow = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  }, []);

  /** 发送一条消息：调用 SSE 流式接口，打字机式渲染 */
  const send = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || sending || !session) return;

      const userMsg: ChatMessage = { id: nextId++, role: 'user', text: q, thoughts: [], streaming: false };
      const agentMsg: ChatMessage = { id: nextId++, role: 'assistant', text: '', thoughts: [], streaming: true };
      setMessages((prev) => [...prev, userMsg, agentMsg]);
      setInput('');
      setSending(true);
      if (taRef.current) taRef.current.style.height = 'auto';

      const controller = new AbortController();
      abortRef.current = controller;

      const patch = (fn: (m: ChatMessage) => ChatMessage) => {
        setMessages((prev) => prev.map((m) => (m.id === agentMsg.id ? fn(m) : m)));
      };

      try {
        const url =
          `/api/chat/stream?q=${encodeURIComponent(q)}` +
          `&visitorId=${encodeURIComponent(session.visitorId)}` +
          `&visitorVc=${encodeURIComponent(session.visitorVc)}` +
          `&conversationId=${encodeURIComponent(session.conversationId)}`;
        const res = await fetch(url, { signal: controller.signal });

        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // 解析 SSE 帧（event: xxx\ndata: {...}\n\n）
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const lines = frame.split('\n');
            let eventName = '';
            let dataRaw = '';
            for (const line of lines) {
              if (line.startsWith('event: ')) eventName = line.slice(7).trim();
              else if (line.startsWith('data: ')) dataRaw = line.slice(6);
            }
            if (!dataRaw) continue;

            if (eventName === 'thought') {
              const { description } = JSON.parse(dataRaw) as { description?: string };
              if (description) {
                setActiveThought(description);
                patch((m) => ({ ...m, thoughts: [...m.thoughts, description] }));
              }
            } else if (eventName === 'delta') {
              const { text } = JSON.parse(dataRaw) as { text?: string };
              if (text) {
                setActiveThought('');
                patch((m) => ({ ...m, text: m.text + text }));
              }
            } else if (eventName === 'final') {
              const { text } = JSON.parse(dataRaw) as { text?: string };
              setActiveThought('');
              patch((m) => ({
                ...m,
                text: text && text.length >= m.text.length ? text : m.text,
                streaming: false,
              }));
            } else if (eventName === 'error') {
              const { message } = JSON.parse(dataRaw) as { message?: string };
              setActiveThought('');
              patch((m) => ({
                ...m,
                text: m.text || message || PAGE.errorRetry,
                streaming: false,
              }));
            }
          }
        }
        patch((m) => ({ ...m, streaming: false }));
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          patch((m) => ({ ...m, text: m.text || PAGE.errorRetry, streaming: false }));
        }
      } finally {
        setActiveThought('');
        setSending(false);
        abortRef.current = null;
      }
    },
    [sending, session]
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input);
    }
  };

  const canSend = input.trim().length > 0 && !sending && !!session;

  return (
    <div className="flex h-full min-h-screen flex-col bg-paper text-ink">
      {/* 头栏 */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-hairline bg-paper px-4 sm:px-6">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-[4px] bg-vermilion font-serif-sc text-[15px] font-bold text-white select-none"
          >
            智
          </span>
          <div className="flex flex-col leading-none">
            <span className="font-serif-sc text-[15px] font-semibold tracking-wide">{PAGE.brandFull}</span>
            <span className="mt-1 text-[11px] text-ink-faint">{PAGE.subtitle}</span>
          </div>
        </div>
        {/* 在线状态：朱砂呼吸圆点 */}
        <div className="flex items-center gap-2 text-[12px] text-ink-faint">
          {sessionError ? (
            <span className="text-vermilion">{PAGE.sessionRetry}</span>
          ) : (
            <>
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${session ? 'animate-pulse bg-vermilion' : 'bg-ink-faint'}`}
              />
              {session ? '在线' : '连接中'}
            </>
          )}
        </div>
      </header>

      {/* 消息列表 */}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 py-8">
          {messages.length === 0 && (
            /* 空状态：排版式欢迎 */
            <div className="flex flex-1 flex-col items-start justify-center gap-5 py-16">
              <p className="text-[12px] tracking-[0.2em] text-vermilion">{PAGE.brand}</p>
              <h1 className="font-serif-sc text-4xl leading-[1.3] font-semibold">{PAGE.welcomeTitle}</h1>
              <p className="max-w-md text-[14px] leading-7 text-ink-soft">{PAGE.welcomeDesc}</p>
              <div className="mt-2 flex flex-wrap gap-2.5">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={!session || sending}
                    onClick={() => void send(s)}
                    className="rounded-full border border-hairline bg-paper px-4 py-2 text-[13px] text-ink-soft transition-colors duration-200 hover:border-vermilion hover:text-vermilion disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) =>
            m.role === 'user' ? (
              /* 用户消息：右对齐纸底描边气泡 */
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-[10px] border border-hairline bg-paper-deep px-4 py-2.5 text-[14px] leading-7">
                  {m.text}
                </div>
              </div>
            ) : (
              /* 智能体消息：左对齐排版式，无气泡 */
              <div key={m.id} className="flex flex-col gap-2.5">
                <div className="flex items-baseline gap-2">
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-vermilion" />
                  <span className="text-[12px] font-medium text-ink-soft">{PAGE.agentLabel}</span>
                </div>

                {/* 思考过程：流式阶段逐条淡入，完成后折叠 */}
                {m.thoughts.length > 0 && (
                  <details className="group" open={m.streaming}>
                    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] text-ink-faint select-none">
                      <span className="group-open:hidden">
                        {m.streaming ? `${PAGE.thinkingLabel}…` : PAGE.thoughtDone}
                        {m.streaming && <span className="ml-1 animate-pulse">·</span>}
                      </span>
                      <span className="hidden group-open:inline">
                        {m.streaming ? `${PAGE.thinkingLabel}…` : `${PAGE.thoughtDone}（${m.thoughts.length} 步）`}
                      </span>
                    </summary>
                    <ul className="mt-1.5 border-l border-hairline pl-4">
                      {m.thoughts.map((t, i) => (
                        <li key={i} className="py-0.5 text-[12px] leading-6 text-ink-faint">
                          {t}
                        </li>
                      ))}
                      {activeThought && m.streaming && (
                        <li className="py-0.5 text-[12px] leading-6 text-ink-soft">{activeThought}</li>
                      )}
                    </ul>
                  </details>
                )}

                {/* 回答正文 + 打字机光标 */}
                {m.text && (
                  <div className="text-[14px] leading-8 whitespace-pre-wrap text-ink">
                    {m.text}
                    {m.streaming && (
                      <span
                        aria-hidden="true"
                        className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-vermilion"
                      />
                    )}
                  </div>
                )}

                {/* 无正文且非流式：等待骨架 */}
                {!m.text && m.streaming && m.thoughts.length === 0 && (
                  <div className="flex items-center gap-2 text-[12px] text-ink-faint">
                    <span
                      aria-hidden="true"
                      className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-hairline border-t-vermilion"
                    />
                    {PAGE.thinkingLabel}…
                  </div>
                )}
              </div>
            )
          )}
        </div>
      </div>

      {/* 输入区 */}
      <footer className="shrink-0 border-t border-hairline bg-paper-deep">
        <div className="mx-auto w-full max-w-3xl px-5 py-4">
          <div className="flex items-end gap-3 rounded-[10px] border border-hairline bg-paper px-3 py-2.5 focus-within:border-vermilion">
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                autoGrow();
              }}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={session ? PAGE.placeholder : '正在连接智能体…'}
              disabled={!session || sessionError}
              className="max-h-[140px] min-h-[28px] flex-1 resize-none bg-transparent text-[14px] leading-7 text-ink outline-none placeholder:text-ink-faint disabled:opacity-60"
            />
            <button
              type="button"
              disabled={!canSend}
              onClick={() => void send(input)}
              className="shrink-0 rounded-lg bg-vermilion px-4 py-1.5 text-[13px] font-medium text-white transition-colors duration-200 hover:bg-vermilion-deep disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion"
            >
              发送
            </button>
          </div>
          <p className="mt-2 text-center text-[11px] text-ink-faint">{PAGE.footer}</p>
        </div>
      </footer>
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
