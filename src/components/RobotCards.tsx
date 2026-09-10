// ABOUTME: 智能体下发的 FORM 表单卡片 / MENU 菜单选项卡片交互组件
// ABOUTME: FORM 提交走 /api/chat/form（SUBMIT_FORM 协议），MENU 选择以普通文本重新发起对话
import { useEffect, useRef, useState } from 'react';
import type { RobotForm, RobotFormField, RobotMenu } from '../lib/robot-types';
import { fmtSize } from './fmt';

/** 表单单个字段是否为文件类型（fieldType 含 File） */
function isFileField(f: RobotFormField): boolean {
  return f.fieldType?.includes('File') || String(f.type ?? '').includes('File');
}

/** 表单文件字段的输入（点击选择 + 拖拽上传，上传中带可视状态） */
function FormFileInput({
  field,
  value,
  onPick,
  disabled,
  uploading,
}: {
  field: RobotFormField;
  value: { name: string; size: number; objectId?: string } | null;
  onPick: (f: File | null) => void;
  disabled: boolean;
  /** 父级上传中（提交按钮联动） */
  uploading: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  // 上传完成状态：done（✓ 已就绪）/ failed（上传失败）
  const [status, setStatus] = useState<'idle' | 'done' | 'failed'>('idle');

  const acceptFile = (f: File | null): void => {
    if (!f) return;
    setStatus('idle');
    onPick(f);
  };

  // value 变化时同步状态（父级上传成功写入 value → done；objectId 清空时复位）
  useEffect(() => {
    if (value?.objectId) setStatus('done');
    else setStatus((prev) => (prev === 'done' ? 'idle' : prev));
  }, [value?.objectId]);

  const busy = disabled || uploading;

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!busy) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (busy) return;
        const f = e.dataTransfer.files?.[0] ?? null;
        acceptFile(f);
      }}
    >
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className={`flex w-full items-center gap-2.5 rounded-[10px] border border-dashed px-3.5 py-2.5 text-left text-[13.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep ${
          dragOver
            ? 'border-lake-deep bg-lake-pale text-lake-deep'
            : status === 'done'
              ? 'border-lake-soft text-ink'
              : 'border-lake-soft text-ink-soft hover:border-lake-deep hover:text-lake-deep'
        }`}
      >
        {/* 状态图标：上传中 spinner / 完成 ✓ / 默认回形针 */}
        <span
          aria-hidden="true"
          className={`flex h-6 w-6 shrink-0 items-center justify-center text-[13px] ${
            status === 'done' ? 'text-lake-deep' : 'text-ink-faint'
          }`}
        >
          {status === 'done' ? (
            '✓'
          ) : (
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
            </svg>
          )}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {value ? value.name : field.placeholder || '点击选择或拖拽文件到此处'}
        </span>
        <span className="shrink-0 text-[12px] text-ink-faint">
          {status === 'done' && value ? fmtSize(value.size) : '选择 / 拖拽'}
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          e.target.value = '';
          acceptFile(f);
        }}
        disabled={busy}
      />
      {/* 拖拽提示条：拖入时可见 */}
      <div
        aria-hidden="true"
        className={`overflow-hidden text-[11.5px] leading-5 text-lake-deep transition-all duration-200 ${
          dragOver ? 'mt-1 max-h-5 opacity-100' : 'max-h-0 opacity-0'
        }`}
      >
        松开鼠标即可上传「{field.title || field.name}」
      </div>
    </div>
  );
}

/**
 * 智能体表单卡片：
 * 按消息内嵌 schema 渲染字段（文本输入 / 文件上传），
 * 提交时把字段值数组（含文件 objectId）交给 onSubmit 回调。
 * 文件选择后立即上传（upload 回调返回 objectId），提交按钮等待全部上传完成。
 */
export function FormCard({
  form,
  submitted,
  uploading,
  onSubmit,
  onUploadFile,
}: {
  form: RobotForm;
  submitted: boolean;
  uploading: boolean;
  onSubmit: (fields: Array<Record<string, unknown>>) => Promise<void>;
  onUploadFile: (field: RobotFormField, file: File) => Promise<{ name: string; size: number; objectId: string } | null>;
}) {
  // 字段值：文本字段为 string，文件字段为已上传文件信息
  const [textValues, setTextValues] = useState<Record<string, string>>({});
  const [fileValues, setFileValues] = useState<Record<string, { name: string; size: number; objectId: string } | null>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (): Promise<void> => {
    // 校验必填
    for (const f of form.schema) {
      if (isFileField(f)) {
        if (f.required && !fileValues[f.name]) {
          setErr(`「${f.title || f.name}」为必填项，请上传文件`);
          return;
        }
      } else if (f.required && !(textValues[f.name] ?? '').trim()) {
        setErr(`「${f.title || f.name}」为必填项`);
        return;
      }
    }
    // 构造提交字段：schema 原始键 + 用户值（文件字段 value = [objectId]）
    const fields: Array<Record<string, unknown>> = form.schema.map((f) => {
      const out: Record<string, unknown> = { ...f };
      if (isFileField(f)) {
        const fv = fileValues[f.name];
        if (fv) {
          out.value = [fv.objectId];
          out.valueDetail = [{ name: fv.name, size: fv.size }];
        } else {
          out.value = [];
        }
      } else {
        out.value = (textValues[f.name] ?? '').trim();
      }
      return out;
    });
    setErr('');
    setBusy(true);
    try {
      await onSubmit(fields);
    } catch {
      setErr('提交失败，请重试');
      setBusy(false);
    }
  };

  if (submitted) {
    return (
      <div className="rounded-[14px] border border-hairline bg-white/70 px-4 py-3 text-[13.5px] text-ink-faint">
        表单已提交，请查看智能体回复。
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-[14px] border border-hairline bg-white px-4 py-4 shadow-sm">
      <p className="text-[13px] font-medium text-ink-soft">请填写以下信息</p>
      {form.schema.map((f) => (
        <div key={f.id} className="flex flex-col gap-1.5">
          <label htmlFor={`ff-${f.id}`} className="text-[13.5px] font-medium text-ink">
            {f.title || f.name}
            {f.required && <span className="ml-1 text-[#c05640]">*</span>}
          </label>
          {f.description ? (
            <p className="text-[11.5px] leading-5 text-ink-faint">{f.description}</p>
          ) : null}
          {isFileField(f) ? (
            <FormFileInput
              field={f}
              value={fileValues[f.name] ?? null}
              disabled={busy}
              uploading={uploading}
              onPick={(file) => {
                if (!file) return;
                setErr('');
                void (async () => {
                  const info = await onUploadFile(f, file);
                  if (info) {
                    setFileValues((prev) => ({ ...prev, [f.name]: info }));
                  } else {
                    setErr(`${file.name} 上传失败，请重试`);
                  }
                })();
              }}
            />
          ) : (
            <input
              id={`ff-${f.id}`}
              type="text"
              value={textValues[f.name] ?? ''}
              placeholder={f.placeholder || ''}
              disabled={busy}
              onChange={(e) => setTextValues((prev) => ({ ...prev, [f.name]: e.target.value }))}
              className="rounded-[10px] border border-hairline bg-white px-3.5 py-2.5 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-lake-deep focus:shadow-[0_0_0_3px_rgba(58,103,171,0.1)] disabled:opacity-60"
            />
          )}
        </div>
      ))}
      {err && <p className="text-[12.5px] text-[#c05640]">{err}</p>}
      <button
        type="button"
        disabled={busy || uploading}
        onClick={() => void submit()}
        className="mt-1 self-start rounded-[10px] bg-lake-deep px-5 py-2 text-[14px] font-medium text-white transition-colors duration-200 hover:bg-[#2f5689] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-deep"
      >
        {busy ? '提交中…' : uploading ? '文件上传中…' : '提交表单'}
      </button>
    </div>
  );
}

/**
 * 智能体菜单选项卡片：点击选项即以该文本作为普通消息重新发送（实测有效协议）。
 * 视觉对照官网单选交互：卡片化选项 + 左侧单选圆点，选中项湖蓝描边高亮；
 * 已回答过（answered）后只读展示：选中项保留高亮与「已选择」标记，其余降为中性只读。
 */
export function MenuCard({ menu, answered, onPick }: {
  menu: RobotMenu;
  answered: boolean;
  onPick: (text: string) => void;
}) {
  // answered 切回 false 时（重新提问新菜单消息）重置本地选择态
  const [picked, setPicked] = useState('');
  useEffect(() => {
    if (!answered) setPicked('');
  }, [answered, menu.messageId]);
  return (
    <div className="flex flex-col gap-2.5">
      {menu.question && <p className="text-[13.5px] font-medium text-ink-soft">{menu.question}</p>}
      <div className="flex flex-col gap-2">
        {menu.items.map((item) => {
          const chosen = picked === item.content;
          return (
            <button
              key={item.menuId || item.content}
              type="button"
              disabled={answered}
              aria-pressed={chosen}
              onClick={() => {
                setPicked(item.content);
                onPick(item.content);
              }}
              className={`group flex w-full items-center gap-3 rounded-[12px] border px-4 py-[11px] text-left text-[14.5px] transition-all duration-200 disabled:cursor-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lake-deep ${
                chosen
                  ? 'border-lake-deep border-[1.5px] bg-lake-pale font-medium text-ink shadow-[0_1px_4px_rgba(58,103,171,0.14)]'
                  : answered
                    ? 'border-hairline bg-white/60 text-ink-faint'
                    : 'border-hairline bg-white text-ink-soft hover:-translate-y-[1px] hover:border-lake-soft hover:text-ink hover:shadow-[0_2px_8px_rgba(58,103,171,0.10)]'
              }`}
            >
              {/* 单选圆点：选中时湖蓝实心 + 白芯；hover 变湖蓝描边 */}
              <span
                aria-hidden="true"
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-200 ${
                  chosen
                    ? 'border-lake-deep bg-lake-deep'
                    : answered
                      ? 'border-hairline bg-transparent'
                      : 'border-ink-faint/40 bg-white group-hover:border-lake-deep'
                }`}
              >
                {chosen && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
              </span>
              <span className="min-w-0 flex-1 break-words leading-6">{item.content}</span>
              {chosen && (
                <span className="shrink-0 text-[12.5px] font-medium text-lake-deep" aria-hidden="true">
                  ✓ 已选择
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
