import test from "node:test";
import assert from "node:assert/strict";
import { BridgeController } from "../src/controller.mjs";

function harness({ write = async () => {}, resolve = async () => ({}), send = async () => ({ accepted: true, taskId: "task-1" }), node = async () => ({ sent: true, messageId: "reply-1" }), now = () => 1_000_000 } = {}) {
  const calls = { writes: [], sends: [], nodes: [], changes: 0 };
  const host = {
    read: async () => null,
    write: async state => { calls.writes.push(structuredClone(state)); await write(state); },
    resolve: async id => resolve(id),
    send: async args => { calls.sends.push(args); return send(args); },
    node: async (method, args) => { calls.nodes.push({ method, args }); return node(method, args); },
    changed: () => { calls.changes++; }, now,
  };
  return { bridge: new BridgeController(host), calls };
}

async function connected({ allowedGroups = ["group-1"], ...opts } = {}) {
  const h = harness(opts);
  await h.bridge.init();
  await h.bridge.configure({ appId: "12345", targetId: "companion-1", enabled: true, allowedGroups });
  await h.bridge.status("connected");
  return h;
}

const msg = (overrides = {}) => ({ appId: "12345", kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", messageId: "message-1", groupId: "group-1", senderId: "member-1", text: "怎么申请？", senderIsBot: false, hasAttachments: false, ...overrides });

test("allowed group @ is delivered to selected companion and correlated reply goes to original QQ message", async () => {
  const h = await connected();
  await h.bridge.receive(msg());
  const job = h.bridge.jobs[0];
  assert.equal(job.state, "waiting");
  assert.equal(h.calls.sends.length, 1);
  assert.equal(h.calls.sends[0].target.id, "companion-1");
  assert.match(h.calls.sends[0].text, /怎么申请/);
  const result = await h.bridge.reply(job.id, "请填写表格。", "task-1");
  assert.equal(result.sent, true);
  assert.equal(h.calls.nodes.filter(x => x.method === "qq/reply").length, 1);
  assert.deepEqual(h.calls.nodes.find(x => x.method === "qq/reply").args, { appId: "12345", requestId: job.id, groupId: "group-1", messageId: "message-1", text: "请填写表格。" });
});

test("ignores non-@, non-group, bot and other-app messages; records but does not dispatch unknown groups", async () => {
  const h = await connected();
  await h.bridge.receive(msg({ rawEventType: "GROUP_MESSAGE_CREATE", messageId: "ordinary" }));
  await h.bridge.receive(msg({ kind: "c2c", messageId: "private" }));
  await h.bridge.receive(msg({ senderIsBot: true, messageId: "bot" }));
  await h.bridge.receive(msg({ appId: "other", messageId: "other" }));
  await h.bridge.receive(msg({ groupId: "group-unknown", messageId: "unknown" }));
  assert.equal(h.calls.sends.length, 0);
  assert.equal(h.bridge.jobs.length, 0);
  assert.ok(h.bridge.groups.some(g => g.id === "group-unknown"));
});

test("rejects wrong companion session and duplicate inbound/reply", async () => {
  const h = await connected();
  await h.bridge.receive(msg());
  const job = h.bridge.jobs[0];
  await assert.rejects(h.bridge.reply(job.id, "不该发", "other-task"), e => e.code === "QUESTION_FORBIDDEN");
  await h.bridge.receive(msg());
  assert.equal(h.calls.sends.length, 1);
  await h.bridge.reply(job.id, "答复", "task-1");
  const duplicate = await h.bridge.reply(job.id, "答复", "task-1");
  assert.equal(duplicate.duplicate, true);
  assert.equal(h.calls.nodes.filter(x => x.method === "qq/reply").length, 1);
});

test("serializes simultaneous reply tool calls for one QQ request", async () => {
  const h = await connected();
  await h.bridge.receive(msg());
  let release;
  let enteredResolve;
  const replyGate = new Promise(resolve => { release = resolve; });
  const replyEntered = new Promise(resolve => { enteredResolve = resolve; });
  h.bridge.host.resolve = async () => { enteredResolve(); await replyGate; };
  const id = h.bridge.jobs[0].id;
  const first = h.bridge.reply(id, "first", "task-1");
  const second = h.bridge.reply(id, "second", "task-1");
  await replyEntered;
  release();
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  assert.equal(h.calls.nodes.filter(x => x.method === "qq/reply").length, 1);
});

test("rejects unsupported content and queue overflow without sending", async () => {
  const h = await connected();
  await h.bridge.receive(msg({ hasAttachments: true }));
  assert.equal(h.bridge.jobs[0].code, "IMAGE_FORMAT_UNSUPPORTED");
  assert.equal(h.calls.sends.length, 0);
  for (let i = 0; i < 13; i++) {
    await h.bridge.receive(msg({ messageId: `m-${i}` }));
  }
  assert.equal(h.calls.sends.length, 1);
  assert.equal(h.bridge.jobs.filter(j => ["queued", "waiting"].includes(j.state)).length, 12);
  assert.equal(h.bridge.jobs.at(-1).code, "QUEUE_FULL");
});

test("turns accepted work into uncertain on restart and never resubmits it", async () => {
  const h = await connected();
  await h.bridge.receive(msg());
  const data = { schema: 1, jobs: structuredClone(h.bridge.jobs), groups: structuredClone(h.bridge.groups) };
  const next = harness();
  next.bridge.host.read = async () => data;
  await next.bridge.init();
  await next.bridge.configure({ appId: "12345", targetId: "companion-1", enabled: true, allowedGroups: ["group-1"] });
  await next.bridge.status("connected");
  assert.equal(next.bridge.jobs[0].state, "uncertain");
  assert.equal(next.calls.sends.length, 0);
});

test("does not send after durable intent write fails", async () => {
  const h = await connected();
  h.bridge.host.write = async () => { throw Object.assign(new Error("disk error"), { code: "WRITE_FAILED" }); };
  await assert.rejects(h.bridge.receive(msg()));
  assert.equal(h.calls.sends.length, 0);
});

test("does not retry a reply after QQ send has an uncertain result", async () => {
  const h = await connected({ node: async () => { throw Object.assign(new Error("network"), { code: "QQ_SEND_UNCERTAIN" }); } });
  await h.bridge.receive(msg());
  const job = h.bridge.jobs[0];
  await assert.rejects(h.bridge.reply(job.id, "答复", "task-1"), e => e.code === "QQ_SEND_UNCERTAIN");
  assert.equal(job.state, "uncertain");
  await assert.rejects(h.bridge.reply(job.id, "答复", "task-1"), e => e.code === "QUESTION_NOT_WAITING");
  assert.equal(h.calls.nodes.filter(x => x.method === "qq/reply").length, 1);
});

const cfg={appId:"12345",targetId:"companion-1",enabled:true,allowedGroups:["group-1"]};
test("pause, target change, whitelist removal and environment change prevent late replies",async()=>{for(const change of [{enabled:false},{targetId:"companion-2"},{allowedGroups:[]},{sandbox:true}]){const h=await connected();await h.bridge.receive(msg());await h.bridge.configure({...cfg,...change});await assert.rejects(h.bridge.reply(h.bridge.jobs[0].id,"answer","task-1"),e=>e.code==="CONFIG_CHANGED");assert.equal(h.calls.nodes.filter(x=>x.method==="qq/reply").length,0);}});
test("pause during target resolution cancels delivery before submission",async()=>{const h=await connected();let finish,entered;const gate=new Promise(r=>finish=r),entry=new Promise(r=>entered=r);h.bridge.host.resolve=async()=>{entered();await gate;};const incoming=h.bridge.receive(msg());await entry;await h.bridge.configure({...cfg,enabled:false});finish();await incoming;assert.equal(h.calls.sends.length,0);assert.equal(h.bridge.jobs[0].state,"cancelled");});
test("delivery transport failure uses stable key and never replays unknown acceptance",async()=>{const h=await connected({send:async()=>{throw new Error("transport lost");}});await h.bridge.receive(msg());assert.equal(h.bridge.jobs[0].state,"uncertain");assert.equal(h.calls.sends[0].requestKey,"qq:12345:message-1");await h.bridge.receive(msg());await h.bridge.tick();assert.equal(h.calls.sends.length,1);});
test("serial questions advance only after correlated reply; elapsed requests expire without reply",async()=>{let now=1_000_000;const h=await connected({now:()=>now});await h.bridge.receive(msg());await h.bridge.receive(msg({messageId:"message-2"}));assert.equal(h.calls.sends.length,1);await h.bridge.reply(h.bridge.jobs[0].id,"answer","task-1");assert.equal(h.calls.sends.length,2);assert.equal(h.bridge.jobs[1].state,"waiting");now+=600001;await assert.rejects(h.bridge.reply(h.bridge.jobs[1].id,"late","task-1"),e=>e.code==="QUESTION_EXPIRED");assert.equal(h.calls.nodes.filter(x=>x.method==="qq/reply").length,1);});
test("stale connection statuses cannot revive a previous connection or paused bot",async()=>{const h=await connected();const epoch=h.bridge.connectionEpoch;await h.bridge.configure(cfg,true);assert.notEqual(h.bridge.connectionEpoch,epoch);await h.bridge.status("connected","",epoch);assert.equal(h.bridge.connection,"connecting");await h.bridge.configure({...cfg,enabled:false});await h.bridge.status("connected");assert.equal(h.bridge.connection,"idle");});
test("durable reply intent failure prevents external QQ write",async()=>{const h=await connected();await h.bridge.receive(msg());h.bridge.host.write=async()=>{throw new Error("disk full");};await assert.rejects(h.bridge.reply(h.bridge.jobs[0].id,"answer","task-1"));assert.equal(h.calls.nodes.filter(x=>x.method==="qq/reply").length,0);});

const imageBytes="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO5kAAAAASUVORK5CYII=";
test("image-only and captioned group questions deliver real attachments without persisting image bytes",async()=>{for(const text of ["", "这张图片是什么？"]){const h=await connected();h.bridge.host.imageSupport=async()=>true;h.bridge.host.images=async()=>[{base64:imageBytes,name:"qq-image-1.png"}];await h.bridge.receive(msg({text,hasAttachments:true,imageCount:1}));assert.equal(h.calls.sends.length,1);assert.equal(h.calls.sends[0].attachments[0].base64,imageBytes);assert.match(h.calls.sends[0].text,/真实图片附件/);assert.equal(h.bridge.snapshot().jobs[0].imageCount,1);assert.ok(!JSON.stringify(h.calls.writes).includes(imageBytes));await h.bridge.reply(h.bridge.jobs[0].id,"图片答复","task-1");assert.equal(h.calls.nodes.at(-1).args.messageId,"message-1");}});
test("unsupported host or failed download never silently drops images",async()=>{for(const supported of [false,true]){const h=await connected();h.bridge.host.imageSupport=async()=>supported;h.bridge.host.images=async()=>{throw Object.assign(new Error("expired"),{code:"IMAGE_DOWNLOAD_FAILED"});};await h.bridge.receive(msg({hasAttachments:true,imageCount:1}));assert.equal(h.calls.sends.length,0);assert.equal(h.bridge.jobs[0].code,supported?"IMAGE_DOWNLOAD_FAILED":"IMAGE_HOST_UNSUPPORTED");}});
test("unallowed groups do not trigger image downloads or image capability checks",async()=>{const h=await connected();h.bridge.host.imageSupport=async()=>{throw new Error("must not be called");};await h.bridge.receive(msg({groupId:"not-allowed",imageCount:1,hasAttachments:true}));assert.equal(h.calls.sends.length,0);assert.equal(h.bridge.jobs.length,0);});
test("pause during image transfer prevents companion submission",async()=>{const h=await connected();let finish,entered;const gate=new Promise(r=>finish=r),entry=new Promise(r=>entered=r);h.bridge.host.imageSupport=async()=>true;h.bridge.host.images=async()=>{entered();await gate;return [{base64:imageBytes}];};const pending=h.bridge.receive(msg({hasAttachments:true,imageCount:1}));await entry;await h.bridge.configure({...cfg,enabled:false});finish();await pending;assert.equal(h.calls.sends.length,0);assert.equal(h.bridge.jobs[0].state,"cancelled");});
test("image delivery uncertainty is not replayed with new images or a new request key",async()=>{const h=await connected({send:async()=>{throw new Error("unknown acceptance");}});let downloads=0;h.bridge.host.imageSupport=async()=>true;h.bridge.host.images=async()=>{downloads++;return [{base64:imageBytes}];};const message=msg({hasAttachments:true,imageCount:1});await h.bridge.receive(message);await h.bridge.receive(message);assert.equal(h.bridge.jobs[0].state,"uncertain");assert.equal(downloads,1);assert.equal(h.calls.sends.length,1);});
