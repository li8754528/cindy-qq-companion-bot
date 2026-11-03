const fs=require("node:fs"),path=require("node:path"),zlib=require("node:zlib"),esbuild=require("esbuild");
const root=path.resolve(__dirname,"..");
function crc32(b){let c=0xffffffff;for(const v of b){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(type,data){const t=Buffer.from(type),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([size,t,data,crc]);}
function icon(){const n=128,pixels=Buffer.alloc(n*(n*4+1));for(let y=0;y<n;y++)for(let x=0;x<n;x++){let inside=(x>=16&&x<91&&y>=21&&y<76)||(x>=25&&x<41&&y>=70&&y<92)||(x>=55&&x<112&&y>=66&&y<105)||(x>=89&&x<102&&y>=96&&y<115);const dot=[35,54,73].some(cx=>(x-cx)**2+(y-48)**2<25);let o=y*(n*4+1)+1+x*4;pixels[o]=dot?255:46;pixels[o+1]=dot?255:107;pixels[o+2]=dot?255:201;pixels[o+3]=inside?255:0;}const h=Buffer.alloc(13);h.writeUInt32BE(n,0);h.writeUInt32BE(n,4);h[8]=8;h[9]=6;fs.writeFileSync(path.join(root,"assets/icon.png"),Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",h),chunk("IDAT",zlib.deflateSync(pixels)),chunk("IEND",Buffer.alloc(0))]));}
(async()=>{
await esbuild.build({absWorkingDir:root,entryPoints:["src/main.mjs"],outfile:"main.js",bundle:true,format:"iife",platform:"browser",target:"chrome120",legalComments:"eof"});
await esbuild.build({absWorkingDir:root,entryPoints:["src/worker.mjs"],outfile:"node/worker.cjs",bundle:true,format:"cjs",platform:"node",target:"node20",external:["bufferutil","utf-8-validate","silk-wasm","mpg123-decoder"],legalComments:"eof"});
icon();console.log("Built main.js, node/worker.cjs and original icon.");
})().catch(e=>{console.error(e.message);process.exitCode=1;});
