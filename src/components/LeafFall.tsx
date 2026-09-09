/**
 * 树叶飘落动效：全页装饰层
 * - 意象：喻家山梧桐叶影，秋日暖阳里缓缓飘落
 * - 实现：纯 CSS 合成层动画（仅 transform/opacity），9 片叶子分层错落
 * - 每片叶子由「下落 + 摆荡 + 自转」组合运动，风感自然
 * - prefers-reduced-motion 时静止隐藏
 */

interface LeafConfig {
  /** 水平起始位置（vw 百分比） */
  left: number;
  /** 叶片大小（px） */
  size: number;
  /** 单次下落全程时长（s），越大越慢 */
  fallDuration: number;
  /** 摆荡周期（s） */
  swayDuration: number;
  /** 自转周期（s） */
  spinDuration: number;
  /** 动画起始延迟（s，负值直接进入动画中段避免集体同时出发） */
  delay: number;
  /** 透明度（远小近大，营造层次） */
  opacity: number;
  /** 叶色（梧桐/枫叶暖色系 + 少量湖畔绿叶） */
  color: string;
  /** 叶形（3 种 SVG 路径之一） */
  shape: 'plane' | 'maple' | 'ellipse';
}

/** 9 片叶子：错落布局，色调取自水彩背景的暖叶 + 青绿体系 */
const LEAVES: LeafConfig[] = [
  { left: 4,  size: 26, fallDuration: 17, swayDuration: 5.5, spinDuration: 9,  delay: -2,  opacity: 0.5,  color: '#C8A24C', shape: 'plane' },
  { left: 12, size: 18, fallDuration: 22, swayDuration: 6.5, spinDuration: 12, delay: -9,  opacity: 0.38, color: '#A8C58A', shape: 'ellipse' },
  { left: 22, size: 22, fallDuration: 19, swayDuration: 5,   spinDuration: 10, delay: -14, opacity: 0.45, color: '#D4B25E', shape: 'maple' },
  { left: 33, size: 15, fallDuration: 25, swayDuration: 7,   spinDuration: 13, delay: -5,  opacity: 0.32, color: '#9FBF8C', shape: 'ellipse' },
  { left: 47, size: 24, fallDuration: 18, swayDuration: 5.8, spinDuration: 11, delay: -11, opacity: 0.48, color: '#CBA85A', shape: 'plane' },
  { left: 58, size: 17, fallDuration: 23, swayDuration: 6.2, spinDuration: 12, delay: -17, opacity: 0.36, color: '#B2CD96', shape: 'maple' },
  { left: 70, size: 21, fallDuration: 20, swayDuration: 5.2, spinDuration: 9.5, delay: -3,  opacity: 0.44, color: '#C9A24C', shape: 'plane' },
  { left: 82, size: 19, fallDuration: 16, swayDuration: 4.8, spinDuration: 8,  delay: -8,  opacity: 0.42, color: '#D3B262', shape: 'ellipse' },
  { left: 92, size: 23, fallDuration: 21, swayDuration: 6,   spinDuration: 10, delay: -13, opacity: 0.46, color: '#A9C68B', shape: 'plane' },
];

/** 三种叶形 SVG path（viewBox 0 0 24 24，叶柄朝上便于旋转观感自然） */
const LEAF_PATHS: Record<LeafConfig['shape'], string> = {
  /** 梧桐阔叶：尖头宽掌 */
  plane: 'M12 2 C9 7 5 9 5 14 C5 19 8 22 12 22 C16 22 19 19 19 14 C19 9 15 7 12 2 Z M12 22 L12 6',
  /** 枫叶感：多裂掌形 */
  maple: 'M12 2 L10 7 L5 5 L7 11 L2 13 L8 16 L6 22 L12 18 L18 22 L16 16 L22 13 L17 11 L19 5 L14 7 Z',
  /** 简洁椭圆叶 */
  ellipse: 'M12 2 C16 6 19 12 19 15 C19 20 15 22 12 22 C9 22 5 20 5 15 C5 12 8 6 12 2 Z M12 22 L12 8',
};

function Leaf({ cfg }: { cfg: LeafConfig }) {
  const style: React.CSSProperties = {
    left: `${cfg.left}%`,
    opacity: cfg.opacity,
    // 传递给 leaf-fall 关键帧使用（动画会覆盖 opacity，故经变量注入）
    ['--leaf-opacity' as string]: cfg.opacity,
    animationDuration: `${cfg.fallDuration}s, ${cfg.swayDuration}s, ${cfg.spinDuration}s`,
    animationDelay: `${cfg.delay}s, ${cfg.delay}s, ${cfg.delay}s`,
  };
  return (
    <div className="env-leaf" style={style}>
      <svg
        width={cfg.size}
        height={cfg.size}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <path
          d={LEAF_PATHS[cfg.shape]}
          fill={cfg.color}
          fillOpacity={0.75}
          stroke={cfg.color}
          strokeWidth={1}
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

export function LeafFall() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {LEAVES.map((cfg, i) => (
        <Leaf key={i} cfg={cfg} />
      ))}
    </div>
  );
}
