/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase 多租户连接（平台注入） */
  readonly CODER_SUPABASE_URL: string;
  readonly CODER_SUPABASE_ANON_KEY: string;
  readonly CODER_SUPABASE_TENANT_ID: string;
  /** Coder 项目 ID（认证代理 exchange 需要） */
  readonly CODER_PROJECTS_ID: string;
  /** 本地开发模式认证代理隧道地址（生产不存在 → 相对路径） */
  readonly CODER_AUTH_PROXY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
