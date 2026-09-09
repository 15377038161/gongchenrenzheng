import { Router } from 'express';
import { applySession, chatOnce } from '../robot/agent';
import dbRouter from './db';

const router = Router();

// 数据库代理（会话与消息持久化，浏览器无法直连 Supabase）
router.use(dbRouter);

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
    q,
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
        case 'error':
          writeEvent('error', { message: ev.message });
          res.end();
          break;
      }
    }
  );

  // 客户端断开时释放上游连接
  req.on('close', () => {
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
