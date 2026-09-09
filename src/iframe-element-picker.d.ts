/**
 * UMD 方式引入 iframe-element-picker 时的全局类型声明。
 * 通过 index.html 中的 <script> 标签加载，供 main.tsx 使用。
 */
export {};

declare global {
  interface Window {
    IframeElementPicker?: {
      child: {
        create: (options?: {
          debug?: boolean;
          computedStyleProps?: string[];
        }) => { init: () => unknown; destroy: () => void };
      };
    };
  }
}
