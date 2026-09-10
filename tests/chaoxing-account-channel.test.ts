import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildChaoxingAccountTaskflowUrl,
  requiresChaoxingAccountChannel,
} from '../shared/chaoxing-account-channel';

test('工程认证表单触发词统一走账号态通道', () => {
  for (const input of [
    '帮我编写工程认证',
    '请帮我撰写一份工程教育认证报告。',
    '写工程认证材料！',
    '帮我提炼文档内容',
    '请帮我总结一下这个工程认证材料。',
  ]) {
    assert.equal(requiresChaoxingAccountChannel(input), true, input);
  }
});

test('普通问答仍留在现有对话通道', () => {
  for (const input of ['你好', '工程认证需要哪些材料？', '什么是工程认证？']) {
    assert.equal(requiresChaoxingAccountChannel(input), false, input);
  }
});

test('带附件的请求统一走账号态通道', () => {
  assert.equal(requiresChaoxingAccountChannel('请处理这个文件', true), true);
});

test('账号态地址只指向固定的超星机构、智能体与任务流', () => {
  const url = new URL(buildChaoxingAccountTaskflowUrl());
  assert.equal(url.origin, 'https://robot.chaoxing.com');
  assert.equal(url.pathname, '/coze');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    unitId: '1731',
    robotId: '9a31c8e736704a0b9d57b35c73da681f',
    taskId: '181612',
    chatModel: 'APP',
  });
});
