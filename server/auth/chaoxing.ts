// ABOUTME: 超星 passport 登录代理（fanyalogin 协议）
// ABOUTME: 协议逆向自 passport2.chaoxing.com 前端：uname/password 均以 AES-128-CBC 加密
// ABOUTME: 登录态 cookie（UID/vc3/fid 等）持久化到磁盘，服务重启后自动恢复，无需重新登录

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** AES 密钥（超星前端 JS 内置，key 即 iv，Pkcs7 填充） */
const KEY = Buffer.from('u2oh6Vu^HWe4_AES', 'utf8');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const PASSPORT_ORIGIN = 'https://passport2.chaoxing.com';
/** 智能体单元/机器人 ID（与 server/robot/agent.ts 保持一致，用于登录态存活探测）。
 * 注意：这是 robot 业务链路的 unitId/robotId，与「机构 FID」语义完全不同——
 * 巧合的是 unitId 数值与华中科技大学 FID 同为 1731，但两者不可混用（FID 用于登录身份校验）。 */
const ROBOT_UNIT_ID = '1731';
const ROBOT_ID = '9a31c8e736704a0b9d57b35c73da681f';

/** 已知机构 FID 名称映射（仅用于强制校验开启时的错误提示，不构成默认白名单）。
 * - 1731：华中科技大学（本站面向的环境学院所属机构）
 * - 1385：超星自有机构（超星集团内部账号）
 * 注意：扫码协议本身 fid=-1 不限机构，登录成功后机构归属才从登录态 cookie 的
 * fid / userinfo 的 schoolid 解析出来；默认（未配置 CHAOXING_FID_ENFORCE）不做机构拒绝。 */
const FID_NAMES: Record<string, string> = {
  '1731': '华中科技大学',
  '1385': '超星',
};

/** 登录用户信息（脱敏，返回给浏览器） */
export interface ChaoxingUser {
  uid: string;
  /** 展示名：优先超星 realname（真实姓名），无则回退手机号 */
  name: string;
  fid: string;
  /** 学通头像 URL（p.anan.chaoxing.com portrait 标准路径，页面端直接加载） */
  avatar: string;
}

interface AuthRecord {
  user: ChaoxingUser;
  cookie: string;
  /** 超星登录态过期时间（p_auth_token 有效期约 7 天，提前 1 小时刷新判定） */
  expiresAt: number;
  /** 最近一次上游存活探测时间（节流用，避免每个请求都打超星） */
  verifiedAt?: number;
}

/** 登录态持久化文件：与日志同目录，服务重启后自动加载（含 cookie 的登录凭据，644 以下权限环境） */
const AUTH_STORE_FILE = path.join(process.cwd(), '.auth-store.json');

/**
 * 自包含会话 token 的加密密钥。部署环境优先使用显式密钥，其次复用平台密钥；
 * 这样实例重启/横向扩容后仍能解码 token，不依赖某个容器的本地文件。
 */
const AUTH_SECRET_SOURCE =
  process.env.CHAOXING_AUTH_SECRET ??
  process.env.CODER_CODING_API_KEY ??
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'chaoxing-auth-local-development-only';
const AUTH_SECRET_KEY = crypto.createHash('sha256').update(AUTH_SECRET_SOURCE).digest();

/** 内部 token → 登录态记录（磁盘持久化；开发环境热重载/服务重启后 token 依然有效） */
const authStore = new Map<string, AuthRecord>();
const AUTH_TTL_MS = 7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000;

/** 启动时从磁盘恢复登录态（过期条目顺带清理） */
function loadAuthStore(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(AUTH_STORE_FILE, 'utf8')) as Record<string, AuthRecord>;
    const now = Date.now();
    for (const [token, rec] of Object.entries(raw)) {
      if (rec && typeof rec.expiresAt === 'number' && now < rec.expiresAt) {
        authStore.set(token, rec);
      }
    }
  } catch {
    // 文件不存在或损坏：首次运行/清空，视为未登录
  }
}

/** 登录态变化时写回磁盘（同步写小文件，登录/登出低频操作无性能影响） */
function persistAuthStore(): void {
  const raw: Record<string, AuthRecord> = {};
  for (const [token, rec] of authStore.entries()) {
    raw[token] = rec;
  }
  try {
    fs.writeFileSync(AUTH_STORE_FILE, JSON.stringify(raw));
  } catch {
    // 磁盘不可写（如生产容器只读）：退化为内存模式，登录态重启后丢失
  }
}

interface AuthEnvelope {
  version: 1;
  user: ChaoxingUser;
  cookie: string;
  expiresAt: number;
}

/** 生成自包含加密 token；密文中包含超星 Cookie，但浏览器无法解密。 */
function issueAuthToken(rec: AuthRecord): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', AUTH_SECRET_KEY, iv);
  const payload: AuthEnvelope = {
    version: 1,
    user: rec.user,
    cookie: rec.cookie,
    expiresAt: rec.expiresAt,
  };
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return [
    'cx1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

/** 解码自包含 token；格式或签名不合法一律视为未登录。 */
function decodeAuthToken(token: string): AuthRecord | null {
  try {
    const [version, ivRaw, tagRaw, encryptedRaw] = token.split('.');
    if (version !== 'cx1' || !ivRaw || !tagRaw || !encryptedRaw) return null;
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      AUTH_SECRET_KEY,
      Buffer.from(ivRaw, 'base64url')
    );
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    const payload = JSON.parse(
      Buffer.concat([decipher.update(Buffer.from(encryptedRaw, 'base64url')), decipher.final()]).toString('utf8')
    ) as Partial<AuthEnvelope>;
    if (
      payload.version !== 1 ||
      !payload.user ||
      typeof payload.user.uid !== 'string' ||
      typeof payload.user.name !== 'string' ||
      typeof payload.user.fid !== 'string' ||
      typeof payload.user.avatar !== 'string' ||
      typeof payload.cookie !== 'string' ||
      typeof payload.expiresAt !== 'number'
    ) {
      return null;
    }
    return {
      user: payload.user,
      cookie: payload.cookie,
      expiresAt: payload.expiresAt,
    };
  } catch {
    return null;
  }
}

loadAuthStore();

function encAes(text: string): string {
  const c = crypto.createCipheriv('aes-128-cbc', KEY, KEY);
  return Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('base64');
}

/** 解析 Set-Cookie 头到 Map */
function absorbCookies(target: Map<string, string>, setCookies: string[]): void {
  for (const c of setCookies) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) target.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

/**
 * 拉取超星用户资料（passport2 api/userinfo?uid=），供登录收尾共用。
 * 返回展示名（realname，缺失回退 fallbackName）与机构 FID。
 * FID 解析优先级：登录态 cookie 的 fid（与登录会话同源）→ userinfo 的 schoolid。
 * 注意：userinfo 还返回 dxfid（学信附属 id），与机构 FID 无关，不得误取。
 * 资料接口失败：姓名回退 fallbackName、FID 回退 cookie 值（可能为空），不阻断登录。
 */
async function fetchUserProfile(
  uid: string,
  cookieHeader: string,
  fallbackName: string,
  cookieFid: string
): Promise<{ displayName: string; fid: string }> {
  let displayName = fallbackName;
  let fid = cookieFid;
  try {
    const info = await fetch(`${PASSPORT_ORIGIN}/api/userinfo?uid=${encodeURIComponent(uid)}`, {
      headers: { 'User-Agent': UA, Cookie: cookieHeader, Accept: 'application/json', Referer: `${PASSPORT_ORIGIN}/` },
    });
    const data = (await info.json().catch(() => null)) as
      | { realname?: string; schoolid?: number | string }
      | null;
    if (data?.realname) displayName = data.realname;
    const schoolId = data?.schoolid !== undefined ? String(data.schoolid) : '';
    // FID：cookie 值优先（登录会话权威来源）；为空时用 userinfo 的 schoolid 兜底
    if (!fid && schoolId) fid = schoolId;
  } catch {
    // 资料接口失败：不影响登录主流程
  }
  return { displayName, fid };
}

/**
 * 机构 FID 强制校验（可选开关，默认关闭）。
 * 仅当部署方通过环境变量 CHAOXING_FID_ENFORCE 显式开启（如 "1731,1385"）时，
 * 非列表内 FID 才在登录收尾抛错拒绝；未配置时 FID 仅作为会话的诊断字段透出，
 * 保证已通过超星扫码/密码认证的账号稳定建立会话，不因机构归属差异误伤登录。
 * fid 解析失败（空值）在强制模式下同样拒绝（无法确认归属不放行）。
 */
const FID_ENFORCE_LIST = (process.env.CHAOXING_FID_ENFORCE ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function assertFidAllowed(fid: string): void {
  if (FID_ENFORCE_LIST.length === 0) return; // 未配置强制校验：默认放行，FID 仅作诊断字段
  if (FID_ENFORCE_LIST.includes(fid)) return;
  if (!fid) {
    throw new Error('无法确认账号所属机构，请联系管理员');
  }
  throw new Error(
    `该账号不属于允许的机构（${FID_ENFORCE_LIST.map((f) => FID_NAMES[f] ?? f).join('、')}），无法登录本站`
  );
}

/**
 * 用账号密码登录超星，成功返回内部 token（浏览器后续请求携带）。
 * 密码仅在本函数执行期间存在于内存，不落盘、不写日志。
 * 失败抛错（错误消息来自超星服务端，可透传给前端展示）。
 */
export async function chaoxingLogin(phone: string, password: string): Promise<{ token: string; user: ChaoxingUser }> {
  const jar = new Map<string, string>();
  // 1. 访问登录页取初始 cookie
  const page = await fetch(
    `${PASSPORT_ORIGIN}/login?fid=&newversion=true&refer=${encodeURIComponent('http://robot.chaoxing.com')}`,
    { headers: { 'User-Agent': UA } }
  );
  absorbCookies(jar, page.headers.getSetCookie?.() ?? []);
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

  // 2. 提交登录
  const login = await fetch(`${PASSPORT_ORIGIN}/fanyalogin`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: `${PASSPORT_ORIGIN}/login`,
      Cookie: cookieHeader(),
      Origin: PASSPORT_ORIGIN,
    },
    body: new URLSearchParams({
      fid: '-1',
      uname: encAes(phone),
      password: encAes(password),
      refer: encodeURIComponent('http://robot.chaoxing.com'),
      t: 'true',
      forbidotherlogin: '0',
      validate: '',
      doubleFactorLogin: '',
      independentId: '',
      independentNameId: '',
    }),
    redirect: 'manual',
  });
  absorbCookies(jar, login.headers.getSetCookie?.() ?? []);
  const body = (await login.json().catch(() => null)) as { status?: boolean; msg2?: string } | null;
  if (!body?.status) {
    throw new Error(body?.msg2 || '账号或密码错误');
  }
  const uid = jar.get('UID');
  if (!uid) {
    throw new Error('登录成功但未获取到用户凭证');
  }
  // 拉取超星用户资料并完成机构 FID 校验（共用收尾逻辑）
  const { displayName, fid } = await fetchUserProfile(uid, cookieHeader(), phone, jar.get('fid') ?? '');
  assertFidAllowed(fid);
  // 学通标准头像路径（浏览器端直接加载；无头像时该 URL 返回默认图，onerror 再兜底首字头像）
  const avatar = `https://p.anan.chaoxing.com/portrait/${uid.slice(0, 3)}/${uid.slice(3, 6)}/${uid}_1.jpg`;
  const user: ChaoxingUser = { uid, name: displayName, fid, avatar };
  const record: AuthRecord = {
    user,
    cookie: cookieHeader(),
    expiresAt: Date.now() + AUTH_TTL_MS,
  };
  const token = issueAuthToken(record);
  authStore.set(token, record);
  persistAuthStore();
  return { token, user };
}

/** 校验内部 token：有效返回登录记录（含超星 cookie），无效/过期返回 null */
export function resolveAuth(token: string | undefined): AuthRecord | null {
  if (!token) return null;
  // 优先读取本实例缓存；实例重启/横向扩容后从自包含密文恢复。
  const rec = authStore.get(token) ?? decodeAuthToken(token);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) {
    authStore.delete(token);
    persistAuthStore();
    return null;
  }
  return rec;
}

/** 上游存活探测节流间隔：避免每个请求都打超星（登录态有效期 7 天，5 分钟探测一次足够） */
const VERIFY_INTERVAL_MS = 5 * 60 * 1000;

/** 异步验证登录记录在超星侧是否仍有效（不阻塞请求，结果以清理/续期体现）。
 * 探测依据（实测 2026-09）：用登录 cookie 调真实业务链路
 * robot.chaoxing.com/v1/front/chat/visitor/apply —— 有效登录态返回 visitorLoggedIn:true
 * 且 visitorId=账号 UID；失效返回匿名 visitorId（无 visitorLoggedIn）。
 * 注意（CRITICAL）：不能用 i.chaoxing.com 判存活——实测新鲜有效 cookie 访问它也会
 * 被重定向到 passport 登录页（该域要求各自的 SSO 会话），曾导致 robot 链路仍有效的
 * 登录态被误杀、用户「无预警自动掉登录」。只有上游明确返回匿名身份才清理，
 * 网络失败/响应损坏一律保持现状（下次再探），杜绝瞬时抖动误杀。有效则滑动续期。 */
function scheduleVerify(rec: AuthRecord): void {
  const now = Date.now();
  if (rec.verifiedAt && now - rec.verifiedAt < VERIFY_INTERVAL_MS) return;
  rec.verifiedAt = now;
  void (async () => {
    try {
      const url =
        `https://robot.chaoxing.com/v1/front/chat/visitor/apply?visitorId=&unitId=${ROBOT_UNIT_ID}` +
        `&channel=WEB&robotId=${ROBOT_ID}&referUrl=&vc=&d=&vc3=&uid=&scene=&isLLMPlanning=0`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Cookie: rec.cookie,
          Referer: 'https://robot.chaoxing.com/coze',
          Accept: 'application/json',
        },
      });
      if (!res.ok) return; // 网关异常：保持现状，下次再探
      const data = (await res.json().catch(() => null)) as { visitorLoggedIn?: boolean } | null;
      if (!data) return; // 响应损坏：保持现状
      if (data.visitorLoggedIn === true) {
        rec.expiresAt = now + AUTH_TTL_MS;
        persistAuthStore();
      } else {
        // 上游明确返回匿名身份：登录态确实失效（异地挤下线/改密码）
        console.info('[auth] 超星侧登录态已失效（探测返回匿名身份），清理本地记录 uid=' + rec.user.uid);
        for (const [t, r] of authStore.entries()) {
          if (r === rec) authStore.delete(t);
        }
        persistAuthStore();
      }
    } catch {
      // 探测网络失败：保持现状（下次请求再探测），不误杀
    }
  })();
}

/** 校验内部 token 并触发上游存活探测（fire-and-forget，不阻塞请求） */
export function resolveAuthWithVerify(token: string | undefined): AuthRecord | null {
  const rec = resolveAuth(token);
  if (rec) scheduleVerify(rec);
  return rec;
}

/** 登出：作废内部 token（超星侧会话自然过期） */
export function chaoxingLogout(token: string | undefined): void {
  if (token) {
    authStore.delete(token);
    persistAuthStore();
  }
}

/* ===== 扫码登录（2026-09 新增） =====
 * 协议逆向自 passport2.chaoxing.com 登录页（实测 2026-09）：
 * 1. 访问登录页 → 页面内嵌 uuid/enc（hidden input）+ 初始 cookie
 * 2. 二维码图片：GET /createqr?uuid=xxx&fid=-1（image/jpeg）
 * 3. 轮询状态：POST /getauthstatus/v2（enc+uuid）→ {status, mes, type}
 *    status:true 即扫码登录成功，响应 Set-Cookie 携带完整登录态（UID/vc3/fid 等）
 * 注意：轮询必须复用创建会话时的 cookie jar（route 等），否则上游判定会话失效。
 */

/** 扫码会话（服务端内存态；低频登录场景无需持久化） */
interface QrSession {
  /** 轮询 cookie jar（含 route 等） */
  jar: Map<string, string>;
  uuid: string;
  enc: string;
  /** 创建时间（超时清理用；二维码有效期上游约 3 分钟） */
  createdAt: number;
  /** 轮询回调句柄（用于客户端放弃登录时停止服务端轮询） */
  active?: boolean;
}

const qrSessions = new Map<string, QrSession>();
/** 内部 id → 扫码会话 */
const QR_TTL_MS = 5 * 60 * 1000;
/** 轮询周期（对齐超星前端 3s） */
const QR_POLL_MS = 3000;
/** 单个二维码最大轮询时长（对齐超星前端 50 次 × 3s） */
const QR_POLL_MAX_MS = 150_000;

/** 启动/调用时清理过期扫码会话（防内存缓慢累积） */
function sweepQrSessions(): void {
  const now = Date.now();
  for (const [id, s] of qrSessions.entries()) {
    if (now - s.createdAt > QR_TTL_MS || s.active === false) qrSessions.delete(id);
  }
}

/** 创建扫码登录会话：访问超星登录页提取 uuid/enc，返回内部 id + 二维码图片 */
export async function qrLoginCreate(): Promise<{ id: string; image: ArrayBuffer; contentType: string }> {
  sweepQrSessions();
  const jar = new Map<string, string>();
  // 1. 访问登录页（拿初始 cookie + 页面内嵌 uuid/enc）
  const page = await fetch(
    `${PASSPORT_ORIGIN}/login?fid=&newversion=true&refer=${encodeURIComponent('http://robot.chaoxing.com')}`,
    { headers: { 'User-Agent': UA } }
  );
  absorbCookies(jar, page.headers.getSetCookie?.() ?? []);
  const html = await page.text();
  // 从登录页 HTML 提取 uuid/enc（hidden input；属性顺序 value 在前 id 在后，两种顺序均兼容）
  const pickHidden = (name: string): string | undefined =>
    html.match(new RegExp(`<input[^>]*id="${name}"[^>]*/?>`))?.[0]?.match(/value="([a-f0-9]{32})"/)?.[1] ??
    html.match(new RegExp(`<input[^>]*value="([a-f0-9]{32})"[^>]*id="${name}"[^>]*/?>`))?.[1];
  const uuid = pickHidden('uuid');
  const enc = pickHidden('enc');
  if (!uuid || !enc) {
    throw new Error('获取扫码登录二维码失败（页面解析失败）');
  }
  // 2. 拉取二维码图片
  const qr = await fetch(`${PASSPORT_ORIGIN}/createqr?uuid=${uuid}&fid=-1`, {
    headers: {
      'User-Agent': UA,
      Referer: `${PASSPORT_ORIGIN}/login`,
      Cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    },
  });
  if (!qr.ok || !qr.body) {
    throw new Error(`获取二维码图片失败（HTTP ${qr.status}）`);
  }
  const id = crypto.randomBytes(16).toString('hex');
  qrSessions.set(id, { jar, uuid, enc, createdAt: Date.now(), active: true });
  return {
    id,
    image: await qr.arrayBuffer(),
    contentType: qr.headers.get('content-type') ?? 'image/jpeg',
  };
}

/** 扫码状态 */
export type QrLoginStatus =
  | { state: 'pending' } // 等待扫码
  | { state: 'scanned' } // 已扫码，等待手机确认
  | { state: 'confirmed'; token: string; user: ChaoxingUser } // 登录成功
  | { state: 'expired' } // 二维码过期/超时
  | { state: 'error'; message: string };

/**
 * 轮询扫码状态：查询内部 id 对应会话的最新状态。
 * 实现为轻量「服务端代理轮询」——每次调用向上游查一次（前端 3s 调用一次，
 * 与超星前端原生节奏一致）。扫码成功后从上游 Set-Cookie 提取登录态，
 * 复用 authStore 落库并返回 token，登录态生命周期与密码登录完全一致。
 */
export async function qrLoginPoll(id: string): Promise<QrLoginStatus> {
  const s = qrSessions.get(id);
  if (!s) return { state: 'expired' };
  if (Date.now() - s.createdAt > QR_POLL_MAX_MS) {
    qrSessions.delete(id);
    return { state: 'expired' };
  }
  const cookieHeader = [...s.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  let res: Response;
  try {
    res = await fetch(`${PASSPORT_ORIGIN}/getauthstatus/v2`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `${PASSPORT_ORIGIN}/login`,
        Origin: PASSPORT_ORIGIN,
        Cookie: cookieHeader,
      },
      body: new URLSearchParams({
        enc: s.enc,
        uuid: s.uuid,
        doubleFactorLogin: '',
        forbidotherlogin: '0',
      }),
    });
  } catch {
    return { state: 'pending' }; // 网络抖动：保持等待，前端下次再查
  }
  absorbCookies(s.jar, res.headers.getSetCookie?.() ?? []);
  const data = (await res.json().catch(() => null)) as
    | { status?: boolean; mes?: string; type?: string }
    | null;
  if (!data) return { state: 'pending' };
  if (data.status === true) {
    // 登录成功：jar 中已含完整登录态 cookie
    qrSessions.delete(id);
    const uid = s.jar.get('UID');
    if (!uid) {
      return { state: 'error', message: '扫码登录成功但未获取到用户凭证' };
    }
    // 拉取用户资料并完成机构 FID 校验（cookie fid 优先、userinfo schoolid 兜底，与密码登录同链路）
    const finalCookie = [...s.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const { displayName, fid } = await fetchUserProfile(
      uid,
      finalCookie,
      '超星用户',
      s.jar.get('fid') ?? ''
    );
    try {
      assertFidAllowed(fid);
    } catch (err) {
      return { state: 'error', message: err instanceof Error ? err.message : '机构校验失败' };
    }
    const avatar = `https://p.anan.chaoxing.com/portrait/${uid.slice(0, 3)}/${uid.slice(3, 6)}/${uid}_1.jpg`;
    const user: ChaoxingUser = { uid, name: displayName, fid, avatar };
    const record: AuthRecord = { user, cookie: finalCookie, expiresAt: Date.now() + AUTH_TTL_MS };
    const token = issueAuthToken(record);
    authStore.set(token, record);
    persistAuthStore();
    return { state: 'confirmed', token, user };
  }
  // 未成功：按上游 type 区分（超星 type：3=未登录/等待扫码，其他=已扫码待确认）
  if (data.type === '3') return { state: 'pending' };
  return { state: 'scanned' };
}

/** 放弃扫码登录（客户端关闭弹窗时调用，清理服务端会话） */
export function qrLoginAbort(id: string): void {
  const s = qrSessions.get(id);
  if (s) s.active = false;
  sweepQrSessions();
}
