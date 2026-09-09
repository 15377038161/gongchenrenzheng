/**
 * 背景动效系统：分层叠层（低干扰、可关闭）
 *
 * 结构（全部 pointer-events:none，位于聊天内容下方）：
 * - .water-overlay    右下水面：2 层细曲线水纹缓流 + 周期性扩散水波
 * - .wind-overlay     上缘：2 条极细气流线从右向左缓慢平移
 * - .branch-overlay   右上：真实透明枝叶素材以枝干连接点为原点轻摆
 * - .leaf-drift-layer 边缘路径：3 片透明叶片缓慢飘落（不同时长/延迟）
 * - .mist-overlay     极淡雾气呼吸
 *
 * 动效纪律（验收要求）：
 * - 只动画 transform/opacity；中央安全区（聊天主容器所在）无任何动态元素
 * - 动效开关（bgFxOn=false）时隐藏全部动态层，仅保留静态背景图
 * - 交互状态（聚焦/滚动/生成中）经 CSS 类由父级降低整体透明度 40%
 */

/** 飘叶配置：不同大小、透明度、时长与起点；路径沿页面外缘，不进入中央安全区 */
const DRIFT_LEAVES = [
  {
    src: '/leaf-plane.png',
    left: '82vw', // 右侧外缘下行
    size: 46,
    duration: 24,
    delay: 3,
    opacity: 0.34,
    drift: 'leafDriftA',
  },
  {
    src: '/leaf-oval.png',
    left: '6vw', // 左侧外缘下行
    size: 34,
    duration: 28,
    delay: 11,
    opacity: 0.26,
    drift: 'leafDriftB',
  },
  {
    src: '/leaf-plane.png',
    left: '70vw', // 中右外缘（避开 max-w-3xl 主容器）
    size: 40,
    duration: 20,
    delay: 17,
    opacity: 0.3,
    drift: 'leafDriftA',
  },
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

          {/* 枝叶层：右上真实素材，枝干连接点（右缘中部）为摆动原点 */}
          <div className="branch-overlay">
            <img src="/branch-leaf.png" alt="" className="branch-img" draggable={false} />
          </div>

          {/* 飘叶层：3 片透明叶片沿外缘缓慢飘落 */}
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
