# 项目上下文

## 项目简介

智识工作台：超星智能体的重设计交互外壳。通过 iframe 嵌入超星智能体对话页（robot.chaoxing.com/coze?unitId=1731&robotId=9a31c8e736704a0b9d57b35c73da681f），外层提供书房纸墨风格的 UI 壳：品牌头栏、能力速览侧栏、排版式欢迎屏、iframe 加载/重载控制。视觉规范见 DESIGN.md。

## 技术栈

- **核心**: Vite 7, React 19, TypeScript, Express
- **SDK**: iframe-route-sync (CDN), iframe-error-sync (CDN), iframe-element-picker (CDN)
- **UI**: Tailwind CSS
- **JSX**: Vite 7 内置 esbuild 处理（无需 @vitejs/plugin-react）

## 目录结构

```
├── scripts/            # 构建与启动脚本
│   ├── build.sh        # 构建脚本
│   ├── dev.sh          # 开发环境启动脚本
│   ├── prepare.sh      # 预处理脚本
│   └── start.sh        # 生产环境启动脚本
├── server/             # 服务端逻辑
│   ├── routes/         # API 路由
│   ├── server.ts       # Express 服务入口
│   └── vite.ts         # Vite 中间件集成
├── src/                # 前端源码
│   ├── sdk/            # SDK 绑定逻辑
│   │   ├── bind-error-sync.ts    # iframe-error-sync Vite HMR 钩子
│   │   └── bind-route-sync.ts    # iframe-route-sync 路由同步
│   ├── iframe-error-sync.d.ts    # error-sync 全局类型声明
│   ├── iframe-element-picker.d.ts # element-picker 全局类型声明
│   ├── iframe-route-sync.d.ts    # route-sync 全局类型声明
│   ├── index.css       # 全局样式
│   ├── index.tsx       # 客户端入口
│   ├── main.tsx        # SDK 初始化入口
│   └── renderer.tsx    # React 组件 + renderHome
├── index.html          # 入口 HTML
├── package.json        # 项目依赖管理
├── tsconfig.json       # TypeScript 配置
└── vite.config.ts      # Vite 配置
```

## 包管理规范

**仅允许使用 pnpm** 作为包管理器，**严禁使用 npm 或 yarn**。
**常用命令**：
- 安装依赖：`pnpm add <package>`
- 安装开发依赖：`pnpm add -D <package>`
- 安装所有依赖：`pnpm install`
- 移除依赖：`pnpm remove <package>`

## 开发规范

- 使用 Tailwind CSS 进行样式开发

### 编码规范

- 默认按 TypeScript `strict` 心智写代码；优先复用当前作用域已声明的变量、函数、类型和导入，禁止引用未声明标识符或拼错变量名。
- 禁止隐式 `any` 和 `as any`；函数参数、返回值、解构项、事件对象、Express `req`/`res`、`catch` 错误在使用前应有明确类型或先完成类型收窄，并清理未使用的变量和导入。
