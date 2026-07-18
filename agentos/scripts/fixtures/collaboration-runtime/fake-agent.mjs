process.stdout.write(JSON.stringify({type:'status',phase:'working',label:'fake working'})+'\n');
process.stdout.write(JSON.stringify({type:'assistant.message',text:'fake streaming response'})+'\n');
process.stdout.write(JSON.stringify({type:'usage',source:'structured',provider:'codex',estimated:false,inputTokens:12,outputTokens:8})+'\n');
