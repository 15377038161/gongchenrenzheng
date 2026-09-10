import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MarkdownView } from './components/MarkdownView';
import { AgentProgress } from './components/AgentProgress';
import { BackgroundEffect } from './components/BackgroundEffect';
import { FormCard, MenuCard } from './components/RobotCards';
import type { RobotForm, RobotMenu } from './lib/robot-types';
import { fmtSize } from './components/fmt';
import { getSupabase } from './lib/supabase';
import { handleOAuthLoginFlow, loginWithChaoxingOAuth, logout } from './lib/auth';
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
  /** 智能体下发的表单（FORM 事件） */
  form?: RobotForm;
  /** 智能体下发的菜单（MENU 事件） */
  menu?: RobotMenu;
  /** 表单是否已提交（提交后卡片转为只读） */
  formSubmitted?: boolean;
  /** 菜单是否已选择（选择后卡片转为只读） */
  menuAnswered?: boolean;
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
  placeholder: '请输入工程认证相关问题',
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
  '帮我编写工程认证',
  '帮我提炼文档内容',
];

/** 智能体会话缓存有效期：12 小时（超星访客会话可能过期，超期自动失效重建） */
const ROBOT_SESSION_TTL = 12 * 60 * 60 * 1000;

/** 登录用户显示名：超星用户取 realname，邮箱用户取邮箱前缀 */
function displayName(user: { user_metadata?: Record<string, unknown>; email?: string | null }): string {
  const meta = user.user_metadata ?? {};
  for (const key of ['realname', 'full_name', 'name']) {
    const v = meta[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  if (user.email) return user.email.split('@')[0];
  return '已登录用户';
}

interface CachedRobotSession {
  session: RobotSession;
  ts: number;
}

/** 各会话的缓存时间（跨 save 保留原始时间戳，避免保存操作刷新 TTL） */
const sessionTimestamps: Record<string, number> = {};

/** 从 localStorage 读取智能体会话映射（本地对话 → chaoxing 会话）；过期条目直接丢弃 */
function loadRobotSessions(): Record<string, RobotSession> {
  try {
    const raw = JSON.parse(localStorage.getItem('engcert_robot_sessions') ?? 'null') as
      | Record<string, CachedRobotSession>
      | null;
    const out: Record<string, RobotSession> = {};
    if (raw && typeof raw === 'object') {
      const now = Date.now();
      for (const [id, entry] of Object.entries(raw)) {
        if (
          entry &&
          typeof entry === 'object' &&
          entry.session &&
          typeof entry.ts === 'number' &&
          now - entry.ts < ROBOT_SESSION_TTL
        ) {
          out[id] = entry.session;
          sessionTimestamps[id] = entry.ts;
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveRobotSessions(map: Record<string, RobotSession>): void {
  const raw: Record<string, CachedRobotSession> = {};
  const now = Date.now();
  for (const [id, session] of Object.entries(map)) {
    raw[id] = { session, ts: sessionTimestamps[id] ?? now };
  }
  localStorage.setItem('engcert_robot_sessions', JSON.stringify(raw));
}

let nextTempId = 1;

/* ===== FORM / MENU 消息的持久化编解码 =====
 * content 为 text 列，表单/菜单消息以 JSON 标记字符串存入（历史加载时解析还原）。 */

/** FORM 标记键（序列化格式：{"__robot_form__":{messageId,schema}}） */
const FORM_TAG = '__robot_form__';
/** MENU 标记键（序列化格式：{"__robot_menu__":{messageId,question,items}}） */
const MENU_TAG = '__robot_menu__';

function encodeForm(form: RobotForm): string {
  return JSON.stringify({ [FORM_TAG]: form });
}

function encodeMenu(menu: RobotMenu): string {
  return JSON.stringify({ [MENU_TAG]: menu });
}

/** 解析历史消息 content：识别 form / menu 标记，返回还原后的附加字段 */
function decodeRobotMessage(content: string): {
  content: string;
  form?: RobotForm;
  menu?: RobotMenu;
} {
  if (!content.startsWith('{"__robot_')) return { content };
  try {
    const raw = JSON.parse(content) as Record<string, unknown>;
    const formRaw = raw[FORM_TAG] as RobotForm | undefined;
    if (formRaw && typeof formRaw.messageId === 'string' && Array.isArray(formRaw.schema)) {
      return { content: '', form: formRaw };
    }
    const menuRaw = raw[MENU_TAG] as RobotMenu | undefined;
    if (
      menuRaw &&
      typeof menuRaw.messageId === 'string' &&
      typeof menuRaw.question === 'string' &&
      Array.isArray(menuRaw.items)
    ) {
      return { content: '', menu: menuRaw };
    }
  } catch {
    // 解析失败按普通文本处理
  }
  return { content };
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
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-lake-pale text-[18px]"
      >
        {attIcon(att.type)}
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-[15.5px] font-medium text-ink">{att.name}</p>
        <p className="mt-0.5 text-[13.5px] text-ink-faint">{fmtSize(att.size)}</p>
      </div>
      {onRemove && (
        <button
          type="button"
          aria-label={`移除 ${att.name}`}
          onClick={onRemove}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[14.5px] text-ink-faint hover:bg-lake-pale hover:text-lake-deep focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep"
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
  /** 历史会话服务不可用（如嵌入第三方门户时 DB 接口异常）：侧栏软提示，不阻塞聊天 */
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /** 待发送附件（仅元数据展示） */
  const [pendingAtts, setPendingAtts] = useState<Attachment[]>([]);
  /** 语音输入状态 */
  const [listening, setListening] = useState(false);
  /** 交互降感：输入聚焦/滚动聊天时降低背景动态层透明度 40% */
  const [bgDimmed, setBgDimmed] = useState(false);

  /* ===== 登录态管理（右上角入口，不强制登录） ===== */
  /** 登录用户：null 未登录/未知，undefined 表示会话检查中 */
  const [authUser, setAuthUser] = useState<{
    name: string;
    email: string;
  } | null | undefined>(undefined);
  /** OAuth 回跳在途（checklogin 中转/exchange 进行中），右上角按钮显示过渡态 */
  const [oauthRelaying, setOauthRelaying] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const robotSessionsRef = useRef<Record<string, RobotSession>>({});
  const recRef = useRef<SpeechRecognitionLike | null>(null);

  /** 登录态初始化 + OAuth 回跳闭环 + 会话变化监听：
   * 1. URL 带 code（超星授权回跳）→ handleOAuthLoginFlow 编排 checklogin 中转与 exchange 兑换
   * 2. onAuthStateChange 监听 session 变化（OAuth 兑换 setSession / 登出），自动刷新右上角登录态
   * 3. 初始检查既有 session；无则未登录——页面正常可用，仅右上角显示登录入口按钮 */
  useEffect(() => {
    let cancelled = false;

    // OAuth 回跳在途标记：中转/exchange 期间右上角显示过渡态
    const relayed = sessionStorage.getItem('cx_checklogin_relay') === '1';
    const hasCode = new URLSearchParams(window.location.search).has('code');
    if (relayed || hasCode) setOauthRelaying(true);

    // session 变化监听：OAuth 兑换 / 登出都会触发，统一刷新 authUser
    const { data: authListener } = getSupabase().auth.onAuthStateChange((_event, session) => {
      if (cancelled) return;
      setAuthUser(
        session?.user
          ? { name: displayName(session.user), email: session.user.email ?? '' }
          : null
      );
      setOauthRelaying(false);
    });

    (async () => {
      const result = await handleOAuthLoginFlow();
      if (cancelled) return;
      if (result.success) {
        // 兑换完成：onAuthStateChange 已刷新 authUser，这里兜底读取一次
        const {
          data: { user },
        } = await getSupabase().auth.getUser();
        if (!cancelled) {
          setAuthUser(user ? { name: displayName(user), email: user.email ?? '' } : null);
          setOauthRelaying(false);
        }
        return;
      }
      // 无 code 或兑换失败：检查既有 session（本系统邮箱登录/OAuth 已建立）
      // 兑换失败（code 失效/交换异常）时上浮错误提示，避免“页面闪一下”无感知
      if (result.error) {
        console.warn('[auth] OAuth 回跳处理失败:', result.error);
        setLoadError(result.error);
      }
      const {
        data: { session },
      } = await getSupabase().auth.getSession();
      if (cancelled) return;
      setAuthUser(
        session?.user
          ? { name: displayName(session.user), email: session.user.email ?? '' }
          : null
      );
      setOauthRelaying(false);
    })();

    return () => {
      cancelled = true;
      authListener.subscription.unsubscribe();
    };
  }, []);

  /** 右上角一键登录：跳转超星授权页（门户已登录用户静默完成） */
  const handleLogin = useCallback(async () => {
    const result = await loginWithChaoxingOAuth();
    if (!result.success) {
      setLoadError(result.error || '跳转授权页失败');
    }
    // 成功时页面即将顶层跳转，无需后续处理
  }, []);

  /** 登出：清除 session，右上角回到登录入口 */
  const handleLogout = useCallback(async () => {
    if (!window.confirm('确定退出登录？')) return;
    await logout();
    setAuthUser(null);
  }, []);

  /** 初始化：加载会话列表（嵌入第三方门户等场景下 DB 接口可能不可用，
   * 历史加载失败仅降级为侧栏提示，不阻塞聊天主流程、不弹顶部错误条） */
  useEffect(() => {
    robotSessionsRef.current = loadRobotSessions();
    (async () => {
      try {
        const rows = await listConversations();
        setConversations(rows);
        if (rows.length > 0) setActiveId(rows[0].id);
      } catch {
        setHistoryUnavailable(true);
      }
    })();
  }, []);

  /** 卸载时释放语音识别 */
  useEffect(() => {
    return () => {
      recRef.current?.stop();
    };
  }, []);

  /** 跳过一次 activeId 加载：程序化新建会话（send/onPickFiles）时，
   * 消息尚未入库，加载 effect 的空结果会覆盖刚插入的本地消息（首条消息消失的根因） */
  const skipLoadRef = useRef<string | null>(null);

  /** 切换会话：加载消息 */
  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    // 程序化新建的会话：跳过本次加载（本地消息即将插入，避免空列表覆盖）
    if (skipLoadRef.current === activeId) {
      skipLoadRef.current = null;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const rows = await listMessages(activeId);
        if (cancelled) return;
        setMessages(
          rows.map((r: MessageRow) => {
            // 还原 form / menu 标记消息；表单/菜单卡片在历史中按已处理展示
            const decoded = decodeRobotMessage(r.content);
            return {
              id: r.id,
              role: r.role,
              content: decoded.content,
              thoughts: Array.isArray(r.thoughts) ? r.thoughts : [],
              attachments: Array.isArray(r.attachments) ? r.attachments : [],
              streaming: false,
              form: decoded.form,
              menu: decoded.menu,
              formSubmitted: decoded.form ? true : undefined,
              menuAnswered: decoded.menu ? true : undefined,
            };
          })
        );
      } catch {
        // 切换会话的历史加载失败：降级为侧栏软提示，不弹顶部错误条阻塞聊天
        if (!cancelled) {
          setHistoryUnavailable(true);
          setMessages([]);
        }
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
    // 与 textarea 的 max-h-[180px] 保持一致，避免增长上限不一致导致提前出现滚动条
    ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
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
    sessionTimestamps[convId] = Date.now(); // 新建会话记录申请时间，供 TTL 判断
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
      delete sessionTimestamps[id];
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
          skipLoadRef.current = row.id; // 跳过加载 effect：消息尚未入库，避免空列表覆盖本地消息
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

      // 3. 先持久化用户消息（不等流结束）：即使后续流式失败/挂起，历史记录也已可见
      try {
        await insertMessage(convId, 'user', q, [], attachments);
        await touchConversation(convId);
        setConversations((prev) => {
          const others = prev.filter((c) => c.id !== convId);
          const cur = prev.find((c) => c.id === convId);
          return cur ? [cur, ...others] : others;
        });
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : '消息保存失败');
      }

      try {
        // 4. 获取智能体会话（同一会话复用同一 chaoxing conversation，天然保持多轮上下文）
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
        /** 收到的 FORM / MENU 下行（表单/菜单消息以标记格式入库） */
        let receivedForm: RobotForm | null = null;
        let receivedMenu: RobotMenu | null = null;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          let streamEnded = false;
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
            } else if (eventName === 'session') {
              // FORCE_LOGOUT 自愈：服务端已换全新会话重发本条消息，本地缓存
              // MUST 同步替换为下发的新会话，否则后续消息仍携带被踢的旧会话
              const fresh = JSON.parse(dataRaw) as RobotSession;
              if (fresh && fresh.visitorId && fresh.visitorVc && fresh.conversationId) {
                robotSessionsRef.current[convId] = fresh;
                saveRobotSessions(robotSessionsRef.current);
                console.info('[chat] 会话已被新窗口占用，已自动切换到新会话');
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
            } else if (eventName === 'form') {
              // 表单下发：填充卡片并结束本轮流（提交走独立 form 接口）
              const form = JSON.parse(dataRaw) as RobotForm;
              if (form && typeof form.messageId === 'string' && Array.isArray(form.schema)) {
                receivedForm = form;
                patch((m) => ({ ...m, form, streaming: false }));
              }
              streamEnded = true;
            } else if (eventName === 'menu') {
              // 菜单下发：填充选项卡片并结束本轮流（选择以普通文本重新发送）
              const menu = JSON.parse(dataRaw) as RobotMenu;
              if (menu && typeof menu.messageId === 'string' && Array.isArray(menu.items)) {
                receivedMenu = menu;
                patch((m) => ({ ...m, menu, streaming: false }));
              }
              streamEnded = true;
            } else if (eventName === 'error') {
              const { message } = JSON.parse(dataRaw) as { message?: string };
              finalText = finalText || message || '回复失败，请重试';
              patch((m) => ({ ...m, content: finalText, streaming: false }));
            }
            if (streamEnded) break;
          }
          if (streamEnded) break;
        }
        patch((m) => ({ ...m, streaming: false }));

        // 5. 持久化智能体回复（用户消息已在请求前入库）
        try {
          if (receivedForm) {
            await insertMessage(convId, 'assistant', encodeForm(receivedForm), lastThoughts);
          } else if (receivedMenu) {
            await insertMessage(convId, 'assistant', encodeMenu(receivedMenu), lastThoughts);
          } else if (finalText) {
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
        // 失败（含超时）时丢弃缓存的智能体会话：疑似过期，下次发送重新申请
        if (convId && robotSessionsRef.current[convId]) {
          const rest = { ...robotSessionsRef.current };
          delete rest[convId];
          delete sessionTimestamps[convId];
          robotSessionsRef.current = rest;
          saveRobotSessions(rest);
        }
      } finally {
        setActiveThought('');
        setSending(false);
      }
    },
    [activeId, sending, messages.length, ensureRobotSession]
  );

  /** 表单文件字段上传：先确保会话，再走 /api/chat/upload 拿 objectId */
  const uploadFormFile = useCallback(
    async (
      convId: string,
      file: File
    ): Promise<{ name: string; size: number; objectId: string } | null> => {
      try {
        const robot = await ensureRobotSession(convId);
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
          return { name: file.name, size: file.size, objectId: data.file.objectId };
        }
        return null;
      } catch {
        return null;
      }
    },
    [ensureRobotSession]
  );

  /**
   * 提交智能体表单（SUBMIT_FORM 协议）：
   * 标记卡片已提交 → 以用户视角追加一条提交回执消息 → 调 /api/chat/form
   * 流式接收回复（事件与 stream 一致，含 form/menu/文本）。
   */
  const sendFormSubmit = useCallback(
    async (agentMsgId: string, formMessageId: string, fields: Array<Record<string, unknown>>) => {
      const convId = activeId;
      if (!convId || sending) return;

      // 1. 表单卡片转只读
      setMessages((prev) =>
        prev.map((m) => (m.id === agentMsgId ? { ...m, formSubmitted: true } : m))
      );

      // 2. 用户回执消息 + 新的流式回复消息
      const receipt: UiMessage = {
        id: `tmp-u-${nextTempId++}`,
        role: 'user',
        content: '已提交表单',
        thoughts: [],
        attachments: [],
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
      setMessages((prev) => [...prev, receipt, agentMsg]);
      setSending(true);

      const patch = (fn: (m: UiMessage) => UiMessage) => {
        setMessages((prev) => prev.map((m) => (m.id === agentMsg.id ? fn(m) : m)));
      };

      // 3. 回执先入库（即使后续失败也已可见）
      try {
        await insertMessage(convId, 'user', '已提交表单', [], []);
        await touchConversation(convId);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : '消息保存失败');
      }

      try {
        const robot = await ensureRobotSession(convId);
        const res = await fetch('/api/chat/form', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            visitorId: robot.visitorId,
            visitorVc: robot.visitorVc,
            conversationId: robot.conversationId,
            messageId: formMessageId,
            fields,
          }),
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finalText = '';
        let lastThoughts: string[] = [];
        let receivedForm: RobotForm | null = null;
        let receivedMenu: RobotMenu | null = null;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          let streamEnded = false;
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
            } else if (eventName === 'session') {
              // FORCE_LOGOUT 自愈：服务端已换全新会话重发本条消息，本地缓存
              // MUST 同步替换为下发的新会话，否则后续消息仍携带被踢的旧会话
              const fresh = JSON.parse(dataRaw) as RobotSession;
              if (fresh && fresh.visitorId && fresh.visitorVc && fresh.conversationId) {
                robotSessionsRef.current[convId] = fresh;
                saveRobotSessions(robotSessionsRef.current);
                console.info('[chat] 会话已被新窗口占用，已自动切换到新会话');
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
            } else if (eventName === 'form') {
              const form = JSON.parse(dataRaw) as RobotForm;
              if (form && typeof form.messageId === 'string' && Array.isArray(form.schema)) {
                receivedForm = form;
                patch((m) => ({ ...m, form, streaming: false }));
              }
              streamEnded = true;
            } else if (eventName === 'menu') {
              const menu = JSON.parse(dataRaw) as RobotMenu;
              if (menu && typeof menu.messageId === 'string' && Array.isArray(menu.items)) {
                receivedMenu = menu;
                patch((m) => ({ ...m, menu, streaming: false }));
              }
              streamEnded = true;
            } else if (eventName === 'error') {
              const { message } = JSON.parse(dataRaw) as { message?: string };
              finalText = finalText || message || '回复失败，请重试';
              patch((m) => ({ ...m, content: finalText, streaming: false }));
            }
            if (streamEnded) break;
          }
          if (streamEnded) break;
        }
        patch((m) => ({ ...m, streaming: false }));

        try {
          if (receivedForm) {
            await insertMessage(convId, 'assistant', encodeForm(receivedForm), lastThoughts);
          } else if (receivedMenu) {
            await insertMessage(convId, 'assistant', encodeMenu(receivedMenu), lastThoughts);
          } else if (finalText) {
            await insertMessage(convId, 'assistant', finalText, lastThoughts);
          }
          await touchConversation(convId);
        } catch (err) {
          setLoadError(err instanceof Error ? err.message : '消息保存失败');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : '表单提交失败，请重试';
        patch((m) => ({ ...m, content: m.content || msg, streaming: false }));
        // 提交失败时恢复卡片可编辑状态（FormCard catch 后会复位 busy）
        setMessages((prev) =>
          prev.map((m) => (m.id === agentMsgId ? { ...m, formSubmitted: false } : m))
        );
        if (robotSessionsRef.current[convId]) {
          const rest = { ...robotSessionsRef.current };
          delete rest[convId];
          delete sessionTimestamps[convId];
          robotSessionsRef.current = rest;
          saveRobotSessions(rest);
        }
      } finally {
        setActiveThought('');
        setSending(false);
      }
    },
    [activeId, sending, ensureRobotSession]
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
          skipLoadRef.current = row.id; // 跳过加载 effect：会话为空，避免覆盖待插入的本地状态
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
      <BackgroundEffect enabled={true} dimmed={bgDimmed} />

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
            <span className="font-serif-sc text-[19px] font-semibold text-ink">{PAGE.brand}</span>
            <span className="mt-0.5 text-[12px] leading-3 text-ink-faint">HUST · 环境学院</span>
          </div>
        </div>

        {/* 新建对话 */}
        <div className="px-3 py-3">
          <button
            type="button"
            onClick={() => void newChat()}
            className="flex w-full items-center justify-center gap-2 rounded-[10px] bg-lake-deep px-4 py-2.5 text-[17px] font-medium text-white transition-colors duration-200 hover:bg-[#2f5689] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-deep"
          >
            <span aria-hidden="true">＋</span>
            {PAGE.newChat}
          </button>
        </div>

        {/* 历史会话列表 */}
        <div className="px-4 pb-2 pt-1 text-[13.5px] font-medium tracking-[0.14em] text-ink-faint uppercase">
          {PAGE.history}
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {historyUnavailable && (
            <p className="mx-1 rounded-[8px] bg-lake-pale/60 px-3 py-2.5 text-[14px] leading-6 text-ink-soft">
              历史记录暂时不可用，对话功能不受影响
            </p>
          )}
          {conversations.length === 0 && (
            <p className="px-3 py-4 text-[15.5px] leading-6 text-ink-faint">暂无历史会话</p>
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
                className="min-w-0 flex-1 truncate px-3 py-2.5 text-left text-[16px] text-ink focus-visible:outline-none"
                title={c.title}
              >
                {c.title}
              </button>
              <button
                type="button"
                aria-label={PAGE.deleteLabel}
                onClick={() => void removeChat(c.id)}
                className="mr-1 hidden h-6 w-6 shrink-0 items-center justify-center rounded-md text-[15.5px] text-ink-faint hover:bg-white hover:text-lake-deep group-hover:flex focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep"
              >
                ×
              </button>
            </div>
          ))}
        </nav>

        {/* 底部说明（背景动效已改为常开，无需用户手动切换） */}
        <div className="border-t border-hairline px-4 py-3">
          {authUser ? (
            <button
              type="button"
              onClick={() => void handleLogout()}
              className="flex w-full items-center gap-2.5 rounded-[10px] px-1.5 py-1.5 text-left hover:bg-lake-mist/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep"
            >
              <span
                aria-hidden="true"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-lake-deep text-[14px] font-medium text-white"
              >
                {authUser.name.slice(0, 1)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14.5px] font-medium text-ink">{authUser.name}</span>
                <span className="block truncate text-[12.5px] text-ink-faint">{authUser.email || '超星账号'}</span>
              </span>
              <span className="shrink-0 text-[13px] text-ink-faint hover:text-lake-deep">退出</span>
            </button>
          ) : (
            <p className="text-[13px] leading-4 text-ink-faint">{PAGE.brandSub}</p>
          )}
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
            <h1 className="truncate text-[18px] font-medium text-ink">{activeTitle}</h1>
          </div>
          <div className="flex min-w-0 items-center gap-2.5 text-[15px] text-ink-faint">
            <span aria-hidden="true" className="hidden h-1.5 w-1.5 animate-pulse rounded-full bg-lake-deep sm:block" />
            <span className="hidden sm:block">在线</span>

            {/* 右上角登录入口：未登录一键登录 / 已登录用户名+退出 */}
            {oauthRelaying ? (
              <button
                type="button"
                disabled
                className="flex h-9 items-center gap-1.5 rounded-[10px] border border-hairline bg-white px-3 text-[15px] text-ink-soft"
              >
                <span
                  aria-hidden="true"
                  className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-hairline border-t-lake-deep"
                />
                登录中…
              </button>
            ) : authUser ? (
              <div className="flex items-center gap-2">
                <span className="hidden min-w-0 items-center gap-1.5 md:flex">
                  <span
                    aria-hidden="true"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-lake-deep text-[12px] font-medium text-white"
                  >
                    {authUser.name.slice(0, 1)}
                  </span>
                  <span className="max-w-[120px] truncate text-[14.5px] text-ink-soft">{authUser.name}</span>
                </span>
                <button
                  type="button"
                  onClick={() => void handleLogout()}
                  className="flex h-9 items-center rounded-[10px] border border-hairline bg-white px-3 text-[15px] text-ink-soft transition-colors duration-200 hover:border-lake-deep hover:text-lake-deep focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep"
                >
                  退出
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void handleLogin()}
                className="flex h-9 items-center gap-1.5 rounded-[10px] bg-lake-deep px-3.5 text-[15px] font-medium text-white transition-all duration-200 hover:scale-[1.03] hover:bg-[#2f5689] hover:shadow-[0_2px_10px_rgba(58,103,171,0.3)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-deep"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4" />
                  <path d="M10 17l5-5-5-5" />
                  <path d="M15 12H3" />
                </svg>
                登录
              </button>
            )}
          </div>
        </header>

        {/* 错误提示 */}
        {loadError && (
          <div className="mx-4 mt-3 rounded-[8px] border border-lake-soft bg-lake-pale px-4 py-2.5 text-[15.5px] text-ink-soft sm:mx-6">
            {loadError}
            <button type="button" className="ml-3 text-lake-deep underline" onClick={() => setLoadError('')}>
              忽略
            </button>
          </div>
        )}

        {/* 消息流：消息块之间 44px 大留白，问答分组清晰（适老化）
            空白页时内层撑满滚动区最小高度，使欢迎区 justify-end 下沉贴住抬升后的输入框上方 */}
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-11 px-5 py-9">
            {messages.length === 0 && (
              <div className="flex min-h-0 flex-1 flex-col items-start justify-end gap-5 pb-4">
                <p className="text-[15.5px] tracking-[0.2em] text-lake-deep">HUST · 环境科学与工程学院</p>
                <h2 className="font-serif-sc text-[2.2rem] leading-[1.35] font-semibold text-ink">
                  {PAGE.welcomeTitle}
                </h2>
                <p className="max-w-lg text-[18px] leading-8 text-ink-soft">{PAGE.welcomeDesc}</p>
                <div className="mt-2 flex flex-wrap gap-2.5">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      disabled={sending}
                      onClick={() => void send(s)}
                      className="rounded-full border border-hairline bg-white/70 px-4 py-2.5 text-[17px] text-ink-soft transition-colors duration-200 hover:border-lake-deep hover:text-lake-deep disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-deep"
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
                    <div className="max-w-[85%] rounded-[16px] rounded-br-[5px] border border-lake-soft bg-lake-pale px-5 py-3.5 text-[18px] leading-[1.75] text-ink shadow-[0_2px_10px_rgba(58,103,171,0.10)]">
                      {m.content}
                    </div>
                  )}
                </div>
              ) : (
                <div key={m.id} className="flex flex-col gap-2.5">
                  <div className="flex items-center gap-2.5">
                    <img src="/hust-logo.png" alt="" className="h-6 w-6 shrink-0 opacity-80" aria-hidden="true" />
                    <span className="text-[17.5px] font-medium text-ink-soft">{PAGE.agentLabel}</span>
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

                  {/* 智能体表单卡片：填写并提交（SUBMIT_FORM），文件字段先行上传 */}
                  {m.form && !m.streaming && activeId && (
                    <div className="max-w-[92%] sm:max-w-[520px]">
                      <FormCard
                        form={m.form}
                        submitted={Boolean(m.formSubmitted)}
                        uploading={false}
                        onUploadFile={async (_field, file) => uploadFormFile(activeId, file)}
                        onSubmit={async (fields) => {
                          await sendFormSubmit(m.id, m.form?.messageId ?? '', fields);
                        }}
                      />
                    </div>
                  )}

                  {/* 智能体菜单卡片：点击选项即以普通文本重新发起对话 */}
                  {m.menu && !m.streaming && (
                    <div className="max-w-[92%] sm:max-w-[520px]">
                      <MenuCard
                        menu={m.menu}
                        answered={Boolean(m.menuAnswered) || sending}
                        onPick={(text) => {
                          setMessages((prev) =>
                            prev.map((x) => (x.id === m.id ? { ...x, menuAnswered: true } : x))
                          );
                          void send(text);
                        }}
                      />
                    </div>
                  )}

                  {!m.content && !m.form && !m.menu && m.streaming && m.thoughts.length === 0 && !activeThought && (
                    <div className="flex items-center gap-2.5 rounded-[12px] bg-white/70 px-4 py-2.5 text-[17px] text-ink-soft">
                      <span
                        aria-hidden="true"
                        className="h-4 w-4 animate-spin rounded-full border-[1.5px] border-hairline border-t-lake-deep"
                      />
                      正在连接智能体…
                    </div>
                  )}
                </div>
              )
            )}
          </div>
        </div>

        {/* 输入区：附件上传 + 语音输入 + 文本框（透明底融入水彩背景，仅输入胶囊保留白底）
            空白对话页：输入框底部距页面底边约 25vh（即页面垂直 75% 处，中间偏下定位），
            欢迎区同步下沉贴住其上方组成整体，无遮挡、排布清晰；
            活跃对话后：下边距归零，贴合页面底部边缘。通过 margin-bottom 过渡实现平滑位移，兼容各分辨率 */}
        <footer
          className={`shrink-0 transition-[margin] duration-500 ease-[cubic-bezier(0.32,0.72,0.22,1)] motion-reduce:transition-none ${
            messages.length === 0 ? 'mb-[25vh]' : 'mb-0'
          }`}
        >
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

            <div className="flex items-center gap-2.5 rounded-[16px] border border-hairline bg-white px-3.5 py-3 shadow-[0_2px_12px_rgba(27,39,51,0.06)] transition-all duration-200 focus-within:border-lake-deep focus-within:shadow-[0_0_0_3px_rgba(58,103,171,0.12),0_4px_16px_rgba(58,103,171,0.10)]">
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
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] text-[18px] text-ink-soft transition-all duration-200 hover:scale-[1.05] hover:bg-lake-pale hover:text-lake-deep disabled:opacity-40 disabled:hover:scale-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep"
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
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] transition-all duration-200 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep ${
                  listening
                    ? 'animate-[env-breath_2s_ease-in-out_infinite] bg-lake-deep text-white'
                    : 'text-ink-soft hover:scale-[1.05] hover:bg-lake-pale hover:text-lake-deep disabled:hover:scale-100'
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
                className="max-h-[180px] min-h-[44px] flex-1 resize-none bg-transparent px-2 py-[6px] text-[18px] leading-[32px] text-ink outline-none placeholder:text-ink-faint placeholder:leading-[32px] disabled:opacity-60"
              />

              <button
                type="button"
                disabled={!canSend}
                onClick={() => void send(input, pendingAtts)}
                className="flex h-11 shrink-0 items-center justify-center rounded-[12px] bg-lake-deep px-6 text-[19px] font-medium text-white transition-all duration-200 hover:scale-[1.03] hover:bg-[#2f5689] hover:shadow-[0_4px_12px_rgba(58,103,171,0.3)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-deep"
              >
                发送
              </button>
            </div>
          </div>
        </footer>

        {/* 底部提示文字：固定在页面最底不动，不随输入框 25vh 抬升/吸底切换而移动 */}
        <p className="shrink-0 py-2 text-center text-[15.5px] text-ink-faint">
          {PAGE.footer} · 支持上传附件（展示名称与大小）与语音输入
        </p>
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
