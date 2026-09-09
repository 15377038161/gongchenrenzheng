/**
 * 背景动效系统：分层叠层（低干扰、可关闭）
 *
 * 结构（全部 pointer-events:none，位于聊天内容下方）：
 * - .water-overlay    右下水面：2 层细曲线水纹缓流 + 周期性扩散水波
 * - .wind-overlay     上缘：2 条极细气流线从右向左缓慢平移
 * - .leaf-drift-layer 全屏分布：9 片透明叶片缓慢飘落（横向覆盖整个画面）
 * - .mist-overlay     极淡雾气呼吸
 *
 * 动效纪律（验收要求）：
 * - 只动画 transform/opacity
 * - 动效开关（enabled=false）时隐藏全部动态层，仅保留静态背景图
 * - 交互状态（聚焦/滚动）经 data-dimmed 由 CSS 降低动态层透明度 40%
 */

/** 飘叶配置：横向覆盖全屏（0~95vw 均匀错落），不同大小、透明度、时长与起点 */
const DRIFT_LEAVES = [
  { src: '/leaf-plane.png', left: '3vw',  size: 34, duration: 26, delay: 0,  opacity: 0.24, drift: 'leafDriftB' },
  { src: '/leaf-maple.png', left: '14vw', size: 28, duration: 29, delay: 18, opacity: 0.20, drift: 'leafDriftA' },
  { src: '/leaf-oval.png',  left: '25vw', size: 24, duration: 32, delay: 7,  opacity: 0.18, drift: 'leafDriftB' },
  { src: '/leaf-plane.png', left: '36vw', size: 40, duration: 24, delay: 22, opacity: 0.26, drift: 'leafDriftA' },
  { src: '/leaf-maple.png', left: '47vw', size: 32, duration: 28, delay: 4,  opacity: 0.22, drift: 'leafDriftB' },
  { src: '/leaf-oval.png',  left: '58vw', size: 27, duration: 31, delay: 15, opacity: 0.19, drift: 'leafDriftA' },
  { src: '/leaf-plane.png', left: '69vw', size: 38, duration: 25, delay: 10, opacity: 0.25, drift: 'leafDriftB' },
  { src: '/leaf-maple.png', left: '80vw', size: 30, duration: 27, delay: 25, opacity: 0.21, drift: 'leafDriftA' },
  { src: '/leaf-oval.png',  left: '91vw', size: 25, duration: 30, delay: 13, opacity: 0.18, drift: 'leafDriftB' },
] as const;

/** 扩散水波：右下水面，周期 11s，单次 5s 消散 */
const RIPPLES = [
  { left: '76%', top: '74%', size: 190, delay: 0 },
  { left: '86%', top: '82%', size: 130, delay: 5.5 },
] as const;

interface BgFxProps {
  /** 背景动效总开关（侧栏控制，localStorage 持久化） */
  enabled: boolean;
  /** 交互降感：输入聚焦/滚动长文时父级降低动态层透明度 40% */
  dimmed: boolean;
}

export function BackgroundEffect({ enabled, dimmed }: BgFxProps) {
  return (
    <div
      aria-hidden="true"
      data-bg-fx={enabled ? 'on' : 'off'}
      data-dimmed={dimmed ? '1' : '0'}
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
    >
      {/* 静态层：水彩校园背景（任何状态下保留） */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: 'url(/bg-campus.png)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          opacity: 0.42,
        }}
      />

      {/* ===== 以下为动态叠层：开关关闭时整体隐藏 ===== */}
      {enabled && (
        <>
          {/* 水纹层：右下水面细曲线缓流 */}
          <div className="water-overlay">
            <div className="water-line water-line-a" />
            <div className="water-line water-line-b" />
            {RIPPLES.map((r, i) => (
              <div
                key={i}
                className="water-ripple"
                style={{
                  left: r.left,
                  top: r.top,
                  width: r.size,
                  height: r.size,
                  animationDelay: `${r.delay}s`,
                }}
              />
            ))}
          </div>

          {/* 气流线层：上缘空白，从右向左极缓平移 */}
          <div className="wind-overlay">
            <div className="wind-line wind-line-a" />
            <div className="wind-line wind-line-b" />
          </div>

          {/* 飘叶层：全屏分布缓慢飘落（聊天内容层在其上方，卡片为浅白底不遮挡阅读） */}
          <div className="leaf-drift-layer">
            {DRIFT_LEAVES.map((cfg, i) => (
              <img
                key={i}
                src={cfg.src}
                alt=""
                draggable={false}
                className="drift-leaf"
                style={{
                  left: cfg.left,
                  width: cfg.size,
                  // 传给 leafDrift 关键帧使用（动画 opacity 会覆盖 inline opacity）
                  ['--leaf-o' as string]: cfg.opacity,
                  animationName: cfg.drift,
                  animationDuration: `${cfg.duration}s`,
                  animationDelay: `${cfg.delay}s`,
                }}
              />
            ))}
          </div>

          {/* 雾气层：大范围极淡径向渐变缓慢呼吸 */}
          <div className="mist-overlay">
            <div className="mist-blob mist-blob-a" />
            <div className="mist-blob mist-blob-b" />
          </div>
        </>
      )}
    </div>
  );
}
