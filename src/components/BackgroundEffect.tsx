/**
 * 背景动效：水环境主题装饰层
 * - 两张 AI 生成的水彩背景（喻家湖水波 / 抽象水纹）低透明度叠加
 * - CSS 缓动：渐变层位移模拟水光流动，装饰圆斑缓浮
 * - prefers-reduced-motion 时静止
 */
export function BackgroundEffect() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {/* 底层：湖面水波（静态铺底） */}
      <div
        className="env-bg-layer absolute inset-0"
        style={{
          backgroundImage: 'url(/bg-lake.png)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          opacity: 0.1,
        }}
      />
      {/* 上层：抽象水纹（缓慢平移流动） */}
      <div
        className="env-bg-layer env-bg-flow absolute -inset-[10%]"
        style={{
          backgroundImage: 'url(/bg-water.png)',
          backgroundSize: 'cover',
          opacity: 0.08,
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
