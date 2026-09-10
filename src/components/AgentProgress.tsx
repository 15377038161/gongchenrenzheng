import { useState } from 'react';

interface AgentProgressProps {
  thoughts: string[];
  active: string;
  streaming: boolean;
}

/**
 * 智能体进度组件 — 横向步骤条（参照用户提供的进度条参考图）
 * - 三步串行：问题理解 → 知识召回 → 生成回答
 * - 已完成：淡绿圆形 + 深绿对勾
 * - 进行中：蓝色实心圆 + 白色步骤数字（呼吸动效）
 * - 未开始：白色描边空心圆 + 灰色数字
 * - 完成后整条折叠为一行摘要，可展开查看事件明细
 */
export function AgentProgress({ thoughts, active, streaming }: AgentProgressProps) {
  const [open, setOpen] = useState(false);

  if (thoughts.length === 0 && !active) return null;

  // 根据思考事件推断当前步骤
  const joined = [...thoughts, active].join('|');
  const done1 = /(问题理解|意图识别)/.test(joined) && /(问题理解完成|意图识别完成|语义流程完成)/.test(joined);
  const done2 = /(知识库召回完成|召回流程完成)/.test(joined);
  const done3 = !streaming;

  const steps = [
    { label: '问题理解', done: done1 },
    { label: '知识召回', done: done2 },
    { label: '生成回答', done: done3 },
  ];
  const current = streaming ? steps.findIndex((s) => !s.done) : -1;

  const label = streaming
    ? active || '智能体处理中…'
    : `已完成 ${thoughts.length} 步处理`;

  return (
    <div className="mb-3">
      {/* 横向步骤条 */}
      <div className="flex items-start">
        {steps.map((s, i) => (
          <div key={s.label} className="flex items-start">
            {/* 连接线（第一段前无） */}
            {i > 0 && (
              <span
                aria-hidden="true"
                className={`mx-1 mt-[13px] h-[2px] w-7 rounded-full sm:w-9 ${
                  s.done ? 'bg-gradient-to-r from-[#9fd6ae] to-lake-mid' : 'bg-hairline'
                }`}
              />
            )}
            <div className="flex w-16 flex-col items-center gap-1.5 sm:w-20">
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-full text-[14.5px] font-semibold transition-all duration-300 ${
                  s.done
                    ? 'bg-[#d3ecd9] text-[#2e7d46]'
                    : i === current
                      ? 'animate-[env-breath_2s_ease-in-out_infinite] bg-lake-deep text-white shadow-[0_0_0_4px_rgba(58,103,171,0.15)]'
                      : 'border border-hairline bg-white text-ink-faint'
                }`}
              >
                {s.done ? (
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="3">
                    <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  i + 1
                )}
              </span>
              <span
                className={`text-[13.5px] leading-4 transition-colors duration-300 ${
                  i === current && !s.done ? 'font-medium text-lake-deep' : 'text-ink-faint'
                }`}
              >
                {s.label}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* 当前状态行 + 展开明细 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mt-2.5 flex items-center gap-2 text-[15px] text-ink-soft transition-colors hover:text-lake-mid focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-deep"
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full ${streaming ? 'animate-pulse bg-lake-deep' : 'bg-mint-deep'}`}
        />
        <span className="truncate">{label}</span>
        {!streaming && thoughts.length > 0 && (
          <span aria-hidden="true" className={`shrink-0 text-[12px] transition-transform ${expanded(open, streaming) ? 'rotate-90' : ''}`}>
            ›
          </span>
        )}
      </button>

      {expanded(open, streaming) && thoughts.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 border-l-2 border-hairline pl-4">
          {thoughts.map((t, i) => (
            <li key={i} className="text-[15px] leading-6 text-ink-faint">
              {t}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function expanded(open: boolean, streaming: boolean): boolean {
  return streaming ? true : open;
}
