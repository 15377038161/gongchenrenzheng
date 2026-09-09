import { useMemo } from 'react';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

/** 智能体消息的 Markdown 渲染（标题/加粗/列表/引用/代码/表格） */
export function MarkdownView({ content }: { content: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(content, { async: false }) as string;
    return raw;
  }, [content]);

  return (
    <div
      className="envchat-md"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
