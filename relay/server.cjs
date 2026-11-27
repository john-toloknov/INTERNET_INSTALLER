'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {WebSocketServer,WebSocket}=require('ws');
const PROTOCOL='umk3-stream-v1';
function signToken(claims,secret){const body=Buffer.from(JSON.stringify(claims)).toString('base64url');return body+'.'+crypto.createHmac('sha256',secret).update(body).digest('base64url');}
function verifyToken(token,secret,now=Date.now()){
 if(typeof token!=='string'||token.length>2400)throw Error('Invalid token');const parts=token.split('.');if(parts.length!==2)throw Error('Invalid token');
 const expected=crypto.createHmac('sha256',secret).update(parts[0]).digest(),given=Buffer.from(parts[1],'base64url');if(given.length!==expected.length||!crypto.timingSafeEqual(expected,given))throw Error('Invalid signature');
 const c=JSON.parse(Buffer.from(parts[0],'base64url').toString());
 if(c.v!==PROTOCOL||!['host','guest'].includes(c.role)||!/^mk_[A-Za-z0-9_-]{20,100}$/.test(c.room)||!/^\w{32,100}$/.test(c.sub)||typeof c.jti!=='string'||c.jti.length<16||c.jti.length>100||!["umk3-md-original-v1", "rr3-md-v1", "rock-md-v1", "ga3-md-v1", "sor3-md-v1", "tmnt-md-v1", "btd-md-v1", "wwf-md-v1", "comix-md-v1", "robo3-md-v1"].includes(c.release)||!Number.isFinite(c.iat)||!Number.isFinite(c.exp)||c.iat>now+30000||c.exp<=now||c.exp-c.iat>7200000||c.session!==undefined&&(!/^[A-Za-z0-9_-]{16,80}$/.test(c.session)||!Number.isSafeInteger(c.sessionVersion)||c.sessionVersion<1))throw Error('Expired or invalid claims');
 return c;
}
// coturn REST credentials are minted only after the existing room authentication.
// The permanent TURN secret never leaves this process; browsers receive expiring grants.
function iceSettings({stunUrls='stun:stun.l.google.com:19302',turnUrls='',turnSecret='',region=''}={}){
 const urls=(value,kind)=>{
  const list=Array.isArray(value)?value:String(value).split(',').map(s=>s.trim()).filter(Boolean);
  if(list.length>6||list.some(s=>typeof s!=='string'||s.length>300||!new RegExp('^'+kind+':[a-zA-Z0-9.\\[\\]:_-]+(?:\\?transport=(?:udp|tcp))?$').test(s)))throw Error('Invalid ICE URLs');
  return [...new Set(list)];
 };
 const stun=urls(stunUrls,'stun'),turn=urls(turnUrls,'turns?');
 if(!!turn.length!==!!turnSecret||turnSecret&&String(turnSecret).length<32)throw Error('Set TURN_URLS and a separate TURN_AUTH_SECRET (32+ characters) together');
 return {stun,turn,turnSecret,region:/^[a-zA-Z0-9 ._-]{1,48}$/.test(region)?region:''};
}
function iceGrant(settings,claims,now=Date.now()){
 const servers=settings.stun.length?[{urls:settings.stun}]:[];
 const expiresAt=Math.min(claims.exp,now+7200000),expires=Math.ceil(expiresAt/1000);
 if(settings.turn.length){
  const user=expires+':'+crypto.createHmac('sha256',settings.turnSecret).update(claims.room+':'+claims.sub+':'+claims.role).digest('hex').slice(0,20);
  servers.push({urls:settings.turn,username:user,credential:crypto.createHmac('sha1',settings.turnSecret).update(user).digest('base64')});
 }
 return {iceServers:servers,turnConfigured:settings.turn.length>0,expiresAt};
}
// Optional managed TURN. The permanent Cloudflare API token stays on this server.
// The endpoint is fixed; no arbitrary remote URL is accepted from clients/env.
function cloudflareTurnSettings({keyId='',apiToken=''}={}){
 if(!keyId&&!apiToken)return null;
 if(typeof keyId!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(keyId)||typeof apiToken!=='string'||apiToken.length<20||apiToken.length>1024||/[\r\n]/.test(apiToken))throw Error('Set CF_TURN_KEY_ID and CF_TURN_API_TOKEN together');
 return {keyId,apiToken};
}
async function cloudflareTurnGrant(settings,claims,fetcher=fetch){
 const now=Date.now(),ttl=Math.max(1,Math.min(7200,Math.floor((claims.exp-now)/1000)));
 const response=await fetcher('https://rtc.live.cloudflare.com/v1/turn/keys/'+settings.keyId+'/credentials/generate-ice-servers',{method:'POST',headers:{'Authorization':'Bearer '+settings.apiToken,'Content-Type':'application/json'},body:JSON.stringify({ttl}),signal:AbortSignal.timeout(3000)});
 if(!response.ok)throw Error('TURN provider unavailable');
 const bodyText=await response.text();if(bodyText.length>20000)throw Error('Invalid TURN response');const data=JSON.parse(bodyText),servers=[];
 for(const item of Array.isArray(data.iceServers)?data.iceServers:[]){
  const urls=(Array.isArray(item.urls)?item.urls:[item.urls]).filter(u=>typeof u==='string'&&/^(stun:stun|turns?:turn)\.cloudflare\.com:(3478|5349|443|80)(\?transport=(udp|tcp))?$/.test(u));
  if(!urls.length||urls.length>6)continue;
  if(urls.some(u=>u.startsWith('turn:')||u.startsWith('turns:'))){
   if(typeof item.username!=='string'||!item.username.length||item.username.length>1024||typeof item.credential!=='string'||!item.credential.length||item.credential.length>1024)continue;
   servers.push({urls,username:item.username,credential:item.credential});
  }else servers.push({urls});
 }
 if(!servers.some(s=>s.credential))throw Error('TURN provider returned no credentials');
 return {iceServers:servers,turnConfigured:true,turnProvider:'cloudflare',expiresAt:now+ttl*1000};
}
const DIAG_METRICS={relayRtt:30000,peerRtt:30000,rafFps:240,sendFps:120,fps:120,sourceFps:240,encodeMs:10000,decodeMs:10000,bufferMs:30000,lossPct:100,queueBytes:10000000,iceRtt:30000,maxFrameGapMs:30000,frameStalls:10000,rafGapMs:30000};
function cleanMetrics(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const out={};for(const [key,max] of Object.entries(DIAG_METRICS))if(Number.isFinite(value[key])&&value[key]>=0&&value[key]<=max)out[key]=Math.round(value[key]*10)/10;
 if(['websocket','webrtc','turn'].includes(value.route))out.route=value.route;
 return out;
}
function createRelayServer({secret,allowedOrigins,webRoot=null,maxRooms=16,ice={},cloudflareTurn={},turnFetch=fetch}={}){
 if(typeof secret!=='string'||secret.length<32)throw Error('Configure a separate relay secret with at least 32 characters');
 if(!(allowedOrigins instanceof Set))throw Error('Configure allowed frontend origins');
 const cf=cloudflareTurnSettings(cloudflareTurn);
 const settings=iceSettings(ice);if(settings.turnSecret===secret)throw Error('Use a separate TURN_AUTH_SECRET');
 const rooms=new Map(),attempts=new Map(),startedAt=Date.now();
 const server=http.createServer((req,res)=>{
  const respond=(code,obj)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(obj));};
  if(req.method==='GET'&&req.url==='/health'){respond(200,{ok:true,protocol:PROTOCOL,presenceVersion:1,networkVersion:3,turnConfigured:!!cf||settings.turn.length>0,turnProvider:cf?'cloudflare':settings.turn.length?'coturn':'none',region:settings.region});return;}
  if(req.method==='GET'&&req.url==='/umk3-status'){
   const at=String(req.headers['x-ii-timestamp']||''),nonce=String(req.headers['x-ii-nonce']||''),signature=String(req.headers['x-ii-signature']||'');
   const expected=crypto.createHmac('sha256',secret).update(at+':'+nonce+':status').digest('hex');
   if(!/^\d{13}$/.test(at)||Math.abs(Date.now()-Number(at))>60000||!/^[A-Za-z0-9_-]{16,80}$/.test(nonce)||!/^[a-f0-9]{64}$/.test(signature)||!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected))){respond(403,{error:'Forbidden'});return;}
   respond(200,{ok:true,protocol:PROTOCOL,presenceVersion:1,startedAt,now:Date.now(),rooms:[...rooms.values()].map(r=>({id:r.id,session:r.session,sessionVersion:r.sessionVersion,playing:r.playing,everReady:r.everReady,waitingSince:r.waitingSince,lastSeen:r.lastSeen}))});return;
  }
  if(!webRoot||!['GET','HEAD'].includes(req.method)){respond(404,{error:'Not found'});return;}
  let name;try{name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{respond(400,{error:'Invalid path'});return;}
  const base=path.resolve(webRoot),file=path.resolve(base,'.'+(name==='/'?'/index.html':name));
  if(!file.startsWith(base+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){respond(404,{error:'Not found'});return;}
  const ext=path.extname(file),mime={'.html':'text/html;charset=utf-8','.css':'text/css','.js':'text/javascript','.json':'application/json','.wasm':'application/wasm','.enc':'application/octet-stream','.data':'application/octet-stream'};
  res.writeHead(200,{'Content-Type':mime[ext]||'application/octet-stream','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store'});
  if(req.method==='HEAD'){res.end();return;}fs.createReadStream(file).pipe(res);
 });
 const wss=new WebSocketServer({noServer:true,maxPayload:262144,perMessageDeflate:false});
 function text(ws,value){if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(value));}
 // Keep only the newest video frame while a receiver is congested.
 // Input/control packets continue immediately; video does not build a stale FIFO.
 function forwardVideo(room,target,data){
  target.videoPending=Buffer.from(data);
  const flush=()=>{target.videoFlush=null;if(room[target.role]!==target||!room.playing||target.ws.readyState!==WebSocket.OPEN){target.videoPending=null;return;}if(target.ws.bufferedAmount>16384){target.videoFlush=setTimeout(flush,12);target.videoFlush.unref?.();return;}const latest=target.videoPending;target.videoPending=null;if(latest)target.ws.send(latest,{binary:true});};
  if(target.videoFlush)return;flush();
 }
 function peerStatus(room){
  const ready=!!(room.host?.ready&&room.guest?.ready&&room.host?.visible&&room.guest?.visible);
  if(ready){room.everReady=true;room.waitingSince=0;}else if(room.everReady&&!room.waitingSince)room.waitingSince=Date.now();
  room.playing=ready;const msg={type:ready?'peer-ready':'waiting',generation:room.generation,host:!!room.host,guest:!!room.guest,hostVisible:room.host?.visible??false,guestVisible:room.guest?.visible??false};
  text(room.host?.ws,msg);text(room.guest?.ws,msg);
 }
 server.on('upgrade',(req,socket,head)=>{
  if(req.url!=='/umk3-play'||!allowedOrigins.has(req.headers.origin)){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
  const now=Date.now(),ip=req.socket.remoteAddress||'unknown';let a=attempts.get(ip);if(!a||now-a.at>60000){a={at:now,count:0};attempts.set(ip,a);}if(++a.count>120){socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');return;}
  wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
 });
 wss.on('connection',ws=>{
  let member=null,room=null,alive=true;const loginTimer=setTimeout(()=>ws.close(4000,'Authentication required'),5000);
  ws.on('pong',()=>alive=true);
  ws.on('message',async(data,binary)=>{
   if(!member){
    if(binary||data.length>3000){ws.close(4001,'Invalid authentication');return;}
    try{
     const auth=JSON.parse(data.toString());if(auth.type!=='auth')throw Error();const c=verifyToken(auth.token,secret);room=rooms.get(c.room);
     if(room&&c.session!==undefined&&(room.session!==c.session||room.sessionVersion!==c.sessionVersion)){
      if((room.sessionVersion||0)>=c.sessionVersion)throw Error('Stale game session');
      const previous=[room.host,room.guest];room.host=room.guest=null;rooms.delete(c.room);for(const peer of previous)peer?.ws.close(4004,'Game session replaced');room=null;
     }
     if(room&&room.session&&c.session===undefined)throw Error('Legacy session replaced');
     if(!room){if(rooms.size>=maxRooms){ws.close(4002,'Server is busy');return;}room={id:c.room,release:c.release,session:c.session||'',sessionVersion:c.sessionVersion||0,generation:0,host:null,guest:null,playing:false,everReady:false,waitingSince:0,lastSeen:Date.now()};rooms.set(c.room,room);}
     if(room.release!==c.release){ws.close(4001,'Game mismatch');return;}const old=room[c.role];if(old){if(old.claims.sub!==c.sub||c.iat<old.claims.iat){ws.close(4001,'Role already occupied');return;}old.ws.close(4004,'Session replaced');}
     member={ws,authPending:true,claims:c,role:c.role,ready:false,visible:true,at:Date.now(),counts:{frame:0,audio:0,input:0,control:0,telemetry:0}};room[c.role]=member;room.generation++;
     let network=iceGrant(settings,c);
     if(cf){try{network=await cloudflareTurnGrant(cf,c,turnFetch);}catch{network={...network,turnConfigured:true,turnProvider:'cloudflare',turnError:'turn-provider-unavailable'};}}
     if(ws.readyState!==WebSocket.OPEN||room[c.role]!==member)return;
     if(c.exp<=Date.now()){ws.close(4003,'Session expired');return;}member.authPending=false;
     clearTimeout(loginTimer);text(ws,{type:'welcome',role:c.role,protocol:PROTOCOL,features:['rtc-v1','latest-video-v1','net-diagnostics-v1','ice-config-v1'],network:{...network,region:settings.region}});peerStatus(room);
    }catch{ws.close(4001,'Invalid or expired authentication');}return;
   }
   if(room[member.role]!==member||member.authPending)return;
   const now=Date.now();if(now>=member.claims.exp){ws.close(4003,'Session expired');return;}room.lastSeen=now;
   if(now-member.at>=1000){member.at=now;member.counts={frame:0,audio:0,input:0,control:0,telemetry:0};}
   if(!binary){
    if(data.length>65536||++member.counts.control>140){ws.close(4005,'Control limit');return;}
    let event;try{event=JSON.parse(data.toString());}catch{ws.close(4005,'Invalid control');return;}
    if(event.type==='ready'){member.ready=true;peerStatus(room);}
    else if(event.type==='visibility'&&typeof event.visible==='boolean'){member.visible=event.visible;peerStatus(room);}
    else if(event.type==='rtc'){
     if(!room.playing||event.generation!==room.generation)return;
     const d=event.description,c=event.candidate;
     const valid=event.disabled===true||d&&typeof d.sdp==='string'&&d.sdp.length<=60000&&d.type===(member.role==='host'?'offer':'answer')||c&&typeof c.candidate==='string'&&c.candidate.length<=2048&&(c.sdpMid===null||typeof c.sdpMid==='string'&&c.sdpMid.length<100)&&(c.sdpMLineIndex===null||Number.isInteger(c.sdpMLineIndex)&&c.sdpMLineIndex>=0&&c.sdpMLineIndex<20);
     if(!valid){ws.close(4005,'Invalid peer signal');return;}
     text(room[member.role==='host'?'guest':'host']?.ws,{type:'rtc',generation:room.generation,...(event.disabled===true?{disabled:true}:d?{description:{type:d.type,sdp:d.sdp}}:{candidate:c})});
    }
    else if(event.type==='net-probe'||event.type==='net-metrics'){
     if(!room.playing||event.generation!==room.generation||++member.counts.telemetry>6)return;
     const other=room[member.role==='host'?'guest':'host']?.ws;
     if(!other||other.bufferedAmount>16384)return;
     if(event.type==='net-probe'){
      if(!['ping','pong'].includes(event.kind)||!Number.isSafeInteger(event.id)||event.id<1||event.id>4294967295){ws.close(4005,'Invalid probe');return;}
      text(other,{type:'net-probe',generation:room.generation,kind:event.kind,id:event.id});
     }else{
      const metrics=cleanMetrics(event.metrics);if(!metrics){ws.close(4005,'Invalid metrics');return;}
      text(other,{type:'net-metrics',generation:room.generation,metrics});
     }
    }
    else if(event.type==='ping')text(ws,{type:'pong',at:Number.isFinite(event.at)?event.at:0});
    else ws.close(4005,'Unsupported control');return;
   }
   if(!room.playing)return;
   const type=data[0],other=room[member.role==='host'?'guest':'host']?.ws;if(!other||other.readyState!==WebSocket.OPEN)return;
   if(type===1){if(member.role!=='host'||data.length<10||++member.counts.frame>65){ws.close(4005,'Invalid video');return;}forwardVideo(room,room[member.role==='host'?'guest':'host'],data);}
   else if(type===2){if(member.role!=='guest'||data.length!==3||data.readUInt16LE(1)>4095||++member.counts.input>160){ws.close(4005,'Invalid input');return;}other.send(data,{binary:true});}
   else if(type===3){if(member.role!=='host'||data.length<7||data.length>16389||(data.length-5)%2!==0||data.readUInt32LE(1)<16000||data.readUInt32LE(1)>48000||++member.counts.audio>80){ws.close(4005,'Invalid audio');return;}if(other.bufferedAmount<24576)other.send(data,{binary:true});}
   else ws.close(4005,'Unsupported packet');
  });
  ws.on('close',()=>{clearTimeout(loginTimer);clearTimeout(member?.videoFlush);if(member)member.videoPending=null;if(member&&room?.[member.role]===member){room[member.role]=null;room.lastSeen=Date.now();peerStatus(room);}});
  ws.on('error',()=>{});
  ws.isAlive=()=>{const value=alive;alive=false;return value;};
 });
 const maintenance=setInterval(()=>{
  const now=Date.now();for(const ws of wss.clients){if(!ws.isAlive?.()){ws.terminate();continue;}if(ws.readyState===WebSocket.OPEN)ws.ping();}
  for(const [id,room] of rooms){for(const role of ['host','guest']){const member=room[role];if(member&&member.claims.exp<=now)member.ws.close(4003,'Session expired');}if(!room.host&&!room.guest&&now-room.lastSeen>180000)rooms.delete(id);}
  for(const [ip,a] of attempts)if(now-a.at>120000)attempts.delete(ip);
 },15000);maintenance.unref();
 return {server,wss,rooms,close:async()=>{clearInterval(maintenance);for(const room of rooms.values())for(const role of ['host','guest'])clearTimeout(room[role]?.videoFlush);for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}};
}
if(require.main===module){
 const allowedOrigins=new Set(String(process.env.FRONTEND_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean));if(!allowedOrigins.size)throw Error('Set FRONTEND_ORIGINS');
 const app=createRelayServer({secret:process.env.GAMES_RELAY_SECRET,allowedOrigins,webRoot:process.env.WEB_ROOT||null,maxRooms:Number(process.env.MAX_ROOMS)||16,ice:{stunUrls:process.env.STUN_URLS,turnUrls:process.env.TURN_URLS,turnSecret:process.env.TURN_AUTH_SECRET,region:process.env.RELAY_REGION},cloudflareTurn:{keyId:process.env.CF_TURN_KEY_ID,apiToken:process.env.CF_TURN_API_TOKEN}});
 app.server.listen(Number(process.env.PORT)||8080,'0.0.0.0',()=>console.log('UMK3 authenticated relay listening; protocol '+PROTOCOL));
 process.on('SIGTERM',()=>{void app.close().then(()=>process.exit(0));});
}
module.exports={createRelayServer,verifyToken,signToken,PROTOCOL,iceSettings,iceGrant,cleanMetrics,cloudflareTurnSettings,cloudflareTurnGrant};
