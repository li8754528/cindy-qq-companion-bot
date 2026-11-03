import { fault } from "./controller.mjs";
import { imageMetadata, downloadImages } from "./images.mjs";
const quietLogger = { info() {}, error() {}, warn() {}, debug() {} };
export class QQClientBridge {
  constructor(makeBot, notify, loadImages = downloadImages) { this.makeBot = makeBot; this.notify = notify; this.loadImages = loadImages; this.client = null; this.appId = ""; this.generation = 0; this.sent = new Map(); this.sending = new Map(); this.epoch = null; this.inboundImages = new Map(); this.imageTransfer = null; this.imageFlight = null; this.transferSequence = 0; }
  status(state, code = "") { this.connectionState = state; this.connectionCode = code; this.notify("qq/status", { state, ...(code ? { code } : {}), epoch: this.epoch }); }
  disconnect() { const old = this.client; this.client = null; this.appId = ""; this.generation++; this.inboundImages.clear(); this.imageTransfer = null; old?.stop(); this.status("idle"); return { disconnected: true }; }
  connect(params, secret) {
    this.disconnect();
    if (!/^\d{4,30}$/.test(params.appId) || typeof secret !== "string" || !secret) throw fault("QQ_SECRET_REQUIRED", "请在插件设置里保存 AppID 和 AppSecret。");
    const generation = this.generation;
    this.epoch = params.epoch;
    const bot = this.makeBot({ appId: params.appId, appSecret: secret, intents: 1 << 25, markdownSupport: false, logger: quietLogger, ...(params.sandbox ? { baseUrl: "https://sandbox.api.sgroup.qq.com" } : {}) });
    this.client = bot; this.appId = params.appId;
    const current = () => this.client === bot && generation === this.generation;
    bot.on("ready", () => { if (current()) this.status("connected"); });
    bot.on("resumed", () => { if (current()) this.status("connected"); });
    bot.on("disconnected", () => { if (current()) this.status("connecting", "QQ_RECONNECTING"); });
    bot.on("error", () => { if (current()) this.status("error", "QQ_CONNECTION_FAILED"); });
    bot.on("message", (_ctx, msg) => {
      if (!current() || msg.kind !== "group" || msg.rawEventType !== "GROUP_AT_MESSAGE_CREATE" || msg.senderIsBot) return;
      const hasAttachments = Array.isArray(msg.attachments) && msg.attachments.length > 0;
      let images = [], attachmentCode = "";
      if (hasAttachments) {
        try { images = imageMetadata(msg.attachments); } catch (error) { attachmentCode = error.code || "IMAGE_FORMAT_UNSUPPORTED"; }
      }
      if (images.length && [msg.messageId, msg.groupOpenid, msg.senderId].every(x => typeof x === "string" && x.length > 0 && x.length <= 160)) {
        const id = (params.botId && params.botId !== "bot1" ? params.botId + ":" : "") + params.appId + ":" + msg.messageId;
        if (!this.inboundImages.has(id)) this.inboundImages.set(id, { images, groupId: msg.groupOpenid, messageId: msg.messageId, at: Date.now() });
        if (this.inboundImages.size > 200) this.inboundImages.delete(this.inboundImages.keys().next().value);
      }
      this.notify("qq/message", { appId: params.appId, kind: "group", rawEventType: msg.rawEventType, senderIsBot: false, groupId: msg.groupOpenid, senderId: msg.senderId, messageId: msg.messageId, text: msg.content, hasAttachments, imageCount: images.length, attachmentCode });
    });
    this.status("connecting");
    Promise.resolve().then(() => { if (current()) return bot.start(); }).catch(() => { bot.stop(); if (current()) this.status("error", "QQ_CONNECTION_FAILED"); });
    return { connecting: true };
  }
  async prepareImages(params) {
    const source = this.inboundImages.get(params.requestId);
    if (!this.client || params.appId !== this.appId || !source || source.groupId !== params.groupId || source.messageId !== params.messageId || params.epoch !== this.epoch || Date.now() - source.at > 600000) throw fault("IMAGE_EXPIRED", "图片消息已过期或连接已更换，请在群里发新的图片提问。");
    if (this.imageTransfer) { if (this.imageTransfer.requestId === params.requestId) return this.imageDescriptor(); throw fault("IMAGE_BUSY", "正在处理另一条图片消息。"); }
    if (this.imageFlight) { if (this.imageFlight.requestId === params.requestId) return this.imageFlight.promise; throw fault("IMAGE_BUSY", "正在下载另一条图片消息。"); }
    const generation = this.generation, flight = { requestId: params.requestId };
    flight.promise = (async () => {
      const images = await this.loadImages(source.images);
      if (generation !== this.generation || !this.client) throw fault("IMAGE_EXPIRED", "连接已更换，请发送新的图片提问。");
      this.imageTransfer = { id: generation + ":" + (++this.transferSequence), requestId: params.requestId, images };
      return this.imageDescriptor();
    })();
    this.imageFlight = flight;
    try { return await flight.promise; } finally { if (this.imageFlight === flight) this.imageFlight = null; }
  }
  imageDescriptor() { const t = this.imageTransfer; return { transferId: t.id, images: t.images.map(i => ({ name: i.name, bytes: i.buffer.length })) }; }
  imageChunk(params) {
    const t = this.imageTransfer, i = t?.images[params.index];
    if (!t || t.id !== params.transferId || !i || !Number.isInteger(params.index) || !Number.isInteger(params.offset) || params.offset < 0 || params.offset >= i.buffer.length || params.offset % (192 * 1024) !== 0) throw fault("IMAGE_TRANSFER_INVALID", "图片传输参数无效或已失效。");
    const end = Math.min(params.offset + 192 * 1024, i.buffer.length);
    return { offset: params.offset, nextOffset: end, base64: i.buffer.subarray(params.offset, end).toString("base64"), done: end === i.buffer.length };
  }
  releaseImages(params) { if (this.imageTransfer?.id === params.transferId) { this.inboundImages.delete(this.imageTransfer.requestId); this.imageTransfer = null; } return { released: true }; }
  async reply(params) {
    if (!this.client || this.appId !== params.appId) throw fault("QQ_NOT_CONNECTED", "QQ 连接不可用。");
    if (![params.groupId, params.messageId, params.requestId].every(x => typeof x === "string" && x.length > 0 && x.length < 200) || typeof params.text !== "string" || !params.text || params.text.length > 1800) throw fault("INVALID_REPLY", "答复参数不正确。");
    const old = this.sent.get(params.requestId);
    if (old) { if (old.text !== params.text || old.groupId !== params.groupId || old.messageId !== params.messageId) throw fault("REPLY_CONFLICT", "同一请求已有不同答复。"); return old.result; }
    if (this.sending.has(params.requestId)) throw fault("QQ_SEND_UNCERTAIN", "同一答复正在发送或结果不确定。");
    const bot = this.client; const generation = this.generation; this.sending.set(params.requestId, true);
    try {
      const result = await bot.sendText({ scope: "group", targetId: params.groupId, msgId: params.messageId }, params.text);
      if (this.client !== bot || generation !== this.generation) throw fault("QQ_SEND_UNCERTAIN", "连接已更换，发送结果不确定。");
      const receipt = { sent: true, messageId: result?.id || "" }; this.sent.set(params.requestId, { ...params, result: receipt });
      if (this.sent.size > 200) this.sent.delete(this.sent.keys().next().value);
      return receipt;
    } catch { throw fault("QQ_SEND_UNCERTAIN", "QQ 未确认发送，请检查原群。"); }
    // Keep the in-flight tombstone on error: do not retry an uncertain write.
    finally { if (this.sent.has(params.requestId)) this.sending.delete(params.requestId); }
  }
}
