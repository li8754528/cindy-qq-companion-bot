import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { MessageApi, ApiClient } from "@tencent-connect/qqbot-nodejs/protocol";
import { QQClientBridge } from "../src/qq-client.mjs";
import { QQBotFleet } from "../src/qq-fleet.mjs";
function setup() {
  const bots = [], bridge = new QQClientBridge(() => {
    const handlers = {}, bot = { handlers, calls: [], on(name, fn) { handlers[name] = fn; }, start() {}, stop() {},
      async sendText(target, text) { this.calls.push({ target, text }); return { id: "out-id", timestamp: "time" }; } };
    bots.push(bot); return bot;
  }, () => {});
  bridge.connect({ appId: "23456", epoch: "epoch" }, "fake-secret"); bots[0].handlers.ready(); return { bots, bridge };
}
const send = { appId: "23456", epoch: "epoch", groupId: "group_2", requestId: "outbound-1", text: "公告" };
test("worker proactive bridge sends without passive identifiers and protects its request key", async () => {
  const { bots, bridge } = setup(); const result = await bridge.sendGroup(send);
  assert.deepEqual(bots[0].calls, [{ target: { scope: "group", targetId: "group_2" }, text: "公告" }]);
  assert.equal(result.messageId, "out-id"); assert.deepEqual(await bridge.sendGroup(send), result); assert.equal(bots[0].calls.length, 1);
  await assert.rejects(bridge.sendGroup({ ...send, text: "different" }), { code: "GROUP_MESSAGE_CONFLICT" });
  await assert.rejects(bridge.sendGroup({ ...send, epoch: "old" }), { code: "QQ_NOT_CONNECTED" });
  await assert.rejects(bridge.sendGroup({ ...send, appId: "99999" }), { code: "QQ_NOT_CONNECTED" });
});
test("worker strips SDK secrets, recognizes explicit 4xx rejection, and preserves uncertain writes", async () => {
  for (const [error, code] of [[{ httpStatus: 403, bizCode: 40034105 }, "QQ_API_40034105"], [{ httpStatus: 429 }, "QQ_HTTP_429"], [{ httpStatus: 503, bizCode: 50055001 }, "QQ_SEND_UNCERTAIN"], [{ httpStatus: 0 }, "QQ_SEND_UNCERTAIN"]]) {
    const { bots, bridge } = setup(); bots[0].sendText = async () => { bots[0].calls.push({}); throw Object.assign(new Error("fake-secret response body"), error); };
    await assert.rejects(bridge.sendGroup(send), e => e.code === code && !e.message.includes("fake-secret"));
    await assert.rejects(bridge.sendGroup(send), { code: "QQ_SEND_UNCERTAIN" }); assert.equal(bots[0].calls.length, 1);
  }
});
test("worker missing receipt and replaced connection are uncertain", async () => {
  const { bots, bridge } = setup(); let finish; bots[0].sendText = () => new Promise(r => finish = r);
  const pending = bridge.sendGroup(send); bridge.connect({ appId: "23456", epoch: "new" }, "fake-secret"); finish({ id: "late" });
  await assert.rejects(pending, { code: "QQ_SEND_UNCERTAIN" });
  const other = setup(); other.bots[0].sendText = async () => ({}); await assert.rejects(other.bridge.sendGroup(send), { code: "QQ_SEND_UNCERTAIN" });
});
test("QQ bot fleet routes proactive calls to the explicitly selected bot", async () => {
  const bots = [], fleet = new QQBotFleet(opts => { const handlers = {}; const bot = { opts, handlers, on(n, fn) { handlers[n] = fn; }, start() {}, stop() {}, calls: [], async sendText(target, text) { this.calls.push({ target, text }); return { id: "receipt" }; } }; bots.push(bot); return bot; }, () => {});
  await fleet.request("qq/connect", { botId: "bot1", appId: "12345", epoch: "one" }, { qq_app_secret: "fake-1" });
  await fleet.request("qq/connect/2", { botId: "bot2", appId: "23456", epoch: "epoch" }, { qq_app_secret_2: "fake-2" }); bots.forEach(b => b.handlers.ready());
  await fleet.request("qq/send-group", { ...send, botId: "bot2" }); assert.equal(bots[0].calls.length, 0); assert.equal(bots[1].calls.length, 1);
  await assert.rejects(fleet.request("qq/send-group", { ...send, botId: "bot1" }), { code: "QQ_NOT_CONNECTED" });
});
test("pinned QQ SDK issues one proactive POST with text body and no msg_id/event_id/msg_seq", async () => {
  const requests = []; const server = http.createServer((req, res) => {
    let body = ""; req.on("data", b => body += b); req.on("end", () => { requests.push({ method: req.method, path: req.url, body: JSON.parse(body) }); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ id: "local-receipt", timestamp: "time" })); });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    const api = new MessageApi(new ApiClient({ baseUrl: "http://127.0.0.1:" + server.address().port }), { async getAccessToken() { return "local-test-token"; } }, { markdownSupport: false });
    const result = await api.sendProactiveMessage("group", "group_2", "公告", { appId: "23456", clientSecret: "fake-secret" });
    assert.equal(result.id, "local-receipt"); assert.deepEqual(requests, [{ method: "POST", path: "/v2/groups/group_2/messages", body: { content: "公告", msg_type: 0 } }]);
  } finally { await new Promise(r => server.close(r)); }
});
