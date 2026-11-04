"use strict";
const $=id=>document.getElementById(id), ids=["bot1","bot2","bot3","bot4"];
const key=id=>id==="bot1"?"qq_app_secret":"qq_app_secret_"+id.slice(3);
const channel=new BroadcastChannel("qq-companion-bot-ui"),pending=new Map();
let config={schema:2,bots:[]},selected="bot1",snapshot=null,targetsList=[],busy=false,secrets=[],targetId="",uiError="";
const stateLabels={idle:"已暂停",connecting:"连接中",connected:"运行中",needs_config:"需要配置",error:"连接失败"};
const jobLabels={queued:"排队中",sending:"正在投递",waiting:"等待伙伴答复",replying:"正在回群",replied:"已回群",failed:"未完成",cancelled:"已取消",expired:"已过期",uncertain:"结果不确定，请检查原群"};
function feedback(text){$("feedback").textContent=text;}
async function api(path,options){const r=await fetch(path,options);if(!r.ok)throw new Error("保存或读取失败（HTTP "+r.status+"），请重试。");return r;}
function normalize(raw){const bots=Array.isArray(raw.bots)?raw.bots:[{...raw,id:"bot1",name:"机器人 1",groupMode:"all"}];return {schema:2,bots:bots.map(b=>{const paused=b.paused===true||(b.paused!==false&&b.enabled===false&&!!b.appId&&!!b.targetId);return {...b,paused,enabled:b.enabled===true&&!paused};})};}
function request(action,botId=selected){return new Promise((resolve,reject)=>{const id=crypto.randomUUID(),msg={type:"ui-request",id,action,botId};const timer=setTimeout(()=>{cleanup();reject(new Error("插件未在 35 秒内响应，请检查是否启用并重试。"));},35000);const repeat=setInterval(()=>channel.postMessage(msg),700);function cleanup(){clearTimeout(timer);clearInterval(repeat);pending.delete(id);}pending.set(id,{resolve:data=>{cleanup();resolve(data);},reject:error=>{cleanup();reject(error);}});channel.postMessage(msg);});}
channel.onmessage=({data})=>{if(data?.type==="ui-response"){const p=pending.get(data.id);if(p)data.ok?p.resolve(data.data):p.reject(new Error(data.error?.message+"（"+data.error?.code+"）"));}else if(data?.type==="snapshot")render(data.snapshot);else if(data?.type==="boot-error"){uiError=data.error.message+"（"+data.error.code+"）";health();}};
function active(){return config.bots.find(b=>b.id===selected);}
function botSnapshot(id=selected){return snapshot?.bots?.find(b=>b.id===id);}
function navigation(){
  const nav=$("bots");nav.replaceChildren();let running=0,paused=0;
  for(const b of config.bots){
    const button=document.createElement("button");button.type="button";button.className="bot-card";
    button.setAttribute("aria-current",String(b.id===selected));button.disabled=busy;
    const name=document.createElement("strong");name.textContent=b.name||b.id;
    const s=botSnapshot(b.id),status=document.createElement("span");status.className="status-pill";status.dataset.state=s?.connection||"needs_config";
    status.textContent=s?(s.connection==="idle"&&!b.paused?"待配置":stateLabels[s.connection]||s.connection):b.enabled?"正在自检":b.paused?"已暂停":"待配置";
    if(s?.connection==="connected")running++;if(b.paused)paused++;
    const detail=document.createElement("small");detail.textContent=b.appId||"未填写 AppID";
    button.append(name,status,detail);button.onclick=()=>{selected=b.id;fill();feedback("");};nav.append(button);
  }
  $("fleet-summary").textContent=config.bots.length+" 个机器人 · "+running+" 个运行中 · "+paused+" 个暂停";
  $("add-bot").disabled=busy||config.bots.length>=4;
  $("empty-state").hidden=!!config.bots.length;$("bot-editor").hidden=!active();
}
function health(){
  const errors=[];
  if(snapshot?.bootError)errors.push(snapshot.bootError.message+"（"+snapshot.bootError.code+"）");
  for(const b of snapshot?.bots||[])if(["error","needs_config"].includes(b.connection))errors.push(b.name+"："+(stateLabels[b.connection]||b.connection)+"（"+(b.connectionCode||"CONFIG_REQUIRED")+"）");
  if(uiError)errors.push(uiError);
  $("health-alert").hidden=!errors.length;
  $("health-message").textContent=[...new Set(errors)].join("；")+(errors.length?"。检查账号、凭证或插件权限后点击“重新自检”。":"");
}
function avatar(target){const el=document.createElement("span");el.className="avatar";const name=target.label||target.name||"伙伴";el.textContent=[...name][0]||"伴";el.setAttribute("aria-label",name+"的名称头像");const url=target.avatarUrl||target.avatar;if(typeof url==="string"&&/^https:[/][/]/i.test(url)){try{const parsed=new URL(url);if(!parsed.username&&!parsed.password){const image=document.createElement("img");image.src=parsed.href;image.alt=name+"头像";image.referrerPolicy="no-referrer";image.addEventListener("error",()=>{image.remove();el.textContent=[...name][0]||"伴";});el.replaceChildren(image);}}catch{}}return el;}
function partner(target){
  const el=document.createElement("label");el.className="partner";
  const input=document.createElement("input");input.type="radio";input.name="partner";input.value=target.id;
  input.checked=target.id===targetId;input.disabled=busy;input.setAttribute("aria-label",target.label||target.name||target.id||"不选择伙伴，新建对话");
  input.onchange=()=>act(async()=>{const before=targetId;targetId=target.id;try{await commit({...active(),targetId},false);feedback(targetId?"回答伙伴已切换并保存。":"已切换为新建独立对话，使用系统辅助模型。");}catch(error){targetId=before;throw error;}});
  const info=document.createElement("div");info.className="partner-info";
  const name=document.createElement("div");name.className="partner-name";name.textContent=target.label||target.name;
  const detail=document.createElement("div");detail.className="partner-id";detail.textContent=target.id?"ID · "+target.id:"系统辅助模型 · 每条提问新建对话";
  info.append(name,detail);el.append(input,avatar(target),info);return el;
}
function partners(){
  const list=$("partners");list.replaceChildren();
  if(active())list.append(partner({id:"",label:"不选择伙伴"}));
  for(const t of targetsList)list.append(partner(t));
  if(targetId&&!targetsList.some(t=>t.id===targetId))list.append(partner({id:targetId,label:"原伙伴不可用，请切换"}));
  $("routing-state").textContent=targetId?"当前伙伴："+(targetsList.find(t=>t.id===targetId)?.label||targetId):"当前未选择伙伴，将新建独立对话。";
}
function secretState(){$("secret-state").textContent=secrets.find(s=>s.key===key(selected))?.saved?"（已加密保存）":"（未保存）";}
function fill(){const b=active();navigation();if(!b){targetId="";partners();return;}$("bot-name").value=b.name||"";$("appid").value=b.appId||"";$("sandbox").checked=!!b.sandbox;$("secret").value="";targetId=b.targetId||"";partners();secretState();navigation();renderSelected();}
function render(s){snapshot=s;health();navigation();renderSelected();}
function renderSelected(){const s=botSnapshot();$("connection").dataset.state=s?.connection||"needs_config";$("connection").textContent=s?(s.connection==="idle"&&!active()?.paused?"待配置":stateLabels[s.connection]||s.connection)+(s.connectionCode?" · "+s.connectionCode:""):"尚未连接";$("history-state").textContent="已记录 "+(s?.conversationCount||0)+" 个追问会话";const jobs=$("jobs");jobs.replaceChildren();if(!s?.jobs?.length){const p=document.createElement("p");p.className="muted";p.textContent="暂无提问。连接后，可在 QQ 群内 @ 机器人测试。";jobs.append(p);}for(const job of s?.jobs||[]){const row=document.createElement("article");row.className="job";const status=document.createElement("strong");status.textContent=(jobLabels[job.state]||job.state)+(job.code?" · "+job.code:"");const question=document.createElement("p");question.textContent=(job.preview||"图片或空消息")+(job.imageCount?" · "+job.imageCount+" 张图片":"");const meta=document.createElement("p");meta.className="muted";meta.textContent=new Date(job.createdAt).toLocaleString()+" · 发言人 "+(job.senderId||"未知")+" · 群 "+job.groupId+" · "+job.id;row.append(status,question,meta);jobs.append(row);}}
async function secretStatus(){secrets=await(await api("/secrets")).json();secretState();}
async function saveSecret(){const value=$("secret").value;if(!value)return;try{await api("/secrets/"+key(selected),{method:"PUT",body:JSON.stringify({value})});}finally{$("secret").value="";}await secretStatus();}
async function targets(){const data=await request("targets");targetsList=data.targets||[];partners();}
function readConfig(enabled,paused){return {id:selected,name:$("bot-name").value.trim().slice(0,60)||selected,appId:$("appid").value.trim(),targetId,sandbox:$("sandbox").checked,enabled,paused,groupMode:"all"};}
async function commit(next,reconnect=false){const current=normalize(await(await api("/kv")).json());const index=current.bots.findIndex(b=>b.id===selected);if(index<0)current.bots.push(next);else current.bots[index]=next;if(current.bots.length>4)throw new Error("最多配置 4 个机器人。");if(next.appId&&current.bots.some(b=>b.id!==selected&&b.appId===next.appId))throw new Error("同一个 AppID 只能配置一次。");await api("/kv",{method:"PUT",body:JSON.stringify(current)});config=current;render(await request("reload",reconnect?selected:null));navigation();}
async function save(mode){const old=active(),paused=mode==="pause"||mode!=="connect"&&old.paused===true,next=mode==="pause"?{...old,enabled:false,paused:true}:readConfig(false,paused),secretEntered=!!$("secret").value;const complete=/^[0-9]{4,30}$/.test(next.appId);if(mode==="connect"&&!complete)throw new Error("请填写正确的 AppID。");if(mode!=="pause"){await saveSecret();await secretStatus();const saved=secrets.some(s=>s.key===key(selected)&&s.saved);if(mode==="connect"&&!saved)throw new Error("请先填写并保存此机器人的 AppSecret。");next.enabled=complete&&saved&&!paused;}await commit(next,next.enabled&&(mode==="connect"||secretEntered||botSnapshot()?.connection==="needs_config"));feedback(mode==="pause"?"已暂停此机器人。账号和凭证保留，可再次连接。":paused?"配置已保存，保留主动暂停；点击“保存并连接”可恢复。":next.enabled?"配置已保存，正在自动连接。所有群内 @ 均可提问，连接状态见下方。":"草稿已保存；补齐 AppID 和凭证后保存，将自动连接。");}
async function act(fn){if(busy)return;busy=true;uiError="";feedback("");health();document.querySelectorAll("button,input,select").forEach(b=>b.disabled=true);try{await fn();}catch(e){feedback(e.message||"操作未完成，请重试。");uiError=e.message||"操作未完成，请重试。";health();}finally{busy=false;document.querySelectorAll("button,input,select").forEach(b=>b.disabled=false);navigation();partners();}}

$("save-secret").onclick=()=>act(async()=>{if(!$("secret").value)throw new Error("请先填写 AppSecret。");await save("save");});
$("connect").onclick=()=>act(()=>save("connect"));$("save-config").onclick=()=>act(()=>save("save"));$("pause").onclick=()=>act(()=>save("pause"));
$("refresh-targets").onclick=()=>act(targets);$("self-check").onclick=()=>act(async()=>{await api("/wake");uiError="";render(await request("self-check"));await secretStatus();feedback(snapshot.bootError?"自检未通过，请按首页提示处理。":"自检完成，机器人状态已更新。");});$("refresh").onclick=()=>act(async()=>{config=normalize(await(await api("/kv")).json());uiError="";render(await request("snapshot"));await secretStatus();fill();feedback("状态已刷新。");});
$("clear-history").onclick=()=>act(async()=>{render(await request("clear-history"));feedback("此机器人的插件追问记录已清空。");});
$("clear-secret").onclick=()=>act(async()=>{await save("pause");await api("/secrets/"+key(selected),{method:"DELETE"});$("secret").value="";await secretStatus();feedback("已暂停此机器人并清除其凭证。");});
$("add-bot").onclick=()=>act(async()=>{const current=normalize(await(await api("/kv")).json()),id=ids.find(id=>!current.bots.some(b=>b.id===id));if(!id)throw new Error("最多配置 4 个机器人。");const b={id,name:"机器人 "+id.slice(3),appId:"",targetId:"",enabled:false,paused:false,sandbox:false,groupMode:"all"};current.bots.push(b);await api("/kv",{method:"PUT",body:JSON.stringify(current)});config=current;selected=id;render(await request("reload"));fill();feedback("已添加机器人，请填写账号和凭证，伙伴可不选，默认新建对话。");});
$("remove-bot").onclick=()=>act(async()=>{
  const id=selected;await save("pause");
  if(botSnapshot(id)?.connection!=="idle")throw new Error("机器人尚未成功停止，请重新自检后再删除。");
  await api("/secrets/"+key(id),{method:"DELETE"});
  const current=normalize(await(await api("/kv")).json());current.bots=current.bots.filter(b=>b.id!==id);
  await api("/kv",{method:"PUT",body:JSON.stringify(current)});config=current;selected=current.bots[0]?.id||"";
  render(await request("reload",null));fill();await request("clear-bot",id);await secretStatus();
  feedback("机器人已删除，连接、凭证和插件记录已清理。");
});
act(async()=>{
  config=normalize(await(await api("/kv")).json());selected=config.bots[0]?.id||"";await secretStatus();fill();
  try{await api("/wake");}catch(error){uiError=error.message;health();}
  const checks=await Promise.allSettled([targets(),request("snapshot")]);
  if(checks[1].status==="fulfilled")render(checks[1].value);
  const failed=checks.filter(c=>c.status==="rejected");if(failed.length){uiError=failed.map(c=>c.reason.message).join("；");health();}
});
