// ABOUTME: 智能体下发的 FORM 表单卡片 / MENU 菜单选项卡片交互组件
// ABOUTME: FORM 提交走 /api/chat/form（SUBMIT_FORM 协议），MENU 选择以普通文本重新发起对话
import { useEffect, useRef, useState } from 'react';
import type { RobotForm, RobotFormField, RobotMenu } from '../lib/robot-types';
import { fmtSize } from './fmt';

/** 表单单个字段是否为文件类型（fieldType 含 File） */
function isFileField(f: RobotFormField): boolean {
  return f.fieldType?.includes('File') || String(f.type ?? '').includes('File');
}

/** 表单文件字段的输入 */
function FormFileInput({
  field,
  value,
  onPick,
  disabled,
}: {
  field: RobotFormField;
  value: { name: string; size: number; objectId?: string } | null;
  onPick: (f: File | null) => void;
  disabled: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  return (
    <div>
      <button
        type="button"
        disabled={disabled || uploading}
        onClick={() => inputRef.current?.click()}
        className="flex w-full items-center justify-between gap-2 rounded-[10px] border border-dashed border-lake-soft px-3.5 py-2.5 text-left text-[13.5px] text-ink-soft transition-colors hover:border-lake-deep hover:text-lake-deep disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep"
      >
        <span className="truncate">{value ? value.name : field.placeholder || '选择文件上传'}</span>
        <span className="shrink-0 text-[12px] text-ink-faint">
          {uploading ? '上传中…' : value ? fmtSize(value.size) : '点击选择'}
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          e.target.value = '';
          if (f) {
            setUploading(true);
            onPick(f);
          }
        }}
        disabled={disabled}
      />
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
              disabled={busy || uploading}
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
 * 已回答过（answered）后只读展示。
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
    <div className="flex flex-col gap-2">
      {menu.question && <p className="text-[13.5px] text-ink-soft">{menu.question}</p>}
      <div className="flex flex-col gap-1.5 rounded-[14px] border border-hairline bg-white/70 p-2.5">
        {menu.items.map((item) => {
          const chosen = answered || picked === item.content;
          return (
            <button
              key={item.menuId || item.content}
              type="button"
              disabled={answered}
              onClick={() => {
                setPicked(item.content);
                onPick(item.content);
              }}
              className={`rounded-[10px] px-3.5 py-2 text-left text-[14px] transition-colors duration-150 disabled:cursor-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-lake-deep ${
                chosen
                  ? 'bg-lake-pale text-lake-deep font-medium'
                  : 'text-ink-soft hover:bg-lake-pale/70 hover:text-lake-deep'
              }`}
            >
              {chosen && <span aria-hidden="true" className="mr-1.5">✓</span>}
              {item.content}
            </button>
          );
        })}
      </div>
    </div>
  );
}
