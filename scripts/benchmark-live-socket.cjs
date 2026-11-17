// Local transport benchmark. A synthetic revision replaces MySQL commit;
// acknowledgement is message receipt, not a rendered iPhone frame.
const http = require('node:http');
const { once } = require('node:events');
const WS = require('ws');
const { install } = require('../lib/live-socket.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
(async () => {
 for (const count of [1,10,100,1000,10000]) {
  let revision=0, start=0, received=0, ready=0, checks=0;
  const samples=[], clients=[];
  const server=http.createServer();
  const hub=install(server,{verifyToken:async()=>({}),revision:async()=>{checks++;return revision},invalidate(){},
   loadSnapshot:async()=>({scorers:{test:{runs:115+revision,wickets:3,innings:3}}})});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  let errors=0;
  const cpu=process.cpuUsage(), wall=performance.now();
  try {
   for(let i=0;i<count;i++) {
    const ws=new WS(`ws://127.0.0.1:${server.address().port}/api/live-updates`);
    ws.on('error',()=>errors++);
    ws.on('open',()=>ws.send(JSON.stringify({token:'local-fixture',scoreSnapshots:true})));
    ws.on('message',data=>{const m=JSON.parse(data);if(m.type==='ready')ready++;if(m.type==='score_snapshot'){samples.push(performance.now()-start);received++;}});
    clients.push(ws); if(i%100===99) await delay(10);
   }
   const deadline=Date.now()+30000;
   while(ready<count && Date.now()<deadline && !errors) await delay(10);
   if(ready!==count) throw Error('Only '+ready+' authenticated viewers connected');
   while(!checks) await delay(5);
   for(let turn=0;turn<5;turn++) {
    received=0; start=performance.now(); revision++;
    const deadline=Date.now()+5000;
    while(received<count && Date.now()<deadline) await delay(5);
    if(received!==count) throw Error('Update deliveries '+received+'/'+count);
   }
   samples.sort((a,b)=>a-b);
   const percentile=p=>Number(samples[Math.min(samples.length-1,Math.ceil(samples.length*p)-1)].toFixed(2));
   const used=process.cpuUsage(cpu);
   console.log(JSON.stringify({viewers:count,updates:5,deliveries:samples.length,p50ms:percentile(.5),p95ms:percentile(.95),p99ms:percentile(.99),errors,lost:count*5-samples.length,rssMB:Math.round(process.memoryUsage().rss/1048576),cpuMs:(used.user+used.system)/1000,wallMs:Math.round(performance.now()-wall)}));
  } catch(error){console.log(JSON.stringify({viewers:count,error:error.message,errors}));}
  finally {for(const ws of clients)ws.terminate();for(const ws of hub.clients)ws.terminate();await new Promise(r=>hub.close(r));await new Promise(r=>server.close(r));}
 }
})().catch(error=>{console.error(error);process.exitCode=1});
