export const CHAOXING_AGENT_ACCOUNT_URL = 'https://robot.chaoxing.com/coze';
export const CHAOXING_UNIT_ID = '1731';
export const CHAOXING_ROBOT_ID = '9a31c8e736704a0b9d57b35c73da681f';
export const ENGINEERING_CERTIFICATION_TASK_ID = '181612';

const ENGINEERING_CERTIFICATION_PATTERN =
  /^(?:帮我|请帮我|麻烦)?(?:撰写|编写|写|做)(?:一份)?工程(?:教育)?认证(?:报告|材料|自评报告)?$/;
const DOCUMENT_EXTRACTION_PATTERN =
  /^(?:帮我|请帮我|麻烦)?(?:提炼|提取|读取|分析|总结)(?:一下)?(?:这个|该)?(?:工程认证)?(?:文档|文件|材料)(?:内容)?$/;

/** FORM 任务流的账号路由元数据；实际请求由本页面服务端透传账号 Cookie。 */
export function requiresChaoxingAccountChannel(question: string, hasAttachments = false): boolean {
  if (hasAttachments) return true;
  const normalized = question.trim().replace(/[\s\u3000]+/g, '').replace(/[!?！？。，,]+$/g, '');
  return ENGINEERING_CERTIFICATION_PATTERN.test(normalized) || DOCUMENT_EXTRACTION_PATTERN.test(normalized);
}

/** 超星任务流入口元数据（仅用于排查/联调，不由前端跳转）。 */
export function buildChaoxingAccountTaskflowUrl(): string {
  const url = new URL(CHAOXING_AGENT_ACCOUNT_URL);
  url.searchParams.set('unitId', CHAOXING_UNIT_ID);
  url.searchParams.set('robotId', CHAOXING_ROBOT_ID);
  url.searchParams.set('taskId', ENGINEERING_CERTIFICATION_TASK_ID);
  url.searchParams.set('chatModel', 'APP');
  return url.toString();
}
