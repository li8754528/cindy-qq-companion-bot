import { fault } from "./controller.mjs";
import { BOT_IDS } from "./config.mjs";
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 10000;
export function sendErrorMessage(code) {
  if (code === "QQ_NOT_CONNECTED") return "所选机器人连接不可用或已更换，请在插件设置中恢复连接后使用新的请求编号发送。";
  if (code === "PERMISSION_DENIED") return "Cindy 未批准此机器人的连接权限，请检查插件权限后使用新的请求编号发送。";
  if (code === "CONFIG_CHANGED") return "机器人配置已变化，消息未发送，请核对机器人和群后使用新的请求编号发送。";
  if (code === "PROACTIVE_STATE_WRITE_FAILED") return "发送前无法保存主动消息状态，消息未发出，请恢复插件数据写入后使用新的请求编号发送。";
  if (["QQ_API_40034100", "QQ_HTTP_429"].includes(code)) return "QQ 主动消息频率或配额已达上限，请等待配额恢复后使用新的请求编号发送。";
  if (["QQ_API_40034101", "QQ_API_40054003"].includes(code)) return "机器人不是该群成员，请将所选机器人加入目标群。";
  if (["QQ_API_40034105", "QQ_HTTP_401", "QQ_HTTP_403"].includes(code)) return "QQ 拒绝主动消息，请检查所选机器人的凭证和主动消息权限。";
  if (code === "QQ_API_40054002") return "机器人被禁言，请等待解禁。";
  if (/^QQ_(API_\d+|HTTP_4\d\d)$/.test(code)) return "QQ 拒绝主动消息（" + code + "），请检查内容、群成员资格和机器人权限。";
  return "主动消息发送结果不确定，请查看目标群；不要更换请求编号重发。";
}
export class ProactiveSender {
  constructor(host) { this.host = host; this.records = []; this.writeChain = Promise.resolve(); this.preparing = Promise.resolve(); }
  now() { return this.host.now?.() ?? Date.now(); }
  snapshot() { return this.records.filter(r => r.createdAt > this.now() - RETENTION_MS).slice(-24).reverse().map(({ fingerprint, workerId, ...record }) => ({ ...record })); }
  allowsSession(sessionId) { return typeof sessionId === "string" && !!sessionId && !this.host.isQQSession(sessionId); }
  save() {
    const data = JSON.parse(JSON.stringify({ schema: 1, records: this.records }));
    const write = this.writeChain.then(() => this.host.write(data));
    // Each operation still awaits its own successful intent write; a transient error cannot poison later operations.
    this.writeChain = write.catch(() => {});
    return write;
  }
  async init() {
    const data = await this.host.read();
    if (!data) return;
    if (data.schema !== 1 || !Array.isArray(data.records) || data.records.length > MAX_RECORDS
      || new Set(data.records.map(r => r?.requestKey)).size !== data.records.length
      || data.records.some(r => !r || typeof r.requestKey !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(r.requestKey)
        || typeof r.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(r.fingerprint) || typeof r.workerId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(r.workerId)
        || !BOT_IDS.includes(r.botId) || typeof r.appId !== "string" || !/^\d{4,30}$/.test(r.appId) || typeof r.sandbox !== "boolean"
        || typeof r.groupId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(r.groupId) || !Number.isFinite(r.createdAt)
        || !["sending", "sent", "failed", "uncertain"].includes(r.state)
        || r.state === "sent" && (typeof r.messageId !== "string" || !r.messageId)
        || r.state === "failed" && (typeof r.code !== "string" || !r.code))) throw fault("PROACTIVE_STATE_INVALID", "主动消息记录损坏，请保留插件数据并联系作者。");
    this.records = data.records.filter(r => r.createdAt > this.now() - RETENTION_MS);
    for (const record of this.records) if (record.state === "sending") { record.state = "uncertain"; record.code = "QQ_SEND_UNCERTAIN"; }
    await this.save();
  }
  validate(args, sessionId) {
    if (!BOT_IDS.includes(args.bot_id) || typeof args.group_openid !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(args.group_openid)
      || typeof args.text !== "string" || !args.text.trim() || args.text.length > 1800
      || typeof args.request_key !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(args.request_key)) throw fault("INVALID_GROUP_MESSAGE", "请指定机器人、有效的 group_openid、1–1800 字符的文字和 1–80 位请求编号。");
    if (!this.allowsSession(sessionId)) throw fault("PROACTIVE_FORBIDDEN", "主动消息须由主人在 Cindy 任务中发起；群内问答任务只能使用 reply_to_qq 回复原问题。");
  }
  receipt(record) {
    return { sent: true, bot_id: record.botId, app_id: record.appId, sandbox: record.sandbox, group_openid: record.groupId,
      request_key: record.requestKey, message_id: record.messageId, ...(record.timestamp ? { timestamp: record.timestamp } : {}) };
  }
  async send(args, sessionId, callId) {
    this.validate(args, sessionId);
    // Serialize intent creation, not network sends. A second identical call can never dispatch a second write.
    const prepare = this.preparing.then(async () => {
      const context = this.host.context(args.bot_id);
      if (!context) throw fault("BOT_CONFIG_INVALID", "所选机器人没有配置。");
      const payload = JSON.stringify([args.bot_id, context.appId, context.sandbox, args.group_openid, args.text]);
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
      const fingerprint = [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, "0")).join("");
      this.records = this.records.filter(r => r.createdAt > this.now() - RETENTION_MS);
      const old = this.records.find(r => r.requestKey === args.request_key);
      if (old) {
        if (old.fingerprint !== fingerprint) throw fault("GROUP_MESSAGE_CONFLICT", "同一请求编号已用于不同的机器人、群或内容，请检查原发送记录。");
        if (old.state === "sent") return { receipt: this.receipt(old) };
        if (old.state === "failed") throw fault(old.code, sendErrorMessage(old.code));
        throw fault("QQ_SEND_UNCERTAIN", sendErrorMessage("QQ_SEND_UNCERTAIN"));
      }
      if (!context.enabled || context.connection !== "connected") throw fault("QQ_NOT_CONNECTED", "所选机器人尚未连接或已暂停，请在插件设置中恢复连接。");
      if (!this.host.current(context)) throw fault("CONFIG_CHANGED", "机器人配置已变化，请检查目标后重新调用。");
      if (this.records.length >= MAX_RECORDS) throw fault("PROACTIVE_OUTBOX_FULL", "主动消息记录已满，请等待七天记录过期后再发送。");
      const record = { requestKey: args.request_key, workerId: crypto.randomUUID(), fingerprint, botId: args.bot_id, appId: context.appId,
        sandbox: context.sandbox, groupId: args.group_openid, createdAt: this.now(), state: "sending" };
      this.records.push(record);
      try { await this.save(); } catch {
        record.state = "failed"; record.code = "PROACTIVE_STATE_WRITE_FAILED";
        throw fault(record.code, sendErrorMessage(record.code));
      }
      return { record, context };
    });
    this.preparing = prepare.then(() => {}, () => {});
    const prepared = await prepare;
    if (prepared.receipt) return prepared.receipt;
    const { record, context } = prepared;
    try {
      if (!this.host.current(context)) throw fault("CONFIG_CHANGED", "机器人配置已变化，消息未发送。");
      const result = await this.host.send({ botId: record.botId, appId: record.appId, epoch: context.epoch, groupId: record.groupId,
        requestId: record.workerId, text: args.text }, callId);
      if (!this.host.current(context) || result?.sent !== true || typeof result.messageId !== "string" || !result.messageId) throw fault("QQ_SEND_UNCERTAIN", sendErrorMessage("QQ_SEND_UNCERTAIN"));
      record.messageId = result.messageId; if (typeof result.timestamp === "string") record.timestamp = result.timestamp;
      record.state = "sent";
    } catch (error) {
      // Only explicit platform rejections and local preflight failures are confirmed failures.
      const code = error.code || "QQ_SEND_UNCERTAIN";
      const rejected = /^(QQ_API_\d{3,10}|QQ_HTTP_4\d\d)$/.test(code) || ["CONFIG_CHANGED", "QQ_NOT_CONNECTED", "PERMISSION_DENIED"].includes(code);
      record.state = rejected ? "failed" : "uncertain"; record.code = rejected ? code : "QQ_SEND_UNCERTAIN";
      // Retain the durable sending tombstone if the terminal write fails; never hide the delivery outcome.
      await this.save().catch(() => {});
      throw fault(record.code, rejected && !/^QQ_(API|HTTP)_/.test(code) ? error.message : sendErrorMessage(record.code));
    }
    try { await this.save(); } catch {
      return { ...this.receipt(record), state_saved: false, warning: "QQ 已确认消息发送，但回执保存失败。请检查目标群，不要更换请求编号重发；插件重启后此记录可能显示为结果不确定。" };
    }
    return this.receipt(record);
  }
}
