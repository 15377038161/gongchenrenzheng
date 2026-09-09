import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    // 占位值 — drizzle-kit generate 不连接数据库，dbCredentials 仅供配置校验
    url: 'postgresql://placeholder:placeholder@localhost:5432/postgres',
  },
})
