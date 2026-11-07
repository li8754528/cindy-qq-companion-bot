const clone = value => JSON.parse(JSON.stringify(value));
const error = () => Object.assign(new Error('插件状态无法核实，已保留原文件，未重放发送。'),{code:'STATE_RECOVERY_REQUIRED'});
async function hash(value) { const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join(''); }
// Both verified copies of every intent precede any external side effect. A lone
// copy is never rolled back to legacy data or automatically repaired/replayed.
export class StateStore {
  constructor(io,name,legacy) {this.io=io;this.paths=[name+'.a.json',name+'.b.json'];this.legacy=legacy;this.seq=0;this.tail=Promise.resolve();this.blocked=false;}
  async read() {
    const raws=await Promise.all(this.paths.map(p=>this.io.read(p)));
    if(raws.every(x=>x===null)) {
      if(await this.io.read(this.paths[0]+'.started')!==null)throw error();
      return this.legacy?this.legacy():null;
    }
    const copies=[];
    for(const raw of raws) {
      if(raw===null)throw error();
      let x;try{x=JSON.parse(raw);}catch{throw error();}
      if(x.format!==1||!Number.isSafeInteger(x.seq)||x.seq<1||!x.payload||x.hash!==await hash([x.seq,x.payload]))throw error();
      copies.push(x);
    }
    if(copies[0].seq!==copies[1].seq||copies[0].hash!==copies[1].hash)throw error();
    this.seq=copies[0].seq;return clone(copies[0].payload);
  }
  write(payload) {
    const frozen=clone(payload);
    const run=this.tail.then(async()=>{
      if(this.blocked)throw error();
      const record={format:1,seq:++this.seq,payload:frozen};record.hash=await hash([record.seq,record.payload]);
      const text=JSON.stringify(record);if(new TextEncoder().encode(text).length>4*1024*1024)throw Object.assign(new Error('插件状态空间不足，未发送。'),{code:'STATE_CAPACITY_FULL'});
      try {
        await this.io.write(this.paths[0]+'.started','1');
        for(const path of this.paths) {await this.io.write(path,text);if(await this.io.read(path)!==text)throw error();}
      } catch(e) {this.blocked=true;throw e;}
    });
    this.tail=run.catch(()=>{});return run;
  }
}
