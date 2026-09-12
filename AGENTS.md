# AGENTS.md

## 项目概览
- 工程认证智能问答应用（华中科技大学环境科学与工程学院）：上传工程认证材料文档，智能体自动提炼内容，按章节（1.1/1.2/2.1）读取章节内容
- 架构：Express（`server/`）+ React SPA（`src/`），Vite 构建，前后端同一 dev server（HMR + `/api` 代理）
- 智能体链路：服务端维护超星账号 Cookie 并透传到 session/upload/stream/form；登录后任务流使用账号 UID，不得回落匿名 visitor

## 常用命令
- 依赖：`pnpm install`（仅 pnpm）
- 静态检查：`pnpm ts-check` / `pnpm lint`
- 冒烟测试端口：`$DEPLOY_RUN_PORT`（禁止硬编码，禁止 9000 端口）

## 代码结构
- `server/robot/agent.ts`：超星智能体协议（applySession / chatOnce / uploadFile）；`RobotFileInfo = { objectId, filename, type, fileSize }`
- `shared/chaoxing-account-channel.ts`：账号态任务流的识别规则、机构/智能体/任务流 ID（不负责页面跳转）
- `server/routes/index.ts`：`/api/chat/session`、`/api/chat/upload`（multipart）、`/api/chat/stream`（SSE，query 传 `files` JSON）、`/api/health`
- `server/routes/db.ts`：`/api/db/conversations`、`/api/db/messages` CRUD；登录请求由服务端 token 推导 UID 隔离键，访客请求才使用 `x-client-key`
- `server/db/supabase.ts`：服务端 Supabase 客户端工厂（浏览器不能直连内网 Supabase，一律走服务端代理）
- `src/renderer.tsx`：主界面（会话/消息/上传/语音/进度条全在此，单文件较大，改动前先 grep 定位）
- `src/lib/chat-store.ts`：前端数据层；`Attachment` 含可选 `objectId`
- `src/index.css`：湖蓝/薄荷主题 tokens、选项卡片、呼吸动效
- `public/hust-logo.png`、`public/bg-campus.png`：华科校徽与校园水彩背景

## 编码规范
- TypeScript strict：所有参数/返回值显式标注类型，禁止隐式 any
- React 19：不 `import React`（除非用 `React.xxx`）；禁止 JSX 内直接用 `Date.now()`/`Math.random()`
- 前端与智能体会话映射按身份命名存入 localStorage（`engcert_robot_sessions_<uid>`；匿名为独立键），删除会话时需同步清理

## 常见问题
- 会话列表加载失败 → 检查是否绕过了服务端代理直连 Supabase
- 插入 DB 报 RLS 违规 → 检查服务端推导的 UID/访客隔离键是否与请求头一致，以及插入 payload 是否带 `client_key`
- 带文件对话超时 → 文档提炼任务流耗时长（>120s），前端需容忍长等待，勿设过短的流超时
- 表单返回“请先登录” → 检查 `/api/auth/me` 是否 authenticated、`/api/chat/session` 的 visitorId 是否等于账号 UID，以及请求是否携带 `authCookieOf(req)`；任务流请求不得静默降级游客，前端在当前页面重新登录；不要把 token/cookie 暴露给浏览器
