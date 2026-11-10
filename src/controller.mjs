import {groupsFrom} from './config.mjs';
export const PLUGIN_ID='qq-companion-bot',PLUGIN_VERSION='1.6.5',TALK_IDLE_MS=2*60*60*1000;
const DONE=new Set(['replied','failed','cancelled','expired','no_reply','uncertain']);
const SEND_STATES=new Set(['replying','proactive_sending']);
const STATES=new Set([...DONE,'queued','sending','waiting','replying','reply_rejected','proactive_sending']);
const identifier=x=>typeof x==='string'&&x.length>0&&x.length<=256;
function validateCurrentState(d){
  if(!Array.isArray(d.histories)||d.histories.length>80||new Set(d.jobs.map(j=>j?.id)).size!==d.jobs.length)throw fault('STATE_INVALID','会话或请求身份损坏。');
  for(const j of d.jobs){
    if(!j||!identifier(j.id)||!STATES.has(j.state)||!Number.isSafeInteger(j.createdAt)||j.createdAt<0||j.taskId!==undefined&&!identifier(j.taskId)||j.finalFingerprint!==undefined&&!/^[a-f0-9]{64}$/.test(j.finalFingerprint)||j.finalText!==undefined&&(typeof j.finalText!=='string'||!j.finalText.trim()||j.finalText.length>1800))throw fault('STATE_INVALID','发送状态损坏，未覆盖或重放。');
    if(!j.legacy&&(!identifier(j.appId)||!identifier(j.groupId)||!identifier(j.senderId)||!identifier(j.messageId)||typeof j.finalEligible!=='boolean'||j.finalEligible&&(!identifier(j.taskId)||!identifier(j.talkId))))throw fault('STATE_INVALID','原请求绑定损坏。');
    if(SEND_STATES.has(j.state)&&(!j.finalFingerprint||!j.finalText))throw fault('STATE_INVALID','发送意图不完整，未重放。');
  }
  for(const h of d.histories)if(!identifier(h.id)||typeof h.key!=='string'||h.key.length>16000||!Number.isSafeInteger(h.updatedAt)||h.updatedAt<0||h.taskId!==undefined&&!identifier(h.taskId))throw fault('STATE_INVALID','成员会话映射损坏。');
}
export function fault(code,message) {return Object.assign(new Error(message),{code});}
export function configFrom(raw={}) {return {appId:typeof raw.appId==='string'?raw.appId.trim():'',enabled:raw.enabled===true,sandbox:raw.sandbox===true,groupMode:'all',groups:groupsFrom(raw.groups)};}
async function digest(value) {const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');}
export class BridgeController {
  constructor(host) {this.host=host;this.cfg=configFrom();this.jobs=[];this.groups=[];this.histories=[];this.connection='idle';this.connectionCode='';this.writeChain=Promise.resolve();this.receiving=Promise.resolve();this.pumping=false;this.targetFlight=null;this.runtimeGeneration=0;this.connectionEpoch=null;}
  now(){return this.host.now?.()??Date.now();}
  snapshot(){return {version:PLUGIN_VERSION,connection:this.connection,connectionCode:this.connectionCode,config:this.cfg,groups:this.groups,conversationCount:this.histories.filter(h=>this.now()-h.updatedAt<TALK_IDLE_MS).length,jobs:this.jobs.filter(j=>j.finalEligible||j.state==='queued').concat(this.jobs.filter(j=>!j.finalEligible&&j.state!=='queued').slice(-24)).reverse().map(({id,groupId,senderId,imageCount,state,createdAt,code,slotReleased,finalEligible,taskId,runId,delivery})=>({id,groupId,senderId,imageCount,state,createdAt,code,slotReleased,finalEligible,taskId,runId,delivery,mode:'member'}))};}
  changed(){this.host.changed?.(this.snapshot());}
  save(){
    const jobs=this.jobs.map(({text,preview,questionContent,...j})=>j);
    const data=JSON.parse(JSON.stringify({schema:5,jobs,groups:this.groups,histories:this.histories}));
    const run=this.writeChain.then(()=>this.host.write(data));this.writeChain=run.catch(()=>{});return run;
  }
  async init(){
    const d=await this.host.read();if(!d){this.changed();return;}
    if(![1,2,3,5].includes(d.schema)||!Array.isArray(d.jobs)||!Array.isArray(d.groups)||d.jobs.length>200)throw fault('STATE_UNSUPPORTED','插件数据不兼容，未覆盖或重放。');
    this.jobs=d.jobs;this.groups=d.groups.slice(-40);
    if(d.schema===5) {
      validateCurrentState(d);
      this.histories=d.histories;
      for(const j of this.jobs) {
        if(SEND_STATES.has(j.state)) {j.state='uncertain';j.code='QQ_SEND_UNCERTAIN';j.finalEligible=false;delete j.finalText;}
        else if(j.state==='sending') {j.state='uncertain';j.code='DELIVERY_UNCERTAIN';j.finalEligible=false;j.nativeSubmissionUnknown=true;j.blockMember=true;}
        else if(j.state==='reply_rejected') {j.state='failed';j.code='HOST_RESTARTED_BEFORE_FALLBACK';j.finalEligible=false;delete j.finalText;}
        else if(j.state==='queued') {j.state='cancelled';j.code='HOST_RESTARTED';j.finalEligible=false;}
        else if(j.state==='waiting') {j.slotReleased=true;j.blockMember=false;j.code='HOST_RESTARTED_WAITING';}
      }
    } else {
      this.histories=[];
      for(const j of this.jobs) {j.legacy=true;j.finalEligible=false;if(!DONE.has(j.state)){j.state='uncertain';j.code='MIGRATED_LEGACY_REQUEST';}delete j.text;delete j.questionContent;delete j.preview;delete j.finalText;}
    }
    await this.save();this.changed();
  }
  allows(){return true;}
  matches(j){return this.cfg.enabled&&j.appId===this.cfg.appId&&!!j.sandbox===this.cfg.sandbox;}
  groupConfig(id){return this.cfg.groups.find(g=>g.groupOpenid===id);}
  conversationKey(j){return JSON.stringify([this.host.botId||'bot1',j.appId,!!j.sandbox,j.groupId,j.senderId,j.configKey]);}
  bindTalk(j){
    const key=this.conversationKey(j);let h=this.histories.findLast(h=>h.key===key&&this.now()-h.updatedAt<TALK_IDLE_MS&&!this.jobs.some(x=>x.talkId===h.id&&x.nativeSubmissionUnknown));
    if(!h){
      this.histories=this.histories.filter(h=>this.now()-h.updatedAt<TALK_IDLE_MS||this.jobs.some(j=>j.talkId===h.id&&j.finalEligible));
      if(this.histories.length>=80)throw fault('SESSION_LIMIT','连续会话已满，未创建任务；请结束闲置会话。');
      h={id:crypto.randomUUID(),key,groupId:j.groupId,senderId:j.senderId,updatedAt:this.now(),accepted:false};this.histories.push(h);
    }
    j.talkId=h.id;return h;
  }
  talkFor(j){return this.histories.find(h=>h.id===j.talkId);}
  async configure(raw,reconnect=false){
    const old=this.cfg;this.cfg=configFrom(raw);const generation=++this.runtimeGeneration;
    for(const j of this.jobs)if(!this.matches(j)&&!DONE.has(j.state)){j.state='cancelled';j.code='CONFIG_CHANGED';j.finalEligible=false;delete j.finalText;delete j.text;}
    await this.save();if(generation!==this.runtimeGeneration)return this.snapshot();
    if(!this.cfg.enabled||!/^[0-9]{4,30}$/.test(this.cfg.appId)) {
      try{if(old.enabled||this.connectionEpoch)await this.host.node('qq/disconnect',{});this.connectionEpoch=null;this.connection=this.cfg.enabled?'needs_config':'idle';this.connectionCode=this.cfg.enabled?'CONFIG_REQUIRED':'';}catch(e){this.connection='error';this.connectionCode=e.code||'NODE_REQUEST_FAILED';}
    } else if(reconnect||!old.enabled||old.appId!==this.cfg.appId||old.sandbox!==this.cfg.sandbox||this.connection!=='connected'){
      this.connection='connecting';this.connectionCode='';this.changed();
      try{await this.host.defaultSupport?.();if(generation!==this.runtimeGeneration)return this.snapshot();this.connectionEpoch=this.now()+':'+generation;await this.host.node('qq/connect',{appId:this.cfg.appId,sandbox:this.cfg.sandbox,epoch:this.connectionEpoch});}
      catch(e){if(generation===this.runtimeGeneration){this.connection=['QQ_SECRET_REQUIRED','PERMISSION_DENIED','HOST_UNSUPPORTED'].includes(e.code)?'needs_config':'error';this.connectionCode=e.code||'CONNECT_FAILED';}}
    }
    this.changed();await this.pump();return this.snapshot();
  }
  receive(m){const run=this.receiving.then(()=>this.accept(m));this.receiving=run.catch(()=>{});return run;}
  async accept(m){
    if(!this.cfg.enabled||m.appId!==this.cfg.appId||m.kind!=='group'||m.rawEventType!=='GROUP_AT_MESSAGE_CREATE'||m.senderIsBot)return;
    if(![m.messageId,m.groupId,m.senderId].every(x=>typeof x==='string'&&x.length>0&&x.length<=160))return;
    const messageAt=Date.parse(m.timestamp);
    if(!Number.isFinite(messageAt)||messageAt<this.now()-86400000||messageAt>this.now()+60000){this.connectionCode='EVENT_TIME_INVALID';this.changed();return;}
    this.jobs=this.jobs.filter(j=>j.finalEligible||j.state==='uncertain'||!DONE.has(j.state)||j.createdAt>=this.now()-86400000);
    const id='qq:'+await digest([this.host.botId||'bot1',m.appId,this.cfg.sandbox,m.groupId,m.messageId]);
    // Keep identities rather than evicting unresolved or confirmed sends. At the
    // bounded limit fail closed; clearing history never releases an identity.
    if(this.jobs.some(j=>j.id===id)||this.jobs.some(j=>j.legacy&&j.appId===m.appId&&j.messageId===m.messageId))return;
    if(!this.groups.some(g=>g.id===m.groupId))this.groups.push({id:m.groupId,firstSeenAt:this.now()});this.groups=this.groups.slice(-40);
    if(this.jobs.length>=200){this.connectionCode='INBOX_FULL';this.changed();await this.save();return;}
    const cfg=this.groupConfig(m.groupId),text=typeof m.text==='string'?m.text.trim():'';
    const imageCount=Number.isInteger(m.imageCount)&&m.imageCount>0&&m.imageCount<=4?m.imageCount:0;
    const j={id,appId:m.appId,sandbox:this.cfg.sandbox,groupId:m.groupId,messageId:m.messageId,senderId:m.senderId,msgIdx:typeof m.msgIdx==='string'&&m.msgIdx.trim()&&m.msgIdx.length<=256?m.msgIdx:undefined,createdAt:messageAt,imageCount,text,state:'queued',finalEligible:false,...cfg?{projectId:cfg.projectId,route:cfg.route,configKey:JSON.stringify([cfg.projectId,cfg.route])}:{}};
    if(!cfg?.projectId||!cfg.route){j.state='failed';j.code='GROUP_CONFIG_REQUIRED';}
    else if((!text&&!imageCount)||text.length>12000||(m.hasAttachments&&(!imageCount||m.attachmentCode))){j.state='failed';j.code=m.attachmentCode||'QUESTION_CONTENT_INVALID';}
    else if(this.jobs.filter(j=>['queued','sending'].includes(j.state)).length>=12){j.state='failed';j.code='QUEUE_FULL';}
    if(j.state==='queued')try{this.bindTalk(j);}catch(e){j.state='failed';j.code=e.code;}
    this.jobs.push(j);await this.save();this.changed();await this.pump();
  }
  prompt(j){return JSON.stringify({request_id:j.id,question:j.text});}
  async pump(){
    // Serialize only Host submissions. Once accepted, the native task owns
    // execution order; a missing final QQ answer must never hold new inputs.
    if(this.pumping||!this.cfg.enabled||this.connection!=='connected')return;
    const j=this.jobs.find(j=>j.state==='queued');if(!j)return;this.pumping=true;
    const guard=()=>{if(!this.jobs.includes(j)||!this.matches(j)||j.state==='cancelled')throw fault('CONFIG_CHANGED','原机器人配置已改变，未发送。');};
    try{
      const current=this.groupConfig(j.groupId);if(JSON.stringify([current?.projectId,current?.route])!==j.configKey)throw fault('GROUP_CONFIG_CHANGED','群项目或模型配置已改变，请重新 @。');
      await this.host.resolve(j.projectId);guard();
      let attachments;if(j.imageCount){if(!await this.host.imageSupport?.())throw fault('IMAGE_HOST_UNSUPPORTED','宿主没有图片投递能力。');attachments=await this.host.images(j,this.connectionEpoch);guard();if(attachments?.length!==j.imageCount)throw fault('IMAGE_TRANSFER_INVALID','图片未完整获取。');}
      // Inputs may have been buffered before an earlier Host ACK was lost.
      // Rotate their binding too, rather than reusing an uncertain task.
      const h=this.jobs.some(x=>x!==j&&x.talkId===j.talkId&&x.nativeSubmissionUnknown)?this.bindTalk(j):this.talkFor(j);if(!h)throw fault('SESSION_UNAVAILABLE','会话已结束。');
      j.state='sending';j.sendKey=j.id;await this.save();guard();
      this.targetFlight=this.host.send({taskId:h.taskId,projectId:j.projectId,route:j.route,requestKey:j.sendKey,text:this.prompt(j),...attachments?{attachments}:{}},guard);
      const receipt=await this.targetFlight;guard();
      if(receipt.accepted!==true||typeof receipt.taskId!=='string'||!receipt.taskId)throw fault('DELIVERY_UNCERTAIN','问题受理结果不确定，未重发。');
      h.taskId=receipt.taskId;h.updatedAt=this.now();h.accepted=true;j.taskId=receipt.taskId;if(receipt.runId)j.runId=receipt.runId;
      j.state='waiting';j.finalEligible=true;j.slotReleased=true;j.blockMember=false;delete j.text;await this.save();
    }catch(e){if(j.state!=='cancelled'){j.nativeSubmissionUnknown=j.state==='sending'&&!e.beforeSend;j.state=j.nativeSubmissionUnknown?'uncertain':'failed';j.blockMember=!!j.nativeSubmissionUnknown;j.code=e.code||'DELIVERY_UNCERTAIN';j.finalEligible=false;delete j.text;await this.save();}}
    finally{this.targetFlight=null;this.pumping=false;this.changed();}
    await this.pump();
  }
  async forCaller(id,session){if(this.targetFlight)await this.targetFlight.catch(()=>{});const j=this.jobs.find(j=>j.id===id);if(!j||j.legacy||!session||j.taskId!==session)throw fault('QUESTION_FORBIDDEN','仅接收原问题的任务可处理本请求。');return j;}
  async question(id,session){const j=await this.forCaller(id,session);return {request_id:j.id,group_id:j.groupId,sender_id:j.senderId,state:j.state,code:j.code,image_count:j.imageCount};}
  async reply(id,text,session){
    const j=await this.forCaller(id,session);if(typeof text!=='string'||!text.trim()||text.length>1800)throw fault('REPLY_TOO_LONG','请将最终答案缩短到1800字符以内。');
    const final=text.trim(),fingerprint=await digest(final);
    if(j.finalFingerprint&&j.finalFingerprint!==fingerprint)throw fault('FINAL_CONFLICT','同一请求已有另一份最终答案，未发送。');
    if(j.state==='replied')return {sent:true,duplicate:true,request_id:id,message_id:j.replyId,delivery:j.delivery};
    if(!j.finalEligible||j.state!=='waiting')throw fault('QUESTION_NOT_WAITING','此请求不能重复发送，请查看原状态。');
    if(!this.matches(j))throw fault('CONFIG_CHANGED','原机器人已暂停或更换，未发送。');
    j.state='replying';j.finalFingerprint=fingerprint;j.finalText=final;
    try{await this.save();return await this.deliver(j,'reply');}
    catch(e){if(!['replied','failed','uncertain','cancelled'].includes(j.state)){j.state='uncertain';j.code=e.code||'STATE_WRITE_FAILED';j.finalEligible=false;}throw e;}
    finally{this.changed();await this.pump();}
  }
  async deliver(j,stage){
    const guard=()=>{if(!this.matches(j)||!this.jobs.includes(j))throw fault('CONFIG_CHANGED','原机器人已改变，未发送。');};
    let result;
    try{guard();result=await this.host.node(stage==='reply'?'qq/reply':'qq/final-active',{appId:j.appId,sandbox:j.sandbox,epoch:this.connectionEpoch,requestId:j.id,groupId:j.groupId,messageId:j.messageId,msgIdx:j.msgIdx,text:j.finalText});}
    catch(e){j.state=['CONFIG_CHANGED','QQ_NOT_CONNECTED','INVALID_REPLY','FINAL_STATE_REQUIRED','FINAL_INBOX_FULL','PERMISSION_DENIED'].includes(e.code)?'failed':'uncertain';j.code=e.code||'QQ_SEND_UNCERTAIN';j.finalEligible=false;delete j.finalText;await this.save();throw fault(j.code,'最终发送未确认，请查看插件状态与原群；不会重发。');}
    if(result?.sent===true&&typeof result.messageId==='string'&&result.messageId.trim()&&result.messageId.length<=512){
      j.state='replied';j.delivery=stage==='reply'?'passive':'proactive';j.replyId=result.messageId;j.sentAt=this.now();j.finalEligible=false;delete j.finalText;delete j.code;delete j.blockMember;const h=this.talkFor(j);if(h)h.updatedAt=this.now();await this.save();return {sent:true,request_id:j.id,message_id:j.replyId,delivery:j.delivery};
    }
    if(stage==='reply'&&result?.outcome==='rejected'){
      j.state='reply_rejected';j.replyFailure=result.code;await this.save();guard();
      j.state='proactive_sending';await this.save();guard();return this.deliver(j,'active');
    }
    j.state=result?.outcome==='rejected'?'failed':'uncertain';j.code=result?.code||'QQ_SEND_UNCERTAIN';j.finalEligible=false;delete j.finalText;await this.save();throw fault(j.code,j.state==='failed'?'最终答案发送失败，已停止。':'最终答案发送结果不确定，未补发。');
  }
  async releaseWaiting(id){const j=this.jobs.find(j=>j.id===id);if(!j||j.state!=='waiting')throw fault('QUESTION_NOT_WAITING','只有等待最终答案的请求可以释放排队位置。');j.slotReleased=true;j.blockMember=false;j.code='WAITING_FINAL_RELEASED';await this.save();this.changed();await this.pump();return this.snapshot();}
  async status(state,code='',epoch){if(epoch!==undefined&&epoch!==this.connectionEpoch)return;if(!this.cfg.enabled&&state!=='idle')return;this.connection=state;this.connectionCode=code;this.changed();await this.pump();}
  async tick(){
    let dirty=false;
    for(const j of this.jobs.filter(j=>j.state==='waiting')) {
      if(j.runId&&this.host.getRun)try{const run=await this.host.getRun(j.runId);if(j.state==='waiting'&&j.finalEligible&&this.jobs.includes(j)&&run.runId===j.runId&&run.taskId===j.taskId&&['completed','failed','cancelled','interrupted'].includes(run.status)&&(!j.slotReleased||j.blockMember!==false||j.code!=='MODEL_ENDED_WITHOUT_REPLY')){j.slotReleased=true;j.blockMember=false;j.code='MODEL_ENDED_WITHOUT_REPLY';dirty=true;}}catch{}
      if(this.now()-j.createdAt>10*60*1000&&!['WAITING_FINAL_ATTENTION','MODEL_ENDED_WITHOUT_REPLY','WAITING_FINAL_RELEASED'].includes(j.code)){j.code='WAITING_FINAL_ATTENTION';dirty=true;}
    }
    if(dirty)await this.save();this.changed();await this.pump();
  }
}
