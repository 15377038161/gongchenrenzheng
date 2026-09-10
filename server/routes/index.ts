import { Router } from 'express';
import multer from 'multer';
import {
  applySession,
  chatOnce,
  submitForm,
  uploadFile,
  type RobotFileInfo,
  type RobotFormFieldValue,
} from '../robot/agent';
import dbRouter from './db';

const router = Router();

// 数据库代理（会话与消息持久化，浏览器无法直连 Supabase）
router.use(dbRouter);

// 文件上传（内存缓冲，转发给超星智能体）
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

/**
 * 申请智能体访客会话。
 * 返回 visitorId / visitorVc / conversationId，供后续 stream 接口使用。
 */
router.post('/api/chat/session', async (_req, res) => {
  try {
    const session = await applySession();
    res.json({ success: true, session });
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
      { name: file.originalname, type: file.mimetype, buffer: file.buffer }
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

  // 触发词归一化：超星智能体的意图路由按精确措辞分流——
  // 「撰写工程认证」等近似表述会落入知识库问答分支（返回长文本），
  // 而「帮我编写工程认证」才能命中任务流并下发 FORM 表单。此处把撰写类
  // 触发词统一改写为已实测可触发任务流的规范短语，保证用户输入即可拿到表单。
  const TRIGGER_CANONICAL = '帮我编写工程认证';
  const TRIGGER_PATTERN = /^(帮我|请帮我|麻烦)?(撰写|编写|写|做)(一份)?工程(教育)?认证(报告|材料|自评报告)?$/;
  let outbound = q;
  if (TRIGGER_PATTERN.test(q)) {
    outbound = TRIGGER_CANONICAL;
    console.log(`[chat] trigger normalized: "${q}" -> "${TRIGGER_CANONICAL}"`);
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
    fileInfo
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
    }
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
