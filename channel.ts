import type { ChannelPlugin, OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { WebSocket } from 'ws';
import https from 'https';

// 全局 runtime 存储（类似微信插件）
let pluginRuntime: PluginRuntime | null = null;
let runtimeWaiters: Array<(runtime: PluginRuntime) => void> = [];

export function setP2pPortalRuntime(runtime: PluginRuntime): void {
  pluginRuntime = runtime;
  // 唤醒等待的 waiter
  while (runtimeWaiters.length > 0) {
    const waiter = runtimeWaiters.shift();
    waiter?.(runtime);
  }
}

export function getP2pPortalRuntime(): PluginRuntime {
  if (!pluginRuntime) {
    throw new Error("[p2p-portal] runtime not initialized");
  }
  return pluginRuntime;
}

export async function waitForP2pPortalRuntime(timeoutMs = 10000): Promise<PluginRuntime> {
  if (pluginRuntime) {
    return pluginRuntime;
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("[p2p-portal] runtime initialization timeout"));
    }, timeoutMs);
    
    runtimeWaiters.push((runtime) => {
      clearTimeout(timer);
      resolve(runtime);
    });
  });
}

// 账户类型
interface P2pPortalAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  hubUrl: string;
  apiKey: string;
}

// 运行时状态
interface P2pPortalRuntime {
  ws?: WebSocket;
  reconnectDelay: number;
  running: boolean;
}

// 创建账户
function createAccount(cfg: OpenClawConfig, accountId: string): P2pPortalAccount {
  const channelConfig = cfg.channels?.['p2p-portal'] || {};
  return {
    accountId,
    enabled: channelConfig.enabled ?? true,
    configured: Boolean(channelConfig.apiKey),
    hubUrl: channelConfig.hubUrl || 'https://agentportalp2p.com',
    apiKey: channelConfig.apiKey || '',
  };
}

// 生成消息ID
function generateMessageSid(): string {
  return `p2p-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// 启动 WebSocket 连接
function startConnection(
  account: P2pPortalAccount,
  runtime: P2pPortalRuntime,
  channelRuntime: any,
  ctx: {
    log?: { info?: (msg: string) => void; error?: (msg: string) => void };
    setStatus?: (status: { accountId: string; running: boolean; lastEventAt?: number }) => void;
    abortSignal?: AbortSignal;
    cfg?: OpenClawConfig;
  }
): void {
  const wsUrl = account.hubUrl
    .replace('https://', 'wss://')
    .replace('http://', 'ws://') + 
    `/ws/agent?api_key=${account.apiKey}`;

  ctx.log?.info?.(`[${account.accountId}] connecting to Portal...`);

  const isHttps = wsUrl.startsWith('wss://');
  const agent = isHttps ? new https.Agent({ rejectUnauthorized: false }) : undefined;

  try {
    const ws = new WebSocket(wsUrl, { agent });
    runtime.ws = ws;

    ws.on('open', () => {
      ctx.log?.info?.(`[${account.accountId}] WebSocket connected`);
      runtime.reconnectDelay = 5000;
      ws.send(JSON.stringify({ type: 'sync_request' }));
      ctx.setStatus?.({ accountId: account.accountId, running: true, lastEventAt: Date.now() });
    });

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        ctx.log?.info?.(`[${account.accountId}] received: ${message.type}`);
        
        // 使用传入的 channelRuntime
        if (!channelRuntime) {
          ctx.log?.error?.(`[${account.accountId}] channelRuntime not available`);
          return;
        }
        await handleMessage(message, account, channelRuntime, {
          log: ctx.log,
          cfg: ctx.cfg,
        });
        ctx.setStatus?.({ accountId: account.accountId, running: true, lastEventAt: Date.now() });
      } catch (e: any) {
        ctx.log?.error?.(`[${account.accountId}] message parse error: ${e.message}`);
      }
    });

    ws.on('close', () => {
      ctx.log?.info?.(`[${account.accountId}] WebSocket closed`);
      runtime.ws = undefined;
      if (runtime.running) {
        scheduleReconnect(account, runtime, ctx);
      }
    });

    ws.on('error', (error: any) => {
      ctx.log?.error?.(`[${account.accountId}] WebSocket error: ${error.message}`);
    });

    ctx.abortSignal?.addEventListener('abort', () => {
      runtime.running = false;
      ws.close();
    });

  } catch (error: any) {
    ctx.log?.error?.(`[${account.accountId}] connection failed: ${error.message}`);
    scheduleReconnect(account, runtime, ctx);
  }
}

// 处理消息 - 使用 ChannelPlugin 方式
async function handleMessage(
  message: any,
  account: P2pPortalAccount,
  channelRuntime: any,
  ctx: { log?: { info?: (msg: string) => void; error?: (msg: string) => void }, cfg?: OpenClawConfig }
): Promise<void> {
  const msgType = message.type;

  if (msgType === 'pong' || msgType === 'ping') return;

  let body = '';
  let from = '';
  let fromName = '';

  if (msgType === 'new_message') {
    fromName = message.from_name || message.from || '未知';
    from = message.from || 'unknown';
    body = message.content || '';
  } else if (msgType === 'owner_message') {
    from = 'owner';
    fromName = '主人';
    body = message.content || '';
  } else if (msgType === 'new_guest_message') {
    from = 'guest';
    fromName = '访客';
    body = message.content || '';
  } else if (msgType === 'sync_response') {
    const messages = message.messages || [];
    for (const msg of messages) {
      await handleMessage({ type: 'new_message', ...msg }, account, channelRuntime, {
        log: ctx.log,
        cfg: ctx.cfg,
      });
    }
    return;
  } else {
    return;
  }

  if (!body || !channelRuntime) {
    ctx.log?.error?.(`[${account.accountId}] missing body or channelRuntime`);
    return;
  }

  ctx.log?.info?.(`[${account.accountId}] processing: ${body.substring(0, 50)}...`);

  try {
    // 1. 解析路由
    const route = channelRuntime.routing.resolveAgentRoute({
      cfg: ctx.cfg,
      channel: 'p2p-portal',
      accountId: account.accountId,
      peer: { id: from, displayName: fromName },
    });

    if (!route.agentId) {
      ctx.log?.error?.(`[${account.accountId}] no agent resolved for peer=${from}`);
      return;
    }

    ctx.log?.info?.(`[${account.accountId}] route: agent=${route.agentId}, session=${route.sessionKey}`);

    // 2. 构建 MsgContext
    const msgContext: any = {
      Body: body,
      From: from,
      To: 'owner',
      AccountId: account.accountId,
      OriginatingChannel: 'p2p-portal',
      Provider: 'p2p-portal',
      ChatType: 'direct',
      MessageSid: generateMessageSid(),
      Timestamp: Date.now(),
    };

    // 关键：设置 SessionKey 让 dispatchReplyFromConfig 使用正确的 session
    msgContext.SessionKey = route.sessionKey;

    // 3. 完成入站上下文
    const finalized = channelRuntime.reply.finalizeInboundContext(msgContext);

    // 4. 解析 storePath
    const storePath = channelRuntime.session.resolveStorePath(ctx.cfg?.session?.store, {
      agentId: route.agentId,
    });

    // 5. 记录入站会话
    await channelRuntime.session.recordInboundSession({
      storePath,
      sessionKey: route.sessionKey,
      ctx: finalized,
      updateLastRoute: {
        sessionKey: route.mainSessionKey,
        channel: 'p2p-portal',
        to: from,
        accountId: account.accountId,
      },
      onRecordError: (err: any) => ctx.log?.error?.(`recordInboundSession: ${err}`),
    });

    ctx.log?.info?.(`[${account.accountId}] message recorded, dispatching reply...`);

    // 6. 触发 AI 回复
    await channelRuntime.reply.dispatchReplyFromConfig({
      ctx: finalized,
      cfg: ctx.cfg,
      dispatcher: {
        deliver: async (payload: any) => {
          ctx.log?.info?.(`[${account.accountId}] delivering reply: ${payload.text?.substring(0, 50)}...`);
          // 发送回复到 Portal
          try {
            const response = await fetch(`${account.hubUrl}/api/chat/owner/reply`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: payload.text }),
            });
            if (!response.ok) {
              ctx.log?.error?.(`[${account.accountId}] deliver failed: ${response.status}`);
            }
          } catch (err: any) {
            ctx.log?.error?.(`[${account.accountId}] deliver error: ${err.message}`);
          }
        },
      },
    });

    ctx.log?.info?.(`[${account.accountId}] reply dispatched`);

  } catch (err: any) {
    ctx.log?.error?.(`[${account.accountId}] process error: ${err.message}`);
  }
}

// 定时重连
function scheduleReconnect(
  account: P2pPortalAccount,
  runtime: P2pPortalRuntime,
  ctx: { log?: { info?: (msg: string) => void }; setStatus?: (status: { accountId: string; running: boolean }) => void }
): void {
  ctx.log?.info?.(`[${account.accountId}] reconnecting in ${runtime.reconnectDelay / 1000}s...`);
  setTimeout(() => {
    if (runtime.running && !runtime.ws) {
      startConnection(account, runtime, ctx);
    }
    runtime.reconnectDelay = Math.min(runtime.reconnectDelay * 2, 60000);
  }, runtime.reconnectDelay);
}

// Channel Plugin 定义
export const p2pPortalPlugin: ChannelPlugin<P2pPortalAccount, P2pPortalRuntime> = {
  id: "p2p-portal",
  meta: {
    id: "p2p-portal",
    label: "Agent P2P Portal",
    selectionLabel: "Agent P2P Portal",
    docsPath: "/channels/p2p-portal",
    docsLabel: "Agent P2P Portal",
    blurb: "WebSocket connection to P2P Portal for agent-to-agent messaging.",
    order: 100,
  },
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        apiKey: { type: "string" },
        hubUrl: { type: "string", format: "uri" },
      },
    },
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
  },
  messaging: {
    targetResolver: {
      looksLikeId: (raw) => raw.startsWith("https://") || raw.startsWith("http://"),
    },
  },
  reload: { configPrefixes: ["channels.p2p-portal"] },
  config: {
    listAccountIds: () => ['default'],
    resolveAccount: (cfg, accountId) => createAccount(cfg, accountId || 'default'),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: "P2P Portal",
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async (ctx) => {
      const account = ctx.account as P2pPortalAccount;
      const text = ctx.text;
      
      ctx.log?.info?.(`[${ctx.accountId}] sendText: ${text.substring(0, 50)}...`);
      
      try {
        const response = await fetch(`${account.hubUrl}/api/chat/owner/reply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text }),
        });
        
        if (response.ok) {
          const result = await response.json();
          return { channel: "p2p-portal", messageId: result.message_id || `msg-${Date.now()}` };
        } else {
          throw new Error(`Failed to send: ${response.status}`);
        }
      } catch (error: any) {
        ctx.log?.error?.(`[${ctx.accountId}] send error: ${error.message}`);
        throw error;
      }
    },
  },
  status: {
    defaultRuntime: {
      accountId: "",
      reconnectDelay: 5000,
      running: true,
    },
    collectStatusIssues: () => [],
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      lastError: null,
      lastInboundAt: snapshot.lastEventAt ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      ...runtime,
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      if (!ctx) return;
      
      const account = createAccount(ctx.cfg, ctx.accountId);
      const runtime: P2pPortalRuntime = {
        accountId: account.accountId,
        reconnectDelay: 5000,
        running: true,
      };

      ctx.setStatus?.({ accountId: account.accountId, running: true, lastEventAt: Date.now() });
      ctx.log?.info?.(`[${account.accountId}] starting P2P Portal connection`);
      
      // 等待 runtime 初始化（从 register() 中设置）
      let channelRuntime: any = null;
      try {
        const pluginRuntime = await waitForP2pPortalRuntime();
        // 等待 channel 属性可用
        let attempts = 0;
        while (!pluginRuntime.channel && attempts < 10) {
          await new Promise(r => setTimeout(r, 100));
          attempts++;
        }
        channelRuntime = pluginRuntime.channel;
        ctx.log?.info?.(`[${account.accountId}] runtime acquired, channel: ${typeof channelRuntime}`);
      } catch (err: any) {
        ctx.log?.error?.(`[${account.accountId}] runtime wait failed: ${err.message}`);
      }
      
      startConnection(account, runtime, channelRuntime, {
        log: ctx.log,
        setStatus: ctx.setStatus,
        abortSignal: ctx.abortSignal,
        cfg: ctx.cfg,
      });
    },
  },
};
