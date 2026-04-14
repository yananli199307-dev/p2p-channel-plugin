/**
 * p2p-portal Plugin - 入口文件
 */

import { p2pPortalPlugin, stopP2pPortalPlugin } from './api.js';

var p2p_portal_default = {
  id: "p2p-portal",
  name: "Agent P2P Portal",
  description: "作为 WebSocket 客户端连接 Portal，接收消息转交给 OpenClaw",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "p2pPortalPlugin"
  },
  runtime: {
    specifier: "./api.js",
    exportName: "stopP2pPortalPlugin"
  }
};

export { p2p_portal_default as default };