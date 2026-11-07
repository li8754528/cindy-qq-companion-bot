import { fault } from "./controller.mjs";
import { BridgeFleet } from "./fleet.mjs";
import { fleetConfig, secretKey } from "./config.mjs";
import { collectImages } from "./image-transfer.mjs";
import { ProactiveSender, sendErrorMessage } from "./proactive.mjs";
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
const connectionScopes = new Map(), migratedQQSessions = new Set();
const controller = new BridgeFleet({ forBot: id => {
  const path = id === "bot1" ? "bridge-state.json" : "bridge-state-" + id + ".json";
  return {
  botId: id, read: async () => {
    const state = await readState(path);
    // Only the deferred parallel-task state has a tasks map. Core schema3
    // already stores /talk correctly and must survive a restart unchanged.
    if (state?.schema !== 3 || !Object.prototype.hasOwnProperty.call(state, "tasks")) return state;
    // Back up the deferred development state before the core controller strips
    // unsupported fields; retain old QQ task restrictions for proactive tools.
    const backupPath = "backups/schema3-" + id + "-" + crypto.randomUUID() + ".json";
    const backup = await cindy.fs({ op: "write", root: "data", path: backupPath, content: JSON.stringify(state) });
    if (!backup.ok) throw fault("STATE_WRITE_FAILED", "无法备份开发版状态，已停止兼容迁移，请检查插件数据。");
    for (const task of Array.isArray(state.tasks) ? state.tasks : []) if (typeof task?.taskId === "string") migratedQQSessions.add(task.taskId);
    for (const job of Array.isArray(state.jobs) ? state.jobs : []) if (typeof job?.taskId === "string") migratedQQSessions.add(job.taskId);
    if (migratedQQSessions.size) {
      const scope = await cindy.fs({ op: "write", root: "data", path: "qq-source-session-compat.json", content: JSON.stringify({ schema: 1, sessionIds: [...migratedQQSessions] }) });
      if (!scope.ok) throw fault("STATE_WRITE_FAILED", "无法保存原 QQ 会话的权限边界，已停止兼容迁移。");
    }
    return { ...state, schema: 3, histories: (Array.isArray(state.histories) ? state.histories : []).filter(h => h?.mode === "talk"), jobs: (Array.isArray(state.jobs) ? state.jobs : []).map(job => job.state === "queued" ? { ...job, state: "cancelled", code: "HOST_RESTARTED" } : job) };
  },
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
    if (method === "qq/connect" || method.startsWith("qq/connect/")) connectionScopes.set(id, { appId: params.appId, sandbox: params.sandbox === true, epoch: params.epoch });
    else if (method === "qq/disconnect") connectionScopes.delete(id);
    return result.result;
  },
  }; }, changed: snapshot => channel.postMessage({ type: "snapshot", snapshot }),
});
const proactive = new ProactiveSender({
  read: () => readState("proactive-state.json"),
  write: async state => { const result = await cindy.fs({ op: "write", root: "data", path: "proactive-state.json", content: JSON.stringify(state) }); if (!result.ok) throw fault("PROACTIVE_STATE_WRITE_FAILED", "无法保存主动消息状态，请检查插件数据。"); },
  isQQSession: sessionId => migratedQQSessions.has(sessionId) || [...controller.controllers.values()].some(b => b.jobs.some(j => j.taskId === sessionId) || b.histories.some(h => h.taskId === sessionId)),
  context: id => {
    const cfg = controller.config.bots.find(b => b.id === id), b = controller.controllers.get(id);
    return cfg && b ? { botId: id, appId: cfg.appId, sandbox: cfg.sandbox, enabled: cfg.enabled, connection: b.connection, generation: b.runtimeGeneration, epoch: b.connectionEpoch } : null;
  },
  current: context => {
    const b = controller.controllers.get(context.botId), cfg = controller.desired.bots.find(b => b.id === context.botId), connected = connectionScopes.get(context.botId);
    return !!b && !!cfg?.enabled && cfg.appId === context.appId && cfg.sandbox === context.sandbox && b.cfg.enabled
      && b.connection === "connected" && b.runtimeGeneration === context.generation && b.connectionEpoch === context.epoch
      && connected?.appId === context.appId && connected.sandbox === context.sandbox && connected.epoch === context.epoch;
  },
  send: async (params, callId) => {
    const result = await cindy.node.request({ method: "qq/send-group", params, callId, timeoutMs: 30000 });
    if (!result.ok) {
      const code = result.errorCode === "PERMISSION_DENIED" ? "PERMISSION_DENIED" : /^(QQ_API_\d{3,10}|QQ_HTTP_4\d\d|QQ_NOT_CONNECTED|QQ_SEND_UNCERTAIN|INVALID_GROUP_MESSAGE|GROUP_MESSAGE_CONFLICT)$/.test(result.message || "") ? result.message : "QQ_SEND_UNCERTAIN";
      throw fault(code, sendErrorMessage(code));
    }
    return result.result;
  },
});
let bootError = null, checkedAt = null, proactiveError = null;
const snapshot = () => ({ ...controller.snapshot(), bootError, checkedAt, proactiveMessages: proactive.snapshot(), proactiveError });
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
  const previousSessions = await readState("qq-source-session-compat.json");
  if (previousSessions) {
    if (previousSessions.schema !== 1 || !Array.isArray(previousSessions.sessionIds) || previousSessions.sessionIds.length > 10000 || previousSessions.sessionIds.some(id => typeof id !== "string" || !id || id.length > 160)) throw fault("STATE_INVALID", "原 QQ 会话权限记录损坏，请保留数据并联系作者。");
    for (const id of previousSessions.sessionIds) migratedQQSessions.add(id);
  }
  await controller.init(); await controller.configure(config); checkedAt = Date.now();
  try { await proactive.init(); } catch (error) { proactiveError = { code: error.code || "PROACTIVE_STATE_INVALID", message: error.message || "主动消息记录无法读取，请检查插件数据。" }; }
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
    if (msg.tool === "get_status") {
      const ownerSession = proactive.allowsSession(args.session_context?.session_id);
      result = { ...snapshot(), ...(!ownerSession ? { proactiveMessages: [], proactiveError: null } : {}), hostImageAttachments: await imageSupport().catch(() => false),
        ...(ownerSession ? { hostTaskCapabilities: await (async () => cindy.tasks?.capabilities?.())().catch(() => null) } : {}) };
    }
    else if (bootError) throw fault(bootError.code, bootError.message);
    else if (msg.tool === "get_question") result = await controller.question(args.request_id, args.session_context?.session_id);
    else if (msg.tool === "reply_to_qq") result = await controller.reply(args.request_id, args.text, args.session_context?.session_id);
    else if (msg.tool === "send_group_message") {
      if (proactiveError) throw fault(proactiveError.code, proactiveError.message);
      result = await proactive.send(args, args.session_context?.session_id, msg.callId);
    }
    else throw fault("UNKNOWN_TOOL", "不支持的工具。");
    await cindy.send({ type: "tool-result", callId: msg.callId, ok: true, result });
  } catch (error) { await cindy.send({ type: "tool-result", callId: msg.callId, ok: false, errorCode: error.code || "QQ_PLUGIN_FAILED", message: error.message || "操作失败，请查看插件设置。" }); }
});
