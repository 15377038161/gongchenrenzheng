/**
 * UMD 方式引入 iframe-error-sync 时的全局类型声明。
 * __errorBridge 在 index.html 中初始化，供 bind-error-sync.ts 使用。
 */
export {};

declare global {
  interface Window {
    __errorBridge?: {
      notifyHotUpdateStart?: () => void;
      notifyHotUpdateEnd?: () => void;
      reportError?: (partial?: {
        message?: string;
        level?: 'error' | 'warn' | 'fatal';
        stack?: string | null;
        meta?: object;
      }) => void;
    };
  }
}
