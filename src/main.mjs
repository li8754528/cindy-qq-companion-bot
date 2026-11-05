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
const defaultSupport = async () => {
  const caps = await cindy.tasks?.capabilities?.();
  if (!["create", "get", "send"].every(op => caps?.operations?.includes(op) && typeof cindy.tasks?.[op] === "function")) throw fault("HOST_UNSUPPORTED", "当前 Cindy 不支持插件新建和恢复连续对话。");
};
async function taskRequestKey(key) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return "qq:" + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
// PERMISSION_DENIED can also arrive from the slot's post-dispatch permission
// check, so it cannot prove that an input was never accepted.
const rejectedBeforeSend = new Set(["INVALID_REQUEST", "TASK_NOT_FOUND", "TASK_BUSY", "REVISION_CONFLICT"]);
const lostTalk = () => Object.assign(fault("TALK_TASK_UNAVAILABLE", "连续会话已结束，请重新 /talk。"), { beforeSend: true });
async function sendQuestion(params, assertCurrent) {
  assertCurrent();
  const { talkCreateKey, talkTaskId, ...message } = params;
  if (params.target) return cindy.targets.send(message);
  let task;
  try { task = await openTalk(params, assertCurrent); } catch (error) { error.beforeSend = true; throw error; }
  const requestKey = await taskRequestKey(params.requestKey);
  assertCurrent();
  let run;
  try {
    run = await cindy.tasks.send({ taskId: task.taskId, expectedRevision: task.revision, requestKey, text: params.text, ...(params.attachments ? { attachments: params.attachments } : {}) });
  } catch (error) {
    if (rejectedBeforeSend.has(error.code)) {
      error.beforeSend = true;
      if (params.talkTaskId && error.code === "TASK_NOT_FOUND") throw lostTalk();
      if (params.talkTaskId && error.code === "TASK_BUSY") {
        // TASK_BUSY can also mean attachment pressure. End a talk only when
        // the Host confirms that its task disappeared or became inactive.
        let current;
        try { current = await cindy.tasks.get({ taskId: task.taskId }); }
        catch (lookupError) { if (lookupError.code === "TASK_NOT_FOUND") throw lostTalk(); throw error; }
        assertCurrent();
        if (!current || current.status && current.status !== "active") throw lostTalk();
      }
    }
    throw error;
  }
  if (typeof run?.runId !== "string" || !run.runId) throw fault("DELIVERY_UNCERTAIN", "无法确认新对话是否已接受问题，请检查对话列表。");
  return { accepted: true, taskId: task.taskId };
}
async function openTalk(params, assertCurrent) {
  assertCurrent();
  if (params.target) return {};
  await defaultSupport(); assertCurrent();
  if (params.talkTaskId) {
    if (typeof cindy.tasks.get !== "function") throw fault("HOST_UNSUPPORTED", "当前 Cindy 不支持恢复连续会话。");
    try {
      const task = await cindy.tasks.get({ taskId: params.talkTaskId });
      if (!task || task.status && task.status !== "active") throw fault("TALK_TASK_UNAVAILABLE", "连续会话已不可用，请重新 /talk。");
      return task;
    } catch (error) {
      if (["TASK_NOT_FOUND", "TALK_TASK_UNAVAILABLE"].includes(error.code)) throw lostTalk();
      throw error;
    }
  }
  const requestKey = params.talkCreateKey || (await taskRequestKey(params.requestKey)) + ":create";
  assertCurrent();
  try {
    const task = await cindy.tasks.create({ requestKey, title: params.talkCreateKey ? "QQ 连续会话" : "QQ 群提问" });
    if (params.talkCreateKey && (!task || task.status && task.status !== "active")) throw lostTalk();
    return task;
  } catch (error) {
    // Replaying a creation receipt may resolve a task that is already gone,
    // even when an interrupted previous send never recorded its taskId.
    if (params.talkCreateKey && error.code === "TASK_NOT_FOUND") throw lostTalk();
    throw error;
  }
}
const controller = new BridgeFleet({ forBot: id => {
  const path = id === "bot1" ? "bridge-state.json" : "bridge-state-" + id + ".json";
  return {
  botId: id, read: () => readState(path),
  write: async state => { const result = await cindy.fs({ op: "write", root: "data", path, content: JSON.stringify(state) }); if (!result.ok) throw fault("STATE_WRITE_FAILED", "无法保存投递状态，已停止发送。"); },
  resolve: id => cindy.targets.resolve({ target: { kind: "bot", id } }),
  send: sendQuestion, openTalk, defaultSupport,
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
let bootError = null, checkedAt = null;
const snapshot = () => ({ ...controller.snapshot(), bootError, checkedAt });
function failBoot(error, message) {
  bootError = { code: error.code || "BOOT_FAILED", message }; checkedAt = Date.now();
  channel.postMessage({ type: "boot-error", error: bootError });
  channel.postMessage({ type: "snapshot", snapshot: snapshot() });
}
const ready = (async () => {
  if (typeof cindy.targets?.send !== "function") throw fault("HOST_UNSUPPORTED", "当前 Cindy 缺少指定伙伴投递接口。");
  const raw = await (await fetch("/kv")).json(), config = fleetConfig(raw);
  // Same-source migration retains the original vault key; credentials never enter /kv.
  if (raw.schema !== 2) { const saved = await fetch("/kv", { method: "PUT", body: JSON.stringify(config) }); if (!saved.ok) throw fault("CONFIG_SAVE_FAILED", "旧配置转换后无法保存。"); }
  await controller.init(); await controller.configure(config); checkedAt = Date.now();
})().catch(error => { failBoot(error, "插件启动自检未通过，请检查权限或保存的数据；修复后重新启用插件。"); });
const uiRequests = new Map();
setInterval(async () => { await ready; if (!bootError) { try { await controller.tick(); } catch (error) { failBoot(error, "状态保存失败，已停止发送，请检查插件数据。"); } } }, 15000);
async function selfCheck() {
  await ready;
  if (!bootError) {
    // Only check/recover connections; never replay a question or an uncertain reply.
    for (const cfg of controller.config.bots) {
      const b = controller.controllers.get(cfg.id);
      if (!cfg.enabled) {
        if (b.connection === "error") await controller.configure(controller.desired, cfg.id);
        continue;
      }
      // Configuration failures need user input. A worker health probe cannot
      // diagnose a missing secret/permission or an unavailable selected partner.
      if (b.connection === "needs_config") continue;
      try {
        const health = await b.host.node("qq/status", { health: true });
        if (health.appId === b.cfg.appId && health.epoch === b.connectionEpoch && ["connected", "connecting"].includes(health.state)) await controller.status({ botId: cfg.id, state: health.state, epoch: health.epoch });
        else await controller.status({ botId: cfg.id, state: "error", code: "NODE_STOPPED", epoch: b.connectionEpoch });
      } catch (error) { await controller.status({ botId: cfg.id, state: ["PERMISSION_DENIED", "QQ_SECRET_REQUIRED"].includes(error.code) ? "needs_config" : "error", code: error.code || "NODE_REQUEST_FAILED", epoch: b.connectionEpoch }); }
    }
    await controller.recover();
  }
  checkedAt = Date.now(); return snapshot();
}
ready.then(async () => {
  try { await selfCheck(); } catch (error) { failBoot(error, "启动后的自检失败，请检查插件权限和保存的数据。"); }
  channel.postMessage({ type: "snapshot", snapshot: snapshot() });
});
channel.onmessage = async event => {
  const msg = event.data; if (!msg || msg.type !== "ui-request" || typeof msg.id !== "string") return;
  if (uiRequests.has(msg.id)) { channel.postMessage(await uiRequests.get(msg.id)); return; }
  const run = (async () => {
    try {
      let data;
      if (msg.action === "targets") data = await cindy.targets.list({ targetKind: "bot" });
      else {
        await ready;
        if (msg.action === "snapshot") data = snapshot();
        else if (msg.action === "self-check") data = await selfCheck();
        else {
          if (bootError) throw fault(bootError.code, bootError.message);
          if (msg.action === "reload") { await controller.configure(await (await fetch("/kv")).json(), msg.botId); data = snapshot(); }
          else if (msg.action === "clear-history") { await controller.clearHistory(msg.botId); data = snapshot(); }
          else if (msg.action === "clear-bot") { await controller.clearBot(msg.botId); data = snapshot(); }
          else throw fault("INVALID_UI_REQUEST", "不支持的操作。");
        }
      }
      return { type: "ui-response", id: msg.id, ok: true, data };
    } catch (error) { return { type: "ui-response", id: msg.id, ok: false, error: { code: error.code || "REQUEST_FAILED", message: error.message || "操作未完成，请检查插件权限和伙伴状态。" } }; }
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
    } catch (error) { failBoot(error, "消息处理或保存失败，已停止发送，请保留数据检查；未自动重发。"); }
  }
  if (msg.type === "event" && msg.name === "node-status" && ["stopped", "crashed"].includes(msg.state) && !bootError) {
    await controller.stopped();
    setTimeout(async () => { if (!bootError) { try { await controller.recover(); } catch {} } }, 2000);
  }
  if (msg.type !== "tool-call") return;
  try {
    let result; const args = msg.args || {};
    if (msg.tool === "get_status") result = { ...snapshot(), hostImageAttachments: await imageSupport().catch(() => false) };
    else if (bootError) throw fault(bootError.code, bootError.message);
    else if (msg.tool === "get_question") result = await controller.question(args.request_id, args.session_context?.session_id);
    else if (msg.tool === "reply_to_qq") result = await controller.reply(args.request_id, args.text, args.session_context?.session_id);
    else throw fault("UNKNOWN_TOOL", "不支持的工具。");
    await cindy.send({ type: "tool-result", callId: msg.callId, ok: true, result });
  } catch (error) { await cindy.send({ type: "tool-result", callId: msg.callId, ok: false, errorCode: error.code || "QQ_PLUGIN_FAILED", message: error.message || "操作失败，请查看插件设置。" }); }
});
