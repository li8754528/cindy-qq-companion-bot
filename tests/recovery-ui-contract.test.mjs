import test from "node:test";
import assert from "node:assert/strict";
import { BridgeFleet } from "../src/fleet.mjs";

function harness(node = async () => ({})) {
  const disk = new Map(), calls = [], sends = [], clock = { now: 1000000 };
  const fleet = new BridgeFleet({ forBot: id => ({
    now: () => clock.now, read: async () => disk.get(id), write: async state => disk.set(id, structuredClone(state)),
    resolve: async () => ({}), defaultSupport: async () => {},
    send: async args => { sends.push(args); return { accepted: true, taskId: "new-session" }; },
    node: async (method, args) => { calls.push({ id, method }); return node(method, args); },
  }) });
  return { fleet, calls, sends, disk, clock };
}
const bot = { id: "bot1", appId: "12345", targetId: "", enabled: true };
const message = (messageId, text) => ({ botId: "bot1", appId: "12345", kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", groupId: "group", senderId: "sender", messageId, text });
test("empty and paused startup slots do not call an unavailable worker", async () => {
  const h = harness(async () => { throw Object.assign(new Error("offline"), { code: "NODE_REQUEST_FAILED" }); });
  await h.fleet.init(); await h.fleet.configure({ bots: [{ ...bot, enabled: false, paused: true }] });
  assert.equal(h.calls.length, 0); assert.equal(h.fleet.snapshot().bots[0].connection, "idle");
});
test("one startup connection failure leaves the fleet usable and schedules recovery", async () => {
  const h = harness(async (method, args) => { if (args.botId === "bot1") throw Object.assign(new Error("offline"), { code: "NODE_REQUEST_FAILED" }); });
  await h.fleet.init(); await h.fleet.configure({ bots: [bot, { ...bot, id: "bot2", appId: "67890" }] });
  assert.equal(h.fleet.snapshot().bots[0].connectionCode, "NODE_REQUEST_FAILED");
  assert.equal(h.fleet.snapshot().bots[1].connection, "connecting"); assert.ok(h.fleet.recovery.has("bot1"));
});
test("failed disconnect pauses local dispatch without poisoning other bots", async () => {
  let fail = false; const h = harness(async method => { if (fail && method === "qq/disconnect") throw Object.assign(new Error("offline"), { code: "NODE_REQUEST_FAILED" }); });
  await h.fleet.init(); await h.fleet.configure({ bots: [bot] }); fail = true;
  await h.fleet.configure({ bots: [{ ...bot, enabled: false, paused: true }] });
  assert.equal(h.fleet.snapshot().bots[0].connection, "error");
  await h.fleet.receive(message("paused", "问题")); assert.equal(h.sends.length, 0); assert.equal(h.fleet.recovery.size, 0);
});
test("unselected route connects and dispatches to a new task with caller checks intact", async () => {
  const h = harness(async () => ({ sent: true })); await h.fleet.init(); await h.fleet.configure({ bots: [bot] });
  await h.fleet.status({ botId: "bot1", state: "connected" }); await h.fleet.receive(message("first", "问题"));
  assert.equal(h.sends[0].target, undefined); assert.equal(h.sends[0].route, undefined);
  await assert.rejects(h.fleet.reply("12345:first", "答复", "wrong"), e => e.code === "QUESTION_FORBIDDEN");
  await h.fleet.reply("12345:first", "答复", "new-session"); assert.equal(h.fleet.controllers.get("bot1").jobs[0].state, "replied");
});
test("queued talk resume preserves history before its turn, even if the request expires", async () => {
  const h = harness(async () => ({ sent: true })); await h.fleet.init(); await h.fleet.configure({ bots: [bot] });
  await h.fleet.status({ botId: "bot1", state: "connected" });
  await h.fleet.receive(message("old", "/talk 旧问题")); await h.fleet.reply("12345:old", "旧答案", "new-session");
  await h.fleet.receive(message("active", "追问")); await h.fleet.receive(message("reset", "/talk 继续"));
  assert.equal(h.fleet.controllers.get("bot1").histories[0].turns[0].answer, "旧答案");
  h.clock.now += 600001; await h.fleet.tick();
  assert.equal(h.fleet.controllers.get("bot1").histories[0].turns[0].answer, "旧答案");
});
test("removing the last bot clears all slot records and permits clean reuse", async () => {
  const h = harness(); await h.fleet.init(); await h.fleet.configure({ bots: [bot] });
  const b = h.fleet.controllers.get("bot1"); b.jobs = [{ id: "old", state: "failed" }]; b.groups = [{ id: "group" }]; b.histories = [{ key: "old", turns: [], updatedAt: h.clock.now }];
  await assert.rejects(h.fleet.clearBot("bot1"), e => e.code === "BOT_STILL_CONFIGURED");
  await h.fleet.configure({ bots: [] }); await h.fleet.clearBot("bot1");
  assert.deepEqual(h.disk.get("bot1"), { schema: 3, jobs: [], groups: [], histories: [] });
  assert.deepEqual(h.fleet.snapshot().bots, []); await h.fleet.configure({ bots: [bot] }); assert.deepEqual(b.jobs, []);
});
test("diagnostic snapshot is available before or during failed initialization", () => {
  const h = harness(); assert.equal(h.fleet.snapshot().bots[0].connectionCode, "BOOT_PENDING");
});
test("switching partners during an awaited submission cancels the old request and frees the queue", async () => {
  const h = harness(); let finish, started; const start = new Promise(r => started = r);
  await h.fleet.init(); await h.fleet.configure({ bots: [bot] }); await h.fleet.status({ botId: "bot1", state: "connected" });
  const b = h.fleet.controllers.get("bot1"); b.host.send = async () => { started(); return new Promise(r => finish = r); };
  const receive = h.fleet.receive(message("slow", "问题")); await start;
  await h.fleet.configure({ bots: [{ ...bot, targetId: "new-partner" }] });
  finish({ accepted: true, taskId: "old-session" }); await receive;
  assert.equal(b.jobs[0].state, "cancelled"); assert.equal(b.jobs[0].code, "CONFIG_CHANGED");
  b.host.send = async () => ({ accepted: true, taskId: "new-session" });
  await h.fleet.receive(message("new", "新问题")); assert.equal(b.jobs[1].state, "waiting");
});
const emptyState = { schema: 3, jobs: [], groups: [], histories: [] };
test("deletion clears a slot immediately while its target receipt is pending", async () => {
  const h = harness(); let finish, started; const start = new Promise(r => started = r);
  await h.fleet.init(); await h.fleet.configure({ bots: [bot] }); await h.fleet.status({ botId: "bot1", state: "connected" });
  const b = h.fleet.controllers.get("bot1"); b.host.send = async () => { started(); return new Promise(r => finish = r); };
  const receive = h.fleet.receive(message("slow", "问题")); await start;
  await h.fleet.configure({ bots: [] }); await h.fleet.clearBot("bot1");
  assert.deepEqual(h.disk.get("bot1"), emptyState);
  finish({ accepted: true, taskId: "old-session" }); await receive;
  assert.deepEqual(h.disk.get("bot1"), emptyState);
  await assert.rejects(async () => h.fleet.question("12345:slow", "old-session"), e => e.code === "QUESTION_FORBIDDEN");
});
test("deletion during image transfer cannot restore a job or send its image later", async () => {
  const h = harness(); let finish, started; const start = new Promise(r => started = r);
  await h.fleet.init(); await h.fleet.configure({ bots: [bot] }); await h.fleet.status({ botId: "bot1", state: "connected" });
  const b = h.fleet.controllers.get("bot1"); b.host.imageSupport = async () => true; b.host.images = async () => { started(); return new Promise(r => finish = r); };
  const receive = h.fleet.receive({ ...message("image", "图片"), imageCount: 1, hasAttachments: true }); await start;
  await h.fleet.configure({ bots: [] }); await h.fleet.clearBot("bot1");
  finish([{ base64: "aW1hZ2U=" }]); await receive;
  assert.equal(h.sends.length, 0); assert.deepEqual(h.disk.get("bot1"), emptyState);
});
test("late QQ reply after deletion cannot restore cleared history", async () => {
  const h = harness(); let finish, started; const start = new Promise(r => started = r);
  await h.fleet.init(); await h.fleet.configure({ bots: [bot] }); await h.fleet.status({ botId: "bot1", state: "connected" });
  await h.fleet.receive(message("reply", "问题"));
  const b = h.fleet.controllers.get("bot1"), original = b.host.node;
  b.host.node = async (method, args) => { if (method !== "qq/reply") return original(method, args); started(); return new Promise(r => finish = r); };
  const reply = h.fleet.reply("12345:reply", "答复", "new-session"); await start;
  await h.fleet.configure({ bots: [] }); await h.fleet.clearBot("bot1");
  finish({ sent: true, messageId: "reply-id" }); assert.equal((await reply).sent, true);
  assert.deepEqual(h.disk.get("bot1"), emptyState);
});
test("default-task sender receives a guard that cancels sending after delayed creation", async () => {
  const h = harness(); let finish, started, sends = 0; const start = new Promise(r => started = r);
  await h.fleet.init(); await h.fleet.configure({ bots: [bot] }); await h.fleet.status({ botId: "bot1", state: "connected" });
  const b = h.fleet.controllers.get("bot1"); b.host.send = async (params, assertCurrent) => { started(); await new Promise(r => finish = r); assertCurrent(); sends++; return { accepted: true, taskId: "new-session" }; };
  const receive = h.fleet.receive(message("create", "问题")); await start;
  await h.fleet.configure({ bots: [] }); await h.fleet.clearBot("bot1"); finish(); await receive;
  assert.equal(sends, 0); assert.deepEqual(h.disk.get("bot1"), emptyState);
});
