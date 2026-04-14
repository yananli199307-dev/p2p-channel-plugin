import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { p2pPortalPlugin, setP2pPortalRuntime } from "./channel.js";

const plugin = {
  id: "p2p-portal",
  name: "Agent P2P Portal",
  description: "WebSocket connection to P2P Portal for agent-to-agent messaging",
  register(api: OpenClawPluginApi) {
    api.logger?.info("[p2p-portal] registering channel plugin");
    
    // 保存 runtime 供后续使用
    if (api.runtime) {
      setP2pPortalRuntime(api.runtime);
    }
    
    api.registerChannel({ plugin: p2pPortalPlugin });
  },
};

export default plugin;
