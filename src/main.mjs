import { fault } from "./controller.mjs";
import { BridgeFleet } from "./fleet.mjs";
import { fleetConfig, secretKey } from "./config.mjs";
import { collectImages } from "./image-transfer.mjs";
const channel = new BroadcastChannel("qq-companion-bot-ui");
async function readState(path) {
  const result = await cindy.fs({ op: "read", root: "data", path });
  if (!result.ok) {
    if (new RegExp("not found|不存在|ENOENT", "i").test(result.message || "") || ["NOT_FOUND", "FILE_NOT_FOUND", "ENOENT"].includes(result.errorCode)) return null;
    throw fault("STATE_READ_FAILED", "无法读取插件数据，请保留数据并检查插件状态。");
  }
  try { return JSON.parse(result.content); } catch { throw fault("STATE_INVALID", "插件数据损坏，请保留原数据并联系作者。"); }
}
const imageSupport = async () => {
  if (typeof cindy.tasks?.capabilities !== "function") return false;
  const caps = await cindy.tasks.capabilities();
  return Array.isArray(caps?.messageAttachments?.kinds) && caps.messageAttachments.kinds.includes("image");
};
const controller = new BridgeFleet({ forBot: id => {
  const path = id === "bot1" ? "bridge-state.json" : "bridge-state-" + id + ".json";
  return {
  botId: id, read: () => readState(path),
  write: async state => { const result = await cindy.fs({ op: "write", root: "data", path, content: JSON.stringify(state) }); if (!result.ok) throw fault("STATE_WRITE_FAILED", "无法保存投递状态，已停止发送。"); },
  resolve: id => cindy.targets.resolve({ target: { kind: "bot", id } }),
  send: params => cindy.targets.send(params),
  imageSupport,
  images: (job, epoch) => collectImages(controller.controllers.get(id).host.node, job, epoch),
  node: async (method, params) => {
    if (method === "qq/connect" || method.startsWith("qq/connect/")) {
      const secrets = await (await fetch("/secrets")).json();
      if (!secrets.some(s => s.key === secretKey(id) && s.saved)) throw fault("QQ_SECRET_REQUIRED", "请在插件设置中保存此机器人的 AppSecret。");
    }
    const result = await cindy.node.request({ method, params, timeoutMs: 30000 });
    if (!result.ok && result.errorCode === "PERMISSION_DENIED") throw fault("PERMISSION_DENIED", "QQ 连接权限未获批准，请检查插件权限。");
    if (!result.ok) { const safe = /QQ_[A-Z_]+|IMAGE_[A-Z_]+|BOT_[A-Z_]+|INVALID_REPLY|REPLY_CONFLICT/.exec(result.message || "")?.[0]; throw fault(safe || "NODE_REQUEST_FAILED", "QQ 连接或请求失败，请查看插件设置。"); }
    return result.result;
  },
  }; }, changed: snapshot => channel.postMessage({ type: "snapshot", snapshot }),
});
let bootError = null;
const ready = (async () => {
  if (typeof cindy.targets?.send !== "function") throw fault("HOST_UNSUPPORTED", "当前 Cindy 缺少指定伙伴投递接口。");
  const raw = await (await fetch("/kv")).json(), config = fleetConfig(raw);
  // Same-source migration retains the original vault key; credentials never enter /kv.
  if (raw.schema !== 2) { const saved = await fetch("/kv", { method: "PUT", body: JSON.stringify(config) }); if (!saved.ok) throw fault("CONFIG_SAVE_FAILED", "旧配置转换后无法保存。"); }
  await controller.init(); await controller.configure(config);
})().catch(error => { bootError = { code: error.code || "BOOT_FAILED", message: "插件未能启动，请检查权限和保存的数据。" }; channel.postMessage({ type: "boot-error", error: bootError }); });
const uiRequests = new Map();
setInterval(async () => { await ready; if (!bootError) { try { await controller.tick(); } catch { bootError = { code: "STATE_WRITE_FAILED", message: "状态保存失败，已停止发送，请检查插件数据。" }; channel.postMessage({ type: "boot-error", error: bootError }); } } }, 15000);
channel.onmessage = async event => {
  const msg = event.data; if (!msg || msg.type !== "ui-request" || typeof msg.id !== "string") return;
  if (uiRequests.has(msg.id)) { channel.postMessage(await uiRequests.get(msg.id)); return; }
  const run = (async () => {
    await ready; if (bootError) return { type: "ui-response", id: msg.id, ok: false, error: bootError };
    try {
      let data;
      if (msg.action === "snapshot") data = controller.snapshot();
      else if (msg.action === "targets") data = await cindy.targets.list({ targetKind: "bot" });
      else if (msg.action === "reload") data = await controller.configure(await (await fetch("/kv")).json(), msg.botId);
      else if (msg.action === "clear-history") data = await controller.clearHistory(msg.botId);
      else throw fault("INVALID_UI_REQUEST", "不支持的操作。");
      return { type: "ui-response", id: msg.id, ok: true, data };
    } catch (error) { return { type: "ui-response", id: msg.id, ok: false, error: { code: error.code || "REQUEST_FAILED", message: "操作未完成，请检查插件权限和伙伴状态。" } }; }
  })();
  uiRequests.set(msg.id, run); if (uiRequests.size > 64) uiRequests.delete(uiRequests.keys().next().value);
  channel.postMessage(await run);
};
cindy.onHostMessage(async msg => {
  await ready;
  if (msg.type === "event" && msg.name === "node-notification" && !bootError) {
    try {
      if (msg.method === "qq/message") await controller.receive(msg.params);
      else if (msg.method === "qq/status") await controller.status(msg.params);
      else if (msg.method === "qq/tick") await controller.tick();
    } catch { bootError = { code: "STATE_OR_INBOUND_FAILED", message: "消息处理或保存失败，已停止发送，请保留数据检查；未自动重发。" }; channel.postMessage({ type: "boot-error", error: bootError }); }
  }
  if (msg.type === "event" && msg.name === "node-status" && ["stopped", "crashed"].includes(msg.state) && !bootError) {
    await controller.stopped();
    setTimeout(async () => { if (!bootError) { try { await controller.recover(); } catch {} } }, 2000);
  }
  if (msg.type !== "tool-call") return;
  try {
    if (bootError) throw fault(bootError.code, bootError.message);
    let result; const args = msg.args || {};
    if (msg.tool === "get_status") result = { ...controller.snapshot(), hostImageAttachments: await imageSupport().catch(() => false) };
    else if (msg.tool === "get_question") result = await controller.question(args.request_id, args.session_context?.session_id);
    else if (msg.tool === "reply_to_qq") result = await controller.reply(args.request_id, args.text, args.session_context?.session_id);
    else throw fault("UNKNOWN_TOOL", "不支持的工具。");
    await cindy.send({ type: "tool-result", callId: msg.callId, ok: true, result });
  } catch (error) { await cindy.send({ type: "tool-result", callId: msg.callId, ok: false, errorCode: error.code || "QQ_PLUGIN_FAILED", message: error.message || "操作失败，请查看插件设置。" }); }
});
