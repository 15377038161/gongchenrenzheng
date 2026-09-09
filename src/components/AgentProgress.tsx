import { useState } from 'react';

interface AgentProgressProps {
  thoughts: string[];
  active: string;
  streaming: boolean;
}

/**
 * 智能体进度组件：实时展示处理状态
 * - 流式中：逐条展示思考事件（薄荷绿圆点 + 最新事件呼吸）
 * - 完成后：折叠为"已完成 N 步思考"，可展开查看
 */
export function AgentProgress({ thoughts, active, streaming }: AgentProgressProps) {
  const [open, setOpen] = useState(false);

  if (thoughts.length === 0 && !active) return null;

  const expanded = streaming ? true : open;
  const label = streaming
    ? `正在思考${thoughts.length > 0 ? ` · 第 ${thoughts.length} 步` : ''}…`
    : `已完成 ${thoughts.length} 步思考`;

  return (
    <div className="mb-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-[12px] text-ink-faint transition-colors hover:text-lake-mid focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-deep"
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full ${streaming ? 'animate-pulse bg-mint-deep' : 'bg-mint'}`}
        />
        {label}
        {!streaming && (
          <span aria-hidden="true" className={`transition-transform ${expanded ? 'rotate-90' : ''}`}>
            ›
          </span>
        )}
      </button>

      {expanded && (thoughts.length > 0 || active) && (
        <ul className="mt-1.5 border-l border-hairline pl-4">
          {thoughts.map((t, i) => (
            <li key={i} className="py-0.5 text-[12px] leading-6 text-ink-faint">
              {t}
            </li>
          ))}
          {streaming && active && (
            <li className="flex items-center gap-1.5 py-0.5 text-[12px] leading-6 text-ink-soft">
              <span
                aria-hidden="true"
                className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-hairline border-t-lake-deep"
              />
              {active}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
