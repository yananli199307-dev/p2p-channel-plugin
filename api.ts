/**
 * p2p-portal Plugin
 * 作为 WebSocket 客户端连接 Portal，接收消息转交给 OpenClaw
 */

import { WebSocket } from 'ws';
import https from 'https';
import http from 'http';

// 插件配置
let config = {
  hubUrl: 'https://agentportalp2p.com',
  apiKey: '',
  gatewayUrl: 'http://127.0.0.1:18789',
};

// WebSocket 连接
let ws = null;
let reconnectDelay = 5000;
let maxReconnectDelay = 60000;
let running = true;

/**
 * 初始化插件
 */
export async function p2pPortalPlugin(api) {
  api.logger?.info('p2p-portal 插件初始化');
  
  // 从配置中获取参数
  config = {
    hubUrl: api.config?.hubUrl || config.hubUrl,
    apiKey: api.config?.apiKey || config.apiKey,
    gatewayUrl: api.config?.gatewayUrl || config.gatewayUrl,
  };
  
  if (!config.apiKey) {
    api.logger?.error('p2p-portal: API Key 未配置');
    return;
  }
  
  // 启动 WebSocket 连接
  startConnection(api);
}

/**
 * 启动 WebSocket 连接
 */
function startConnection(api) {
  const wsUrl = config.hubUrl
    .replace('https://', 'wss://')
    .replace('http://', 'ws://') + 
    `/ws/agent?api_key=${config.apiKey}`;
  
  api.logger?.info(`p2p-portal: 连接 Portal: ${wsUrl.substring(0, 60)}...`);
  
  // 创建 SSL 上下文
  const isHttps = wsUrl.startsWith('wss://');
  const agent = isHttps ? new https.Agent({ rejectUnauthorized: false }) : undefined;
  
  try {
    ws = new WebSocket(wsUrl, {
      agent,
    });
    
    ws.on('open', () => {
      api.logger?.info('p2p-portal: WebSocket 连接成功');
      reconnectDelay = 5000;
      
      // 发送同步请求
      ws.send(JSON.stringify({ type: 'sync_request' }));
    });
    
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await handleMessage(message, api);
      } catch (e) {
        api.logger?.error(`p2p-portal: 消息解析错误: ${e.message}`);
      }
    });
    
    ws.on('close', () => {
      api.logger?.info('p2p-portal: WebSocket 连接断开');
      ws = null;
      if (running) {
        scheduleReconnect(api);
      }
    });
    
    ws.on('error', (error) => {
      api.logger?.error(`p2p-portal: WebSocket 错误: ${error.message}`);
    });
    
  } catch (error) {
    api.logger?.error(`p2p-portal: 连接失败: ${error.message}`);
    scheduleReconnect(api);
  }
}

/**
 * 处理收到的消息
 */
async function handleMessage(message, api) {
  const msgType = message.type;
  
  api.logger?.info(`p2p-portal: 收到消息: ${msgType}`);
  
  if (msgType === 'pong') {
    return;
  }
  
  // 处理 Portal 的 ping
  if (msgType === 'ping') {
    ws?.send(JSON.stringify({ type: 'pong' }));
    return;
  }
  
  // 构建通知
  let notification = null;
  let text = '';
  
  if (msgType === 'new_message') {
    const from = message.from || '';
    const fromName = message.from_name || from;
    const content = message.content || '';
    
    text = `[Agent P2P] 新消息来自 ${fromName}: ${content}`;
    notification = {
      type: 'message',
      sender: from,
      sender_name: fromName,
      content: content,
      message_id: message.id,
    };
  } else if (msgType === 'owner_message') {
    text = `[主人消息] ${message.content || ''}`;
    notification = {
      type: 'owner_message',
      content: message.content || '',
      message_id: message.message_id,
    };
  } else if (msgType === 'new_guest_message') {
    text = `[Agent P2P] 新留言: ${message.content || ''}`;
    notification = {
      type: 'guest_message',
      content: message.content || '',
      message_id: message.id,
    };
  } else if (msgType === 'file_transfer') {
    text = `[Agent P2P] 文件传输: ${message.content || ''}`;
    notification = {
      type: 'file_transfer',
      content: message.content || '',
    };
  } else if (msgType === 'sync_response') {
    // 处理离线消息同步
    const messages = message.messages || [];
    if (messages.length > 0) {
      api.logger?.info(`p2p-portal: 同步 ${messages.length} 条离线消息`);
      for (const msg of messages) {
        await handleMessage({
          type: 'new_message',
          from: msg.from,
          from_name: msg.from_name,
          content: msg.content,
          id: msg.id,
        }, api);
      }
      // 发送 ack
      ws?.send(JSON.stringify({
        type: 'ack',
        message_ids: messages.map(m => m.id),
      }));
    }
    return;
  }
  
  // 如果有通知，发送到 OpenClaw
  if (notification) {
    await forwardToOpenClaw(text, notification, api);
    
    // 发送确认
    if (message.id) {
      ws?.send(JSON.stringify({
        type: 'ack',
        message_ids: [message.id],
      }));
    }
  }
}

/**
 * 转发消息到 OpenClaw
 */
async function forwardToOpenClaw(text, notification, api) {
  try {
    const url = `${config.gatewayUrl}/api/chat`;
    
    const payload = {
      message: text,
      metadata: notification,
    };
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    
    if (response.ok) {
      api.logger?.info('p2p-portal: 消息已转发到 OpenClaw');
    } else {
      api.logger?.error(`p2p-portal: 转发失败: ${response.status}`);
    }
  } catch (error) {
    api.logger?.error(`p2p-portal: 转发异常: ${error.message}`);
  }
}

/**
 * 定时重连
 */
function scheduleReconnect(api) {
  api.logger?.info(`p2p-portal: ${reconnectDelay/1000}秒后重连...`);
  setTimeout(() => {
    if (running && !ws) {
      startConnection(api);
    }
    reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
  }, reconnectDelay);
}

/**
 * 停止插件
 */
export function stopP2pPortalPlugin(api) {
  running = false;
  if (ws) {
    ws.close();
    ws = null;
  }
  api.logger?.info('p2p-portal: 插件已停止');
}