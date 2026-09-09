// 智能体交互卡片（FORM 表单 / MENU 菜单）的前端类型定义
// 与服务端 server/robot/agent.ts 的协议类型保持结构一致（前端无法直接 import 服务端代码）

/** 表单字段 schema（FORM 消息解析结果，透传原始键） */
export interface RobotFormField {
  fieldType: string[];
  id: string;
  name: string;
  title?: string;
  placeholder?: string;
  description?: string;
  required?: boolean;
  type?: string;
  [key: string]: unknown;
}

/** FORM 下行消息（供前端渲染表单并提交） */
export interface RobotForm {
  messageId: string;
  schema: RobotFormField[];
}

/** MENU 下行消息（供前端渲染选项卡片） */
export interface RobotMenu {
  messageId: string;
  question: string;
  items: Array<{ menuId: string; content: string }>;
}

/** 表单提交字段值（schema 字段 + 用户填写值；透传其余原始键） */
export interface RobotFormFieldValue {
  name: string;
  value: string | string[];
  valueDetail?: Array<{ name: string; size: number }>;
  [key: string]: unknown;
}
