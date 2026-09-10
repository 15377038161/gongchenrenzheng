// 登录页覆盖层：超星 OAuth 一键登录（门户已登录静默联动）+ 邮箱密码登录（独立入口）
// 水彩校园风格：白底卡片 + 湖蓝主按钮，与主界面配色体系一致
import { useEffect, useState } from 'react';
import { loginWithEmail, loginWithChaoxingOAuth, registerWithEmail } from '../lib/auth';

interface LoginOverlayProps {
  /** OAuth 回跳在途（exchange 进行中），显示过渡态不闪屏 */
  relaying?: boolean;
  onOAuthError?: (message: string) => void;
}

export function LoginOverlay({ relaying, onOAuthError }: LoginOverlayProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // 切换模式时清空错误提示
  useEffect(() => {
    setErrorMsg('');
  }, [mode]);

  /** 邮箱登录/注册提交 */
  const handleSubmit = async () => {
    if (busy) return;
    setErrorMsg('');
    if (!email.trim() || !password) {
      setErrorMsg('请填写邮箱和密码');
      return;
    }
    if (mode === 'register' && password !== confirmPwd) {
      setErrorMsg('两次输入的密码不一致');
      return;
    }
    setBusy(true);
    try {
      const result =
        mode === 'login'
          ? await loginWithEmail(email.trim(), password)
          : await registerWithEmail(email.trim(), password);
      if (!result.success) {
        setErrorMsg(result.error || '登录失败，请重试');
        return;
      }
      if (mode === 'register') {
        // 注册成功（无邮箱确认要求时已自动登录；否则提示查收邮件）
        setErrorMsg('');
        setMode('login');
        setErrorMsg('注册成功，请登录');
      }
      // 登录成功：session 已持久化，renderer 的 onAuthStateChange 会解除本覆盖层
    } finally {
      setBusy(false);
    }
  };

  /** 超星一键登录：门户已登录用户静默授权无感完成 */
  const handleOAuthLogin = async () => {
    if (busy) return;
    setErrorMsg('');
    const result = await loginWithChaoxingOAuth();
    if (!result.success) {
      onOAuthError?.(result.error || '跳转授权页失败');
      setErrorMsg(result.error || '跳转授权页失败');
    }
    // 成功时页面即将顶层跳转，无需后续处理
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 px-5 py-8 backdrop-blur-sm">
      <div className="w-full max-w-[400px] overflow-hidden rounded-[20px] border border-hairline bg-white shadow-[0_12px_48px_rgba(27,39,51,0.18)]">
        {/* 头部：校徽 + 应用名 */}
        <div className="flex flex-col items-center gap-3 px-8 pt-9">
          <img src="/hust-logo.png" alt="华中科技大学" className="h-14 w-14" aria-hidden="true" />
          <h2 className="font-serif-sc text-[1.7rem] font-semibold text-ink">工程认证</h2>
          <p className="text-[15.5px] text-ink-soft">华中科技大学环境科学与工程学院</p>
        </div>

        {relaying ? (
          // OAuth 回跳在途：过渡态
          <div className="flex flex-col items-center gap-3 px-8 py-10">
            <span
              aria-hidden="true"
              className="h-6 w-6 animate-spin rounded-full border-2 border-hairline border-t-lake-deep"
            />
            <p className="text-[16px] text-ink-soft">正在完成超星登录…</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4 px-8 py-7">
            {/* 超星一键登录（主推：门户已登录时静默联动） */}
            <button
              type="button"
              onClick={() => void handleOAuthLogin()}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-[12px] bg-lake-deep text-[18px] font-medium text-white transition-all duration-200 hover:scale-[1.02] hover:bg-[#2f5689] hover:shadow-[0_4px_14px_rgba(58,103,171,0.35)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-deep"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4" />
                <path d="M10 17l5-5-5-5" />
                <path d="M15 12H3" />
              </svg>
              超星一键登录
            </button>
            <p className="text-center text-[14px] text-ink-faint">
              门户已登录的用户可直接静默完成认证
            </p>

            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-hairline" />
              <span className="text-[14px] text-ink-faint">或使用邮箱</span>
              <span className="h-px flex-1 bg-hairline" />
            </div>

            {/* 邮箱登录/注册表单 */}
            {mode === 'login' ? (
              <div className="flex flex-col gap-3">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="邮箱"
                  autoComplete="email"
                  className="h-12 rounded-[12px] border border-hairline bg-white px-4 text-[17px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-lake-deep focus:shadow-[0_0_0_3px_rgba(58,103,171,0.12)]"
                />
                <div className="relative">
                  <input
                    type={showPwd ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="密码"
                    autoComplete="current-password"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleSubmit();
                    }}
                    className="h-12 w-full rounded-[12px] border border-hairline bg-white px-4 pr-12 text-[17px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-lake-deep focus:shadow-[0_0_0_3px_rgba(58,103,171,0.12)]"
                  />
                  <button
                    type="button"
                    aria-label={showPwd ? '隐藏密码' : '显示密码'}
                    onClick={() => setShowPwd((v) => !v)}
                    className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-md text-[16px] text-ink-faint hover:bg-lake-pale hover:text-lake-deep focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep"
                  >
                    {showPwd ? '隐藏' : '显示'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="邮箱"
                  autoComplete="email"
                  className="h-12 rounded-[12px] border border-hairline bg-white px-4 text-[17px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-lake-deep focus:shadow-[0_0_0_3px_rgba(58,103,171,0.12)]"
                />
                <div className="relative">
                  <input
                    type={showPwd ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="密码"
                    autoComplete="new-password"
                    className="h-12 w-full rounded-[12px] border border-hairline bg-white px-4 pr-12 text-[17px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-lake-deep focus:shadow-[0_0_0_3px_rgba(58,103,171,0.12)]"
                  />
                  <button
                    type="button"
                    aria-label={showPwd ? '隐藏密码' : '显示密码'}
                    onClick={() => setShowPwd((v) => !v)}
                    className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-md text-[16px] text-ink-faint hover:bg-lake-pale hover:text-lake-deep focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep"
                  >
                    {showPwd ? '隐藏' : '显示'}
                  </button>
                </div>
                <input
                  type={showPwd ? 'text' : 'password'}
                  value={confirmPwd}
                  onChange={(e) => setConfirmPwd(e.target.value)}
                  placeholder="确认密码"
                  autoComplete="new-password"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleSubmit();
                  }}
                  className="h-12 rounded-[12px] border border-hairline bg-white px-4 text-[17px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-lake-deep focus:shadow-[0_0_0_3px_rgba(58,103,171,0.12)]"
                />
              </div>
            )}

            {errorMsg && (
              <p className="rounded-[8px] bg-lake-pale px-3 py-2 text-[15px] leading-5 text-ink-soft" role="alert">
                {errorMsg}
              </p>
            )}

            <button
              type="button"
              disabled={busy}
              onClick={() => void handleSubmit()}
              className="h-12 w-full rounded-[12px] border border-lake-deep bg-white text-[18px] font-medium text-lake-deep transition-all duration-200 hover:scale-[1.02] hover:bg-lake-pale disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-deep"
            >
              {busy ? '处理中…' : mode === 'login' ? '登录' : '注册'}
            </button>

            {/* 模式切换 */}
            <p className="text-center text-[15px] text-ink-soft">
              {mode === 'login' ? (
                <>
                  还没有账号？
                  <button
                    type="button"
                    onClick={() => setMode('register')}
                    className="ml-1 text-lake-deep underline underline-offset-2 hover:text-[#2f5689] focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep"
                  >
                    去注册
                  </button>
                </>
              ) : (
                <>
                  已有账号？
                  <button
                    type="button"
                    onClick={() => setMode('login')}
                    className="ml-1 text-lake-deep underline underline-offset-2 hover:text-[#2f5689] focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep"
                  >
                    去登录
                  </button>
                </>
              )}
            </p>
          </div>
        )}

        <p className="border-t border-hairline bg-lake-pale/50 px-8 py-3 text-center text-[13px] leading-4 text-ink-faint">
          登录后对话记录将关联您的账号 · 内容由 AI 生成，仅供参考
        </p>
      </div>
    </div>
  );
}
