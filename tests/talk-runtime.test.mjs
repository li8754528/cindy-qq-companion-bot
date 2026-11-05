import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto, createHash } from "node:crypto";
import { TALK_IDLE_MS } from "../src/controller.mjs";
const code = fs.readFileSync(new URL("../main.js", import.meta.url), "utf8");

async function runtime({ disk = new Map(), tasks = new Map(), creationReceipts = new Map(), now = 1000000, targetId = "", botId = "bot1", operations = ["create", "get", "send"] } = {}) {
  const calls = [], results = [], clock = { now }, failures = {}; let handler, health = { state: "idle", appId: "" };
  class ClockDate extends Date { static now() { return clock.now; } }
  const cindy = {
    onHostMessage(fn) { handler = fn; },
    async send(result) { results.push(result); },
    async fs(req) {
      if (req.op === "read") return disk.has(req.path) ? { ok: true, content: disk.get(req.path) } : { ok: false, errorCode: "NOT_FOUND" };
      disk.set(req.path, req.content); return { ok: true };
    },
    targets: {
      async list() { return { targets: [{ id: "partner", label: "伙伴" }] }; },
      async resolve() { return {}; },
      async send(req) { calls.push({ kind: "target", req }); return { accepted: true, taskId: "partner-session" }; },
    },
    tasks: {
      async capabilities() { return { operations, messageAttachments: { kinds: ["image"] } }; },
      async create(req) {
        assert.ok(req.requestKey.length <= 128, "official tasks.create requestKey limit");
        calls.push({ kind: "create", req }); const taskId = "session-" + req.requestKey;
        if (creationReceipts.has(req.requestKey)) {
          if (!tasks.has(taskId)) throw Object.assign(new Error("Task not found"), { code: "TASK_NOT_FOUND" });
          return tasks.get(taskId);
        }
        creationReceipts.set(req.requestKey, taskId);
        if (!tasks.has(taskId)) tasks.set(taskId, { taskId, revision: 1, status: "active" }); return tasks.get(taskId);
      },
      async get(req) {
        calls.push({ kind: "get", req });
        if (failures.get) throw Object.assign(new Error(failures.get), { code: failures.get });
        if (!tasks.has(req.taskId)) throw Object.assign(new Error("Task not found"), { code: "TASK_NOT_FOUND" });
        return tasks.get(req.taskId);
      },
      async send(req) {
        assert.ok(req.requestKey.length <= 128, "official tasks.send requestKey limit");
        calls.push({ kind: "task-send", req });
        await failures.beforeSend?.(req);
        if (failures.send) throw typeof failures.send === "object" ? failures.send : Object.assign(new Error(failures.send), { code: failures.send });
        if (!tasks.has(req.taskId)) throw Object.assign(new Error("Task not found"), { code: "TASK_NOT_FOUND" });
        if (tasks.get(req.taskId).status !== "active") throw Object.assign(new Error("Archived tasks cannot accept input"), { code: "TASK_BUSY" });
        return { runId: "run-" + req.requestKey, status: "queued" };
      },
    },
    node: { async request(req) {
      calls.push({ kind: "node", req });
      if (req.method.startsWith("qq/connect")) health = { state: "connected", appId: req.params.appId, epoch: req.params.epoch };
      if (req.method === "qq/status") return { ok: true, result: health };
      if (req.method === "qq/disconnect") health = { state: "idle", appId: "" };
      return { ok: true, result: { sent: true, messageId: "answer" } };
    } },
  };
  const sandbox = { cindy, crypto: webcrypto, TextEncoder, Date: ClockDate, queueMicrotask,
    BroadcastChannel: class { postMessage() {} }, setInterval() {}, setTimeout(fn) { queueMicrotask(fn); },
    async fetch(path) {
      return { ok: true, async json() {
        if (path === "/kv") return { schema: 2, bots: [{ id: botId, appId: "12345", enabled: true, targetId, paused: false }] };
        if (path === "/secrets") return [{ key: "qq_app_secret" + (botId === "bot1" ? "" : "_" + botId.slice(3)), saved: true }]; return {};
      } };
    },
  };
  vm.runInNewContext(code, sandbox);
  let toolCounter = 0;
  async function tool(name, args) { const callId = "tool-" + ++toolCounter; await handler({ type: "tool-call", tool: name, args, callId }); return results.find(r => r.callId === callId); }
  const start = await tool("get_status", {}); assert.equal(start.ok, true); assert.equal(start.result.bootError, null);
  if (health.state === "connected") await handler({ type: "event", name: "node-notification", method: "qq/status", params: { botId, ...health } });
  async function receive(id, text, senderId = "person", groupId = "group") {
    await handler({ type: "event", name: "node-notification", method: "qq/message", params: { botId, appId: "12345", kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", senderId, groupId, messageId: id, text } });
  }
  async function reply(id, sessionId, text = "ANSWER_MARKER") { return tool("reply_to_qq", { request_id: (botId === "bot1" ? "" : botId + ":") + "12345:" + id, text, session_context: { session_id: sessionId } }); }
  return { calls, clock, disk, tasks, creationReceipts, failures, receive, reply, tool };
}
const sent = h => h.calls.filter(c => c.kind === "task-send");
test("bundled default runtime gives ordinary mentions fresh tasks and never persists their bodies", async () => {
  const h = await runtime(); await h.receive("one", "QUESTION_MARKER");
  assert.ok(!JSON.stringify([...h.disk]).includes("QUESTION_MARKER"));
  const first = sent(h)[0].req; assert.equal((await h.reply("one", "wrong")).errorCode, "QUESTION_FORBIDDEN");
  assert.equal((await h.reply("one", first.taskId)).ok, true);
  await h.receive("two", "第二条"); assert.notEqual(sent(h)[1].req.taskId, first.taskId);
  assert.ok(!JSON.stringify([...h.disk]).includes("ANSWER_MARKER"));
  assert.equal(JSON.parse(h.disk.get("bridge-state.json")).histories.length, 0);
});
test("bundled bare talk opens one actual task, acknowledges in QQ, and ordinary follow-ups reuse current revision", async () => {
  const h = await runtime(); await h.receive("open", "/talk");
  assert.equal(sent(h).length, 0); const task = h.calls.find(c => c.kind === "create").req;
  assert.match(task.requestKey, /^qq-talk:/); assert.equal(task.route, undefined); assert.equal(task.callId, undefined);
  assert.match(h.calls.find(c => c.req?.method === "qq/reply").req.params.text, /连续会话已开启/);
  await h.receive("one", "第一个问题"); const first = sent(h)[0].req; await h.reply("one", first.taskId);
  h.tasks.get(first.taskId).revision = 3; await h.receive("two", "然后呢");
  assert.equal(sent(h)[1].req.taskId, first.taskId); assert.equal(sent(h)[1].req.expectedRevision, 3);
  assert.equal(h.calls.filter(c => c.kind === "create").length, 1);
  await h.reply("two", first.taskId); await h.receive("other", "不同的人", "someone-else");
  assert.notEqual(sent(h)[2].req.taskId, first.taskId);
});
test("bundled talk restores the same task after restart but expires to a new task at two idle hours", async () => {
  const h = await runtime(); await h.receive("one", "/talk 问题"); const first = sent(h)[0].req; await h.reply("one", first.taskId);
  const next = await runtime({ disk: h.disk, tasks: h.tasks, now: h.clock.now + 100 });
  await next.receive("two", "继续"); assert.equal(sent(next)[0].req.taskId, first.taskId); await next.reply("two", first.taskId);
  next.clock.now += TALK_IDLE_MS; await next.receive("three", "/talk 新话题");
  assert.notEqual(sent(next)[1].req.taskId, first.taskId); assert.ok(!sent(next)[1].req.text.includes("ANSWER_MARKER"));
});
test("selected partner receives no internal task fields and only opted-in scope history", async () => {
  const h = await runtime({ targetId: "partner" }); await h.receive("one", "/talk 问题");
  assert.equal(h.calls.filter(c => c.kind === "create").length, 0);
  const first = h.calls.find(c => c.kind === "target").req;
  assert.equal(first.talkCreateKey, undefined); assert.equal(first.talkTaskId, undefined); await h.reply("one", "partner-session");
  await h.receive("two", "继续"); assert.match(h.calls.filter(c => c.kind === "target").at(-1).req.text, /ANSWER_MARKER/); await h.reply("two", "partner-session");
  await h.receive("other", "其他人", "different"); assert.ok(!h.calls.filter(c => c.kind === "target").at(-1).req.text.includes("ANSWER_MARKER"));
});

for (const unavailable of ["deleted", "archived"]) {
  test(`bundled ordinary follow-up ends a ${unavailable} talk without resubmitting the question`, async () => {
    const h = await runtime(); await h.receive("open", "/talk 原问题");
    const oldTask = sent(h)[0].req.taskId; await h.reply("open", oldTask);
    if (unavailable === "deleted") h.tasks.delete(oldTask); else h.tasks.get(oldTask).status = "archived";
    await h.receive("lost", "不应重发的问题");
    assert.equal(sent(h).length, 1); assert.equal(h.calls.filter(c => c.kind === "create").length, 1);
    const state = JSON.parse(h.disk.get("bridge-state.json"));
    assert.deepEqual(state.histories, []);
    assert.equal(state.jobs.at(-1).state, "replied"); assert.equal(state.jobs.at(-1).code, "TALK_TASK_UNAVAILABLE");
    assert.match(h.calls.filter(c => c.req?.method === "qq/reply").at(-1).req.params.text, /重新发送 \/talk/);
    assert.ok(!JSON.stringify([...h.disk]).includes("不应重发的问题"));
    await h.receive("new", "/talk 新问题");
    assert.notEqual(sent(h)[1].req.taskId, oldTask);
    assert.notEqual(h.calls.filter(c => c.kind === "create")[1].req.requestKey, h.calls.find(c => c.kind === "create").req.requestKey);
    assert.equal((await h.reply("new", sent(h)[1].req.taskId)).ok, true);
  });

  test(`bundled explicit talk replaces a ${unavailable} task using a new creation key`, async () => {
    const h = await runtime(); await h.receive("open", "/talk 原问题");
    const oldTask = sent(h)[0].req.taskId; await h.reply("open", oldTask);
    if (unavailable === "deleted") h.tasks.delete(oldTask); else h.tasks.get(oldTask).status = "archived";
    await h.receive("reopen", "/talk");
    const creates = h.calls.filter(c => c.kind === "create");
    assert.equal(creates.length, 2); assert.notEqual(creates[1].req.requestKey, creates[0].req.requestKey);
    assert.equal(sent(h).length, 1);
    assert.match(h.calls.filter(c => c.req?.method === "qq/reply").at(-1).req.params.text, /连续会话已开启/);
    await h.receive("next", "新的追问");
    assert.notEqual(sent(h)[1].req.taskId, oldTask);
    assert.ok(!sent(h)[1].req.text.includes("ANSWER_MARKER"));
    assert.equal((await h.reply("next", sent(h)[1].req.taskId)).ok, true);
  });
}

test("bundled unknown task lookup failure preserves talk and does not replace or send it", async () => {
  const h = await runtime(); await h.receive("open", "/talk 原问题");
  const oldTask = sent(h)[0].req.taskId; await h.reply("open", oldTask);
  h.failures.get = "TIMEOUT"; await h.receive("next", "继续");
  assert.equal(sent(h).length, 1); assert.equal(h.calls.filter(c => c.kind === "create").length, 1);
  const state = JSON.parse(h.disk.get("bridge-state.json"));
  assert.equal(state.histories[0].taskId, oldTask);
  assert.equal(state.jobs.at(-1).state, "failed"); assert.equal(state.jobs.at(-1).code, "TIMEOUT");
});

test("bundled send with unknown acknowledgement remains uncertain and never retries", async () => {
  const h = await runtime(); h.failures.send = "TIMEOUT"; await h.receive("one", "问题");
  assert.equal(sent(h).length, 1);
  const state = JSON.parse(h.disk.get("bridge-state.json"));
  assert.equal(state.jobs[0].state, "uncertain"); assert.equal(state.jobs[0].code, "TIMEOUT");
  await h.receive("one", "问题"); assert.equal(sent(h).length, 1);
});

for (const botId of ["bot1", "bot2", "bot3", "bot4"]) {
  test(`bundled ${botId} handles real-length QQ identities with bounded deterministic task keys`, async () => {
    const h = await runtime({ botId }), prefix = botId === "bot1" ? "" : botId + ":";
    const id = "ROBOT1.0_" + "x".repeat(128);
    const expected = "qq:" + createHash("sha256").update("qq:" + prefix + "12345:" + id).digest("hex");
    await h.receive(id, "普通问题"); const first = sent(h)[0].req;
    assert.equal(first.requestKey, expected);
    assert.equal(h.calls.find(c => c.kind === "create").req.requestKey, expected + ":create");
    assert.equal((await h.reply(id, first.taskId)).ok, true);
    await h.receive(id, "普通问题"); assert.equal(sent(h).length, 1);
    await h.receive(id.replace(/x$/, "y"), "/talk");
    const talkCreate = h.calls.filter(c => c.kind === "create").at(-1).req;
    assert.match(talkCreate.requestKey, /^qq-talk:/);
    await h.receive(id.replace(/x$/, "z"), "继续问题");
    assert.equal(sent(h)[1].req.taskId, "session-" + talkCreate.requestKey);
    assert.match(sent(h)[1].req.requestKey, /^qq:[0-9a-f]{64}$/);
    assert.equal((await h.reply(id.replace(/x$/, "z"), sent(h)[1].req.taskId)).ok, true);
    await h.receive(id.replace(/x$/, "w"), "/talk 再问");
    assert.equal(sent(h)[2].req.taskId, sent(h)[1].req.taskId);
    assert.equal((await h.reply(id.replace(/x$/, "w"), sent(h)[2].req.taskId)).ok, true);
  });
}

for (const code of ["INVALID_REQUEST", "REVISION_CONFLICT", "TASK_NOT_FOUND", "TASK_BUSY"]) {
  test(`bundled deterministic task send rejection ${code} is failed without resubmission`, async () => {
    const h = await runtime(); h.failures.send = code; await h.receive("one", "问题");
    const state = JSON.parse(h.disk.get("bridge-state.json"));
    assert.equal(state.jobs[0].state, "failed"); assert.equal(state.jobs[0].code, code);
    await h.receive("one", "问题"); assert.equal(sent(h).length, 1);
  });
}

for (const unavailable of ["deleted", "archived"]) {
  test(`bundled task becoming ${unavailable} between get and send ends talk and asks to reopen`, async () => {
    const h = await runtime(); await h.receive("open", "/talk");
    const taskId = h.calls.find(c => c.kind === "create").req.requestKey;
    h.failures.beforeSend = req => { if (unavailable === "deleted") h.tasks.delete(req.taskId); else h.tasks.get(req.taskId).status = "archived"; };
    h.failures.send = unavailable === "deleted" ? "TASK_NOT_FOUND" : "TASK_BUSY";
    await h.receive("next", "问题");
    const state = JSON.parse(h.disk.get("bridge-state.json"));
    assert.equal(state.histories.length, 0); assert.equal(state.jobs.at(-1).state, "replied");
    assert.equal(state.jobs.at(-1).code, "TALK_TASK_UNAVAILABLE");
    assert.match(h.calls.filter(c => c.req?.method === "qq/reply").at(-1).req.params.text, /重新发送 \/talk/);
    assert.equal(h.calls.filter(c => c.kind === "create").length, 1);
    delete h.failures.beforeSend; delete h.failures.send; await h.receive("new", "/talk 新问题");
    assert.notEqual(h.calls.filter(c => c.kind === "create").at(-1).req.requestKey, taskId);
    assert.equal((await h.reply("new", sent(h).at(-1).req.taskId)).ok, true);
  });
}

test("bundled task busy from attachment pressure does not end an active talk", async () => {
  const h = await runtime(); await h.receive("open", "/talk");
  h.failures.send = "TASK_BUSY"; await h.receive("next", "问题");
  const state = JSON.parse(h.disk.get("bridge-state.json"));
  assert.equal(state.histories.length, 1); assert.equal(state.jobs.at(-1).state, "failed");
  assert.equal(h.calls.filter(c => c.req?.method === "qq/reply").length, 1);
});

for (const failure of ["HOST_NOT_READY", "PERMISSION_DENIED", new Error("unknown acknowledgement")]) {
  test(`bundled unknown send failure ${failure.code || failure} remains uncertain`, async () => {
    const h = await runtime(); h.failures.send = failure; await h.receive("one", "问题");
    const state = JSON.parse(h.disk.get("bridge-state.json")); assert.equal(state.jobs[0].state, "uncertain");
    await h.receive("one", "问题"); assert.equal(sent(h).length, 1);
  });
}

test("bundled default route requires task recovery capability before connecting", async () => {
  const h = await runtime({ operations: ["create", "send"] });
  const status = await h.tool("get_status", {});
  assert.equal(status.result.bots[0].connectionCode, "HOST_UNSUPPORTED");
  assert.equal(h.calls.filter(c => c.req?.method.startsWith?.("qq/connect")).length, 0);
});

for (const firstFailure of ["HOST_NOT_READY", "TASK_BUSY"]) {
  for (const unavailable of ["deleted", "archived"]) {
    for (const reopen of ["/talk", "/talk 新问题"]) {
      test(`bundled talk persists creation before ${firstFailure} and reopens ${unavailable} task with ${reopen}`, async () => {
        const h = await runtime(); h.failures.send = firstFailure;
        await h.receive("open", "/talk 原问题");
        const oldKey = h.calls.find(c => c.kind === "create").req.requestKey;
        const oldTask = "session-" + oldKey;
        const firstState = JSON.parse(h.disk.get("bridge-state.json"));
        assert.equal(firstState.histories[0].taskId, oldTask);
        assert.equal(firstState.jobs[0].state, firstFailure === "HOST_NOT_READY" ? "uncertain" : "failed");
        if (unavailable === "deleted") h.tasks.delete(oldTask); else h.tasks.get(oldTask).status = "archived";
        delete h.failures.send; await h.receive("reopen", reopen);
        const creates = h.calls.filter(c => c.kind === "create");
        assert.equal(creates.length, 2); assert.notEqual(creates[1].req.requestKey, oldKey);
        const state = JSON.parse(h.disk.get("bridge-state.json"));
        assert.notEqual(state.histories[0].id, firstState.histories[0].id);
        assert.equal(state.histories[0].taskId, "session-" + creates[1].req.requestKey);
        if (reopen === "/talk") {
          assert.equal(sent(h).length, 1);
          assert.match(h.calls.filter(c => c.req?.method === "qq/reply").at(-1).req.params.text, /连续会话已开启/);
          await h.receive("next", "继续");
        }
        assert.equal(sent(h).at(-1).req.taskId, state.histories[0].taskId);
        assert.equal((await h.reply(reopen === "/talk" ? "next" : "reopen", state.histories[0].taskId)).ok, true);
      });
    }
  }
}

for (const unavailable of ["deleted", "archived"]) {
  for (const input of ["继续问题", "/talk", "/talk 新问题"]) {
    test(`bundled legacy talk without taskId handles replay of ${unavailable} task for ${input}`, async () => {
      const first = await runtime(); first.failures.send = "HOST_NOT_READY"; await first.receive("open", "/talk 问题");
      const key = first.calls.find(c => c.kind === "create").req.requestKey, taskId = "session-" + key;
      const state = JSON.parse(first.disk.get("bridge-state.json")); delete state.histories[0].taskId;
      first.disk.set("bridge-state.json", JSON.stringify(state));
      if (unavailable === "deleted") first.tasks.delete(taskId); else first.tasks.get(taskId).status = "archived";
      const h = await runtime({ disk: first.disk, tasks: first.tasks, creationReceipts: first.creationReceipts });
      await h.receive("next", input);
      const after = JSON.parse(h.disk.get("bridge-state.json"));
      if (input === "继续问题") {
        assert.equal(after.histories.length, 0); assert.equal(sent(h).length, 0);
        assert.equal(after.jobs.at(-1).code, "TALK_TASK_UNAVAILABLE");
        assert.match(h.calls.filter(c => c.req?.method === "qq/reply").at(-1).req.params.text, /重新发送 \/talk/);
      } else {
        const newKey = h.calls.filter(c => c.kind === "create").at(-1).req.requestKey;
        assert.notEqual(newKey, key); assert.equal(after.histories[0].taskId, "session-" + newKey);
        if (input === "/talk") {
          assert.match(h.calls.filter(c => c.req?.method === "qq/reply").at(-1).req.params.text, /连续会话已开启/);
          await h.receive("follow", "继续");
        }
        assert.equal(sent(h).at(-1).req.taskId, "session-" + newKey);
        assert.equal((await h.reply(input === "/talk" ? "follow" : "next", "session-" + newKey)).ok, true);
      }
    });
  }
}
