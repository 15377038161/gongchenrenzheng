// ABOUTME: 超星智能体（robot.chaoxing.com）对话代理
// ABOUTME: 协议基于对该站点前端逆向调研，真实调用其访客会话 + WebSocket 对话链路
// ABOUTME: 附加支持 FORM 表单（SUBMIT_FORM 提交协议）与 MENU 菜单（纯文本回复）交互

const UNIT_ID = '1731';
const ROBOT_ID = '9a31c8e736704a0b9d57b35c73da681f';
const ROBOT_ORIGIN = 'https://robot.chaoxing.com';
/** 请求超星时统一使用的浏览器 UA（登录态 cookie 与 UA 需配套，服务端有指纹校验） */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** 访客会话信息（来自 visitor/apply） */
export interface RobotSession {
  visitorId: string;
  visitorVc: string;
  conversationId: string;
}

/** 上传到智能体的文件信息（WS msg.fileInfo 单元素） */
export interface RobotFileInfo {
  objectId: string;
  filename: string;
  type: string;
  fileSize: number;
}

/** 表单字段 schema（FORM 消息 mobileProperties.content.schema 单元素） */
export interface RobotFormField {
  fieldType: string[];
  id: string;
  name: string;
  [key: string]: unknown;
}

/** FORM 下行消息解析结果（供前端渲染表单并提交） */
export interface RobotForm {
  messageId: string;
  schema: RobotFormField[];
}

/** MENU 下行消息解析结果（供前端渲染选项卡片） */
export interface RobotMenu {
  messageId: string;
  question: string;
  items: Array<{ menuId: string; content: string }>;
}

/** 表单提交字段值（FORM schema 字段 + 用户填写值；透传其余原始键） */
export interface RobotFormFieldValue {
  name: string;
  value: string | string[];
  valueDetail?: Array<{ name: string; size: number }>;
  [key: string]: unknown;
}

/** 供前端展示的下行事件 */
export type RobotEvent =
  | { type: 'thought'; description: string }
  | { type: 'delta'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; message: string }
  | { type: 'form'; form: RobotForm }
  | { type: 'menu'; menu: RobotMenu };

/**
 * 会话恢复事件：会话被超星强制踢出（FORCE_LOGOUT，同一 conversation 在新窗口打开）
 * 后服务端自动申请全新访客会话重试，并通过该事件把新会话下发给调用方，
 * 前端 MUST 持久化新会话替换旧缓存，否则后续消息仍携带被踢的旧会话。
 */
export type RobotSessionEvent = { type: 'session'; session: RobotSession };

/** 会话通道完整事件流（业务事件 + 会话恢复事件） */
export type RobotStreamEvent = RobotEvent | RobotSessionEvent;

/** 超星 WS 原始消息的宽松类型 */
interface RobotWsMessage {
  type?: string;
  agent_event?: { event?: string };
  meta?: { description?: string };
  answer?: string;
  answerType?: string;
  communicateType?: string;
  systemMsg?: boolean;
  sseStop?: boolean;
  messageId?: string;
  items?: unknown;
  mobileProperties?: { content?: string };
  [key: string]: unknown;
}

/** 向超星发送的 DATA 消息体 */
interface OutgoingMessage {
  msgTimeId: number;
  time: number;
  direction: string;
  messageType: string;
  communicateType: string;
  lang: string;
  msg: {
    channel: string;
    question: unknown;
    visibleQuestion: string;
    questionType: string;
    fileInfo: unknown[];
  };
  ackStatus: string;
  robot: {
    type: string;
    scene: number;
    extend: string;
    subject: string;
    spage: number;
  };
  dxNumber: string;
  d: string;
}

/** 申请访客会话（可携带超星登录态 cookie：登录用户返回 visitorLoggedIn 会话，visitorId 即账号 UID） */
export async function applySession(authCookie?: string): Promise<RobotSession> {
  const url =
    `${ROBOT_ORIGIN}/v1/front/chat/visitor/apply?visitorId=&unitId=${UNIT_ID}` +
    `&channel=WEB&robotId=${ROBOT_ID}&referUrl=&vc=&d=&vc3=&uid=&scene=&isLLMPlanning=0`;
  const res = await fetch(url, {
    headers: {
      Referer: `${ROBOT_ORIGIN}/coze`,
      Accept: 'application/json',
      ...(authCookie ? { Cookie: authCookie, 'User-Agent': UA } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`申请会话失败：HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    code?: number;
    visitorId?: string;
    visitorVc?: string;
    cvsInfo?: { conversationId?: string };
  };
  if (data.code !== 1 || !data.visitorId || !data.visitorVc || !data.cvsInfo?.conversationId) {
    throw new Error('申请会话失败：返回数据不完整');
  }
  return {
    visitorId: data.visitorId,
    visitorVc: data.visitorVc,
    conversationId: data.cvsInfo.conversationId,
  };
}

/**
 * 上传文件到智能体会话（multipart，uploadType=CHAT_FILE 实测可用，含表单文件场景）。
 * 返回 fileId 信息，发送消息时填入 WS msg.fileInfo 即可让智能体读取文档内容。
 */
export async function uploadFile(
  session: RobotSession,
  file: { name: string; type: string; buffer: Buffer },
  authCookie?: string
): Promise<RobotFileInfo> {
  const url =
    `${ROBOT_ORIGIN}/v1/front/chat/upload/multipart?conversationId=${session.conversationId}` +
    `&uploadType=CHAT_FILE&unitId=${UNIT_ID}`;
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(file.buffer)], { type: file.type || 'application/octet-stream' }), file.name);
  const res = await fetch(url, {
    method: 'POST',
    body: fd,
    headers: {
      Referer: `${ROBOT_ORIGIN}/coze`,
      Accept: 'application/json',
      ...(authCookie ? { Cookie: authCookie, 'User-Agent': UA } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`上传失败：HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    status?: boolean;
    datas?: Array<{ filename?: string; type?: string; objectId?: string }>;
  };
  const obj = data.datas?.[0];
  if (!data.status || !obj?.objectId) {
    throw new Error(data.status === false ? '上传失败：智能体拒绝了该文件' : '上传失败：返回数据不完整');
  }
  return {
    objectId: obj.objectId,
    filename: obj.filename ?? file.name,
    type: obj.type ?? file.type,
    fileSize: file.buffer.length,
  };
}

/**
 * 下行消息统一解析：转换为 RobotEvent 流。
 * FORM / MENU 到达即结束本次流（表单提交走 submitForm 新链路，菜单选择按普通文本重新发起）。
 */
function processDownstream(
  raw: string,
  onEvent: (event: RobotEvent) => void,
  finish: (event: RobotEvent) => void
): void {
  let data: RobotWsMessage;
  try {
    data = JSON.parse(raw) as RobotWsMessage;
  } catch {
    return;
  }

  // 调试日志（debug 级别，截断输出，供运行日志排查表单/卡片类消息）
  if ((process.env.LOG_LEVEL ?? 'debug') === 'debug') {
    console.log(
      `[agent-debug] answerType=${JSON.stringify(data.answerType)} type=${JSON.stringify(data.type)} ` +
        `sseStop=${JSON.stringify(data.sseStop)} raw=${raw.length > 800 ? raw.slice(0, 800) + `...[truncated ${raw.length}]` : raw}`
    );
  }

  // 表单消息：解析 schema 后下发 form 事件并结束本次流。
  // 任务流「查询结果文本 + 推送表单」是同轮连续两帧，文本先于 FORM 到达并已通过
  // delta 下发累积；路由层在 form/menu 收尾前会把累积文本透传给前端（防止丢失）
  if (data.answerType === 'FORM') {
    let schema: RobotFormField[] = [];
    try {
      const content = JSON.parse(String(data.mobileProperties?.content ?? '{}')) as { schema?: RobotFormField[] };
      schema = Array.isArray(content.schema) ? content.schema : [];
    } catch {
      finish({ type: 'error', message: '表单消息解析失败，请重新提问' });
      return;
    }
    finish({ type: 'form', form: { messageId: String(data.messageId ?? ''), schema } });
    return;
  }

  // 菜单消息：下发选项后结束本次流（前端点击选项后以普通文本重新发起对话，实测有效）
  if (data.answerType === 'MENU' || data.answerType === 'MENU_RADIO') {
    const rawItems = Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : [];
    finish({
      type: 'menu',
      menu: {
        messageId: String(data.messageId ?? ''),
        question: typeof data.answer === 'string' ? data.answer : '',
        items: rawItems
          .filter((x) => x !== null && typeof x === 'object')
          .map((x) => ({ menuId: String(x.menuId ?? ''), content: String(x.content ?? '') }))
          .filter((x) => x.content.length > 0),
      },
    });
    return;
  }

  // 思考过程事件（语义理解 / 知识召回等）
  if (data.type === 'SEMANTIC' || data.type === 'LLM') {
    const desc = data.meta?.description;
    if (desc && data.agent_event?.event !== 'FINAL_FINISH') {
      onEvent({ type: 'thought', description: desc });
    }
    return;
  }

  // 系统元消息（意图分类回显等）：仅当内含真实答案 responseText 时才放行
  if (data.systemMsg === true) {
    let isRealAnswer = false;
    if (typeof data.answer === 'string' && data.answer.length > 0) {
      try {
        const inner = JSON.parse(data.answer) as { responseText?: string };
        isRealAnswer = typeof inner.responseText === 'string' && inner.responseText.length > 0;
      } catch {
        isRealAnswer = false;
      }
    }
    if (!isRealAnswer) {
      // 仍需监听结束信号
      if (data.sseStop === true) {
        finish({ type: 'final', text: '' });
      }
      return;
    }
  }

  // 答案类消息：answer 可能是纯文本或内嵌 JSON
  if (typeof data.answer === 'string' && data.answer.length > 0) {
    let text = data.answer;
    let flagStop = false;
    try {
      const inner = JSON.parse(data.answer) as {
        responseText?: string;
        message?: string;
        flag?: string;
        [key: string]: unknown;
      };
      // 控制帧（flag/metadata 类）：既非正文也非提示，直接按结束/忽略处理
      if (inner.flag !== undefined) {
        if (inner.flag === 'stop') flagStop = true;
        text = '';
      } else if (inner.responseText !== undefined) {
        text = inner.responseText;
      } else if (inner.message !== undefined) {
        // 加载提示（"正在生成中"）：不展示，等待真实分片
        text = '';
      }
    } catch {
      // 纯文本，直接使用
    }

    if (text) {
      onEvent({ type: 'delta', text });
    }
    if (flagStop || data.sseStop === true) {
      finish({ type: 'final', text: '' });
    }
    return;
  }

  // sseStop 兜底
  if (data.sseStop === true) {
    finish({ type: 'final', text: '' });
  }
}

/**
 * 建立智能体 WS 通道（chatOnce / submitForm 共用）：
 * 含 75 秒空闲超时兜底与 25 秒心跳；消息体由 buildMessage 工厂按会话生成。
 *
 * FORCE_LOGOUT 自愈（CRITICAL）：同一 conversation 被超星判定「已在其他窗口打开」时，
 * 上游会下发 communicateType=FORCE_LOGOUT 并以 reason=FORCE_LOGOUT 关闭连接。
 * 服务端自动申请全新访客会话，经 'session' 事件下发给调用方（前端 MUST 持久化新会话），
 * 随后用新会话重发原始消息，最多重试一次（防循环）。
 */
function openRobotChannel(
  session: RobotSession,
  onEvent: (event: RobotStreamEvent) => void,
  buildMessage: () => OutgoingMessage,
  authCookie?: string
): { close: () => void } {
  // FORCE_LOGOUT 自愈状态：是否已用新会话重试过（只重试一次，防循环）
  let retriedOnLogout = false;
  // 客户端主动关闭标记：此时不触发自愈重连
  let closedByClient = false;
  // 当前活跃连接的清理句柄（FORCE_LOGOUT 换新会话时整体替换）
  let activeCleanup: (() => void) | null = null;

  const connect = (sess: RobotSession): void => {
    const wsUrl =
      `${ROBOT_ORIGIN.replace('https', 'wss')}/v1/ws/chat/${UNIT_ID}/visitor` +
      `?userId=${sess.visitorId}&channel=WEB&conversationId=${sess.conversationId}` +
      `&robotId=${ROBOT_ID}&visitorVc=${sess.visitorVc}&scene=&lang=zh&isLLMPlanning=0`;

    let settled = false;
    let ws: WebSocket;
    try {
      // undici 全局 WS 运行时支持第二参数为 options 对象（含 headers，实测登录态 WS 可用），
      // 但 TS DOM lib 类型仅声明 string[] 协议形态，此处断言对齐运行时行为
      ws = new WebSocket(wsUrl, {
        headers: {
          'User-Agent': UA,
          Origin: ROBOT_ORIGIN,
          ...(authCookie ? { Cookie: authCookie } : {}),
        },
      } as unknown as string[]);
    } catch (err) {
      onEvent({ type: 'error', message: err instanceof Error ? err.message : '连接智能体失败' });
      return;
    }

    const finish = (event: RobotEvent) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      onEvent(event);
      // 不主动关闭 WS：客户端主动 close 会被超星记为「用户主动关闭会话」，
      // 管理后台出现碎片化中断记录（图三 vs 图四差异根源）。
      // 停止心跳即可——无 KEEPALIVE 后超星平台会自然超时回收连接，会话保持进行中。
      clearInterval(heartbeat);
    };

    // 空闲超时兜底：上游 WS 打开但静默不回（如会话过期）时，保证流一定会结束，
    // 避免前端 SSE 永久挂起导致界面卡死。每收到下行消息即重置。
    const IDLE_LIMIT_MS = 75_000;
    const idleTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
      finish({ type: 'error', message: '智能体长时间无响应（可能是会话已过期），请重新发送' });
    }, IDLE_LIMIT_MS);

    // 内容静默判定（CRITICAL）：任务流的中间步骤答案（如「请输入您的数据编号」）
    // 是一次性完整消息，既无 sseStop=true 也无 flag=stop 结束标记，上游发完即静默，
    // WS 甚至保持打开不关（实测 57s 后才被平台关闭）。若只等结束标记，SSE 流会
    // 挂起导致前端输入框被禁用一分钟左右。收到真实内容分片（delta）后启动本定时器，
    // 静默期满仍未有新消息（也无思考事件推进）即视为本轮结束，主动下发 final。
    // 普通流式回答的 delta 间隔远小于该窗口，不受影响；有结束标记时 finish 先触发。
    const CONTENT_SETTLE_MS = 3000;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'KEEPALIVE' }));
      }
    }, 25000);

    const cleanup = () => {
      clearInterval(heartbeat);
      clearTimeout(idleTimer);
      clearTimeout(settleTimer);
    };

    activeCleanup = () => {
      cleanup();
      try { ws.close(); } catch { /* 忽略关闭异常 */ }
    };

    ws.onopen = () => {
      console.log(`[ws] open conversationId=${sess.conversationId}`);
      const msg = buildMessage();
      const summary = {
        msgTimeId: msg.msgTimeId,
        time: msg.time,
        messageType: msg.messageType,
        communicateType: msg.communicateType,
        question:
          msg.messageType === 'HIDDEN_MESSAGE'
            ? {
                messageId: (msg.msg.question as { messageId?: unknown })?.messageId,
                dataCount: Array.isArray((msg.msg.question as { data?: unknown[] }).data)
                  ? (msg.msg.question as { data: unknown[] }).data.length
                  : -1,
                dataPreview: JSON.stringify((msg.msg.question as { data?: unknown[] }).data)?.slice(0, 600),
              }
            : String(msg.msg.question),
        fileInfoCount: msg.msg.fileInfo.length,
      };
      console.log(`[ws] send ${JSON.stringify(summary)}`);
      ws.send(JSON.stringify(msg));
    };

    // 注：全局 WebSocket 类型无事件命名空间（WebSocket.ErrorEvent 等不可用），
    // 回调按标准 Event 签名声明，内部用结构化收窄读取错误信息。
    ws.onerror = (ev: Event) => {
      const info = ev as { message?: unknown; error?: { constructor?: { name?: string } } };
      console.error(`[ws] error conversationId=${sess.conversationId} message=${JSON.stringify(info.message ?? '')} type=${info.error?.constructor?.name ?? ''}`);
      cleanup();
      finish({ type: 'error', message: '与智能体的连接出现错误，请稍后重试' });
    };

    ws.onclose = (ev: CloseEvent) => {
      console.log(`[ws] close conversationId=${sess.conversationId} code=${ev.code} reason=${JSON.stringify(ev.reason ?? '')} wasClean=${ev.wasClean}`);
      cleanup();
      // FORCE_LOGOUT：会话被新窗口占用而强制踢出 → 换全新会话重发原消息（一次）
      if (ev.reason === 'FORCE_LOGOUT' && !settled && !retriedOnLogout && !closedByClient) {
        retriedOnLogout = true;
        console.log('[ws] FORCE_LOGOUT 检测到会话被踢，自动换新会话重试');
        void retryWithFreshSession();
        return;
      }
      if (!settled) {
        finish({ type: 'error', message: '智能体连接已断开，请重新提问' });
      }
    };

    ws.onmessage = (ev: MessageEvent) => {
      // 收到任何下行消息即视为链路活跃，重置空闲超时
      idleTimer.refresh();
      // 内容静默判定：delta（真实内容）出现即（重新）启动 settle 定时器；
      // thought / final / form / menu / error 等事件出现时按各自语义处理：
      // thought 说明上游仍在推进（重置 settle 等待后续内容），其余结束类事件
      // 会触发 finish（settled 置位）使 settle 到期后不再动作。
      let sawContent = false;
      processDownstream(
        String(ev.data),
        (event) => {
          if (event.type === 'delta') {
            sawContent = true;
          } else if (event.type === 'thought') {
            // 思考推进中：清掉 pending settle，等待内容或结束信号
            clearTimeout(settleTimer);
            settleTimer = undefined;
          }
          onEvent(event);
          if (sawContent) {
            clearTimeout(settleTimer);
            settleTimer = setTimeout(() => {
              // 静默期满仍无新消息：视为本轮结束，主动收尾（finish 幂等，settled 后无副作用）
              console.log(`[ws] content settle (${CONTENT_SETTLE_MS}ms 静默) conversationId=${sess.conversationId}，主动结束本轮流`);
              finish({ type: 'final', text: '' });
            }, CONTENT_SETTLE_MS);
          }
        },
        finish
      );
    };
  };

  /** FORCE_LOGOUT 自愈：申请全新访客会话 → 通知调用方 → 用新会话重连重发 */
  const retryWithFreshSession = async (): Promise<void> => {
    try {
      const fresh = await applySession(authCookie);
      console.log(`[ws] FORCE_LOGOUT 自愈：新会话 conversationId=${fresh.conversationId}`);
      onEvent({ type: 'session', session: fresh });
      connect(fresh);
    } catch (err) {
      onEvent({
        type: 'error',
        message: err instanceof Error ? err.message : '会话恢复失败，请重新发送',
      });
    }
  };

  connect(session);

  return {
    close: () => {
      closedByClient = true;
      activeCleanup?.();
    },
  };
}

/**
 * 与智能体建立一次对话：连接 WS、发送问题、把下行消息转换为事件流。
 * onEvent 收到 'final' / 'error' / 'form' / 'menu' 后结束；'session' 为会话恢复通知。
 * @param fileInfo 上传文件列表（来自 uploadFile），智能体将读取文档内容
 */
export function chatOnce(
  session: RobotSession,
  question: string,
  onEvent: (event: RobotStreamEvent) => void,
  fileInfo: RobotFileInfo[] = [],
  authCookie?: string
): { close: () => void } {
  return openRobotChannel(session, onEvent, () => {
    const now = Date.now();
    return {
      msgTimeId: now,
      time: now,
      direction: 'IN',
      messageType: 'TEXT',
      communicateType: 'DATA',
      lang: 'zh',
      msg: {
        channel: 'WEB',
        question,
        visibleQuestion: question,
        questionType: 'TEXT',
        fileInfo,
      },
      ackStatus: 'SENDING',
      robot: { type: '', scene: -1, extend: '', subject: '', spage: 1 },
      dxNumber: '',
      d: '',
    };
  }, authCookie);
}

/**
 * 提交智能体下发的表单（SUBMIT_FORM 协议，逆向自官网前端）：
 * messageType=HIDDEN_MESSAGE + communicateType=SUBMIT_FORM，
 * msg.question = { data: [schema 字段 + 用户填写值], messageId: FORM 消息 id }。
 * 文件字段 value 为 objectId 数组（先经 uploadFile 上传到同一会话）；
 * 实测可在全新 WS 连接上提交（无需复用收到 FORM 的连接）。
 */
export function submitForm(
  session: RobotSession,
  messageId: string,
  fields: RobotFormFieldValue[],
  onEvent: (event: RobotStreamEvent) => void,
  authCookie?: string
): { close: () => void } {
  return openRobotChannel(session, onEvent, () => {
    const now = Date.now();
    return {
      msgTimeId: now,
      time: now,
      direction: 'IN',
      messageType: 'HIDDEN_MESSAGE',
      communicateType: 'SUBMIT_FORM',
      lang: 'zh',
      msg: {
        channel: 'WEB',
        question: { data: fields, messageId },
        visibleQuestion: '',
        questionType: 'TEXT',
        fileInfo: [],
      },
      ackStatus: 'SENDING',
      robot: { type: '', scene: -1, extend: '', subject: '', spage: 1 },
      dxNumber: '',
      d: '',
    };
  }, authCookie);
}
