import { useMemo } from 'react';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

/** 列表项是否为"纯选项"行（短文本、无内联格式），适合渲染为卡片 */
function isPlainOptionLine(text: string): boolean {
  const plain = text.replace(/[*_`~]/g, '');
  return plain.length > 0 && plain.length <= 30 && !/[。：:；;！!？?]/.test(plain);
}

interface MarkdownViewProps {
  content: string;
  /** 选项卡片的点击回调（点选后作为下一条消息发送） */
  onOptionClick?: (text: string) => void;
}

/**
 * 智能体消息的 Markdown 渲染
 * - 常规元素：标题/加粗/列表/引用/代码/表格
 * - 选项卡片化：连续的短列表项合并渲染为可点击卡片组（参照用户参考图的单选卡片样式）
 */
export function MarkdownView({ content, onOptionClick }: MarkdownViewProps) {
  const html = useMemo(() => {
    const raw = marked.parse(content, { async: false }) as string;

    // 后处理：把"全短项列表块"（<ul>/<ol>）转换为选项卡片容器
    return raw.replace(
      /<(ul|ol)>([\s\S]*?)<\/\1>/g,
      (block, tag: string, inner: string) => {
        const items = [...inner.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
        if (items.length === 0) return block;
        // 至少 2 项且全部为短选项 → 卡片化；否则保持原生列表
        if (items.length < 2 || !items.every((it) => isPlainOptionLine(it))) return block;
        const ordered = tag === 'ol';
        const cards = items
          .map((it) => {
            const plain = it.replace(/<[^>]+>/g, '').trim();
            const label = ordered ? `${items.indexOf(it) + 1}` : '';
            return (
              `<button type="button" class="md-option" data-option="${escapeAttr(plain)}">` +
              `<span class="md-option-dot" aria-hidden="true"></span>` +
              (ordered ? `<span class="md-option-idx">${label}</span>` : '') +
              `<span class="md-option-label">${escapeHtml(plain)}</span>` +
              `</button>`
            );
          })
          .join('');
        return `<div class="md-option-group">${cards}</div>`;
      }
    );
  }, [content]);

  return (
    <div
      className="envchat-md"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const target = (e.target as HTMLElement).closest('.md-option') as HTMLButtonElement | null;
        if (target?.dataset.option && onOptionClick) {
          onOptionClick(target.dataset.option);
        }
      }}
    />
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
