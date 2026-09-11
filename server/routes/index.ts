import { Router, type Request } from 'express';
import multer from 'multer';
import {
  applySession,
  chatOnce,
  submitForm,
  uploadFile,
  type RobotFileInfo,
  type RobotFormFieldValue,
} from '../robot/agent';
import { chaoxingLogin, chaoxingLogout, qrLoginAbort, qrLoginCreate, qrLoginPoll, resolveAuth, resolveAuthWithVerify } from '../auth/chaoxing';
import dbRouter from './db';

const router = Router();

// 数据库代理（会话与消息持久化，浏览器无法直连 Supabase）
router.use(dbRouter);

// 文件上传（内存缓冲，转发给超星智能体）
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

/** 从请求提取内部登录 token（Authorization: Bearer <token>）并解析超星登录 cookie */
function authCookieOf(req: Request): string | undefined {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return resolveAuth(token || undefined)?.cookie;
}

/**
 * 超星账号登录（服务端代理 fanyalogin 协议）。
 * 请求体：{ phone, password }；密码仅登录瞬间存在于内存，不落盘。
 * 成功返回内部 token + 脱敏用户信息，浏览器存 localStorage 并在后续请求携带。
 */
router.post('/api/auth/login', async (req, res) => {
  const body = (req.body ?? {}) as { phone?: unknown; password?: unknown };
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!phone || !password) {
    res.status(400).json({ success: false, error: '请输入手机号和密码' });
    return;
  }
  try {
    const { token, user } = await chaoxingLogin(phone, password);
    res.json({ success: true, token, user });
  } catch (err) {
    const message = err instanceof Error ? err.message : '登录失败';
    res.status(401).json({ success: false, error: message });
  }
});

/** 登出：作废内部 token */
router.post('/api/auth/logout', (req, res) => {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  chaoxingLogout(token || undefined);
  res.json({ success: true });
});

/** 查询登录状态（页面加载时校验 token 是否仍有效；触发上游存活探测+滑动续期） */
router.get('/api/auth/me', (req, res) => {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const rec = resolveAuthWithVerify(token || undefined);
  res.json({ success: true, login: Boolean(rec), user: rec?.user ?? null });
});

/**
 * 扫码登录（2026-09 新增）：三步流程。
 * 1. POST /api/auth/qr/create → 创建扫码会话，返回内部 id + 二维码图片（base64 内联，
 *    避免跨域图片直链的 Referer/cookie 约束）
 * 2. GET /api/auth/qr/poll?id=xxx → 查询状态（pending/scanned/confirmed/expired/error），
 *    confirmed 时返回内部 token + 脱敏用户信息（与密码登录一致）
 * 3. POST /api/auth/qr/abort?id=xxx → 放弃登录，清理服务端扫码会话
 */
router.post('/api/auth/qr/create', async (_req, res) => {
  try {
    const { id, image, contentType } = await qrLoginCreate();
    const base64 = Buffer.from(image).toString('base64');
    res.json({ success: true, id, image: `data:${contentType};base64,${base64}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : '创建扫码登录失败';
    res.status(502).json({ success: false, error: message });
  }
});

router.get('/api/auth/qr/poll', async (req, res) => {
  const id = String(req.query.id ?? '');
  if (!id) {
    res.status(400).json({ success: false, error: '缺少参数 id' });
    return;
  }
  try {
    const status = await qrLoginPoll(id);
    if (status.state === 'confirmed') {
      res.json({ success: true, state: status.state, token: status.token, user: status.user });
    } else if (status.state === 'error') {
      res.status(502).json({ success: false, state: 'error', error: status.message });
    } else {
      res.json({ success: true, state: status.state });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '查询扫码状态失败';
    res.status(502).json({ success: false, error: message });
  }
});

router.post('/api/auth/qr/abort', (req, res) => {
  const id = String((req.body as { id?: unknown } | undefined)?.id ?? req.query.id ?? '');
  if (id) qrLoginAbort(id);
  res.json({ success: true });
});

/**
 * 申请智能体会话。
 * 返回 visitorId / visitorVc / conversationId，供后续 stream 接口使用。
 * 携带有效登录 token 时以超星登录身份申请（visitorLoggedIn），任务流表单等服务对登录用户放行。
 */
router.post('/api/chat/session', async (req, res) => {
  try {
    // 附带登录态判定：前端据此检测 token 失效（如服务重启后内存登录态丢失）
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const rec = resolveAuth(token || undefined);
    const session = await applySession(rec?.cookie);
    res.json({ success: true, session, login: Boolean(rec), user: rec?.user ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : '申请会话失败';
    res.status(502).json({ success: false, error: message });
  }
});

/**
 * 上传文件到智能体会话（multipart 转发至超星）。
 * 表单字段：visitorId / visitorVc / conversationId（来自 session 接口）+ file
 * 返回 { objectId, filename, type, fileSize }，发送消息时随请求带给 stream 接口。
 */
router.post('/api/chat/upload', upload.single('file'), async (req, res) => {
  const { visitorId = '', visitorVc = '', conversationId = '' } = req.body as Record<string, string>;
  const file = req.file;
  if (!visitorId || !visitorVc || !conversationId) {
    res.status(400).json({ success: false, error: '会话参数缺失，请先申请会话' });
    return;
  }
  if (!file) {
    res.status(400).json({ success: false, error: '缺少文件' });
    return;
  }
  try {
    const info = await uploadFile(
      { visitorId, visitorVc, conversationId },
      { name: file.originalname, type: file.mimetype, buffer: file.buffer },
      authCookieOf(req)
    );
    res.json({ success: true, file: info });
  } catch (err) {
    const message = err instanceof Error ? err.message : '上传失败';
    res.status(502).json({ success: false, error: message });
  }
});

/**
 * 与智能体对话（SSE 流式下行）。
 * 查询参数：q（问题）、visitorId / visitorVc / conversationId（来自 session 接口）
 * 事件类型：thought（思考过程）、delta（增量文本）、final（结束）、error（错误）
 */
router.get('/api/chat/stream', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const visitorId = String(req.query.visitorId ?? '');
  const visitorVc = String(req.query.visitorVc ?? '');
  const conversationId = String(req.query.conversationId ?? '');

  if (!q) {
    res.status(400).json({ error: '缺少参数 q' });
    return;
  }
  if (!visitorId || !visitorVc || !conversationId) {
    res.status(400).json({ error: '会话参数缺失，请先调用 /api/chat/session' });
    return;
  }

  // 随消息携带的已上传文件（JSON：[{objectId,filename,type,fileSize}]）
  let fileInfo: RobotFileInfo[] = [];
  const rawFiles = String(req.query.files ?? '[]');
  if (rawFiles !== '[]') {
    try {
      const parsed = JSON.parse(rawFiles) as unknown[];
      fileInfo = parsed
        .filter(
          (x): x is RobotFileInfo =>
            x !== null && typeof x === 'object' &&
            typeof (x as RobotFileInfo).objectId === 'string' &&
            typeof (x as RobotFileInfo).filename === 'string'
        )
        .slice(0, 6);
    } catch {
      // 非法 JSON 时按无文件处理
    }
  }

  const outbound = q;

  // SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const writeEvent = (event: string, payload: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  let accumulated = '';
  const handle = chatOnce(
    { visitorId, visitorVc, conversationId },
    outbound,
    (ev) => {
      switch (ev.type) {
        case 'session':
          // FORCE_LOGOUT 自愈：服务端已换全新访客会话重试，新会话下发给前端持久化，
          // 否则前端缓存仍是被踢的旧会话，后续消息会再次触发 FORCE_LOGOUT
          writeEvent('session', ev.session);
          break;
        case 'thought':
          writeEvent('thought', { description: ev.description });
          break;
        case 'delta':
          accumulated += ev.text;
          writeEvent('delta', { text: ev.text });
          break;
        case 'final':
          writeEvent('final', { text: accumulated });
          res.end();
          break;
        case 'form':
          writeEvent('form', ev.form);
          res.end();
          break;
        case 'menu':
          writeEvent('menu', ev.menu);
          res.end();
          break;
        case 'error':
          writeEvent('error', { message: ev.message });
          res.end();
          break;
      }
    },
    fileInfo,
    authCookieOf(req)
  );

  // 客户端断开时释放上游连接
  // 注意用 res.on('close') 而非 req.on('close')：
  // Node 18+ 中带请求体的请求（如本接口的 JSON body）在 body 读取完成后
  // req 的 'close' 事件即触发，会在上游 WS 握手阶段就把连接误关掉，
  // 导致用户看到「与智能体的连接出现错误」。res 'close' 只在连接真正断开
  // （客户端中断或响应结束）时触发，语义正确。
  res.on('close', () => {
    handle.close();
  });
});

/**
 * 提交智能体下发的表单（SSE 流式下行，事件与 stream 接口一致）。
 * 请求体：{ visitorId, visitorVc, conversationId, messageId, fields }
 * fields：表单字段值数组，文件字段 value 为 objectId 数组（先经 upload 接口上传）。
 */
router.post('/api/chat/form', (req, res) => {
  const body = (req.body ?? {}) as {
    visitorId?: unknown;
    visitorVc?: unknown;
    conversationId?: unknown;
    messageId?: unknown;
    fields?: unknown;
  };
  const visitorId = String(body.visitorId ?? '');
  const visitorVc = String(body.visitorVc ?? '');
  const conversationId = String(body.conversationId ?? '');
  const messageId = String(body.messageId ?? '');
  const fields = Array.isArray(body.fields) ? body.fields : [];

  if (!visitorId || !visitorVc || !conversationId) {
    res.status(400).json({ error: '会话参数缺失，请先调用 /api/chat/session' });
    return;
  }
  if (!messageId || fields.length === 0) {
    res.status(400).json({ error: '缺少表单 messageId 或字段值' });
    return;
  }

  // 字段值校验：name 必须为非空字符串，value 为 string 或 string[]，其余键透传
  const safeFields: RobotFormFieldValue[] = [];
  for (const item of fields) {
    if (item === null || typeof item !== 'object') continue;
    const f = item as Record<string, unknown>;
    const name = typeof f.name === 'string' ? f.name : '';
    if (!name) continue;
    let value: string | string[] = '';
    if (typeof f.value === 'string') {
      value = f.value;
    } else if (Array.isArray(f.value) && f.value.every((x) => typeof x === 'string')) {
      value = f.value as string[];
    } else {
      value = '';
    }
    const field: RobotFormFieldValue = { ...f, name, value };
    if (Array.isArray(f.valueDetail)) {
      field.valueDetail = (f.valueDetail as unknown[])
        .filter(
          (x): x is { name: string; size: number } =>
            x !== null && typeof x === 'object' &&
            typeof (x as { name?: unknown }).name === 'string' &&
            typeof (x as { size?: unknown }).size === 'number'
        )
        .map((x) => ({ name: x.name, size: x.size }));
    }
    safeFields.push(field);
  }
  if (safeFields.length === 0) {
    res.status(400).json({ error: '表单字段值不合法' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const writeEvent = (event: string, payload: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  let accumulated = '';
  const handle = submitForm(
    { visitorId, visitorVc, conversationId },
    messageId,
    safeFields,
    (ev) => {
      switch (ev.type) {
        case 'session':
          // FORCE_LOGOUT 自愈：新会话下发给前端持久化（与 stream 路由一致）
          writeEvent('session', ev.session);
          break;
        case 'thought':
          writeEvent('thought', { description: ev.description });
          break;
        case 'delta':
          accumulated += ev.text;
          writeEvent('delta', { text: ev.text });
          break;
        case 'final':
          writeEvent('final', { text: accumulated });
          res.end();
          break;
        case 'form':
          writeEvent('form', ev.form);
          res.end();
          break;
        case 'menu':
          writeEvent('menu', ev.menu);
          res.end();
          break;
        case 'error':
          writeEvent('error', { message: ev.message });
          res.end();
          break;
      }
    },
    authCookieOf(req)
  );

  // 注意用 res.on('close') 而非 req.on('close')：
  // Node 18+ 中带请求体的请求（如本接口的 JSON body）在 body 读取完成后
  // req 的 'close' 事件即触发，会在上游 WS 握手阶段就把连接误关掉，
  // 导致用户看到「与智能体的连接出现错误」。res 'close' 只在连接真正断开
  // （客户端中断或响应结束）时触发，语义正确。
  res.on('close', () => {
    handle.close();
  });
});

// API 路由示例
router.get('/api/hello', (req, res) => {
  res.json({
    message: 'Hello from Express + Vite!',
    timestamp: new Date().toISOString(),
  });
});

router.post('/api/data', (req, res) => {
  const requestData = req.body;
  res.json({
    success: true,
    data: requestData,
    receivedAt: new Date().toISOString(),
  });
});

// 健康检查接口
router.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    env: process.env.CODER_PROJECT_ENV,
    timestamp: new Date().toISOString(),
  });
});

export default router;
