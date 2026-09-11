import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MarkdownView } from './components/MarkdownView';
import { AgentProgress } from './components/AgentProgress';
import { BackgroundEffect } from './components/BackgroundEffect';
import { FormCard, MenuCard } from './components/RobotCards';
import type { RobotForm, RobotMenu } from './lib/robot-types';
import { fmtSize } from './components/fmt';
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

/** 快捷提示词（输入框上方标签组）：点击填充到输入框，可编辑后再发送 */
const QUICK_PROMPTS = [
  '帮我编写工程认证',
  '帮我提炼文档内容',
  '列出章节目录',
  '读取第一章',
  '读取 1.1 学生',
];

/** 表单填写页（超星智能体内置表单）：新窗口打开，需超星登录态 */
const FORM_FILL_URL =
  'https://v1.chaoxing.com/mobileSet/gotoUrlPreview?type=0&appId=2348489&mappId=20840782';

/** 智能体会话缓存有效期：12 小时（超星访客会话可能过期，超期自动失效重建） */
const ROBOT_SESSION_TTL = 12 * 60 * 60 * 1000;

/** 整轮流式请求总超时：120s（正常轮含思考+生成远小于此；仅兜底 SSE 挂起导致输入锁不释放的极端场景） */
const TOTAL_STREAM_TIMEOUT_MS = 120_000;

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

/** 登录弹窗：超星账号登录（手机号+密码，服务端代理 fanyalogin 协议） */
/** 顶栏用户头像：学通 portrait URL 加载失败（无自定义头像/CDN 不可达）时兜底首字头像 */
function UserAvatar({ name, avatar }: { name: string; avatar: string }) {
  const [failed, setFailed] = useState(false);
  if (!avatar || failed) {
    return (
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-lake-deep text-[13px] font-medium text-white"
      >
        {name.slice(0, 1)}
      </span>
    );
  }
  return (
    <img
      src={avatar}
      alt={`${name}的头像`}
      onError={() => setFailed(true)}
      className="h-8 w-8 shrink-0 rounded-full border border-hairline object-cover"
    />
  );
}

/** 扫码登录 Tab 内部状态 */
interface QrState {
  /** 服务端扫码会话 id */
  id: string;
  /** 二维码图片（data URL 内联） */
  image: string;
}

/**
 * 扫码登录面板：打开时创建二维码，3s 轮询状态；
 * 过期/失败自动重建；卸载或关闭弹窗时调用 abort 清理服务端会话。
 */
function QrLoginPanel({
  onConfirmed,
  onError,
}: {
  onConfirmed: (token: string, user: { uid: string; name: string; avatar: string }) => void;
  onError: (message: string) => void;
}) {
  const [qr, setQr] = useState<QrState | null>(null);
  const [qrState, setQrState] = useState<'loading' | 'pending' | 'scanned' | 'expired' | 'error'>('loading');
  /** error 状态下的用户提示文案（来自服务端或网络异常） */
  const [qrError, setQrError] = useState('');
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sessionRef = useRef<string | null>(null);

  /** 创建（或重建）二维码会话 */
  const createQr = useCallback(async (): Promise<void> => {
    clearTimeout(pollTimerRef.current);
    setQrState('loading');
    setQr(null);
    setQrError('');
    try {
      const res = await fetch('/api/auth/qr/create', { method: 'POST' });
      const data = (await res.json()) as { success?: boolean; id?: string; image?: string; error?: string };
      if (!data.success || !data.id || !data.image) {
        throw new Error(data.error || '创建二维码失败');
      }
      sessionRef.current = data.id;
      setQr({ id: data.id, image: data.image });
      setQrState('pending');
    } catch (err) {
      onError(err instanceof Error ? err.message : '创建二维码失败，请重试');
      // 5s 后自动重试（网络抖动场景）
      pollTimerRef.current = setTimeout(() => void createQr(), 5000);
    }
  }, [onError]);

  /** 轮询扫码状态（3s 节奏，与超星前端一致） */
  const pollOnce = useCallback(async (): Promise<void> => {
    const id = sessionRef.current;
    if (!id) return;
    try {
      const res = await fetch(`/api/auth/qr/poll?id=${encodeURIComponent(id)}`);
      const data = (await res.json()) as {
        success?: boolean;
        state?: 'pending' | 'scanned' | 'confirmed' | 'expired' | 'error';
        token?: string;
        user?: { uid: string; name: string; avatar: string };
        error?: string;
      };
      if (data.state === 'confirmed' && data.token && data.user) {
        clearTimeout(pollTimerRef.current);
        sessionRef.current = null;
        onConfirmed(data.token, data.user);
        return;
      }
      if (data.state === 'expired') {
        setQrState('expired');
        return; // 停止轮询，等待用户点击「刷新二维码」
      }
      if (data.state === 'error') {
        clearTimeout(pollTimerRef.current);
        sessionRef.current = null;
        setQrError(data.error || '扫码登录失败，请重试');
        setQrState('error');
        return; // 停止轮询，等待用户点击「重新登录」
      }
      if (data.state === 'scanned') {
        setQrState('scanned');
      }
    } catch {
      // 网络抖动：跳过本轮，下轮继续
    }
    pollTimerRef.current = setTimeout(() => void pollOnce(), 3000);
  }, [onConfirmed]);

  // 打开面板即创建二维码；卸载时停止轮询并 abort 服务端会话
  useEffect(() => {
    void createQr();
    return () => {
      clearTimeout(pollTimerRef.current);
      const id = sessionRef.current;
      if (id) {
        void fetch(`/api/auth/qr/abort?id=${encodeURIComponent(id)}`, { method: 'POST' }).catch(() => undefined);
      }
    };
  }, [createQr]);

  return (
    <div className="flex flex-col items-center gap-4 pt-2">
      <div className="relative">
        {qr ? (
          <img
            src={qr.image}
            alt="超星登录二维码"
            width={200}
            height={200}
            className={`h-[200px] w-[200px] rounded-[12px] border border-hairline ${qrState === 'expired' ? 'opacity-30' : ''}`}
          />
        ) : (
          <div className="flex h-[200px] w-[200px] items-center justify-center rounded-[12px] border border-hairline bg-lake-pale/40">
            <span
              aria-hidden="true"
              className="h-6 w-6 animate-spin rounded-full border-[2px] border-hairline border-t-lake-deep"
            />
          </div>
        )}
        {qrState === 'scanned' && (
          <div className="absolute inset-0 flex items-center justify-center rounded-[12px] bg-white/85">
            <div className="flex flex-col items-center gap-2">
              <span aria-hidden="true" className="text-[32px] text-mint-deep">✓</span>
              <p className="text-[14.5px] text-ink-soft">已扫码，请在手机上确认</p>
            </div>
          </div>
        )}
        {qrState === 'expired' && (
          <button
            type="button"
            onClick={() => void createQr()}
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-[12px] bg-white/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep"
          >
            <span aria-hidden="true" className="text-[26px] text-ink-faint">⟳</span>
            <span className="text-[14.5px] font-medium text-lake-deep">二维码已过期，点击刷新</span>
          </button>
        )}
        {qrState === 'error' && (
          <button
            type="button"
            onClick={() => void createQr()}
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-[12px] bg-white/90 px-4 text-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep"
          >
            <span aria-hidden="true" className="text-[26px] text-ink-faint">!</span>
            <span className="text-[14.5px] font-medium text-lake-deep">重新获取二维码</span>
          </button>
        )}
      </div>

      <p className="text-center text-[14px] leading-6 text-ink-faint">
        {qrState === 'pending' && '请使用学习通 App 扫描二维码登录'}
        {qrState === 'scanned' && '扫描成功，等待手机确认…'}
        {qrState === 'expired' && '二维码已过期'}
        {qrState === 'loading' && '正在获取二维码…'}
        {qrState === 'error' && (qrError || '扫码登录失败，请重试')}
      </p>
    </div>
  );
}

function LoginDialog({
  busy,
  error,
  onClose,
  onSubmit,
  onQrConfirmed,
}: {
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (phone: string, password: string) => void;
  onQrConfirmed: (token: string, user: { uid: string; name: string; avatar: string }) => void;
}) {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  /** 登录方式 Tab：qr=扫码登录（默认），pwd=账号密码 */
  const [loginTab, setLoginTab] = useState<'qr' | 'pwd'>('qr');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="登录超星账号"
    >
      <div className="w-full max-w-[380px] rounded-[16px] border border-hairline bg-white p-6 shadow-[0_12px_40px_rgba(27,39,51,0.16)]">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-[19px] font-medium text-ink">登录超星账号</h2>
            <p className="mt-1.5 text-[14px] leading-5 text-ink-faint">
              登录后可使用工程认证编写等完整任务流功能
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭登录窗口"
            disabled={busy}
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[16px] text-ink-faint hover:bg-lake-pale hover:text-lake-deep disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep"
          >
            ×
          </button>
        </div>

        {/* 登录方式 Tab：扫码登录 / 账号密码 */}
        <div
          role="tablist"
          aria-label="登录方式"
          className="mt-4 grid grid-cols-2 gap-1 rounded-[10px] bg-lake-pale/60 p-1"
        >
          <button
            type="button"
            role="tab"
            aria-selected={loginTab === 'qr'}
            onClick={() => setLoginTab('qr')}
            className={`rounded-[8px] px-3 py-2 text-[14.5px] font-medium transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep ${
              loginTab === 'qr' ? 'bg-white text-lake-deep shadow-sm' : 'text-ink-soft hover:text-ink'
            }`}
          >
            扫码登录
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={loginTab === 'pwd'}
            onClick={() => setLoginTab('pwd')}
            className={`rounded-[8px] px-3 py-2 text-[14.5px] font-medium transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep ${
              loginTab === 'pwd' ? 'bg-white text-lake-deep shadow-sm' : 'text-ink-soft hover:text-ink'
            }`}
          >
            账号密码
          </button>
        </div>

        {loginTab === 'qr' ? (
          <div className="mt-4">
            <QrLoginPanel onConfirmed={onQrConfirmed} onError={() => undefined} />
            {error && (
              <p role="alert" className="mt-3 rounded-[8px] bg-lake-pale px-3 py-2 text-center text-[14px] leading-5 text-ink-soft">
                {error}
              </p>
            )}
            <p className="mt-2 text-center text-[13px] leading-4 text-ink-faint">
              扫码即代表同意超星账号在本站使用登录态
            </p>
          </div>
        ) : (
          <form
            className="mt-4 flex flex-col gap-3.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy && phone.trim() && password) onSubmit(phone.trim(), password);
            }}
          >
          <label className="flex flex-col gap-1.5">
            <span className="text-[14px] font-medium text-ink-soft">手机号</span>
            <input
              type="tel"
              inputMode="numeric"
              autoComplete="username"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={busy}
              placeholder="请输入超星账号手机号"
              className="rounded-[10px] border border-hairline bg-white px-3.5 py-2.5 text-[16px] text-ink outline-none transition-colors duration-150 placeholder:text-ink-faint focus:border-lake-deep focus:shadow-[0_0_0_3px_rgba(58,103,171,0.12)] disabled:opacity-60"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[14px] font-medium text-ink-soft">密码</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              placeholder="请输入密码"
              className="rounded-[10px] border border-hairline bg-white px-3.5 py-2.5 text-[16px] text-ink outline-none transition-colors duration-150 placeholder:text-ink-faint focus:border-lake-deep focus:shadow-[0_0_0_3px_rgba(58,103,171,0.12)] disabled:opacity-60"
            />
          </label>

          {error && (
            <p role="alert" className="rounded-[8px] bg-lake-pale px-3 py-2 text-[14px] leading-5 text-ink-soft">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || !phone.trim() || !password}
            className="mt-1 flex h-11 items-center justify-center rounded-[10px] bg-lake-deep text-[16.5px] font-medium text-white transition-all duration-150 hover:bg-[#2f5689] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-deep"
          >
            {busy ? '登录中…' : '登 录'}
          </button>
          <p className="text-center text-[13px] leading-4 text-ink-faint">
            密码仅在登录瞬间使用，不保存在本站
          </p>
        </form>
        )}
      </div>
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
  /** 登录状态：token 经 ref 供请求闭包读取（不入 state，避免渲染耦合），用户信息展示在顶栏右上角 */
  const [authUser, setAuthUser] = useState<{ uid: string; name: string; avatar: string } | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  /** 复制成功 Toast 文案（空串即隐藏）：2 秒自动消失 */
  const [copyToast, setCopyToast] = useState('');
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** 展示复制成功 Toast（重复触发时重置 2s 倒计时） */
  const notifyCopied = useCallback(() => {
    setCopyToast('复制成功');
    clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyToast(''), 2000);
  }, []);

  /** 复制消息原文到剪贴板（Markdown 源文本，保留代码块/换行/缩进）；非安全上下文降级 execCommand */
  const copyToClipboard = useCallback(
    async (text: string) => {
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand('copy');
        } catch {
          // 降级也失败时仅不提示成功
        }
        document.body.removeChild(ta);
      }
      notifyCopied();
    },
    [notifyCopied]
  );

  /** 登录用户信息 ref：ensureRobotSession 升级判定同步读取，避免 /api/auth/me
   * 异步校验完成前发送消息时 authUser state 尚未恢复、升级判定失效走匿名的竞态 */
  const authUserRef = useRef<{ uid: string; name: string; avatar: string } | null>(null);
  const setAuthUserSynced = useCallback((u: { uid: string; name: string; avatar: string } | null) => {
    authUserRef.current = u;
    setAuthUser(u);
  }, []);

  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const robotSessionsRef = useRef<Record<string, RobotSession>>({});
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  /** token ref：回调闭包内取最新值，避免依赖数组膨胀 */
  const authTokenRef = useRef<string | null>(null);
  const setToken = (t: string | null, user?: { uid: string; name: string; avatar: string } | null) => {
    authTokenRef.current = t;
    if (t) {
      localStorage.setItem('engcert_auth_token', t);
      if (user) {
        setAuthUserSynced(user);
        localStorage.setItem('engcert_auth_user', JSON.stringify(user));
      }
    } else {
      localStorage.removeItem('engcert_auth_token');
      localStorage.removeItem('engcert_auth_user');
      setAuthUserSynced(null);
    }
  };
  /** 统一带 token 的请求头 */
  const authHeaders = useCallback((): Record<string, string> => {
    const t = authTokenRef.current;
    return t ? { Authorization: `Bearer ${t}` } : {};
  }, []);

  /** 初始化：加载会话列表（嵌入第三方门户等场景下 DB 接口可能不可用，
   * 历史加载失败仅降级为侧栏提示，不阻塞聊天主流程、不弹顶部错误条） */
  useEffect(() => {
    robotSessionsRef.current = loadRobotSessions();
    // 恢复登录状态并校验有效性
    const savedToken = localStorage.getItem('engcert_auth_token');
    const savedUser = localStorage.getItem('engcert_auth_user');
    (async () => {
      if (savedToken) {
        authTokenRef.current = savedToken;
        if (savedUser) {
          try {
            // 同步恢复到 ref：确保首个请求发出前升级判定即可用（/me 校验异步进行，不阻塞）
            const parsed = JSON.parse(savedUser) as { uid: string; name: string; avatar?: string };
            // 旧缓存无 avatar 时补默认头像路径，保持类型完整
            setAuthUserSynced({ ...parsed, avatar: parsed.avatar ?? '' });
          } catch {
            // 忽略损坏的用户缓存
          }
        }
        try {
          const res = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${savedToken}` } });
          const data = (await res.json()) as { login?: boolean; user?: { uid: string; name: string; avatar: string } | null };
          if (data.login && data.user) {
            setAuthUserSynced(data.user);
            localStorage.setItem('engcert_auth_user', JSON.stringify(data.user));
          } else {
            setToken(null);
          }
        } catch {
          // 校验网络失败时保留本地缓存（乐观保留，后续请求若 401 会自然清理）
        }
      }
      try {
        const rows = await listConversations();
        setConversations(rows);
        if (rows.length > 0) setActiveId(rows[0].id);
      } catch {
        setHistoryUnavailable(true);
      }
    })();
  }, []);

  /** 卸载时释放语音识别与 Toast 定时器 */
  useEffect(() => {
    return () => {
      recRef.current?.stop();
      clearTimeout(copyTimerRef.current);
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

  /** 登录提交（超星账号，服务端代理 fanyalogin） */
  const doLogin = useCallback(
    async (phone: string, password: string): Promise<boolean> => {
      setLoginBusy(true);
      setLoginError('');
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, password }),
        });
        const data = (await res.json()) as {
          success?: boolean;
          token?: string;
          user?: { uid: string; name: string; avatar: string };
          error?: string;
        };
        if (!data.success || !data.token) {
          setLoginError(data.error || '登录失败');
          return false;
        }
        setToken(data.token, data.user ?? null);
        setLoginOpen(false);
        // 登录身份变化：清空缓存的访客会话，下次发送以登录身份重新申请
        robotSessionsRef.current = {};
        saveRobotSessions({});
        return true;
      } catch {
        setLoginError('网络异常，请稍后重试');
        return false;
      } finally {
        setLoginBusy(false);
      }
    },
    []
  );

  /** 登出 */
  const doLogout = useCallback(async (): Promise<void> => {
    const t = authTokenRef.current;
    try {
      if (t) await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${t}` } });
    } catch {
      // 忽略登出网络异常
    }
    setToken(null);
    // 身份变化：清空智能体会话缓存
    robotSessionsRef.current = {};
    saveRobotSessions({});
  }, []);

  /** 获取（或申请）某个本地对话对应的智能体会话（带登录 token 时为登录身份会话）。
   * 身份升级（CRITICAL）：登录后 visitorId 应为账号 UID；若缓存的会话还是匿名形态
   * （visitorId ≠ UID，即「登录前走到一半」的旧会话），自动丢弃并以登录身份重建，
   * 否则任务流表单环节会以匿名身份被超星拦截（「请先登录账号」）。
   * 升级返回 upgraded=true：新会话丢失了任务流上下文（任务流状态在超星侧的旧会话里），
   * 调用方需重发任务流触发语（如「帮我编写工程认证」）重建流程，否则用户输入会被
   * 当作新话题、超星 LLM 只能兜底回复「您说的我不太明白」。 */
  const ensureRobotSession = useCallback(
    async (convId: string): Promise<{ session: RobotSession; upgraded: boolean }> => {
      const cached = robotSessionsRef.current[convId];
      // 读 ref（同步恢复，无 /me 竞态）：刷新页面后立即发消息时升级判定依然生效
      const uid = authUserRef.current?.uid;
      let upgraded = false;
      if (cached) {
        // 有 token 时绝不复用身份未知的旧 visitor；必须重新向服务端申请并校验 UID。
        if (!authTokenRef.current && !uid) return { session: cached, upgraded: false };
        if (uid && cached.visitorId === uid) return { session: cached, upgraded: false };
        // 已登录但缓存是匿名会话：升级为登录身份会话
        console.info('[chat] 检测到匿名会话与登录身份不一致，自动升级为登录会话');
        delete robotSessionsRef.current[convId];
        delete sessionTimestamps[convId];
        upgraded = true;
      }
      const res = await fetch('/api/chat/session', { method: 'POST', headers: authHeaders() });
      const data = (await res.json()) as {
        success?: boolean;
        session?: RobotSession;
        login?: boolean;
        user?: { uid: string; name: string } | null;
      };
      // token 失效自愈：服务端内存登录态可能已丢失（如服务重启），前端立即清理，
      // 避免界面显示已登录、实际请求全部走匿名的「假登录」状态
      if (data.login === false && authTokenRef.current) {
        console.info('[chat] 登录态已失效（服务端无此 token）');
        setToken(null);
        setLoginOpen(true);
        throw new Error('登录态已失效，请重新登录后重试');
      }
      if (res.status === 401) {
        setToken(null);
        setLoginOpen(true);
        throw new Error('登录态已失效，请重新登录后重试');
      }
      if (!data.success || !data.session) {
        throw new Error('申请智能体会话失败');
      }
      if (authTokenRef.current && data.login !== true) {
        setLoginOpen(true);
        throw new Error('超星账号态未建立，已阻止游客会话，请重新登录');
      }
      if (authUserRef.current && data.session.visitorId !== authUserRef.current.uid) {
        setLoginOpen(true);
        throw new Error('超星未识别当前账号态，已阻止游客会话，请重新登录');
      }
      robotSessionsRef.current[convId] = data.session;
      sessionTimestamps[convId] = Date.now(); // 新建会话记录申请时间，供 TTL 判断
      saveRobotSessions(robotSessionsRef.current);
      return { session: data.session, upgraded };
    },
    [authHeaders]
  );

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
      if ((!q && attachments.length === 0) || sending) return;

      if (!q) return;

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
      // 仅当发送的正是输入框当前内容时才清空（任务流/菜单选项等程序化发送不覆盖用户草稿）；
      // 流式期间输入框保持可输入，此处不清空在流中预输入的下一条问题
      setInput((prev) => (prev.trim() === q ? '' : prev));
      setPendingAtts((prev) => (prev === attachments ? [] : prev));
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

      /** 整轮流总超时定时器（finally 中清理；abort 后 fetch 抛 AbortError 走既有兜底） */
      let abortTimer: ReturnType<typeof setTimeout> | undefined;

      try {
        // 3.5 整轮流总超时兜底：SSE 挂起（既无内容也无结束事件，如上游异常）时
        // 主动中止请求并释放 sending 锁，避免输入区被长期锁死的极端情况
        const abortCtrl = new AbortController();
        abortTimer = setTimeout(
          () => abortCtrl.abort(),
          TOTAL_STREAM_TIMEOUT_MS
        );
        // 4. 获取智能体会话（同一会话复用同一 chaoxing conversation，天然保持多轮上下文）
        const { session: robot, upgraded } = await ensureRobotSession(convId);

        // 4.5 会话升级后任务流上下文丢失（任务流状态存在超星侧的旧会话里）：
        // 静默重发本对话的首条用户消息（通常为任务流触发语，如「帮我编写工程认证」），
        // 让超星侧任务流重新进入等待输入状态，当前消息才能被任务流正确接续处理，
        // 否则当前输入会被当作新话题、超星 LLM 只能兜底回复「您说的我不太明白」。
        if (upgraded) {
          const trigger = messages.find((m) => m.role === 'user')?.content;
          if (trigger && trigger !== q) {
            try {
              const tUrl =
                `/api/chat/stream?q=${encodeURIComponent(trigger)}` +
                `&visitorId=${encodeURIComponent(robot.visitorId)}` +
                `&visitorVc=${encodeURIComponent(robot.visitorVc)}` +
                `&conversationId=${encodeURIComponent(robot.conversationId)}`;
              const tRes = await fetch(tUrl, { headers: authHeaders() });
              if (tRes.ok && tRes.body) {
                const tReader = tRes.body.getReader();
                for (;;) {
                  const { done } = await tReader.read();
                  if (done) break;
                }
              }
            } catch {
              // 重放失败不阻断当前消息：仍尝试直接发送（最坏情况是任务流未重建）
            }
          }
        }

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
        const res = await fetch(url, { headers: authHeaders(), signal: abortCtrl.signal });
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
        // form/menu 与文本同属一轮输出时两条都存（先文本后卡片，与超星原生消息序一致），
        // 此前只存卡片导致刷新后文本丢失——「第一话内容断成两截/消失」的根因之一
        try {
          if (finalText) {
            await insertMessage(convId, 'assistant', finalText, lastThoughts);
          }
          if (receivedForm) {
            await insertMessage(convId, 'assistant', encodeForm(receivedForm), []);
          } else if (receivedMenu) {
            await insertMessage(convId, 'assistant', encodeMenu(receivedMenu), []);
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

        // 6. 「请先登录」检测（表单服务拦截）：引导登录后重发原问题。
        // 登录后 ensureRobotSession 的身份升级逻辑会自动以登录身份重建会话，
        // 用户重新点击/输入即可继续走到一半的任务流。
        if ((finalText || '').includes('请先登录')) {
          setLoginOpen(true);
          setLoadError('超星要求账号登录；请在当前页面重新登录后，再重试这条任务流。');
        }
      } catch (err) {
        // 失败（含超时）时丢弃缓存的智能体会话：疑似过期，下次发送重新申请
        const msg = err instanceof Error ? err.message : '回复失败，请重试';
        if (msg.includes('HTTP 401')) {
          setToken(null);
          setLoginOpen(true);
          setLoadError('该任务流需要超星账号登录，请在当前页面登录后重试。');
        }
        patch((m) => ({ ...m, content: m.content || msg, streaming: false }));
        if (convId && robotSessionsRef.current[convId]) {
          const rest = { ...robotSessionsRef.current };
          delete rest[convId];
          delete sessionTimestamps[convId];
          robotSessionsRef.current = rest;
          saveRobotSessions(rest);
        }
      } finally {
        clearTimeout(abortTimer);
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
        const { session: robot } = await ensureRobotSession(convId);
        const fd = new FormData();
        fd.append('visitorId', robot.visitorId);
        fd.append('visitorVc', robot.visitorVc);
        fd.append('conversationId', robot.conversationId);
        fd.append('file', file);
        const res = await fetch('/api/chat/upload', { method: 'POST', headers: authHeaders(), body: fd });
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
        const { session: robot } = await ensureRobotSession(convId);
        const res = await fetch('/api/chat/form', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
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
        if (msg.includes('HTTP 401')) {
          setToken(null);
          setLoginOpen(true);
          setLoadError('表单提交需要超星账号登录，请在当前页面重新登录后重试。');
        }
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

  /**
   * 附件选择只保留本地元数据。文档任务流必须在超星官方账号态页面执行，
   * 不能先把文件上传到匿名 visitor 会话；发送时会打开官方页并提示重新选择。
   */
  const onPickFiles = (files: FileList | null): void => {
    if (!files || files.length === 0) return;
    const picked: Attachment[] = Array.from(files)
      .slice(0, 6 - pendingAtts.length)
      .map((f) => ({ name: f.name, size: f.size, type: f.type || 'application/octet-stream' }));
    if (picked.length === 0) return;
    setPendingAtts((prev) => [...prev, ...picked].slice(0, 6));
    if (fileRef.current) fileRef.current.value = '';
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

        {/* 底部：学院说明（登录入口已移至顶栏右上角） */}
        <div className="border-t border-hairline px-4 py-3">
          <p className="text-[13px] leading-4 text-ink-faint">{PAGE.brandSub}</p>
        </div>
      </aside>

      {/* 登录弹窗 */}
      {loginOpen && (
        <LoginDialog
          busy={loginBusy}
          error={loginError}
          onClose={() => {
            if (!loginBusy) setLoginOpen(false);
          }}
          onSubmit={(phone, password) => void doLogin(phone, password)}
          onQrConfirmed={(token, user) => {
            // 扫码登录成功：与密码登录同路径落库（清空匿名会话，下次发送以登录身份申请）
            setToken(token, user);
            setLoginOpen(false);
            robotSessionsRef.current = {};
            saveRobotSessions({});
          }}
        />
      )}

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
            {/* 表单填写跳转（左上角）：直达超星表单页（新窗口，需超星登录态） */}
            <a
              href={FORM_FILL_URL}
              target="_blank"
              rel="noopener noreferrer"
              title="打开工程认证表单填写页（超星新窗口）"
              className="ml-1 flex shrink-0 items-center gap-1.5 rounded-full border border-lake-soft bg-lake-pale px-3.5 py-1.5 text-[14px] leading-6 font-medium text-lake-deep transition-all duration-150 hover:border-lake-deep hover:shadow-[0_2px_8px_rgba(58,103,171,0.18)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-deep"
            >
              <span aria-hidden="true">📝</span>
              <span className="hidden sm:inline">填写表单</span>
            </a>
          </div>
          <div className="flex min-w-0 items-center gap-2.5 text-[15px] text-ink-faint">
            <span aria-hidden="true" className="hidden h-1.5 w-1.5 animate-pulse rounded-full bg-lake-deep sm:block" />
            <span className="hidden sm:block">在线</span>
            {/* 登录入口/用户信息（2026-09 移至顶栏右上角）：未登录显示登录按钮，
                登录后显示学通头像 + 姓名 + 退出 */}
            {authUser ? (
              <div className="ml-1.5 flex items-center gap-2 border-l border-hairline pl-3">
                <UserAvatar name={authUser.name} avatar={authUser.avatar} />
                <span className="hidden min-w-0 truncate text-[14.5px] text-ink-soft md:block" title={authUser.name}>
                  {authUser.name}
                </span>
                <button
                  type="button"
                  onClick={() => void doLogout()}
                  className="shrink-0 rounded-md px-2 py-1 text-[13.5px] text-ink-faint hover:bg-lake-pale hover:text-lake-deep focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep"
                >
                  退出
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setLoginError('');
                  setLoginOpen(true);
                }}
                className="ml-1.5 shrink-0 rounded-[8px] bg-lake-deep px-3.5 py-1.5 text-[14px] font-medium text-white transition-colors duration-150 hover:bg-[#2f5689] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-deep"
              >
                登录超星账号
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

        {/* 消息流：消息块之间 20px 适中留白（用户反馈 44px 过空，现聚焦内容密度与问答节奏）
            空白页时内层撑满滚动区最小高度，使欢迎区 justify-end 下沉贴住抬升后的输入框上方 */}
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-5 px-5 py-9">
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
                    <div className="group relative max-w-[85%]">
                      <div className="rounded-[16px] rounded-br-[5px] border border-lake-soft bg-lake-pale px-5 py-3.5 text-[18px] leading-[1.75] text-ink shadow-[0_2px_10px_rgba(58,103,171,0.10)]">
                        {m.content}
                      </div>
                      {!m.streaming && (
                        <button
                          type="button"
                          aria-label="复制该消息"
                          title="复制该消息"
                          onClick={() => void copyToClipboard(m.content)}
                          className="absolute -top-1 right-[-36px] flex h-7 w-7 items-center justify-center rounded-full border border-hairline bg-white text-ink-faint opacity-0 shadow-sm transition-all duration-150 hover:border-lake-deep hover:text-lake-deep group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep"
                        >
                          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <rect x="9" y="9" width="12" height="12" rx="2.5" />
                            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                          </svg>
                        </button>
                      )}
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
                    <div className="group relative max-w-[92%] text-ink">
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
                      {!m.streaming && (
                        <button
                          type="button"
                          aria-label="复制该消息"
                          title="复制该消息"
                          onClick={() => void copyToClipboard(m.content)}
                          className="absolute -top-1 right-0 flex h-7 w-7 items-center justify-center rounded-full border border-hairline bg-white text-ink-faint opacity-0 shadow-sm transition-all duration-150 hover:border-lake-deep hover:text-lake-deep group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep"
                        >
                          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <rect x="9" y="9" width="12" height="12" rx="2.5" />
                            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                          </svg>
                        </button>
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
                      正在思考中
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
            {/* 快捷提示词标签组：点击填充到输入框（可编辑后再发送）
                小屏横向滑动（no-scrollbar 隐藏滚动条），不换行、不遮挡输入框；
                空白页不显示（欢迎区已有同款建议按钮，避免重复） */}
            {messages.length > 0 && (
              <div
                className="no-scrollbar mb-2.5 flex items-center gap-2 overflow-x-auto"
                role="group"
                aria-label="快捷提示词"
              >
              {QUICK_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    setInput(p);
                    requestAnimationFrame(() => {
                      autoGrow();
                      taRef.current?.focus();
                    });
                  }}
                  className="shrink-0 whitespace-nowrap rounded-full border border-hairline bg-white/70 px-3.5 py-1.5 text-[14px] leading-6 text-ink-soft transition-colors duration-150 hover:border-lake-deep hover:bg-lake-pale hover:text-lake-deep focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-deep"
                >
                  {p}
                </button>
              ))}
              </div>
            )}

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
                className="max-h-[180px] min-h-[44px] flex-1 resize-none bg-transparent px-2 py-[6px] text-[18px] leading-[32px] text-ink outline-none placeholder:text-ink-faint placeholder:leading-[32px]"
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

        {/* 复制成功 Toast：复制任意消息后浮现 2 秒 */}
        {copyToast && (
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-none fixed left-1/2 top-16 z-50 -translate-x-1/2 rounded-full bg-ink/90 px-4 py-2 text-[15px] leading-6 text-white shadow-[0_4px_16px_rgba(27,39,51,0.25)]"
          >
            {copyToast}
          </div>
        )}
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
