// ABOUTME: 超星智能体（robot.chaoxing.com）对话代理
// ABOUTME: 协议基于对该站点前端逆向调研，真实调用其访客会话 + WebSocket 对话链路

const UNIT_ID = '1731';
const ROBOT_ID = '9a31c8e736704a0b9d57b35c73da681f';
const ROBOT_ORIGIN = 'https://robot.chaoxing.com';

/** 访客会话信息（来自 visitor/apply） */
export interface RobotSession {
  visitorId: string;
  visitorVc: string;
  conversationId: string;
}

/** 供前端展示的下行事件 */
export type RobotEvent =
  | { type: 'thought'; description: string }
  | { type: 'delta'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; message: string };

/** 超星 WS 原始消息的宽松类型 */
interface RobotWsMessage {
  type?: string;
  agent_event?: { event?: string };
  meta?: { description?: string };
  answer?: string;
  answerType?: string;
  systemMsg?: boolean;
  sseStop?: boolean;
  [key: string]: unknown;
}

/** 向超星发送的 DATA 消息体 */
interface OutgoingMessage {
  msgTimeId: number;
  time: number;
  direction: string;
  messageType: string;
  communicateType: string;
  lang: string;
  msg: {
    channel: string;
    question: string;
    visibleQuestion: string;
    questionType: string;
    fileInfo: unknown[];
  };
  ackStatus: string;
  robot: {
    type: string;
    scene: number;
    extend: string;
    subject: string;
    spage: number;
  };
  dxNumber: string;
  d: string;
}

/** 申请匿名访客会话 */
export async function applySession(): Promise<RobotSession> {
  const url =
    `${ROBOT_ORIGIN}/v1/front/chat/visitor/apply?visitorId=&unitId=${UNIT_ID}` +
    `&channel=WEB&robotId=${ROBOT_ID}&referUrl=&vc=&d=&vc3=&uid=&scene=&isLLMPlanning=0`;
  const res = await fetch(url, {
    headers: { Referer: `${ROBOT_ORIGIN}/coze`, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`申请会话失败：HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    code?: number;
    visitorId?: string;
    visitorVc?: string;
    cvsInfo?: { conversationId?: string };
  };
  if (data.code !== 1 || !data.visitorId || !data.visitorVc || !data.cvsInfo?.conversationId) {
    throw new Error('申请会话失败：返回数据不完整');
  }
  return {
    visitorId: data.visitorId,
    visitorVc: data.visitorVc,
    conversationId: data.cvsInfo.conversationId,
  };
}

/**
 * 与智能体建立一次对话：连接 WS、发送问题、把下行消息转换为事件流。
 * onEvent 收到 'final' 或 'error' 后结束。
 */
export function chatOnce(
  session: RobotSession,
  question: string,
  onEvent: (event: RobotEvent) => void
): { close: () => void } {
  const wsUrl =
    `${ROBOT_ORIGIN.replace('https', 'wss')}/v1/ws/chat/${UNIT_ID}/visitor` +
    `?userId=${session.visitorId}&channel=WEB&conversationId=${session.conversationId}` +
    `&robotId=${ROBOT_ID}&visitorVc=${session.visitorVc}&scene=&lang=zh&isLLMPlanning=0`;

  let settled = false;
  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    onEvent({ type: 'error', message: err instanceof Error ? err.message : '连接智能体失败' });
    return { close: () => undefined };
  }

  const finish = (event: RobotEvent) => {
    if (settled) return;
    settled = true;
    onEvent(event);
    try { ws.close(); } catch { /* 忽略关闭异常 */ }
  };

  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'KEEPALIVE' }));
    }
  }, 25000);

  const cleanup = () => clearInterval(heartbeat);

  ws.onopen = () => {
    const now = Date.now();
    const outgoing: OutgoingMessage = {
      msgTimeId: now,
      time: now,
      direction: 'IN',
      messageType: 'TEXT',
      communicateType: 'DATA',
      lang: 'zh',
      msg: {
        channel: 'WEB',
        question,
        visibleQuestion: question,
        questionType: 'TEXT',
        fileInfo: [],
      },
      ackStatus: 'SENDING',
      robot: { type: '', scene: -1, extend: '', subject: '', spage: 1 },
      dxNumber: '',
      d: '',
    };
    ws.send(JSON.stringify(outgoing));
  };

  ws.onerror = () => {
    cleanup();
    finish({ type: 'error', message: '与智能体的连接出现错误，请稍后重试' });
  };

  ws.onclose = () => {
    cleanup();
    if (!settled) {
      finish({ type: 'error', message: '智能体连接已断开，请重新提问' });
    }
  };

  ws.onmessage = (ev: MessageEvent) => {
    let data: RobotWsMessage;
    try {
      data = JSON.parse(String(ev.data)) as RobotWsMessage;
    } catch {
      return;
    }

    // 思考过程事件（语义理解 / 知识召回等）
    if (data.type === 'SEMANTIC' || data.type === 'LLM') {
      const desc = data.meta?.description;
      if (desc && data.agent_event?.event !== 'FINAL_FINISH') {
        onEvent({ type: 'thought', description: desc });
      }
      return;
    }

    // 系统元消息（意图分类回显等）：仅当内含真实答案 responseText 时才放行
    if (data.systemMsg === true) {
      let isRealAnswer = false;
      if (typeof data.answer === 'string' && data.answer.length > 0) {
        try {
          const inner = JSON.parse(data.answer) as { responseText?: string };
          isRealAnswer = typeof inner.responseText === 'string' && inner.responseText.length > 0;
        } catch {
          isRealAnswer = false;
        }
      }
      if (!isRealAnswer) {
        // 仍需监听结束信号
        if (data.sseStop === true) {
          finish({ type: 'final', text: '' });
        }
        return;
      }
    }

    // 答案类消息：answer 可能是纯文本或内嵌 JSON
    if (typeof data.answer === 'string' && data.answer.length > 0) {
      let text = data.answer;
      let flagStop = false;
      try {
        const inner = JSON.parse(data.answer) as {
          responseText?: string;
          message?: string;
          flag?: string;
          [key: string]: unknown;
        };
        // 控制帧（flag/metadata 类）：既非正文也非提示，直接按结束/忽略处理
        if (inner.flag !== undefined) {
          if (inner.flag === 'stop') flagStop = true;
          text = '';
        } else if (inner.responseText !== undefined) {
          text = inner.responseText;
        } else if (inner.message !== undefined) {
          // 加载提示（"正在生成中"）：不展示，等待真实分片
          text = '';
        }
      } catch {
        // 纯文本，直接使用
      }

      if (text) {
        onEvent({ type: 'delta', text });
      }
      if (flagStop || data.sseStop === true) {
        finish({ type: 'final', text: '' });
      }
      return;
    }

    // sseStop 兜底
    if (data.sseStop === true) {
      finish({ type: 'final', text: '' });
    }
  };

  return {
    close: () => {
      cleanup();
      try { ws.close(); } catch { /* 忽略关闭异常 */ }
    },
  };
}
