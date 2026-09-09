// ABOUTME: Express server with Vite integration
// ABOUTME: Handles API routes and serves frontend in dev/prod modes

import { createServer, type Server } from 'http';
import express from 'express';
import router from './routes/index';
import { setupVite } from './vite';

const isDev = process.env.CODER_PROJECT_ENV !== 'PROD';
const port = parseInt(process.env.PORT || '5000', 10);
const hostname = process.env.HOSTNAME || 'localhost';
const app = express();
// 使用 http.createServer 包装 Express app，以便支持 WebSocket 等协议升级
const server = createServer(app);

async function startServer(): Promise<Server> {
  // 添加请求体解析（须在 API 路由之前）
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // 注册 API 路由（必须在 Vite 中间件之前，否则 SPA fallback 会吞掉 /api/* 请求）
  app.use(router);

  // 集成 Vite（开发模式）或静态文件服务（生产模式）
  // 放在 API 路由之后，确保 API 请求优先处理
  // 传入 HTTP server，使 Vite 能在其上挂载 HMR WebSocket
  await setupVite(app, server);

  // 请求日志（仅开发环境）
  if (isDev) {
    app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const ms = Date.now() - start;
        console.log(`${req.method} ${req.url} - ${ms}ms`);
      });
      next();
    });
  }

  // 全局错误处理
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('Server error:', message);
    const status = err instanceof Error && 'status' in err ? (err as { status?: number }).status ?? 500 : 500;
    res.status(status).json({ error: message });
  });

  server.once('error', err => {
    console.error('Server error:', err);
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`\n✨ Server running at http://${hostname}:${port}`);
    console.log(`📝 Environment: ${isDev ? 'development' : 'production'}\n`);
  });

  return server;
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
