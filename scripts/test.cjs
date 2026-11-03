const fs=require("node:fs"),path=require("node:path"),{spawnSync}=require("node:child_process");
const root=path.resolve(__dirname,"..");
const files=fs.readdirSync(path.join(root,"tests")).filter(n=>/\.test\.(cjs|mjs)$/.test(n)).map(n=>path.join(root,"tests",n));
const r=spawnSync(process.execPath,["--test",...files],{cwd:root,stdio:"inherit"});process.exit(r.status??1);
