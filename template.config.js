export const paramsSchema = {
  type: "object",
  properties: {
    appName: {
      type: "string",
      minLength: 1,
      pattern: "^[a-z0-9-]+$",
      description:
        "Application name (lowercase, alphanumeric and hyphens only)",
    },
    port: {
      type: "number",
      default: 5000,
      minimum: 1024,
      maximum: 65535,
      description: "Development server port",
    },
    hmrPort: {
      type: "number",
      default: 6000,
      minimum: 1024,
      maximum: 65535,
      description: "Development HMR server port",
    },
  },
  required: [],
  additionalProperties: false,
};

const description = `Vite（简单项目）：\`coder init \${CODER_PROJECTS_PATH} --template vite\`
- 适用：轻量级 SPA、纯前端交互、仪表盘等轻量级项目。`;

const config = {
  description: description,
  paramsSchema,

  defaultParams: {
    port: 5000,
    hmrPort: 6000,
    appName: "projects",
  },

  onBeforeRender: async (context) => {
    console.log(
      `Creating React + TypeScript + Vite project: ${context.appName}`
    );
    return context;
  },

  onAfterRender: async (_context, _outputPath) => {
    // 输出由 init 命令统一处理
  },

  onComplete: async (_context, _outputPath) => {},
};

export default config;
