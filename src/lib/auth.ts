// 超星身份认证（OAuth2.0 一键登录 + 邮箱密码登录）
// 门户已登录用户经 snsapi_base 静默授权无感登录；未登录用户走独立登录入口。
// 契约遵循 supabase-auth 技能：AUTH_BASE 环境变量读取、checklogin 中转、exchange 单次兑换。
import { getSupabase } from './supabase';

const PROJECT_ID = import.meta.env.CODER_PROJECTS_ID;
// 登录请求 base：本地开发模式平台注入隧道地址（浏览器直连，绕开预览网关）；
// 生产环境该变量不存在 → 空字符串 → 相对路径，由 Nginx 转发。禁止硬编码任何绝对 URL。
const AUTH_BASE = import.meta.env.CODER_AUTH_PROXY_URL || '';

/** 登录后去向（唯一事实源，全项目仅此一处声明） */
export const POST_LOGIN_HOME = '/';

const AUTH_HEADERS = {
  'Content-Type': 'application/json',
  // 本地模式绕过 ngrok 免费版浏览器警告页；生产环境该头无副作用，必须保留
  'ngrok-skip-browser-warning': 'true',
};

export interface LoginResult {
  success: boolean;
  error?: string;
}

/** 邮箱密码登录（Supabase 原生 Auth，Auth 配置已启用 external_email） */
export async function loginWithEmail(email: string, password: string): Promise<LoginResult> {
  const { error } = await getSupabase().auth.signInWithPassword({ email, password });
  if (error) {
    return { success: false, error: error.message };
  }
  return { success: true };
}

/** 邮箱注册（注册后按 Supabase 配置自动登录或需邮箱确认） */
export async function registerWithEmail(email: string, password: string): Promise<LoginResult> {
  const { error } = await getSupabase().auth.signUp({ email, password });
  if (error) {
    return { success: false, error: error.message };
  }
  return { success: true };
}

/** 退出登录 */
export async function logout(): Promise<LoginResult> {
  const { error } = await getSupabase().auth.signOut();
  if (error) {
    return { success: false, error: error.message };
  }
  return { success: true };
}

/**
 * 超星 OAuth2.0 一键登录：向服务端换取授权跳转地址后顶层导航到超星授权页。
 * snsapi_base 静默授权——门户（超星体系）已登录的用户无感完成；未登录则显示超星登录页。
 */
export async function loginWithChaoxingOAuth(): Promise<LoginResult> {
  // redirect_uri 固定为当前页面完整 URL，授权后原路回跳
  const redirectUri = window.location.href.split('#')[0];
  console.info('[auth] 获取授权地址 redirect_uri=', redirectUri);
  const res = await fetch(
    `${AUTH_BASE}/v1/api/coder/proxy/auth/chaoxing-oauth/authorize-url?redirect_uri=${encodeURIComponent(redirectUri)}`,
    { headers: AUTH_HEADERS }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    return { success: false, error: body.message || `获取授权地址失败 (${res.status})` };
  }
  const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
  // 必须顶层导航：fetch 跟随跨域 302 会被 CORS 拦截
  window.location.assign(authorizeUrl);
  return { success: true };
}

/**
 * OAuth 回跳兑换（只兑换、不导航、不中转）。
 * 幂等（CRITICAL）：模块级 in-flight 去重——无论被并发调用几次（React StrictMode 双执行
 * effect 等），exchange 请求只发一次；授权码是一次性票据，重复兑换必然报 invalid code。
 */
let inflight: Promise<LoginResult> | null = null;
export function handleOAuthCallback(): Promise<LoginResult> {
  if (inflight) {
    return inflight;
  }
  inflight = doHandleOAuthCallback().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doHandleOAuthCallback(): Promise<LoginResult> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) {
    return { success: false };
  }
  return doExchange(code);
}

/**
 * 以给定 code 完成 exchange 兑换：换取 session → setSession → 清理 URL。
 * userinfo（中转回跳的 AES 密文，可选）随请求体提交，服务端在兑换前内部解密并暂存凭证。
 */
async function doExchange(code: string, userinfo?: string): Promise<LoginResult> {
  console.info('[auth] 开始 exchange 兑换', userinfo ? '（携带 userinfo 密文）' : '（无 userinfo）');
  const res = await fetch(`${AUTH_BASE}/v1/api/coder/proxy/auth/chaoxing-oauth/exchange`, {
    method: 'POST',
    headers: AUTH_HEADERS,
    body: JSON.stringify({ code, projectId: PROJECT_ID, ...(userinfo ? { userinfo } : {}) }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    console.warn('[auth] exchange 失败 status=', res.status, 'message=', body.message);
    // code 一次性且短时效：失败后清掉 URL 参数，提示用户重新发起登录
    cleanOAuthParamsFromUrl();
    return { success: false, error: body.message || '登录链接已失效，请重新登录' };
  }

  const session = (await res.json()) as { access_token: string; refresh_token: string };
  const { error } = await getSupabase().auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (error) {
    console.warn('[auth] setSession 失败:', error.message);
    cleanOAuthParamsFromUrl();
    return { success: false, error: error.message };
  }

  console.info('[auth] exchange 兑换成功，session 已建立');
  // 登录成功：清掉 URL 上的 code/state，避免刷新重放
  cleanOAuthParamsFromUrl();
  return { success: true };
}

/** 用 replaceState 移除 URL 中的 OAuth 回跳参数（不留历史记录）。 */
function cleanOAuthParamsFromUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  url.searchParams.delete('userinfo');
  window.history.replaceState({}, '', url.toString());
}

// ── checklogin 中转（取回浏览器超星登录凭证）────────────────────
// 授权回跳拿到 code 后，先经超星 checklogin 接口中转一跳：超星读取浏览器超星 cookie，
// 302 回跳本页并追加 userinfo 参数（AES 密文）；再取回暂存的 code，将 userinfo 随包
// 在单次 exchange 内完成兑换。中转最多一次（一次性标记防循环）；
// 任何中转环节失败都不阻断登录主链路。
const CX_CODE_KEY = 'cx_oauth_code';
const CX_RELAY_KEY = 'cx_checklogin_relay';

/**
 * 入口页登录闭环编排（挂载点统一调用此函数）：
 * 首次拿到 code → 暂存并中转 checklogin；中转回跳/已中转 → 观测 userinfo 后兑换 session。
 */
export async function handleOAuthLoginFlow(): Promise<LoginResult> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const userinfo = params.get('userinfo');
  const relayed = sessionStorage.getItem(CX_RELAY_KEY) === '1';
  console.info('[auth] 登录闭环入口', { hasCode: !!code, hasUserinfo: !!userinfo, relayed });

  // 首次拿到 code 且未中转：暂存 code、清理 URL，立即中转（time 有时效，取得地址后不得缓存）
  if (code && !relayed) {
    sessionStorage.setItem(CX_CODE_KEY, code);
    sessionStorage.setItem(CX_RELAY_KEY, '1');
    cleanOAuthParamsFromUrl();
    try {
      const backurl = window.location.href.split('#')[0];
      const res = await fetch(
        `${AUTH_BASE}/v1/api/coder/proxy/auth/chaoxing-checklogin/url?backurl=${encodeURIComponent(backurl)}`,
        { headers: AUTH_HEADERS }
      );
      if (res.ok) {
        const { checkloginUrl } = (await res.json()) as { checkloginUrl: string };
        window.location.assign(checkloginUrl);
        // 页面即将跳转；若返回则视为失败（不应继续，避免 code 在中转未完成时被兑换）
        return { success: false };
      }
      console.warn('[auth] checklogin 中转地址获取失败，跳过中转直接登录:', res.status);
    } catch (e) {
      console.warn('[auth] checklogin 中转异常，跳过中转直接登录:', e);
    }
  }

  // 中转回跳（带 userinfo）或已中转：归一化密文（URL 传参可能把 Base64 的 '+' 丢失为空格）
  const relayedUserinfo = userinfo ? userinfo.replace(/ /g, '+') : undefined;

  // 兑换 session：优先取暂存 code（中转回跳后 URL 已无 code），其次兼容 URL 直回跳形态。
  // 中转标记与 URL 参数 MUST 在 exchange 在途窗口保持存活，统一在结算后（finally）清理。
  const pendingCode = sessionStorage.getItem(CX_CODE_KEY) || code;
  if (pendingCode) {
    try {
      return await doExchange(pendingCode, relayedUserinfo);
    } finally {
      sessionStorage.removeItem(CX_RELAY_KEY);
      sessionStorage.removeItem(CX_CODE_KEY);
      cleanOAuthParamsFromUrl();
    }
  }
  // 无 code 可兑（暂存丢失等）：清理标记防守卫永久挂起，走失败降级路径
  sessionStorage.removeItem(CX_RELAY_KEY);
  cleanOAuthParamsFromUrl();
  return { success: false };
}
