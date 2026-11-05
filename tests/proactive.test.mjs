import test from "node:test";
import assert from "node:assert/strict";
import { ProactiveSender } from "../src/proactive.mjs";
const args = { bot_id: "bot2", group_openid: "group_2", text: "通知正文_MARKER", request_key: "notice-001" };
function setup({ disk = null, send, write, now = 1000000 } = {}) {
  const h = { disk, calls: [], writes: [], now, current: true, context: { botId: "bot2", appId: "23456", sandbox: true, enabled: true, connection: "connected", epoch: "epoch" } };
  h.sender = new ProactiveSender({
    read: async () => h.disk,
    write: async data => { if (write) await write(data, h); h.disk = structuredClone(data); h.writes.push(h.disk); },
    now: () => h.now,
    context: id => ({ ...h.context, botId: id }), current: () => h.current, isQQSession: id => id === "qq-task",
    send: async (params, callId) => { h.calls.push({ params, callId }); return send ? send(params, h) : { sent: true, messageId: "out-id", timestamp: "2026-11-05T12:00:00+08:00" }; },
  });
  h.send = (input = args, session = "owner-task") => h.sender.send(input, session, "call-1");
  return h;
}
test("proactive send durably records intent, returns exact destination, deduplicates and never stores text", async () => {
  const h = setup({ send: async (_, h) => { assert.equal(h.disk.records[0].state, "sending"); return { sent: true, messageId: "out-id" }; } });
  const result = await h.send();
  assert.deepEqual(result, { sent: true, bot_id: "bot2", app_id: "23456", sandbox: true, group_openid: "group_2", request_key: "notice-001", message_id: "out-id" });
  assert.deepEqual(await h.send(), result); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].callId, "call-1");
  assert.equal(h.calls[0].params.messageId, undefined); assert.equal(h.calls[0].params.epoch, "epoch");
  assert.ok(!JSON.stringify(h.disk).includes(args.text)); assert.ok(!JSON.stringify(h.sender.snapshot()).includes("fingerprint"));
  assert.match(h.disk.records[0].fingerprint, /^[a-f0-9]{64}$/);
  const restarted = setup({ disk: h.disk }); await restarted.sender.init();
  assert.deepEqual(await restarted.send(), result); assert.equal(restarted.calls.length, 0);
});
test("proactive request key cannot change robot, AppID, environment, group or text", async () => {
  const h = setup(); await h.send();
  for (const patch of [{ bot_id: "bot1" }, { group_openid: "another-group" }, { text: "different" }]) await assert.rejects(h.send({ ...args, ...patch }), { code: "GROUP_MESSAGE_CONFLICT" });
  h.context.appId = "99999"; await assert.rejects(h.send(), { code: "GROUP_MESSAGE_CONFLICT" });
  h.context.appId = "23456"; h.context.sandbox = false; await assert.rejects(h.send(), { code: "GROUP_MESSAGE_CONFLICT" });
  assert.equal(h.calls.length, 1);
});
test("concurrent identical calls send once; uncertain calls stay blocked after restart", async () => {
  let finish, started; const signal = new Promise(r => started = r);
  const h = setup({ send: () => { started(); return new Promise(r => finish = r); } });
  const first = h.send(); await signal;
  await assert.rejects(h.send(), { code: "QQ_SEND_UNCERTAIN" }); assert.equal(h.calls.length, 1);
  const restarted = setup({ disk: h.disk }); await restarted.sender.init();
  assert.equal(restarted.disk.records[0].state, "uncertain"); await assert.rejects(restarted.send(), { code: "QQ_SEND_UNCERTAIN" }); assert.equal(restarted.calls.length, 0);
  finish({ sent: true, messageId: "out-id" }); await first;
});
test("network errors, missing receipt and late connection changes never permit retry", async () => {
  for (const send of [async () => { throw new Error("private token"); }, async () => ({ sent: true }), async (_, h) => { h.current = false; return { sent: true, messageId: "late-id" }; }]) {
    const h = setup({ send });
    await assert.rejects(h.send(), e => e.code === "QQ_SEND_UNCERTAIN" && !e.message.includes("private token"));
    h.current = true; await assert.rejects(h.send(), { code: "QQ_SEND_UNCERTAIN" }); assert.equal(h.calls.length, 1);
    assert.equal(h.disk.records[0].state, "uncertain");
  }
});
test("platform rejections keep numeric code, explain next step and do not replay", async () => {
  for (const [code, message] of [["QQ_API_40034100", "配额"], ["QQ_API_40034105", "权限"], ["QQ_API_40034101", "群成员"], ["QQ_HTTP_403", "权限"]]) {
    const h = setup({ send: async () => { throw Object.assign(new Error("private token"), { code }); } });
    await assert.rejects(h.send(), e => e.code === code && e.message.includes(message) && !e.message.includes("private token"));
    await assert.rejects(h.send(), { code }); assert.equal(h.calls.length, 1); assert.equal(h.disk.records[0].state, "failed");
  }
});
test("invalid arguments, QQ-origin sessions, paused bots and changed settings fail before sends", async () => {
  const h = setup();
  for (const patch of [{ bot_id: "bot5" }, { group_openid: "group/path" }, { text: "   " }, { text: "a".repeat(1801) }, { request_key: "a/path" }]) await assert.rejects(h.send({ ...args, ...patch }), { code: "INVALID_GROUP_MESSAGE" });
  await assert.rejects(h.send(args, "qq-task"), { code: "PROACTIVE_FORBIDDEN" }); await assert.rejects(h.send(args, ""), { code: "PROACTIVE_FORBIDDEN" });
  h.context.enabled = false; await assert.rejects(h.send(), { code: "QQ_NOT_CONNECTED" });
  h.context.enabled = true; h.current = false; await assert.rejects(h.send(), { code: "CONFIG_CHANGED" });
  assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0);
});
test("failed durable writes stop external actions; late receipt-write failure cannot resend", async () => {
  const h = setup({ write: async () => { throw Object.assign(new Error("disk full"), { code: "PROACTIVE_STATE_WRITE_FAILED" }); } });
  await assert.rejects(h.send(), { code: "PROACTIVE_STATE_WRITE_FAILED" }); assert.equal(h.calls.length, 0);
  const late = setup({ write: async (_, h) => { if (h.calls.length) throw Object.assign(new Error("disk full"), { code: "PROACTIVE_STATE_WRITE_FAILED" }); } });
  const receipt = await late.send(); assert.equal(receipt.sent, true); assert.equal(receipt.message_id, "out-id"); assert.equal(receipt.state_saved, false); assert.match(receipt.warning, /QQ 已确认.*保存失败/);
  assert.equal((await late.send()).message_id, "out-id"); assert.equal(late.calls.length, 1);
  const restarted = setup({ disk: late.disk }); await restarted.sender.init(); await assert.rejects(restarted.send(), { code: "QQ_SEND_UNCERTAIN" });
});
test("transient intent-write failure blocks that request but does not disable a separate new send", async () => {
  let writes = 0; const h = setup({ write: async () => { if (++writes === 1) throw new Error("temporarily unwritable"); } });
  await assert.rejects(h.send(), e => e.code === "PROACTIVE_STATE_WRITE_FAILED" && e.message.includes("消息未发出"));
  await assert.rejects(h.send(), { code: "PROACTIVE_STATE_WRITE_FAILED" }); assert.equal(h.calls.length, 0);
  assert.equal((await h.send({ ...args, request_key: "separate-notice" })).sent, true); assert.equal(h.calls.length, 1); assert.equal(writes, 3);
  const restarted = setup({ disk: h.disk }); await restarted.sender.init(); await assert.rejects(restarted.send(), { code: "PROACTIVE_STATE_WRITE_FAILED" }); assert.equal(restarted.calls.length, 0);
});
test("an uncertain network send stays uncertain even when its terminal state cannot be saved", async () => {
  const h = setup({ write: async (_, h) => { if (h.calls.length) throw new Error("disk full"); }, send: async () => { throw new Error("network interrupted"); } });
  await assert.rejects(h.send(), e => e.code === "QQ_SEND_UNCERTAIN" && e.message.includes("查看目标群"));
  await assert.rejects(h.send(), { code: "QQ_SEND_UNCERTAIN" }); assert.equal(h.calls.length, 1);
});
test("configuration change while persisting intent is caught before node dispatch", async () => {
  const h = setup({ write: async (_, h) => { h.current = false; } });
  await assert.rejects(h.send(), { code: "CONFIG_CHANGED" }); assert.equal(h.calls.length, 0); assert.equal(h.disk.records[0].state, "failed");
});
test("outbox expires after seven days and rejects incompatible state", async () => {
  const h = setup(); await h.send(); h.now += 7 * 24 * 60 * 60 * 1000; assert.equal(h.sender.snapshot().length, 0);
  const restarted = setup({ disk: h.disk, now: h.now }); await restarted.sender.init(); assert.equal(restarted.sender.snapshot().length, 0); assert.equal(restarted.disk.records.length, 0);
  await h.send(); assert.equal(h.calls.length, 2); assert.equal(h.disk.records.length, 1);
  for (const disk of [{ schema: 2, records: [] }, { schema: 1, records: [{ state: "sent" }] }]) await assert.rejects(setup({ disk }).sender.init(), { code: "PROACTIVE_STATE_INVALID" });
  const corruptReceipt = structuredClone(h.disk); delete corruptReceipt.records[0].messageId;
  await assert.rejects(setup({ disk: corruptReceipt }).sender.init(), { code: "PROACTIVE_STATE_INVALID" });
});
