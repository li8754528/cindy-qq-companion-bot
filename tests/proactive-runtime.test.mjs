import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
const code = fs.readFileSync(new URL("../main.js", import.meta.url), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("../ghost.json", import.meta.url), "utf8"));
const args = { bot_id: "bot2", group_openid: "group_2", text: "主动通知_BODY_MARKER", request_key: "notice-001" };
async function runtime({ disk = new Map(), nodeError, paused = false, selectedPartner = false, denyBackup = false } = {}) {
  const calls = [], results = [], health = new Map(), control = { beforeWrite: null }; let handler, channel;
  const config = { schema: 2, bots: [{ id: "bot1", appId: "12345", enabled: true, paused: false }, { id: "bot2", appId: "23456", sandbox: true, enabled: !paused, paused }] };
  if (selectedPartner) config.bots[0].targetId = "partner";
  const cindy = {
    onHostMessage(fn) { handler = fn; }, async send(result) { results.push(result); },
    async fs(req) {
      calls.push({ kind: "fs", req });
      if (!req.path.split("/").every(segment => /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(segment))) return { ok: false, message: "path 必须是安全相对路径" };
      if (req.op === "read") return disk.has(req.path) ? { ok: true, content: disk.get(req.path) } : { ok: false, errorCode: "NOT_FOUND" };
      if (denyBackup && req.path.startsWith("backups/schema3-")) return { ok: false };
      if (control.beforeWrite) await control.beforeWrite(req);
      disk.set(req.path, req.content); return { ok: true };
    },
    targets: { async list() { return { targets: [] }; }, async resolve() { return {}; }, async send(req) { calls.push({ kind: "partner-send", req }); return { accepted: true, taskId: "existing-partner-session" }; } },
    tasks: {
      async capabilities() { return { operations: ["create", "get", "send"], messageAttachments: { kinds: ["image"] } }; },
      async purgeExpired() { return { purged: [] }; },
      async create(req) { calls.push({ kind: "task-create", req }); return { taskId: "qq-task-" + req.requestKey, revision: 1, status: "active" }; },
      async get(req) { return { taskId: req.taskId, revision: 1, status: "active" }; },
      async send(req) { calls.push({ kind: "task-send", req }); return { runId: "run" }; },
    },
    node: { async request(req) {
      calls.push({ kind: "node", req }); const id = req.params.botId;
      if (req.method.startsWith("qq/connect")) health.set(id, { state: "connected", appId: req.params.appId, epoch: req.params.epoch });
      if (req.method === "qq/status") return { ok: true, result: health.get(id) || { state: "idle", appId: "" } };
      if (req.method === "qq/send-group" && nodeError) return { ok: false, message: nodeError };
      return { ok: true, result: { sent: true, messageId: "actual-message-id" } };
    } },
  };
  const sandbox = { cindy, crypto: webcrypto, Date, TextEncoder, Uint8Array, queueMicrotask,
    BroadcastChannel: class { constructor() { channel = this; } postMessage() {} }, setInterval() {}, setTimeout(fn) { queueMicrotask(fn); },
    async fetch(path) { return { ok: true, async json() {
      if (path === "/kv") return config;
      if (path === "/secrets") return [{ key: "qq_app_secret", saved: true }, { key: "qq_app_secret_2", saved: true }]; return {};
    } }; },
  };
  vm.runInNewContext(code, sandbox); let counter = 0;
  async function tool(name, input = {}, sessionId = "owner-task") {
    const callId = "call-" + ++counter; await handler({ type: "tool-call", tool: name, args: { ...input, session_context: { session_id: sessionId } }, callId });
    return results.find(r => r.callId === callId);
  }
  const startup = await tool("get_status");
  if (denyBackup) assert.equal(startup.result.bootError.code, "STATE_WRITE_FAILED"); else assert.equal(startup.result.bootError, null);
  for (const [botId, state] of health) await handler({ type: "event", name: "node-notification", method: "qq/status", params: { botId, ...state } });
  async function receive(id, text = "群内问题") { await handler({ type: "event", name: "node-notification", method: "qq/message", params: { botId: "bot1", appId: "12345", kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", senderId: "person", groupId: "group_1", messageId: id, text } }); }
  async function refreshStatus() { for (const [botId, state] of health) await handler({ type: "event", name: "node-notification", method: "qq/status", params: { botId, ...state } }); }
  async function reload(botId) { await channel.onmessage({ data: { type: "ui-request", id: "reload-" + ++counter, action: "reload", botId } }); }
  return { calls, disk, tool, receive, config, control, refreshStatus, reload };
}
test("manifest declares proactive tool, discovery and existing permissions stay consistent", () => {
  const tool = manifest.tools.find(t => t.name === "send_group_message"); assert.ok(tool);
  assert.deepEqual(tool.parameters.required, ["bot_id", "group_openid", "text", "request_key"]); assert.match(manifest.whenToUse, /主动/);
  assert.equal(manifest.version, "1.5.1"); assert.equal(manifest.minCindyVersion, "0.1.124"); assert.equal(manifest.tools.length, 4);
});
test("bundled tool routes to bot2, passes callId, returns verifiable receipt and keeps QQ question state untouched", async () => {
  const h = await runtime(); const before = new Map(h.disk);
  const first = await h.tool("send_group_message", args); assert.equal(first.ok, true);
  assert.equal(first.result.bot_id, "bot2"); assert.equal(first.result.app_id, "23456"); assert.equal(first.result.sandbox, true);
  assert.equal(first.result.group_openid, "group_2"); assert.equal(first.result.message_id, "actual-message-id");
  const send = h.calls.find(c => c.req.method === "qq/send-group").req;
  assert.equal(send.params.botId, "bot2"); assert.equal(send.params.appId, "23456"); assert.equal(send.params.messageId, undefined); assert.equal(send.callId, first.callId);
  assert.ok(!h.calls.some(c => c.kind === "task-create"));
  for (const [path, content] of before) assert.equal(h.disk.get(path), content);
  assert.ok(!h.disk.get("proactive-state.json").includes(args.text));
  assert.equal((await h.tool("send_group_message", args)).ok, true); assert.equal(h.calls.filter(c => c.req.method === "qq/send-group").length, 1);
  const status = await h.tool("get_status"); assert.equal(status.result.proactiveMessages[0].state, "sent");
});
test("QQ question task cannot proactively message any bot, while its passive reply still works", async () => {
  const h = await runtime(); await h.receive("question", "帮我解释");
  const taskId = h.calls.find(c => c.kind === "task-send").req.taskId;
  const rejected = await h.tool("send_group_message", args, taskId); assert.equal(rejected.errorCode, "PROACTIVE_FORBIDDEN");
  assert.equal(h.calls.filter(c => c.req.method === "qq/send-group").length, 0);
  const before = JSON.parse(h.disk.get("bridge-state.json")).histories;
  assert.equal((await h.tool("send_group_message", args)).ok, true);
  const qqStatus = await h.tool("get_status", {}, taskId); assert.equal(qqStatus.result.proactiveMessages.length, 0); assert.equal(qqStatus.result.proactiveError, null);
  assert.ok(!JSON.stringify(qqStatus.result).includes(args.group_openid));
  assert.equal((await h.tool("get_status", {}, "")).result.proactiveMessages.length, 0);
  assert.deepEqual(JSON.parse(h.disk.get("bridge-state.json")).histories, before);
  const reply = await h.tool("reply_to_qq", { request_id: "12345:question", text: "原群答复" }, taskId); assert.equal(reply.ok, true);
  assert.equal(h.calls.find(c => c.req.method === "qq/reply").req.params.groupId, "group_1");
});
test("formal host without companionTasks connects, preserves selected-partner delivery and passive replies", async () => {
  const h = await runtime({ selectedPartner: true });
  assert.equal((await h.tool("get_status")).result.bots[0].connection, "connected");
  assert.equal((await h.tool("get_status")).result.hostTaskCapabilities.companionTasks, undefined);
  await h.receive("formal-host-question"); const delivered = h.calls.find(c => c.kind === "partner-send");
  assert.equal(delivered.req.target.id, "partner"); assert.equal(h.calls.filter(c => c.kind === "task-create").length, 0);
  assert.equal((await h.tool("reply_to_qq", { request_id: "12345:formal-host-question", text: "原群答复" }, "existing-partner-session")).ok, true);
  assert.equal((await h.tool("send_group_message", args)).ok, true);
});

test("core talk survives proactive-enabled restart without schema downgrade or backup replay", async () => {
  const h = await runtime(); await h.receive("talk-first", "/talk 问题");
  const taskId = h.calls.find(c => c.kind === "task-send").req.taskId;
  assert.equal((await h.tool("reply_to_qq", { request_id: "12345:talk-first", text: "TALK_ANSWER_MARKER" }, taskId)).ok, true);
  const before = JSON.parse(h.disk.get("bridge-state.json"));
  assert.equal(before.schema, 3); assert.equal(before.histories[0].taskId, taskId);
  assert.equal(before.histories[0].turns[0].answer, "TALK_ANSWER_MARKER");
  const next = await runtime({ disk: h.disk }); await next.receive("talk-next", "继续");
  assert.equal(next.calls.find(c => c.kind === "task-send").req.taskId, taskId);
  assert.equal(next.calls.filter(c => c.kind === "task-create").length, 0);
  assert.equal([...next.disk.keys()].filter(path => path.startsWith("backups/")).length, 0);
  const after = JSON.parse(next.disk.get("bridge-state.json"));
  assert.equal(after.histories[0].id, before.histories[0].id);
  assert.equal((await next.tool("send_group_message", args, taskId)).errorCode, "PROACTIVE_FORBIDDEN");
  assert.equal((await next.tool("reply_to_qq", { request_id: "12345:talk-next", text: "继续答复" }, taskId)).ok, true);
});

test("bare talk task is a QQ source before any model input and cannot proactively send", async () => {
  const h = await runtime(); await h.receive("bare", "/talk");
  const state = JSON.parse(h.disk.get("bridge-state.json")), taskId = state.histories[0].taskId;
  assert.ok(taskId); assert.equal(h.calls.filter(c => c.kind === "task-send").length, 0);
  assert.ok(!state.jobs.some(job => job.taskId === taskId));
  assert.equal((await h.tool("send_group_message", args, taskId)).errorCode, "PROACTIVE_FORBIDDEN");
  const before = h.disk.get("bridge-state.json");
  assert.equal((await h.tool("send_group_message", args)).ok, true);
  assert.equal(h.disk.get("bridge-state.json"), before);
});
test("failed development-version state is backed up before stable migration without replaying queued messages", async () => {
  const state = { schema: 3, jobs: [{ id: "12345:old", appId: "12345", groupId: "group_1", senderId: "person", messageId: "old", targetId: "partner", sandbox: false, text: "OLD_QUESTION_NOT_TO_REPLAY", state: "queued", createdAt: Date.now() }], groups: [{ id: "group_1" }], histories: [], tasks: [{ taskId: "old-qq-session", createdAt: Date.now() }] };
  const disk = new Map([["bridge-state.json", JSON.stringify(state)]]); const h = await runtime({ disk, selectedPartner: true });
  const backups = [...disk.keys()].filter(path => path.startsWith("backups/schema3-bot1-")); assert.equal(backups.length, 1); assert.deepEqual(JSON.parse(disk.get(backups[0])), state);
  const migrated = JSON.parse(disk.get("bridge-state.json")); assert.equal(migrated.schema, 3); assert.equal(migrated.jobs[0].state, "cancelled"); assert.equal(migrated.groups[0].id, "group_1");
  assert.equal(h.calls.filter(c => c.kind === "partner-send" || c.kind === "task-send").length, 0);
  assert.equal((await h.tool("send_group_message", args, "old-qq-session")).errorCode, "PROACTIVE_FORBIDDEN");
  const restarted = await runtime({ disk, selectedPartner: true });
  assert.equal((await restarted.tool("send_group_message", args, "old-qq-session")).errorCode, "PROACTIVE_FORBIDDEN");
});
test("schema3 backups for all four bot slots satisfy the real host path-segment limit", async () => {
  const disk = new Map(); for (const id of ["bot1", "bot2", "bot3", "bot4"]) disk.set(id === "bot1" ? "bridge-state.json" : "bridge-state-" + id + ".json", JSON.stringify({ schema: 3, jobs: [], groups: [], histories: [], tasks: [] }));
  await runtime({ disk, selectedPartner: true }); const backups = [...disk.keys()].filter(path => path.startsWith("backups/schema3-"));
  assert.equal(backups.length, 4); for (const path of backups) assert.ok(path.split("/").every(segment => segment.length <= 64));
});
test("failed schema3 backup prevents conversion, connections and external sends", async () => {
  const original = JSON.stringify({ schema: 3, jobs: [], histories: [], groups: [], tasks: [] });
  const disk = new Map([["bridge-state.json", original]]); const h = await runtime({ disk, selectedPartner: true, denyBackup: true });
  assert.equal(disk.get("bridge-state.json"), original); assert.equal((await h.tool("send_group_message", args)).errorCode, "STATE_WRITE_FAILED");
  assert.equal(h.calls.filter(c => c.req.method?.startsWith("qq/connect") || c.req.method === "qq/send-group").length, 0);
});
test("legacy completed-job session IDs survive job pruning and restart in the permission mapping", async () => {
  const state = { schema: 3, jobs: [{ id: "12345:old-done", appId: "12345", groupId: "group_1", senderId: "person", targetId: "partner", sandbox: false, messageId: "old-done", taskId: "legacy-qq-session", state: "replied", createdAt: Date.now() - 2 * 86400000 }], groups: [], histories: [], tasks: [] };
  const disk = new Map([["bridge-state.json", JSON.stringify(state)]]), h = await runtime({ disk, selectedPartner: true });
  assert.deepEqual(JSON.parse(disk.get("qq-source-session-compat.json")).sessionIds, ["legacy-qq-session"]);
  await h.receive("new-after-pruning"); assert.ok(!JSON.parse(disk.get("bridge-state.json")).jobs.some(j => j.id === "12345:old-done"));
  assert.equal((await h.tool("send_group_message", args, "legacy-qq-session")).errorCode, "PROACTIVE_FORBIDDEN");
  const restarted = await runtime({ disk, selectedPartner: true });
  assert.equal((await restarted.tool("send_group_message", args, "legacy-qq-session")).errorCode, "PROACTIVE_FORBIDDEN");
});
test("sandbox change cannot send through the old connection during a pending config save", async () => {
  const h = await runtime(); assert.equal((await h.tool("send_group_message", args)).ok, true);
  const beforeEpoch = h.calls.find(c => c.req.method === "qq/send-group").req.params.epoch;
  let release, entered; const blocked = new Promise(r => release = r), writing = new Promise(r => entered = r);
  h.control.beforeWrite = async req => { if (req.path === "bridge-state-bot2.json") { entered(); await blocked; } };
  h.config.bots[1].sandbox = false; const reload = h.reload("bot2"); await writing;
  const during = await h.tool("send_group_message", { ...args, request_key: "during-switch" });
  assert.equal(during.errorCode, "CONFIG_CHANGED"); assert.equal(h.calls.filter(c => c.req.method === "qq/send-group").length, 1);
  release(); h.control.beforeWrite = null; await reload; await h.refreshStatus();
  const after = await h.tool("send_group_message", { ...args, request_key: "after-switch" });
  assert.equal(after.ok, true); assert.equal(after.result.sandbox, false); assert.notEqual(h.calls.filter(c => c.req.method === "qq/send-group").at(-1).req.params.epoch, beforeEpoch);
  const connections = h.calls.filter(c => c.req.method?.startsWith("qq/connect")).length;
  h.config.bots[1].targetId = "partner"; await h.reload();
  assert.equal((await h.tool("send_group_message", { ...args, request_key: "after-partner-change" })).ok, true);
  assert.equal(h.calls.filter(c => c.req.method?.startsWith("qq/connect")).length, connections);
});
test("bundled proactive errors distinguish platform limits from uncertain results and survive restart", async () => {
  for (const code of ["QQ_API_40034100", "QQ_API_40034105", "timeout with private-body"]) {
    const h = await runtime({ nodeError: code }); const result = await h.tool("send_group_message", args);
    const expected = code.startsWith("QQ_API_") ? code : "QQ_SEND_UNCERTAIN"; assert.equal(result.errorCode, expected); assert.ok(!result.message.includes("private-body"));
    const restarted = await runtime({ disk: h.disk }); assert.equal((await restarted.tool("send_group_message", args)).errorCode, expected);
    assert.equal(restarted.calls.filter(c => c.req.method === "qq/send-group").length, 0);
  }
});
test("broken proactive state and paused bot do not stop the existing question pipeline", async () => {
  const disk = new Map([["proactive-state.json", "invalid JSON"]]);
  const h = await runtime({ disk }); assert.equal((await h.tool("send_group_message", args)).errorCode, "STATE_INVALID");
  await h.receive("still-working"); assert.equal(h.calls.filter(c => c.kind === "task-send").length, 1);
  const paused = await runtime({ paused: true }); assert.equal((await paused.tool("send_group_message", args)).errorCode, "QQ_NOT_CONNECTED");
  assert.equal(paused.calls.filter(c => c.req.method === "qq/send-group").length, 0);
});
