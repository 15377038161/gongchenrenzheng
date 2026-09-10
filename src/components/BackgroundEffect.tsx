/**
 * 背景动效系统：分层叠层（低干扰、可关闭）
 *
 * 结构（全部 pointer-events:none，位于聊天内容下方）：
 * - .water-overlay    右下水面：2 层细曲线水纹缓流 + 周期性扩散水波
 * - .wind-overlay     上缘：2 条极细气流线从右向左缓慢平移
 * - .leaf-drift-layer 全屏分布：36 片透明叶片缓慢飘落（横向覆盖整个画面，2026-09 密度提升 4 倍，透明度 0.28~0.38 适度加深提升辨识度）
 * - .mist-overlay     极淡雾气呼吸
 *
 * 动效纪律（验收要求）：
 * - 只动画 transform/opacity
 * - 动效开关（enabled=false）时隐藏全部动态层，仅保留静态背景图
 * - 交互状态（聚焦/滚动）经 data-dimmed 由 CSS 降低动态层透明度 40%
 */

/**
 * 飘叶配置：横向覆盖全屏（0~95vw 均匀错落），不同大小、透明度、时长与起点。
 * 密度 2026-09 适老化可见性优化：9 片 → 36 片（4 倍），任何屏幕区域均有持续落叶。
 * 生成方式确定性（无随机数）：以 3vw 步进网格 + 稳定抖动，保证每次渲染一致。
 */
const LEAF_KINDS = [
  { src: '/leaf-plane.png' },
  { src: '/leaf-maple.png' },
  { src: '/leaf-oval.png' },
] as const;

/** 基准特性池：尺寸变化 / 时长变化 / 透明度分级（2026-09 适度加深：0.18~0.26 → 0.28~0.38，辨识度提升且不遮挡聊天内容） */
const LEAF_SIZES = [34, 28, 24, 40, 32, 27, 38, 30, 25];
const LEAF_DURATIONS = [26, 29, 32, 24, 28, 31, 25, 27, 30];
const LEAF_OPACITIES = [0.36, 0.30, 0.28, 0.38, 0.32, 0.29, 0.34, 0.31, 0.28];

interface DriftLeaf {
  src: string;
  left: string;
  size: number;
  duration: number;
  delay: number;
  opacity: number;
  drift: 'leafDriftA' | 'leafDriftB';
}

/** 生成 36 片落叶：3 列×9 行网格，left 均匀铺满 0~95vw，delay 全周期错开避免同帧齐飞 */
function buildDriftLeaves(): DriftLeaf[] {
  const leaves: DriftLeaf[] = [];
  for (let i = 0; i < 36; i++) {
    const col = i % 3; // 同一 left 附近的第几片（0/1/2）
    const slot = Math.floor(i / 3); // 9 个横向槽位
    // 槽位基础 left + 列内偏移（±2vw），保持均匀但不机械
    const leftVw = 3 + slot * 10.5 + (col - 1) * 2;
    const left = `${Math.min(Math.max(leftVw, 0), 95).toFixed(1)}vw`;
    leaves.push({
      src: LEAF_KINDS[(slot + col) % 3].src,
      left,
      size: LEAF_SIZES[(i * 4) % 9],
      duration: LEAF_DURATIONS[(i * 4 + 3) % 9],
      // 0~29s 全周期错开（约等于最短时长 24s 的满周期）
      delay: (i * 8) % 30,
      opacity: LEAF_OPACITIES[(i * 4 + 5) % 9],
      // 轨迹随机性：A/B 关键帧交替（leafDriftA 左漂 +8°、leafDriftB 右漂 -8°），
      // 叠加横向槽位/尺寸/时长的确定性抖动，保持原有随机观感
      drift: (i % 2 === 0 ? 'leafDriftA' : 'leafDriftB'),
    });
  }
  return leaves;
}

const DRIFT_LEAVES = buildDriftLeaves();

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
