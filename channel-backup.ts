import type { ChannelPlugin, OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { WebSocket } from 'ws';
import https from 'https';

// 全局 runtime 存储
let pluginRuntime: PluginRuntime | null = null;

export function setP2pPortalRuntime(next: PluginRuntime): void {
  pluginRuntime = next;
}

export function getP2pPortalRuntime(): PluginRuntime {
  if (!pluginRuntime) {
    throw new Error("P2P Portal runtime not initialized");
  }
  return pluginRuntime;
}

export async function waitForP2pPortalRuntime(timeoutMs = 10000): Promise<PluginRuntime> {
  const start = Date.now();
  while (!pluginRuntime) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("P2P Portal runtime initialization timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return pluginRuntime;
}

// 插件配置类型
interface P2pPortalAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  hubUrl: string;
  apiKey: string;
}

// 运行时状态
interface P2pPortalRuntime {
  accountId: string;
  ws?: WebSocket;
  reconnectDelay: number;
  running: boolean;
  lastMessageAt?: number;
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

// 列出账户ID
function listAccountIds(cfg: OpenClawConfig): string[] {
  return ['default'];
}

// 解析账户
function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): P2pPortalAccount {
  return createAccount(cfg, accountId || 'default');
}

// 生成消息ID
function generateMessageSid(): string {
  return `p2p-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// 启动 WebSocket 连接
function startConnection(
  account: P2pPortalAccount,
  runtime: P2pPortalRuntime,
  channelRuntime: PluginRuntime["channel"],
  ctx: {
    log?: { info?: (msg: string) => void; error?: (msg: string) => void };
    setStatus?: (status: { accountId: string; running: boolean; lastEventAt?: number }) => void;
    abortSignal?: AbortSignal;
  }
): void {
  const wsUrl = account.hubUrl
    .replace('https://', 'wss://')
    .replace('http://', 'ws://') + 
    `/ws/agent?api_key=${account.apiKey}`;

  ctx.log?.info?.(`[${account.accountId}] connecting to ${wsUrl.substring(0, 60)}...`);

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
        await handleMessage(message, account, channelRuntime, ctx);
        ctx.setStatus?.({ accountId: account.accountId, running: true, lastEventAt: Date.now() });
      } catch (e) {
        ctx.log?.error?.(`[${account.accountId}] message parse error: ${e.message}`);
      }
    });

    ws.on('close', () => {
      ctx.log?.info?.(`[${account.accountId}] WebSocket closed`);
      runtime.ws = undefined;
      if (runtime.running) {
        scheduleReconnect(account, runtime, channelRuntime, ctx);
      }
    });

    ws.on('error', (error) => {
      ctx.log?.error?.(`[${account.accountId}] WebSocket error: ${error.message}`);
    });

    ctx.abortSignal?.addEventListener('abort', () => {
      runtime.running = false;
      ws.close();
    });

  } catch (error) {
    ctx.log?.error?.(`[${account.accountId}] connection failed: ${error.message}`);
    scheduleReconnect(account, runtime, channelRuntime, ctx);
  }
}

// 处理消息 - 使用 channelRuntime 发送
async function handleMessage(
  message: any,
  account: P2pPortalAccount,
  channelRuntime: PluginRuntime["channel"],
  ctx: { log?: { info?: (msg: string) => void } }
): Promise<void> {
  const msgType = message.type;
  ctx.log?.info?.(`[${account.accountId}] received: ${msgType}`);

  if (msgType === 'pong') return;
  if (msgType === 'ping') return;

  let body = '';
  let from = '';

  if (msgType === 'new_message') {
    const fromName = message.from_name || message.from || '未知';
    from = message.from || 'unknown';
    body = `[Agent P2P] 新消息来自 ${fromName}: ${message.content || ''}`;
  } else if (msgType === 'owner_message') {
    from = 'owner';
    body = `[主人消息] ${message.content || ''}`;
  } else if (msgType === 'new_guest_message') {
    from = 'guest';
    body = `[Agent P2P] 新留言: ${message.content || ''}`;
  } else if (msgType === 'sync_response') {
    const messages = message.messages || [];
    for (const msg of messages) {
      await handleMessage({ type: 'new_message', ...msg }, account, channelRuntime, ctx);
    }
    return;
  } else {
    return;
  }

  if (body) {
    ctx.log?.info?.(`[${account.accountId}] dispatching: ${body.substring(0, 50)}...`);
    
    // 使用 channelRuntime 发送消息
    try {
      await channelRuntime.inbound.dispatchDirectDm({
        accountId: account.accountId,
        channel: "p2p-portal",
        body,
        from,
        to: "owner",
        messageId: generateMessageSid(),
      });
    } catch (error) {
      ctx.log?.info?.(`[${account.accountId}] dispatch error: ${error.message}`);
    }
  }
}

// 定时重连
function scheduleReconnect(
  account: P2pPortalAccount,
  runtime: P2pPortalRuntime,
  channelRuntime: PluginRuntime["channel"],
  ctx: { log?: { info?: (msg: string) => void }; setStatus?: (status: { accountId: string; running: boolean }) => void }
): void {
  ctx.log?.info?.(`[${account.accountId}] reconnecting in ${runtime.reconnectDelay / 1000}s...`);
  setTimeout(() => {
    if (runtime.running && !runtime.ws) {
      startConnection(account, runtime, channelRuntime, ctx);
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
      properties: {},
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
    listAccountIds,
    resolveAccount,
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
      } catch (error) {
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
      
      const account = ctx.account;
      const runtime: P2pPortalRuntime = {
        accountId: account.accountId,
        reconnectDelay: 5000,
        running: true,
      };

      ctx.setStatus?.({ accountId: account.accountId, running: true, lastEventAt: Date.now() });
      ctx.log?.info?.(`[${account.accountId}] starting P2P Portal connection`);

      // 等待 runtime 初始化
      const channelRuntime = ctx.channelRuntime || (await waitForP2pPortalRuntime()).channel;
      
      startConnection(account, runtime, channelRuntime, {
        log: ctx.log,
        setStatus: ctx.setStatus,
        abortSignal: ctx.abortSignal,
      });
    },
  },
};
