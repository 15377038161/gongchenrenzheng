import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

/** 超星智能体嵌入地址（含登录态的官方对话页） */
const ROBOT_URL =
  'https://robot.chaoxing.com/coze?unitId=1731&robotId=9a31c8e736704a0b9d57b35c73da681f';

/** 能力速览条目：引导用户理解智能体能做什么 */
const CAPABILITIES = [
  {
    key: 'ask',
    title: '问答求解',
    desc: '课程疑问、概念辨析、知识拓展，直接提问即可。',
  },
  {
    key: 'draft',
    title: '资料整理',
    desc: '梳理文献脉络、总结要点，产出结构化笔记。',
  },
  {
    key: 'write',
    title: '写作助手',
    desc: '从提纲到成文，润色、改写、扩写一步到位。',
  },
  {
    key: 'study',
    title: '学习规划',
    desc: '拆解学习目标，制定阶段计划与复习节奏。',
  },
] as const;

/** 页面标题与说明 */
const PAGE = {
  brand: '智识',
  brandFull: '智识工作台',
  subtitle: '超星智能体交互界面',
  welcomeTitle: '打开一页，与智能体对谈',
  welcomeDesc:
    '这里重新设计了智能体的入口。选择下方任意一项能力，即刻唤起对话——你的登录态与全部对话功能均由超星智能体原生提供。',
  cta: '唤起智能体',
  loading: '研墨中…',
  loadingDesc: '正在接入超星智能体，请稍候',
  footer: 'Powered by Chaoxing Agent',
} as const;

type Mode = 'welcome' | 'chat';

function App() {
  const [mode, setMode] = useState<Mode>('welcome');
  const [iframeKey, setIframeKey] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeCap, setActiveCap] = useState<string>('ask');

  const frameSrc = useMemo(() => ROBOT_URL, []);  // 进入对话态后复位加载标记（重载场景 iframeKey 变化）
  useEffect(() => {
    setLoaded(false);
  }, [iframeKey]);

  /** 从欢迎屏进入对话：iframe 采用惰性挂载，仅在首次唤起时开始加载 */
  const enterChat = () => setMode('chat');

  /** 重新加载智能体页面 */
  const reload = () => setIframeKey((k) => k + 1);

  /** 返回欢迎屏 */
  const backHome = () => {
    setMode('welcome');
    setSidebarOpen(false);
  };

  return (
    <div className="flex h-full min-h-screen flex-col bg-paper text-ink">
      {/* 头栏 */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-hairline bg-paper px-4 sm:px-6">
        <div className="flex items-center gap-3">
          {/* 品牌印：朱砂方章意象 */}
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-[4px] bg-vermilion font-serif-sc text-[15px] font-bold text-white select-none"
          >
            智
          </span>
          <div className="flex flex-col leading-none">
            <span className="font-serif-sc text-[15px] font-semibold tracking-wide">
              {PAGE.brandFull}
            </span>
            <span className="mt-1 text-[11px] text-ink-faint">{PAGE.subtitle}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {mode === 'chat' ? (
            <>
              <button
                type="button"
                onClick={backHome}
                className="rounded-lg border border-hairline px-3 py-1.5 text-[13px] text-ink-soft transition-colors duration-200 hover:border-vermilion hover:text-vermilion focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion"
              >
                返回首页
              </button>
              <button
                type="button"
                onClick={reload}
                className="rounded-lg bg-vermilion px-3 py-1.5 text-[13px] font-medium text-white transition-colors duration-200 hover:bg-vermilion-deep focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion"
              >
                重新加载
              </button>
            </>
          ) : (
            <span className="hidden text-[12px] text-ink-faint sm:inline">{PAGE.footer}</span>
          )}
        </div>
      </header>

      {/* 移动端能力面板开关 */}
      {mode === 'welcome' && (
        <button
          type="button"
          onClick={() => setSidebarOpen((v) => !v)}
          className="flex items-center justify-between border-b border-hairline px-4 py-2 text-[13px] text-ink-soft lg:hidden"
        >
          <span>能力速览</span>
          <span aria-hidden="true" className={sidebarOpen ? 'rotate-180 transition-transform' : 'transition-transform'}>
            ▾
          </span>
        </button>
      )}

      {/* 主体 */}
      <div className="flex min-h-0 flex-1">
        {/* 左侧能力栏（欢迎态显示） */}
        {mode === 'welcome' && (
          <aside
            className={`${
              sidebarOpen ? 'block' : 'hidden'
            } shrink-0 border-b border-hairline bg-paper-deep lg:block lg:w-72 lg:border-b-0 lg:border-r lg:border-hairline`}
          >
            <p className="px-5 pt-5 text-[11px] font-medium tracking-[0.14em] text-ink-faint uppercase">
              能力速览
            </p>
            <ul className="p-3 lg:p-3">
              {CAPABILITIES.map((cap) => (
                <li key={cap.key}>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveCap(cap.key);
                      if (sidebarOpen) setSidebarOpen(false);
                    }}
                    className={`w-full rounded-[10px] px-4 py-3 text-left transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion ${
                      activeCap === cap.key ? 'bg-paper' : 'hover:bg-paper'
                    }`}
                  >
                    <span
                      className={`flex items-baseline gap-2 text-[14px] font-medium ${
                        activeCap === cap.key ? 'text-vermilion' : 'text-ink'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          activeCap === cap.key ? 'bg-vermilion' : 'bg-ink-faint'
                        }`}
                      />
                      {cap.title}
                    </span>
                    <span className="mt-1.5 block pl-3.5 text-[12px] leading-relaxed text-ink-soft">
                      {cap.desc}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        )}

        {/* 主区 */}
        <main className="relative flex min-w-0 flex-1 flex-col">
          {mode === 'chat' ? (
            <>
              {/* 加载态：深墨底 + 淡墨提示 */}
              {!loaded && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-dark-ink">
                  <div
                    aria-hidden="true"
                    className="h-6 w-6 animate-spin rounded-full border-2 border-[#3a3f47] border-t-[#8a9099]"
                  />
                  <p className="text-[13px] tracking-[0.2em] text-ink-faint">{PAGE.loading}</p>
                  <p className="text-[11px] text-[#5a5f66]">{PAGE.loadingDesc}</p>
                </div>
              )}
              {/* 智能体 iframe：真实调用超星智能体（保留登录态与完整对话功能） */}
              <iframe
                key={iframeKey}
                src={frameSrc}
                title="超星智能体对话"
                className={`h-full w-full flex-1 transition-opacity duration-300 ${
                  loaded ? 'opacity-100' : 'opacity-0'
                }`}
                allow="clipboard-write; microphone; camera"
                referrerPolicy="no-referrer-when-downgrade"
                onLoad={() => setLoaded(true)}
              />
            </>
          ) : (
            /* 欢迎屏：排版式，无插画 */
            <section className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-6 py-10">
              <p className="mb-4 text-[12px] tracking-[0.2em] text-vermilion">{PAGE.brand}</p>
              <h1 className="font-serif-sc text-4xl leading-[1.3] font-semibold text-ink sm:text-[2.5rem]">
                {PAGE.welcomeTitle}
              </h1>
              <p className="mt-5 max-w-xl text-[15px] leading-8 text-ink-soft">
                {PAGE.welcomeDesc}
              </p>
              <div className="mt-9 flex flex-wrap items-center gap-4">
                <button
                  type="button"
                  onClick={enterChat}
                  className="rounded-lg bg-vermilion px-7 py-3 text-[15px] font-medium text-white transition-colors duration-200 hover:bg-vermilion-deep focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion"
                >
                  {PAGE.cta}
                </button>
                <span className="text-[12px] text-ink-faint">{PAGE.footer}</span>
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

let root: ReturnType<typeof createRoot> | null = null;

/** 首页渲染 */
export function renderHome() {
  const app = document.getElementById('app');

  if (!app) {
    throw new Error('App element not found');
  }

  if (!root) {
    root = createRoot(app);
  }

  root.render(<App />);
}
