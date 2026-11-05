import test from "node:test";
import assert from "node:assert/strict";
import { BridgeController, TALK_IDLE_MS } from "../src/controller.mjs";

const cfg = { appId: "12345", targetId: "partner", enabled: true, groupMode: "all" };
const message = (id, text, extra = {}) => ({ appId: "12345", kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", messageId: id, groupId: "group", senderId: "person", text, ...extra });
async function harness(disk, time = 1000000) {
  const writes = [], sends = [], nodes = [], clock = { now: time };
  const bridge = new BridgeController({
    now: () => clock.now, read: async () => disk || null,
    write: async data => writes.push(structuredClone(data)),
    resolve: async () => ({}),
    send: async args => { sends.push(args); return { accepted: true, taskId: "partner-session" }; },
    node: async (method, args) => { nodes.push({ method, args }); return { sent: true }; },
  });
  await bridge.init(); await bridge.configure(cfg); await bridge.status("connected");
  return { bridge, writes, sends, nodes, clock };
}
async function answer(h, id, text = "ANSWER_MARKER") { return h.bridge.reply("12345:" + id, text, "partner-session"); }
test("ordinary mentions never persist bodies or accumulate history, while dedup still works", async () => {
  const h = await harness(); await h.bridge.receive(message("one", "QUESTION_MARKER"));
  assert.ok(!JSON.stringify(h.writes).includes("QUESTION_MARKER"));
  await answer(h, "one"); assert.ok(!JSON.stringify(h.writes).includes("ANSWER_MARKER"));
  assert.equal(h.bridge.histories.length, 0); assert.equal(h.bridge.jobs[0].preview, undefined);
  await h.bridge.receive(message("two", "后续问题"));
  assert.ok(!h.sends[1].text.includes("ANSWER_MARKER")); assert.match(h.sends[1].text, /一次性问答/);
  await answer(h, "two"); await h.bridge.receive(message("one", "QUESTION_MARKER"));
  assert.equal(h.sends.length, 2); assert.equal((await answer(h, "one")).duplicate, true);
});
test("bare talk replies directly and opts only this person into subsequent ordinary mentions", async () => {
  const h = await harness(); await h.bridge.receive(message("open", "/talk"));
  assert.equal(h.sends.length, 0); assert.equal(h.nodes.filter(n => n.method === "qq/reply").length, 1);
  const id = h.bridge.histories[0].id;
  await h.bridge.receive(message("follow", "继续问")); assert.equal(h.bridge.jobs.at(-1).talkId, id); await answer(h, "follow");
  await h.bridge.receive(message("other", "问题", { senderId: "another" }));
  assert.equal(h.bridge.jobs.at(-1).talkId, undefined); assert.ok(!h.sends.at(-1).text.includes("ANSWER_MARKER"));
});
test("talk with a question strips the command and ordinary follow-ups include only this scope", async () => {
  const h = await harness(); await h.bridge.receive(message("one", "/talk 独特问题"));
  assert.equal(h.bridge.jobs[0].text, undefined); assert.match(h.sends[0].text, /"独特问题"/); await answer(h, "one");
  for (const [id, extra] of [["sender", { senderId: "someone-else" }], ["group", { groupId: "other-group" }]]) {
    await h.bridge.receive(message(id, "问题", extra)); assert.equal(h.bridge.jobs.at(-1).talkId, undefined);
    assert.ok(!h.sends.at(-1).text.includes("ANSWER_MARKER")); await answer(h, id, "OTHER_ANSWER");
  }
  await h.bridge.receive(message("follow", "然后呢"));
  assert.match(h.sends.at(-1).text, /ANSWER_MARKER/); assert.ok(!h.sends.at(-1).text.includes("OTHER_ANSWER"));
});
test("at exactly two hours idle ordinary mentions are one-shot and the next talk opens a new session", async () => {
  const h = await harness(); await h.bridge.receive(message("one", "/talk 问题")); await answer(h, "one"); const id = h.bridge.histories[0].id;
  h.clock.now += TALK_IDLE_MS; await h.bridge.receive(message("once", "又一个问题"));
  assert.equal(h.bridge.jobs.at(-1).talkId, undefined); assert.equal(h.bridge.histories.length, 0); await answer(h, "once");
  await h.bridge.receive(message("new", "/talk 新会话"));
  assert.notEqual(h.bridge.histories[0].id, id); assert.ok(!h.sends.at(-1).text.includes("ANSWER_MARKER"));
});
test("accepted user input and a confirmed reply both extend the idle deadline", async () => {
  const h = await harness(); await h.bridge.receive(message("one", "/talk 问题")); await answer(h, "one"); const id = h.bridge.histories[0].id;
  h.clock.now += TALK_IDLE_MS - 1000; await h.bridge.receive(message("two", "续聊"));
  const receivedAt = h.clock.now; assert.equal(h.bridge.histories[0].updatedAt, receivedAt);
  h.clock.now += 500; await answer(h, "two"); assert.equal(h.bridge.histories[0].updatedAt, h.clock.now);
  h.clock.now += TALK_IDLE_MS - 1000; await h.bridge.receive(message("three", "再问")); assert.equal(h.bridge.jobs.at(-1).talkId, id);
});
test("duplicate, unsupported attachment and queue-full messages do not extend talk activity", async () => {
  const h = await harness(); await h.bridge.receive(message("open", "/talk")); const original = h.bridge.histories[0].updatedAt;
  h.clock.now += 100; await h.bridge.receive(message("open", "/talk")); assert.equal(h.bridge.histories[0].updatedAt, original);
  await h.bridge.receive(message("invalid", "/talk", { hasAttachments: true })); assert.equal(h.bridge.histories[0].updatedAt, original);
  for (let i = 0; i < 12; i++) await h.bridge.receive(message("q" + i, "问题"));
  const beforeFull = h.bridge.histories[0].updatedAt; h.clock.now += 100;
  await h.bridge.receive(message("overflow", "/talk")); assert.equal(h.bridge.jobs.at(-1).code, "QUEUE_FULL"); assert.equal(h.bridge.histories[0].updatedAt, beforeFull);
});
test("talk stays scoped to its configured partner and resumes safely across restart", async () => {
  const h = await harness(); await h.bridge.receive(message("one", "/talk 问题")); await answer(h, "one");
  const next = await harness(h.writes.at(-1), h.clock.now + 100);
  await next.bridge.receive(message("next", "续聊")); assert.match(next.sends.at(-1).text, /ANSWER_MARKER/); await answer(next, "next");
  await next.bridge.configure({ ...cfg, targetId: "different-partner" });
  await next.bridge.receive(message("different", "问题")); assert.equal(next.bridge.jobs.at(-1).talkId, undefined); assert.ok(!next.sends.at(-1).text.includes("ANSWER_MARKER"));
});
test("legacy automatic history is cleared without dropping request dedup identities", async () => {
  const h = await harness({ schema: 2, jobs: [{ id: "12345:old", state: "replied", createdAt: 1000000, preview: "OLD_QUESTION" }], groups: [], histories: [{ key: "old", updatedAt: 1000000, turns: [{ answer: "OLD_ANSWER" }] }] });
  assert.equal(h.bridge.histories.length, 0); assert.equal(h.bridge.jobs.length, 1);
  assert.ok(!JSON.stringify(h.writes).includes("OLD_")); await h.bridge.receive(message("old", "再次到达")); assert.equal(h.sends.length, 0);
});
test("idle cleanup is persisted by tick and bare talk advances an already queued question", async () => {
  const h = await harness();
  // Simulate an established socket that has not yet notified the controller.
  await h.bridge.status("connecting"); await h.bridge.receive(message("open", "/talk")); await h.bridge.receive(message("next", "排队追问"));
  await h.bridge.status("connected"); assert.equal(h.sends.length, 1); assert.equal(h.bridge.jobs[1].state, "waiting"); await answer(h, "next");
  h.clock.now += TALK_IDLE_MS; await h.bridge.tick(); assert.equal(h.bridge.histories.length, 0); assert.deepEqual(h.writes.at(-1).histories, []);
});
