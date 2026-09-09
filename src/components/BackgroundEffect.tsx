/**
 * 背景动效：华科校园主题装饰层
 * - 主背景：用户选定水彩（临湖建筑/青山/湖面/飘叶），低饱和浅调，中等不透明度保证可辨
 * - 装饰圆斑缓浮；底部水色渐变收边；prefers-reduced-motion 时静止
 * - 树叶飘落动效见 LeafFall 组件
 */
export function BackgroundEffect() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {/* 底层：水彩校园全景（临湖建筑/青山/湖面） */}
      <div
        className="env-bg-layer absolute inset-0"
        style={{
          backgroundImage: 'url(/bg-campus.png)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          opacity: 0.42,
        }}
      />
      {/* 装饰圆斑：气泡与水珠意象，分层缓浮 */}
      <div className="env-bubble env-bubble-1 absolute rounded-full bg-lake-mist" />
      <div className="env-bubble env-bubble-2 absolute rounded-full bg-mint" />
      <div className="env-bubble env-bubble-3 absolute rounded-full bg-lake-soft" />
      {/* 底部水色渐变过渡 */}
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-lake-pale/70 to-transparent" />
    </div>
  );
}
