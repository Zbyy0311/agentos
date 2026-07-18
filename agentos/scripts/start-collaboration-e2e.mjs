import { spawn } from 'node:child_process';
const children=[]; const start=(command,args,env={})=>{const child=spawn(command,args,{stdio:'inherit',shell:true,env:{...process.env,...env}});children.push(child);return child;};
start('pnpm.cmd',['--filter','@agentos/server','dev:stable'],{PORT:'3200',AGENTOS_SERVER_HOST:'127.0.0.1'}); start('pnpm.cmd',['--filter','@agentos/web','dev','--','-p','3201']);
const stop=()=>children.forEach(child=>child.kill('SIGTERM')); process.on('SIGINT',stop); process.on('SIGTERM',stop); process.on('exit',stop);
