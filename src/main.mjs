import { fault } from "./controller.mjs";
import { BridgeFleet } from "./fleet.mjs";
import { fleetConfig, secretKey } from "./config.mjs";
import { collectImages } from "./image-transfer.mjs";
import { ProactiveSender, sendErrorMessage } from "./proactive.mjs";
import { StateStore } from './state-store.mjs';
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
  if (!['get','send'].every(op=>caps?.operations?.includes(op)&&typeof cindy.tasks?.[op]==='function') || !['list','resolve','send','get'].every(op=>typeof cindy.targets?.[op]==='function')) throw fault('HOST_UNSUPPORTED','当前 Cindy 缺少项目投递或独立任务续聊能力。');
};
// Omit creation permission so the Host applies the owner's task preference.
async function sendQuestion(params, assertCurrent) {
  assertCurrent();await defaultSupport();assertCurrent();
  let task;
  if(params.taskId)try {
    task=await cindy.tasks.get({taskId:params.taskId});assertCurrent();
    if(task.status!=='active')task=null;
  } catch(error) {if(error.code==='TASK_NOT_FOUND')task=null;else {error.beforeSend=true;throw error;}}
  if(task) {
    const caps=await cindy.tasks.capabilities();
    if(!caps.operations?.includes('setModel')||typeof cindy.tasks.setModel!=='function')throw Object.assign(fault('HOST_UNSUPPORTED','宿主缺少群模型同步能力。'),{beforeSend:true});
    try {const selected=await cindy.tasks.setModel({taskId:task.taskId,expectedRevision:task.revision,route:params.route});task=selected.task;assertCurrent();}
    catch(error) {error.beforeSend=true;throw error;}
    if(!task||task.taskId!==params.taskId)throw Object.assign(fault('TASK_SOURCE_CONFLICT','任务回执不匹配。'),{beforeSend:true});
    const run=await cindy.tasks.send({taskId:task.taskId,expectedRevision:task.revision,requestKey:params.requestKey,text:params.text,...(params.attachments?{attachments:params.attachments}:{})});
    if(!run?.runId)throw fault('DELIVERY_UNCERTAIN','任务受理结果不确定，未重发。');
    return {accepted:true,taskId:task.taskId,runId:run.runId};
  }
  const receipt=await cindy.targets.send({target:{kind:'project',id:params.projectId},requestKey:params.requestKey,text:params.text,title:'QQ 成员连续会话',route:params.route,delivery:'queue',...(params.attachments?{attachments:params.attachments}:{})});
  if(!receipt?.accepted||!receipt.taskId)throw fault('DELIVERY_UNCERTAIN','项目投递结果不确定，未重发。');
  await recordSource(receipt.taskId);assertCurrent();return receipt;
}
const connectionScopes = new Map(), migratedQQSessions = new Set();
const rawIO={
  read:async path=>{const value=await cindy.fs({op:'read',root:'data',path});if(value.ok)return value.content;if(['NOT_FOUND','FILE_NOT_FOUND','ENOENT'].includes(value.errorCode)||/not found|不存在|ENOENT/i.test(value.message||''))return null;throw fault('STATE_READ_FAILED','状态读取失败，未重放。');},
  write:async(path,content)=>{const value=await cindy.fs({op:'write',root:'data',path,content});if(!value.ok)throw fault('STATE_WRITE_FAILED','状态保存失败，未发送。');},
};
const stores=new Map(['bot1','bot2','bot3','bot4'].map(id=>[id,new StateStore(rawIO,'member-state-'+id,()=>readState(id==='bot1'?'bridge-state.json':'bridge-state-'+id+'.json'))]));
const sourceStore=new StateStore(rawIO,'member-sources');let sourcesReady=false,sourceWrite=Promise.resolve();
async function recordSource(id){if(typeof id!=='string'||!id||id.length>160)throw fault('TASK_SOURCE_CONFLICT','任务身份无效。');migratedQQSessions.add(id);const run=sourceWrite.then(()=>{if(migratedQQSessions.size>10000)throw fault('SOURCE_CAPACITY_FULL','来源记录已满，未发送。');return sourceStore.write({schema:1,sessionIds:[...migratedQQSessions]});});sourceWrite=run.catch(()=>{});await run;}
async function ownerSession(id){
  if(!sourcesReady||typeof id!=='string'||!id)throw fault('PROACTIVE_FORBIDDEN','来源未核实，主动发送不可用。');
  if(migratedQQSessions.has(id)||[...controller.controllers.values()].some(b=>b.jobs.some(j=>j.taskId===id)||b.histories.some(h=>h.taskId===id)))return false;
  // Host ownership also covers a project creation whose ACK was lost before
  // the plugin could persist its taskId. No source-identity gap grants group send.
  try {const task=await cindy.tasks.get({taskId:id});if(task?.taskId===id)return false;throw fault('SOURCE_UNCERTAIN','任务来源不明确。');}
  catch(error){if(error.code==='TASK_NOT_FOUND')return true;throw error;}
}
const controller = new BridgeFleet({forBot:id=>({
  botId:id,read:()=>stores.get(id).read(),write:state=>stores.get(id).write(state),
  resolve:projectId=>cindy.targets.resolve({target:{kind:'project',id:projectId}}),
  send:sendQuestion,defaultSupport,imageSupport,
  getRun:async runId=>{const caps=await cindy.tasks.capabilities();if(!caps.operations?.includes('getRun')||typeof cindy.tasks.getRun!=='function')throw fault('HOST_UNSUPPORTED','缺少原生运行状态读取能力。');return cindy.tasks.getRun({runId});},
  images:(job,epoch)=>collectImages(controller.controllers.get(id).host.node,job,epoch),
  node:async(method,params)=>{
    if(method.startsWith('qq/connect')) {const secrets=await(await fetch('/secrets')).json();if(!secrets.some(s=>s.key===secretKey(id)&&s.saved))throw fault('QQ_SECRET_REQUIRED','请保存此机器人的AppSecret。');}
    const result=await cindy.node.request({method,params,timeoutMs:method==='qq/reply'||method==='qq/final-active'?40000:30000});
    if(!result.ok) {const code=result.errorCode==='PERMISSION_DENIED'?'PERMISSION_DENIED':/^(QQ_[A-Z_]+|IMAGE_[A-Z_]+|INVALID_REPLY|REPLY_CONFLICT|FINAL_CONFLICT|FINAL_STATE_REQUIRED|FINAL_INBOX_FULL)$/.test(result.message||'')?result.message:'QQ_SEND_UNCERTAIN';throw fault(code,'QQ操作未确认，未重发。');}
    if(method.startsWith('qq/connect'))connectionScopes.set(id,{appId:params.appId,sandbox:params.sandbox===true,epoch:params.epoch});
    else if(method==='qq/disconnect')connectionScopes.delete(id);
    return result.result;
  },
}),changed:()=>channel.postMessage({type:'snapshot',snapshot:snapshot()})});
const proactive = new ProactiveSender({
  read: () => readState("proactive-state.json"),
  write: async state => { const result = await cindy.fs({ op: "write", root: "data", path: "proactive-state.json", content: JSON.stringify(state) }); if (!result.ok) throw fault("PROACTIVE_STATE_WRITE_FAILED", "无法保存主动消息状态，请检查插件数据。"); },
  isQQSession: sessionId => !sourcesReady || migratedQQSessions.has(sessionId) || [...controller.controllers.values()].some(b => b.jobs.some(j => j.taskId === sessionId) || b.histories.some(h => h.taskId === sessionId)),
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
  if (typeof cindy.targets?.send !== "function") throw fault("HOST_UNSUPPORTED", "当前 Cindy 缺少项目投递接口。");
  const raw = await (await fetch("/kv")).json(), config = fleetConfig(raw);
  // Same-source migration retains the original vault key; credentials never enter /kv.
  if (raw.schema !== 3) { if(await rawIO.read("config-legacy-1.5.1.json")===null)await rawIO.write("config-legacy-1.5.1.json",JSON.stringify(raw)); const saved = await fetch("/kv", { method: "PUT", body: JSON.stringify(config) }); if (!saved.ok) throw fault("CONFIG_SAVE_FAILED", "旧配置转换后无法保存。"); }
  const previousSessions = await readState("qq-source-session-compat.json");
  if (previousSessions) {
    if (previousSessions.schema !== 1 || !Array.isArray(previousSessions.sessionIds) || previousSessions.sessionIds.length > 10000 || previousSessions.sessionIds.some(id => typeof id !== "string" || !id || id.length > 160)) throw fault("STATE_INVALID", "原 QQ 会话权限记录损坏，请保留数据并联系作者。");
    for (const id of previousSessions.sessionIds) migratedQQSessions.add(id);
  }
  const prior=await sourceStore.read();
  if(prior){if(prior.schema!==1||!Array.isArray(prior.sessionIds)||prior.sessionIds.length>10000||prior.sessionIds.some(id=>typeof id!=='string'||!id||id.length>160))throw fault('STATE_INVALID','群请求来源记录损坏。');for(const id of prior.sessionIds)migratedQQSessions.add(id);}
  for(const id of ['bot1','bot2','bot3','bot4']){
    const legacy=await readState(id==='bot1'?'bridge-state.json':'bridge-state-'+id+'.json');
    if(legacy){if(![1,2,3].includes(legacy.schema)||!Array.isArray(legacy.jobs)||legacy.histories!==undefined&&!Array.isArray(legacy.histories))throw fault('STATE_UNSUPPORTED','旧来源数据不兼容，未清空。');for(const item of [...legacy.jobs,...(legacy.histories||[])])if(item.taskId){if(typeof item.taskId!=='string'||item.taskId.length>160)throw fault('STATE_INVALID','旧来源身份损坏。');migratedQQSessions.add(item.taskId);}}
  }
  await sourceStore.write({schema:1,sessionIds:[...migratedQQSessions]});
  await controller.init();
  for(const b of controller.controllers.values())for(const j of b.jobs)if(j.taskId)migratedQQSessions.add(j.taskId);
  await sourceStore.write({schema:1,sessionIds:[...migratedQQSessions]});sourcesReady=true;
  await controller.configure(config); checkedAt=Date.now();
  try { await proactive.init(); } catch (error) { proactiveError = { code: error.code || "PROACTIVE_STATE_INVALID", message: error.message || "主动消息记录无法读取，请检查插件数据。" }; }
})().catch(error => { failBoot(error, "插件启动自检未通过，请检查权限或保存的数据；修复后重新启用插件。"); });
const uiRequests = new Map();
setInterval(async () => { await ready; if (!bootError) { try { await controller.tick(); } catch (error) { failBoot(error, "状态保存失败，已停止发送，请检查插件数据。"); } } }, 15000);
async function selfCheck() {
  await ready;
  if (!bootError) {
    // Recover only a proven accepted project receipt. found:false/pending is
    // not evidence of non-submission and never triggers a second send.
    for(const b of controller.controllers.values())for(const j of b.jobs)if(!j.legacy&&j.nativeSubmissionUnknown&&j.projectId&&j.sendKey){
      try {
        const receipt=await cindy.targets.get({requestKey:j.sendKey});
        if(receipt.found===true&&receipt.status==='accepted'&&receipt.target?.kind==='project'&&receipt.target.id===j.projectId&&typeof receipt.taskId==='string'&&receipt.taskId&&receipt.taskId.length<=160){
          await recordSource(receipt.taskId);j.taskId=receipt.taskId;j.state='waiting';j.finalEligible=true;j.slotReleased=true;j.blockMember=false;j.nativeSubmissionUnknown=false;j.code='HOST_RECEIPT_RECOVERED';
          const h=b.talkFor(j);if(h)h.taskId=receipt.taskId;await b.save();
        }
      }catch{} // Keep the original uncertainty; no request or send is replayed.
    }
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
    await controller.tick();
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
      if (msg.action === "targets") data = await cindy.targets.list({ targetKind: "project" });
      else {
        await ready;
        if (msg.action === "snapshot") data = snapshot();
        else if (msg.action === "self-check") data = await selfCheck();
        else {
          if (bootError) throw fault(bootError.code, bootError.message);
          if (msg.action === "reload") { await controller.configure(await (await fetch("/kv")).json(), msg.botId); data = snapshot(); }
          else if(msg.action==='pick-model'){if(typeof cindy.pickModel!=='function')throw fault('HOST_UNSUPPORTED','当前 Cindy 缺少统一模型选择器，请升级客户端。');data=await cindy.pickModel({allowRemote:false,...(msg.initial?{initial:msg.initial}:{}),...(msg.mobilePageId?{mobilePageId:msg.mobilePageId}:{})});}
          else if(msg.action==='release-waiting'){const b=controller.controllers.get(msg.botId);if(!b)throw fault('BOT_CONFIG_INVALID','机器人不存在。');await b.releaseWaiting(msg.requestId);data=snapshot();}
          else if (msg.action === "clear-history") { await controller.clearHistory(msg.botId); data = snapshot(); }
          else if (msg.action === "clear-bot") { await controller.clearBot(msg.botId); data = snapshot(); }
          else throw fault("INVALID_UI_REQUEST", "不支持的操作。");
        }
      }
      return { type: "ui-response", id: msg.id, ok: true, data };
    } catch (error) { return { type: "ui-response", id: msg.id, ok: false, error: { code: error.code || "REQUEST_FAILED", message: error.message || "操作未完成，请检查插件权限、项目和模型配置。" } }; }
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
      const view=snapshot(),caller=args.session_context?.session_id;
      let isOwner=false,callerScope={kind:'unverified',code:'CALLER_CONTEXT_REQUIRED'};
      if(caller)try{isOwner=await ownerSession(caller);callerScope={kind:isOwner?'owner':'qq-request'};}catch(error){callerScope={kind:'unverified',code:/^[A-Z][A-Z0-9_]{0,79}$/.test(error.code||'')?error.code:'SOURCE_UNCERTAIN'};}
      if(!isOwner){
        view.bots=view.bots.map(b=>{const scoped=callerScope.kind==='qq-request'?b.jobs.filter(j=>j.taskId===caller):[],groups=new Set(scoped.map(j=>j.groupId));return {...b,jobs:scoped,groups:(b.groups||[]).filter(g=>groups.has(g.id)),config:{appId:b.config?.appId,enabled:b.config?.enabled,sandbox:b.config?.sandbox},conversationCount:undefined};}).filter(b=>b.jobs.length);
        // This is a caller-scoped request view, not the persisted global KV.
        // An empty visible request list must never impersonate bots:[] in KV.
        delete view.config;
      }
      result = { ...view, caller_scope:callerScope, config_visibility:isOwner?'full':'not-included', ...(!isOwner ? { proactiveMessages: [], proactiveError: null, scope_message:callerScope.kind==='unverified'?'调用来源未核实，未提供全局机器人配置；空的可见请求列表不代表账号或凭证被删除。':'仅显示本任务请求；未提供全局机器人配置。' } : {}), hostImageAttachments: await imageSupport().catch(() => false),
        ...(isOwner ? { hostTaskCapabilities: await (async () => cindy.tasks?.capabilities?.())().catch(() => null) } : {}) };
    }
    else if (bootError) throw fault(bootError.code, bootError.message);
    else if (msg.tool === "get_question") result = await controller.question(args.request_id, args.session_context?.session_id);
    else if (msg.tool === "reply_to_qq") result = await controller.reply(args.request_id, args.text, args.session_context?.session_id);
    else if (msg.tool === "send_group_message") {
      if (proactiveError) throw fault(proactiveError.code, proactiveError.message);
      if(!await ownerSession(args.session_context?.session_id))throw fault("PROACTIVE_FORBIDDEN","群问答只能回复原请求，不能主动选择群发送。");
      result = await proactive.send(args, args.session_context?.session_id, msg.callId);
    }
    else throw fault("UNKNOWN_TOOL", "不支持的工具。");
    await cindy.send({ type: "tool-result", callId: msg.callId, ok: true, result });
  } catch (error) { await cindy.send({ type: "tool-result", callId: msg.callId, ok: false, errorCode: error.code || "QQ_PLUGIN_FAILED", message: error.message || "操作失败，请查看插件设置。" }); }
});
