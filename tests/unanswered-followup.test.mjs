import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime} from './runtime-fixture.mjs';
import {StateStore} from '../src/state-store.mjs';

const submissions=h=>h.calls.filter(c=>c.kind==='project'||c.kind==='task');
const jobs=async h=>(await h.tool('get_status',{session_context:{session_id:'owner'}})).result.bots[0].jobs;

test('unanswered first message does not hold followups or other members in the plugin',async()=>{
  const h=await runtime(),a=await h.receive('first','FIRST');
  assert.equal(a.runId,undefined);
  const b=await h.receive('second','SECOND');
  assert.equal(submissions(h).length,2);
  assert.equal(b.taskId,a.taskId);
  assert.equal(b.state,'waiting');
  assert.equal(h.runs.get(b.runId).status,'queued');
  const c=await h.receive('other','OTHER',{senderId:'other'});
  assert.notEqual(c.taskId,a.taskId);
  assert.equal(submissions(h).length,3);
  assert.ok((await jobs(h)).every(j=>j.state!=='queued'));
  for(const [index,job,question] of [[0,a,'FIRST'],[1,b,'SECOND'],[2,c,'OTHER']]){
    const req=submissions(h)[index].req,separator=req.text.indexOf('\n');
    assert.equal(req.text.slice(0,separator).length,236);
    assert.deepEqual(JSON.parse(req.text.slice(separator+1)),{request_id:job.id,question});
    assert.equal(req.requestKey,job.id);
  }
  assert.equal((await h.reply(b,'SECOND_FINAL')).ok,true);
  assert.equal((await h.reply(a,'LATE_FIRST_FINAL')).ok,true);
  const replies=h.calls.filter(c=>c.req?.method==='qq/reply');
  assert.deepEqual(replies.map(c=>c.req.params.messageId),['second','first']);
});

test('unanswered messages do not consume the twelve local submission positions',async()=>{
  const h=await runtime();
  for(let i=0;i<15;i++)await h.receive('input-'+i,'QUESTION '+i);
  assert.equal(submissions(h).length,15);
  assert.equal(h.tasks.size,1);
  assert.ok((await jobs(h)).every(j=>j.state==='waiting'&&j.code!=='QUEUE_FULL'));
  await h.receive('input-14','duplicate');
  assert.equal(submissions(h).length,15);
});

test('upgrade ignores legacy member blocking flags while preserving late finals',async()=>{
  const h=await runtime(),a=await h.receive('old');
  const io={read:async p=>h.disk.get(p)??null,write:async(p,text)=>h.disk.set(p,text)};
  const store=new StateStore(io,'member-state-bot1'),state=await store.read();
  Object.assign(state.jobs.find(j=>j.id===a.id),{slotReleased:true,blockMember:true,code:'WAITING_FINAL_RELEASED'});
  await store.write(state);
  const next=await runtime({disk:h.disk,tasks:h.tasks,receipts:h.receipts});
  const b=await next.receive('new');
  assert.equal(submissions(next).length,1);
  assert.equal(b.taskId,a.taskId);
  assert.equal((await next.reply(a,'LATE_OLD')).ok,true);
  assert.equal((await next.reply(b)).ok,true);
});

test('unknown project acceptance rotates the next conversation without replaying the old question',async()=>{
  const h=await runtime();
  h.failures.afterProject=()=>{throw Object.assign(new Error('lost ACK'),{code:'DELIVERY_UNCERTAIN'});};
  await h.receive('unknown-first','OLD_UNKNOWN');
  const oldTask=[...h.tasks.keys()][0],oldKey=submissions(h)[0].req.requestKey;
  h.failures.afterProject=null;
  const b=await h.receive('fresh','NEW_QUESTION');
  assert.equal(submissions(h).length,2);
  assert.notEqual(b.taskId,oldTask);
  assert.notEqual(b.id,oldKey);
  await h.ui('self-check');
  const old=(await jobs(h)).find(j=>j.id===oldKey);
  assert.equal(old.code,'HOST_RECEIPT_RECOVERED');
  assert.equal((await h.reply(old,'LATE_OLD')).ok,true);
  const c=await h.receive('fresh-next');
  assert.equal(c.taskId,b.taskId);
  assert.equal(submissions(h).filter(c=>c.req.requestKey===oldKey).length,1);
});

test('unknown followup acceptance does not block a later message or reuse its uncertain conversation',async()=>{
  const h=await runtime(),a=await h.receive('first');
  h.failures.taskSend='DELIVERY_UNCERTAIN';
  await h.receive('unknown-followup');
  const uncertainKey=submissions(h).at(-1).req.requestKey;
  h.failures.taskSend=null;
  const b=await h.receive('after-unknown');
  assert.equal(submissions(h).length,3);
  assert.notEqual(b.taskId,a.taskId);
  assert.equal((await jobs(h)).find(j=>j.id===uncertainKey).state,'uncertain');
  assert.equal((await h.reply(a,'LATE_FIRST')).ok,true);
});

test('already buffered inputs rotate their binding after a preceding lost ACK',async()=>{
  const h=await runtime();
  await h.notify('qq/status',{botId:'bot1',state:'error',code:'NODE_STOPPED'});
  await h.receive('buffered-first');
  await h.receive('buffered-second');
  assert.equal(submissions(h).length,0);
  h.failures.afterProject=()=>{h.failures.afterProject=null;throw Object.assign(new Error('lost ACK'),{code:'DELIVERY_UNCERTAIN'});};
  await h.notify('qq/status',{botId:'bot1',state:'connected'});
  assert.equal(submissions(h).length,2);
  const current=await jobs(h),old=current.find(j=>j.state==='uncertain'),next=current.find(j=>j.state==='waiting');
  assert.ok(old);assert.ok(next);
  assert.equal(next.taskId,[...h.tasks.keys()][1]);
  assert.equal(submissions(h).filter(c=>c.req.requestKey===old.id).length,1);
});
