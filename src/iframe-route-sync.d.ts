/**
 * UMD 方式引入 iframe-route-sync 时的全局类型声明。
 * 对应 index.html 中的 IframeRouteSync 全局变量。
 */
export {};

declare global {
  interface Window {
    IframeRouteSync?: {
      child: {
        create: (options?: { debug?: boolean }) => {
          init: () => unknown;
          notify: () => void;
          destroy: () => void;
        };
      };
      toRoutePath: (href: string) => string;
    };
  }
}
