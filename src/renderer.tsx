import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MarkdownView } from './components/MarkdownView';
import { AgentProgress } from './components/AgentProgress';
import { BackgroundEffect } from './components/BackgroundEffect';
import {
  type Attachment,
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
  attachments: Attachment[];
  streaming: boolean;
}

/* ===== Web Speech API 类型（Chrome 私有实现的最小声明） ===== */
interface SpeechResultItem {
  transcript: string;
}
interface SpeechResultList {
  length: number;
  [index: number]: ArrayLike<SpeechResultItem>;
}
interface SpeechEventLike {
  resultIndex: number;
  results: SpeechResultList;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  start(): void;
  stop(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

const PAGE = {
  brand: '工程认证',
  brandSub: '华中科技大学环境科学与工程学院',
  newChat: '新建对话',
  history: '历史会话',
  welcomeTitle: '工程认证材料 · 智能读取',
  welcomeDesc:
    '上传工程认证材料文档，智能体自动提取文档内容，可按章节（如 1.1、1.2、2.1）读取并细分选择章节内容。',
  agentLabel: '工程认证',
  placeholder: '输入问题或章节号（如 1.1），Enter 发送，Shift+Enter 换行',
  deleteLabel: '删除',
  confirmDelete: '确定删除该会话？',
  footer: '内容由 AI 生成，仅供参考',
  loadFail: '历史加载失败',
  uploadLabel: '上传文件',
  uploadHint: '上传工程认证材料（doc/pdf/txt），智能体将提取文档内容',
  voiceLabel: '语音输入',
  voiceUnsupported: '当前浏览器不支持语音输入',
} as const;

const SUGGESTIONS = [
  '列出文档的全部章节目录',
  '读取 1.1 培养目标的内容',
  '读取 2.1 工程知识毕业要求',
  '读取第 3 章 课程体系的内容',
];

/** 从 localStorage 读取智能体会话映射（本地对话 → chaoxing 会话） */
function loadRobotSessions(): Record<string, RobotSession> {
  try {
    return (
      JSON.parse(localStorage.getItem('engcert_robot_sessions') ?? 'null') ??
      JSON.parse(localStorage.getItem('envchat_robot_sessions') ?? 'null') ??
      {}
    ) as Record<string, RobotSession>;
  } catch {
    return {};
  }
}

function saveRobotSessions(map: Record<string, RobotSession>): void {
  localStorage.setItem('engcert_robot_sessions', JSON.stringify(map));
}

let nextTempId = 1;

/** 文件大小可读化 */
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 附件类型图标（Unicode 符号，按 MIME 粗分） */
function attIcon(type: string): string {
  if (type.startsWith('image/')) return '🖼';
  if (type.startsWith('audio/') || type.startsWith('video/')) return '🎬';
  if (type.includes('pdf')) return '📕';
  if (type.includes('word') || type.includes('document')) return '📘';
  if (type.includes('sheet') || type.includes('excel')) return '📗';
  if (type.includes('zip') || type.includes('rar')) return '🗜';
  return '📄';
}

/** 附件卡片：一眼可见上传了什么文件（名称 / 类型 / 大小）；上传中带 1.8s 细扫描光 */
function AttachmentChip({ att, onRemove }: { att: Attachment; onRemove?: () => void }) {
  const uploading = !att.objectId;
  return (
    <div
      className={`flex max-w-[260px] items-center gap-2.5 rounded-[10px] border border-hairline bg-white px-3 py-2 shadow-sm ${uploading ? 'att-scan' : ''}`}
      title={att.name}
    >
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-lake-pale text-[15px]"
      >
        {attIcon(att.type)}
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-[13px] font-medium text-ink">{att.name}</p>
        <p className="mt-0.5 text-[11px] text-ink-faint">{fmtSize(att.size)}</p>
      </div>
      {onRemove && (
        <button
          type="button"
          aria-label={`移除 ${att.name}`}
          onClick={onRemove}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[12px] text-ink-faint hover:bg-lake-pale hover:text-lake-deep focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep"
        >
          ×
        </button>
      )}
    </div>
  );
}

function App() {
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [activeThought, setActiveThought] = useState('');
  const [loadError, setLoadError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /** 待发送附件（仅元数据展示） */
  const [pendingAtts, setPendingAtts] = useState<Attachment[]>([]);
  /** 语音输入状态 */
  const [listening, setListening] = useState(false);
  /** 背景动效开关（localStorage 持久化，默认开启） */
  const [bgFxOn, setBgFxOn] = useState(() => {
    try {
      return localStorage.getItem('engcert_bg_fx') !== '0';
    } catch {
      return true;
    }
  });
  /** 交互降感：输入聚焦/滚动聊天时降低背景动态层透明度 40% */
  const [bgDimmed, setBgDimmed] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const robotSessionsRef = useRef<Record<string, RobotSession>>({});
  const recRef = useRef<SpeechRecognitionLike | null>(null);

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

  /** 卸载时释放语音识别 */
  useEffect(() => {
    return () => {
      recRef.current?.stop();
    };
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
            attachments: Array.isArray(r.attachments) ? r.attachments : [],
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
  }, [messages, activeThought, pendingAtts]);

  /** 背景动效状态联动：滚动聊天时降低动态层透明度；页面隐藏/侧栏抽屉打开时暂停 */
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    let dimTimer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = (): void => {
      setBgDimmed(true);
      clearTimeout(dimTimer);
      // 停止滚动 1.5s 后恢复
      dimTimer = setTimeout(() => setBgDimmed(false), 1500);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const onVis = (): void => {
      document.documentElement.dataset.paused = document.hidden ? '1' : '0';
    };
    document.addEventListener('visibilitychange', onVis);
    onVis();
    return () => {
      el.removeEventListener('scroll', onScroll);
      document.removeEventListener('visibilitychange', onVis);
      clearTimeout(dimTimer);
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.paused = sidebarOpen ? '1' : '0';
  }, [sidebarOpen]);

  const autoGrow = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
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
      setMessages([]);
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
      const rest = { ...robotSessionsRef.current };
      delete rest[id];
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
    async (question: string, attachments: Attachment[] = []) => {
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

      // 2. 保存用户消息（DB，含附件元数据）
      const userMsg: UiMessage = {
        id: `tmp-u-${nextTempId++}`,
        role: 'user',
        content: q,
        thoughts: [],
        attachments,
        streaming: false,
      };
      const agentMsg: UiMessage = {
        id: `tmp-a-${nextTempId++}`,
        role: 'assistant',
        content: '',
        thoughts: [],
        attachments: [],
        streaming: true,
      };
      setMessages((prev) => [...prev, userMsg, agentMsg]);
      setInput('');
      setPendingAtts([]);
      setSending(true);
      if (taRef.current) taRef.current.style.height = 'auto';

      const patch = (fn: (m: UiMessage) => UiMessage) => {
        setMessages((prev) => prev.map((m) => (m.id === agentMsg.id ? fn(m) : m)));
      };

      try {
        // 3. 获取智能体会话（同一会话复用同一 chaoxing conversation，天然保持多轮上下文）
        const robot = await ensureRobotSession(convId);

        // 4. SSE 流式请求（已上传成功的附件以 fileInfo 形式随消息携带）
        const sentFiles = attachments
          .filter((a): a is Attachment & { objectId: string } => Boolean(a.objectId))
          .map((a) => ({
            objectId: a.objectId,
            filename: a.name,
            type: a.type,
            fileSize: a.size,
          }));
        const url =
          `/api/chat/stream?q=${encodeURIComponent(q)}` +
          `&visitorId=${encodeURIComponent(robot.visitorId)}` +
          `&visitorVc=${encodeURIComponent(robot.visitorVc)}` +
          `&conversationId=${encodeURIComponent(robot.conversationId)}` +
          (sentFiles.length > 0 ? `&files=${encodeURIComponent(JSON.stringify(sentFiles))}` : '');
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
          await insertMessage(convId, 'user', q, [], attachments);
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

  /** 附件选择：立即上传到智能体拿 objectId（发送时随消息带 fileInfo） */
  const onPickFiles = (files: FileList | null): void => {
    if (!files || files.length === 0) return;
    const picked: Attachment[] = Array.from(files)
      .slice(0, 6 - pendingAtts.length)
      .map((f) => ({ name: f.name, size: f.size, type: f.type || 'application/octet-stream' }));
    if (picked.length === 0) return;
    setPendingAtts((prev) => [...prev, ...picked].slice(0, 6));
    if (fileRef.current) fileRef.current.value = '';

    // 逐个真实上传（需绑定到当前会话；无会话时先建会话，确保文件与消息同会话）
    (async () => {
      try {
        let convId = activeId;
        if (!convId) {
          const row = await createConversation('材料读取');
          convId = row.id;
          setConversations((prev) => [row, ...prev]);
          setActiveId(row.id);
        }
        const robot = await ensureRobotSession(convId);
        for (const att of picked) {
          const file = Array.from(files).find((f) => f.name === att.name);
          if (!file) continue;
          const fd = new FormData();
          fd.append('visitorId', robot.visitorId);
          fd.append('visitorVc', robot.visitorVc);
          fd.append('conversationId', robot.conversationId);
          fd.append('file', file);
          const res = await fetch('/api/chat/upload', { method: 'POST', body: fd });
          const data = (await res.json()) as {
            success?: boolean;
            file?: { objectId?: string };
            error?: string;
          };
          if (data.success && data.file?.objectId) {
            setPendingAtts((prev) =>
              prev.map((p) => (p.name === att.name && !p.objectId ? { ...p, objectId: data.file!.objectId } : p))
            );
          } else {
            throw new Error(data.error ?? `${att.name} 上传失败`);
          }
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : '文件上传失败');
        // 上传失败的附件直接移除，避免发送无效文件
        setPendingAtts((prev) => prev.filter((p) => p.objectId));
      }
    })();
  };

  /** 语音输入开关（Web Speech API，zh-CN） */
  const toggleVoice = (): void => {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) {
      setLoadError(PAGE.voiceUnsupported);
      return;
    }
    const rec = new Ctor();
    rec.lang = 'zh-CN';
    rec.continuous = true;
    rec.interimResults = false;
    let finalBuf = '';
    rec.onresult = (e: SpeechEventLike) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const item = e.results[i][0];
        if (item?.transcript) finalBuf += item.transcript;
      }
      setInput(finalBuf);
    };
    rec.onend = () => {
      setListening(false);
      recRef.current = null;
    };
    rec.onerror = () => {
      setListening(false);
      recRef.current = null;
    };
    recRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      setListening(false);
      recRef.current = null;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input, pendingAtts);
    }
  };

  const canSend = (input.trim().length > 0 || pendingAtts.length > 0) && !sending;
  const activeTitle = conversations.find((c) => c.id === activeId)?.title ?? PAGE.brand;

  return (
    <div className="relative flex h-full min-h-screen">
      <BackgroundEffect enabled={bgFxOn} dimmed={bgDimmed} />

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
        {/* 品牌区：华科校徽 + 工程认证 */}
        <div className="flex items-center gap-3 border-b border-hairline px-4 py-4">
          <img
            src="/hust-logo.png"
            alt="华中科技大学校徽"
            className="h-11 w-11 shrink-0 select-none"
          />
          <div className="flex flex-col leading-tight">
            <span className="font-serif-sc text-[16px] font-semibold text-ink">{PAGE.brand}</span>
            <span className="mt-0.5 text-[10px] leading-3 text-ink-faint">HUST · 环境学院</span>
          </div>
        </div>

        {/* 新建对话 */}
        <div className="px-3 py-3">
          <button
            type="button"
            onClick={() => void newChat()}
            className="flex w-full items-center justify-center gap-2 rounded-[10px] bg-lake-deep px-4 py-2.5 text-[14px] font-medium text-white transition-colors duration-200 hover:bg-[#2f5689] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-deep"
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
            <p className="px-3 py-4 text-[13px] leading-6 text-ink-faint">暂无历史会话</p>
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
                className="min-w-0 flex-1 truncate px-3 py-2.5 text-left text-[13.5px] text-ink focus-visible:outline-none"
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

        {/* 背景动效开关 */}
        <div className="border-t border-hairline px-4 py-2.5">
          <button
            type="button"
            role="switch"
            aria-checked={bgFxOn}
            onClick={() => {
              const next = !bgFxOn;
              setBgFxOn(next);
              try {
                localStorage.setItem('engcert_bg_fx', next ? '1' : '0');
              } catch {
                // 持久化失败不阻断
              }
            }}
            className="flex w-full items-center justify-between gap-2 rounded-[8px] px-1 py-1 text-[12.5px] text-ink-soft hover:bg-lake-mist/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep"
          >
            <span>背景动效</span>
            <span
              aria-hidden="true"
              className={`relative inline-flex h-[18px] w-[34px] shrink-0 items-center rounded-full transition-colors duration-200 ${
                bgFxOn ? 'bg-lake-deep' : 'bg-lake-soft/70'
              }`}
            >
              <span
                className={`absolute h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-transform duration-200 ${
                  bgFxOn ? 'translate-x-[16px]' : 'translate-x-[2px]'
                }`}
              />
            </span>
          </button>
        </div>

        {/* 底部说明 */}
        <div className="border-t border-hairline px-4 py-3 text-[10.5px] leading-4 text-ink-faint">
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
            <h1 className="truncate text-[15px] font-medium text-ink">{activeTitle}</h1>
          </div>
          <div className="flex items-center gap-2 text-[12.5px] text-ink-faint">
            <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-lake-deep" />
            在线
          </div>
        </header>

        {/* 错误提示 */}
        {loadError && (
          <div className="mx-4 mt-3 rounded-[8px] border border-lake-soft bg-lake-pale px-4 py-2.5 text-[13px] text-ink-soft sm:mx-6">
            {loadError}
            <button type="button" className="ml-3 text-lake-deep underline" onClick={() => setLoadError('')}>
              忽略
            </button>
          </div>
        )}

        {/* 消息流 */}
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 py-8">
            {messages.length === 0 && (
              <div className="flex flex-1 flex-col items-start justify-center gap-5 py-14">
                <p className="text-[13px] tracking-[0.2em] text-lake-deep">HUST · 环境科学与工程学院</p>
                <h2 className="font-serif-sc text-[2.2rem] leading-[1.35] font-semibold text-ink">
                  {PAGE.welcomeTitle}
                </h2>
                <p className="max-w-lg text-[15px] leading-8 text-ink-soft">{PAGE.welcomeDesc}</p>
                <div className="mt-2 flex flex-wrap gap-2.5">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      disabled={sending}
                      onClick={() => void send(s)}
                      className="rounded-full border border-hairline bg-white/70 px-4 py-2.5 text-[14px] text-ink-soft transition-colors duration-200 hover:border-lake-deep hover:text-lake-deep disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-deep"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m) =>
              m.role === 'user' ? (
                <div key={m.id} className="flex flex-col items-end gap-2">
                  {m.attachments.length > 0 && (
                    <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
                      {m.attachments.map((a, i) => (
                        <AttachmentChip key={`${a.name}-${i}`} att={a} />
                      ))}
                    </div>
                  )}
                  {m.content && (
                    <div className="max-w-[85%] rounded-[14px] rounded-br-[4px] bg-lake-soft/50 px-4 py-3 text-[15px] leading-8 text-ink">
                      {m.content}
                    </div>
                  )}
                </div>
              ) : (
                <div key={m.id} className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <img src="/hust-logo.png" alt="" className="h-5 w-5 shrink-0 opacity-80" aria-hidden="true" />
                    <span className="text-[13px] font-medium text-ink-soft">{PAGE.agentLabel}</span>
                  </div>

                  <AgentProgress
                    thoughts={m.thoughts}
                    active={m.streaming ? activeThought : ''}
                    streaming={m.streaming}
                  />

                  {m.content && (
                    <div className="text-ink">
                      <MarkdownView
                        content={m.content}
                        onOptionClick={!m.streaming && !sending ? (text) => void send(text) : undefined}
                      />
                      {m.streaming && (
                        <span
                          aria-hidden="true"
                          className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-lake-deep"
                        />
                      )}
                    </div>
                  )}

                  {!m.content && m.streaming && m.thoughts.length === 0 && !activeThought && (
                    <div className="flex items-center gap-2 text-[13px] text-ink-faint">
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

        {/* 输入区：附件上传 + 语音输入 + 文本框 */}
        <footer className="shrink-0 border-t border-hairline bg-white/70 backdrop-blur-sm">
          <div className="mx-auto w-full max-w-3xl px-5 py-4">
            {/* 待发送附件卡片 */}
            {pendingAtts.length > 0 && (
              <div className="mb-2.5 flex flex-wrap gap-2">
                {pendingAtts.map((a, i) => (
                  <AttachmentChip
                    key={`${a.name}-${i}`}
                    att={a}
                    onRemove={() => setPendingAtts((prev) => prev.filter((_, j) => j !== i))}
                  />
                ))}
              </div>
            )}

            <div className="flex items-end gap-2 rounded-[14px] border border-hairline bg-white px-3 py-2.5 shadow-sm transition-colors focus-within:border-lake-deep focus-within:shadow-[0_0_0_3px_rgba(58,103,171,0.1)]">
              {/* 上传文件 */}
              <input
                ref={fileRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => onPickFiles(e.target.files)}
              />
              <button
                type="button"
                aria-label={PAGE.uploadLabel}
                title={PAGE.uploadLabel}
                disabled={sending}
                onClick={() => fileRef.current?.click()}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-[17px] text-ink-soft transition-colors hover:bg-lake-pale hover:text-lake-deep disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                </svg>
              </button>

              {/* 语音输入 */}
              <button
                type="button"
                aria-label={PAGE.voiceLabel}
                title={PAGE.voiceLabel}
                disabled={sending}
                onClick={toggleVoice}
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] transition-colors disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep ${
                  listening
                    ? 'animate-[env-breath_2s_ease-in-out_infinite] bg-lake-deep text-white'
                    : 'text-ink-soft hover:bg-lake-pale hover:text-lake-deep'
                }`}
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
                  <path d="M19 10v2a7 7 0 01-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              </button>

              <textarea
                ref={taRef}
                value={input}
                onFocus={() => setBgDimmed(true)}
                onBlur={() => setBgDimmed(false)}
                onChange={(e) => {
                  setInput(e.target.value);
                  autoGrow();
                }}
                onKeyDown={onKeyDown}
                rows={1}
                placeholder={listening ? '正在聆听，请说话…' : PAGE.placeholder}
                disabled={sending}
                className="max-h-[160px] min-h-[36px] flex-1 resize-none bg-transparent px-1 text-[15px] leading-8 text-ink outline-none placeholder:text-ink-faint disabled:opacity-60"
              />

              <button
                type="button"
                disabled={!canSend}
                onClick={() => void send(input, pendingAtts)}
                className="shrink-0 rounded-[10px] bg-lake-deep px-5 py-2 text-[14px] font-medium text-white transition-colors duration-200 hover:bg-[#2f5689] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-deep"
              >
                发送
              </button>
            </div>
            <p className="mt-2 text-center text-[11.5px] text-ink-faint">
              {PAGE.footer} · 支持上传附件（展示名称与大小）与语音输入
            </p>
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
