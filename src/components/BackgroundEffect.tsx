/**
 * 背景动效：华科校园主题装饰层
 * - 主背景：AI 生成的华科校园水彩（校门 / 教学楼 / 山 / 湖水 / 树叶），透明度适中保证可辨识
 * - 上层：喻家湖水纹缓慢流动，增加生命感
 * - 装饰圆斑缓浮；底部水色渐变收边；prefers-reduced-motion 时静止
 */
export function BackgroundEffect() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {/* 底层：华科校园全景（校门/教学楼/山/湖水/树） */}
      <div
        className="env-bg-layer absolute inset-0"
        style={{
          backgroundImage: 'url(/bg-campus.png)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          opacity: 0.16,
        }}
      />
      {/* 上层：喻家湖水纹（缓慢平移流动） */}
      <div
        className="env-bg-layer env-bg-flow absolute -inset-[10%]"
        style={{
          backgroundImage: 'url(/bg-water.png)',
          backgroundSize: 'cover',
          opacity: 0.1,
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
