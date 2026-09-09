import { createRoot } from 'react-dom/client';

function App() {
  return (
    <div className="flex h-full items-center justify-center bg-background text-foreground transition-colors duration-300 dark:bg-background dark:text-foreground overflow-hidden min-h-screen">
      <main className="flex w-full h-full max-w-3xl flex-col items-center justify-center px-16 py-32 sm:items-center">
        <div className="flex flex-col items-center justify-between gap-4">
          <img
            src="/coder-coding.gif"
            alt="Coder 编程 Logo"
            width={156}
            height={130}
            style={{ width: 156, height: 130, objectFit: 'contain' }}
          />
          <div>
            <div className="flex flex-col items-center gap-2 text-center sm:items-center sm:text-center">
              <h1 className="max-w-xl text-base font-semibold leading-tight tracking-tight text-foreground dark:text-foreground">
                应用开发中
              </h1>
              <p className="max-w-2xl text-sm-14 leading-8 text-muted-foreground dark:text-muted-foreground">
                请稍后，页面即将呈现
              </p>
            </div>
          </div>
        </div>
      </main>
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