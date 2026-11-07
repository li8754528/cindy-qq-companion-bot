import { QQClientBridge } from "./qq-client.mjs";
import { BOT_IDS, connectMethod, secretKey } from "./config.mjs";
import { fault } from "./controller.mjs";
export class QQBotFleet {
  constructor(makeBot, notify, loadImages) { this.bridges = new Map(BOT_IDS.map(id => [id, new QQClientBridge(makeBot, (method, params) => notify(method, { ...params, botId: id }), loadImages)])); }
  async request(method, params = {}, secrets = {}) {
    const connectId = BOT_IDS.find(id => connectMethod(id) === method);
    const id = connectId || params.botId || "bot1", b = this.bridges.get(id);
    if (!b || (connectId && params.botId && params.botId !== connectId)) throw fault("BOT_CONFIG_INVALID", "机器人编号无效。");
    if (connectId) {
      if ([...this.bridges.entries()].some(([other, client]) => other !== id && client.appId && client.appId === params.appId)) throw fault("BOT_APP_DUPLICATE", "同一机器人已连接。");
      return b.connect(params, secrets[secretKey(id)]);
    }
    if (method === "qq/disconnect") return b.disconnect();
    if (method === "qq/reply") return b.reply(params);
    if (method === 'qq/final-active') return b.finalActive(params);
    if (method === "qq/send-group") return b.sendGroup(params);
    if (method === "qq/images") return b.prepareImages(params);
    if (method === "qq/image-chunk") return b.imageChunk(params);
    if (method === "qq/images-release") return b.releaseImages(params);
    if (method === "qq/status") return { connected: b.client !== null, appId: b.appId, ...(params.health ? { state: b.connectionState || "idle", code: b.connectionCode || "", epoch: b.epoch } : {}) };
    throw fault("METHOD_NOT_FOUND", "不支持的方法。");
  }
  disconnect() { for (const b of this.bridges.values()) b.disconnect(); }
}
