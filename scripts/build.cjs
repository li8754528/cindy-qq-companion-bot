const path=require("node:path"),esbuild=require("esbuild");
const root=path.resolve(__dirname,"..");
(async()=>{
await esbuild.build({absWorkingDir:root,entryPoints:["src/main.mjs"],outfile:"main.js",bundle:true,format:"iife",platform:"browser",target:"chrome120",legalComments:"eof"});
await esbuild.build({absWorkingDir:root,entryPoints:["src/worker.mjs"],outfile:"node/worker.cjs",bundle:true,format:"cjs",platform:"node",target:"node20",external:["bufferutil","utf-8-validate","silk-wasm","mpg123-decoder"],legalComments:"eof"});
console.log("Built main.js and node/worker.cjs; existing icon preserved.");
})().catch(e=>{console.error(e.message);process.exitCode=1;});
