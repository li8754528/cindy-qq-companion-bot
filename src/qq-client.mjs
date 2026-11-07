import { fault } from "./controller.mjs";
import { imageMetadata, downloadImages } from "./images.mjs";
import { rejectedMessage } from './delivery-policy.mjs';
import { createHash } from 'node:crypto';
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
    this.sandbox = params.sandbox === true;
    this.botId = params.botId || 'bot1';
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
        const id = JSON.stringify([params.appId,msg.groupOpenid,msg.messageId]);
        const requestId='qq:'+createHash('sha256').update(JSON.stringify([this.botId,params.appId,this.sandbox,msg.groupOpenid,msg.messageId])).digest('hex');
        if (!this.inboundImages.has(id)) this.inboundImages.set(id, { images, requestId, groupId: msg.groupOpenid, messageId: msg.messageId, at: Date.now() });
        if (this.inboundImages.size > 200) this.inboundImages.delete(this.inboundImages.keys().next().value);
      }
      this.notify("qq/message", { appId: params.appId, kind: "group", rawEventType: msg.rawEventType, senderIsBot: false, groupId: msg.groupOpenid, senderId: msg.senderId, messageId: msg.messageId, timestamp: msg.timestamp, msgIdx: typeof msg.msgIdx === 'string' && msg.msgIdx.trim() && msg.msgIdx.length <= 256 ? msg.msgIdx : undefined, text: msg.content, hasAttachments, imageCount: images.length, attachmentCode });
    });
    this.status("connecting");
    Promise.resolve().then(() => { if (current()) return bot.start(); }).catch(() => { bot.stop(); if (current()) this.status("error", "QQ_CONNECTION_FAILED"); });
    return { connecting: true };
  }
  async prepareImages(params) {
    const cacheKey=JSON.stringify([params.appId,params.groupId,params.messageId]);
    const source = this.inboundImages.get(cacheKey);
    if (!this.client || params.appId !== this.appId || !source || source.requestId !== params.requestId || source.groupId !== params.groupId || source.messageId !== params.messageId || params.epoch !== this.epoch || Date.now() - source.at > 600000) throw fault("IMAGE_EXPIRED", "图片消息已过期或连接已更换，请在群里发新的图片提问。");
    if (this.imageTransfer) { if (this.imageTransfer.requestId === params.requestId) return this.imageDescriptor(); throw fault("IMAGE_BUSY", "正在处理另一条图片消息。"); }
    if (this.imageFlight) { if (this.imageFlight.requestId === params.requestId) return this.imageFlight.promise; throw fault("IMAGE_BUSY", "正在下载另一条图片消息。"); }
    const generation = this.generation, flight = { requestId: params.requestId };
    flight.promise = (async () => {
      const images = await this.loadImages(source.images);
      if (generation !== this.generation || !this.client) throw fault("IMAGE_EXPIRED", "连接已更换，请发送新的图片提问。");
      this.imageTransfer = { id: generation + ":" + (++this.transferSequence), requestId: params.requestId, cacheKey, images };
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
  releaseImages(params) { if (this.imageTransfer?.id === params.transferId) { this.inboundImages.delete(this.imageTransfer.cacheKey); this.imageTransfer = null; } return { released: true }; }
  async sendGroup(params) {
    if (!this.client || this.appId !== params.appId || this.connectionState !== "connected" || params.epoch !== this.epoch) throw fault("QQ_NOT_CONNECTED", "QQ 连接不可用或已更换。");
    if (typeof params.groupId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(params.groupId)
      || typeof params.requestId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(params.requestId)
      || typeof params.text !== "string" || !params.text.trim() || params.text.length > 1800) throw fault("INVALID_GROUP_MESSAGE", "主动消息参数不正确。");
    this.proactiveSends ??= new Map();
    const old = this.proactiveSends.get(params.requestId);
    if (old) {
      if (old.appId !== params.appId || old.groupId !== params.groupId || old.text !== params.text) throw fault("GROUP_MESSAGE_CONFLICT", "同一主动消息请求已有不同内容。");
      if (old.result) return old.result;
      throw fault("QQ_SEND_UNCERTAIN", "主动消息正在发送或结果不确定，请查看目标群。");
    }
    const bot = this.client, generation = this.generation;
    const record = { appId: params.appId, groupId: params.groupId, text: params.text };
    this.proactiveSends.set(params.requestId, record);
    try {
      // Omitting msgId selects the SDK's POST /v2/groups/{group_openid}/messages proactive path.
      const result = await bot.sendText({ scope: "group", targetId: params.groupId }, params.text);
      if (this.client !== bot || generation !== this.generation || typeof result?.id !== "string" || !result.id) throw fault("QQ_SEND_UNCERTAIN", "QQ 未确认主动消息发送。");
      record.result = { sent: true, messageId: result.id, ...(typeof result.timestamp === "string" ? { timestamp: result.timestamp } : {}) };
      return record.result;
    } catch (error) {
      // Never forward SDK messages/bodies: they can contain credentials and private request details.
      if (this.client === bot && generation === this.generation && error.httpStatus >= 400 && error.httpStatus < 500) {
        const code = Number.isSafeInteger(error.bizCode) && error.bizCode > 0 && error.bizCode < 1e10 ? "QQ_API_" + error.bizCode : "QQ_HTTP_" + error.httpStatus;
        throw fault(code, "QQ 拒绝主动消息，请检查机器人权限、群成员资格和发送配额。");
      }
      throw fault("QQ_SEND_UNCERTAIN", "主动消息发送结果不确定，请查看目标群；不要自动重发。");
    } finally {
      // Payloads stay in memory only. Durable deduplication lives in the separate proactive outbox.
      if (this.proactiveSends.size > 200) this.proactiveSends.delete(this.proactiveSends.keys().next().value);
    }
  }

  reply(params) {return this.sendFinal(params,'reply');}
  finalActive(params) {return this.sendFinal(params,'active');}
  async sendFinal(params,stage) {
    if(!this.client||this.appId!==params.appId||this.connectionState!=='connected'||params.epoch!==this.epoch||!!params.sandbox!==!!this.sandbox)throw fault('QQ_NOT_CONNECTED','原机器人连接已失效，未发送。');
    if(![params.groupId,params.messageId,params.requestId].every(x=>typeof x==='string'&&x.length>0&&x.length<=160)||typeof params.text!=='string'||!params.text.trim()||params.text.length>1800||params.msgIdx!==undefined&&(typeof params.msgIdx!=='string'||!params.msgIdx||params.msgIdx.length>256))throw fault('INVALID_REPLY','原请求或最终答案无效。');
    this.finalRecords??=new Map();
    const signature=JSON.stringify([params.appId,!!params.sandbox,params.groupId,params.messageId,params.text,params.msgIdx]);
    let record=this.finalRecords.get(params.requestId);
    if(record&&record.signature!==signature)throw fault('FINAL_CONFLICT','同一请求已有不同最终答案。');
    if(!record){
      if(stage!=='reply')throw fault('FINAL_STATE_REQUIRED','没有本次明确被动失败记录，未主动发送。');
      // Durable main-process intents remain the authority across cache eviction
      // and process restart. Only confirmed terminal records leave this cache;
      // in-flight/unknown or passive-only rejected records stay claimed.
      if(this.finalRecords.size>=200)for(const [key,old]of this.finalRecords)if(old.reply?.sent||old.active?.sent||old.active?.outcome==='rejected'){this.finalRecords.delete(key);if(this.finalRecords.size<200)break;}
      if(this.finalRecords.size>=200)throw fault('FINAL_INBOX_FULL','发送记录已满，未删除未知回执。');
      record={signature};this.finalRecords.set(params.requestId,record);
    }
    if(stage==='active'&&record.reply?.outcome!=='rejected')throw fault('FINAL_STATE_REQUIRED','被动结果未明确拒绝，未主动补发。');
    if(record[stage])return record[stage];
    record[stage]={sent:false,outcome:'uncertain',code:'QQ_SEND_UNCERTAIN'};
    const bot=this.client,generation=this.generation;
    try {
      const result=await bot.send({target:{scope:'group',targetId:params.groupId,...(stage==='reply'?{msgId:params.messageId}:{})},msgType:0,content:params.text,...(params.msgIdx?{messageReference:{message_id:params.msgIdx}}:{}),extra:{msg_seq:1}});
      if(this.client!==bot||generation!==this.generation||typeof result?.id!=='string'||!result.id.trim()||result.id.length>512)return record[stage];
      record[stage]={sent:true,messageId:result.id,...(typeof result.timestamp==='string'?{timestamp:result.timestamp}:{})};return record[stage];
    } catch(error) {
      if(this.client===bot&&generation===this.generation)record[stage]=rejectedMessage(error,'/v2/groups/'+params.groupId+'/messages');
      return record[stage];
    }
  }
}
