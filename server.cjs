'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {WebSocketServer,WebSocket}=require('ws');
const PROTOCOL='umk3-stream-v1';
function signToken(claims,secret){const body=Buffer.from(JSON.stringify(claims)).toString('base64url');return body+'.'+crypto.createHmac('sha256',secret).update(body).digest('base64url');}
function verifyToken(token,secret,now=Date.now()){
 if(typeof token!=='string'||token.length>2400)throw Error('Invalid token');const parts=token.split('.');if(parts.length!==2)throw Error('Invalid token');
 const expected=crypto.createHmac('sha256',secret).update(parts[0]).digest(),given=Buffer.from(parts[1],'base64url');if(given.length!==expected.length||!crypto.timingSafeEqual(expected,given))throw Error('Invalid signature');
 const c=JSON.parse(Buffer.from(parts[0],'base64url').toString());
 if(c.v!==PROTOCOL||!['host','guest'].includes(c.role)||!/^mk_[A-Za-z0-9_-]{20,100}$/.test(c.room)||!/^\w{32,100}$/.test(c.sub)||typeof c.jti!=='string'||c.jti.length<16||c.jti.length>100||!['umk3-md-original-v1','rr3-md-v1','rock-md-v1'].includes(c.release)||!Number.isFinite(c.iat)||!Number.isFinite(c.exp)||c.iat>now+30000||c.exp<=now||c.exp-c.iat>7200000)throw Error('Expired or invalid claims');
 return c;
}
function createRelayServer({secret,allowedOrigins,webRoot=null,maxRooms=16}={}){
 if(typeof secret!=='string'||secret.length<32)throw Error('Configure a separate relay secret with at least 32 characters');
 if(!(allowedOrigins instanceof Set))throw Error('Configure allowed frontend origins');
 const rooms=new Map(),attempts=new Map();
 const server=http.createServer((req,res)=>{
  const respond=(code,obj)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(obj));};
  if(req.method==='GET'&&req.url==='/health'){respond(200,{ok:true,protocol:PROTOCOL});return;}
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
 function peerStatus(room){
  const ready=!!(room.host?.ready&&room.guest?.ready&&room.host?.visible&&room.guest?.visible);
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
  ws.on('message',(data,binary)=>{
   if(!member){
    if(binary||data.length>3000){ws.close(4001,'Invalid authentication');return;}
    try{
     const auth=JSON.parse(data.toString());if(auth.type!=='auth')throw Error();const c=verifyToken(auth.token,secret);room=rooms.get(c.room);
     if(!room){if(rooms.size>=maxRooms){ws.close(4002,'Server is busy');return;}room={id:c.room,release:c.release,generation:0,host:null,guest:null,playing:false,lastSeen:Date.now()};rooms.set(c.room,room);}
     if(room.release!==c.release){ws.close(4001,'Game mismatch');return;}const old=room[c.role];if(old){if(old.claims.sub!==c.sub||c.iat<old.claims.iat){ws.close(4001,'Role already occupied');return;}old.ws.close(4004,'Session replaced');}
     member={ws,claims:c,role:c.role,ready:false,visible:true,at:Date.now(),counts:{frame:0,audio:0,input:0,control:0}};room[c.role]=member;room.generation++;
     clearTimeout(loginTimer);text(ws,{type:'welcome',role:c.role,protocol:PROTOCOL,features:['rtc-v1']});peerStatus(room);
    }catch{ws.close(4001,'Invalid or expired authentication');}return;
   }
   if(room[member.role]!==member)return;
   const now=Date.now();if(now>=member.claims.exp){ws.close(4003,'Session expired');return;}room.lastSeen=now;
   if(now-member.at>=1000){member.at=now;member.counts={frame:0,audio:0,input:0,control:0};}
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
    else if(event.type==='ping')text(ws,{type:'pong',at:event.at});
    else ws.close(4005,'Unsupported control');return;
   }
   if(!room.playing)return;
   const type=data[0],other=room[member.role==='host'?'guest':'host']?.ws;if(!other||other.readyState!==WebSocket.OPEN)return;
   if(type===1){if(member.role!=='host'||data.length<10||++member.counts.frame>65){ws.close(4005,'Invalid video');return;}if(other.bufferedAmount<49152)other.send(data,{binary:true});}
   else if(type===2){if(member.role!=='guest'||data.length!==3||data.readUInt16LE(1)>4095||++member.counts.input>160){ws.close(4005,'Invalid input');return;}other.send(data,{binary:true});}
   else if(type===3){if(member.role!=='host'||data.length<7||data.length>16389||(data.length-5)%2!==0||data.readUInt32LE(1)<16000||data.readUInt32LE(1)>48000||++member.counts.audio>80){ws.close(4005,'Invalid audio');return;}if(other.bufferedAmount<24576)other.send(data,{binary:true});}
   else ws.close(4005,'Unsupported packet');
  });
  ws.on('close',()=>{clearTimeout(loginTimer);if(member&&room?.[member.role]===member){room[member.role]=null;room.lastSeen=Date.now();peerStatus(room);}});
  ws.on('error',()=>{});
  ws.isAlive=()=>{const value=alive;alive=false;return value;};
 });
 const maintenance=setInterval(()=>{
  const now=Date.now();for(const ws of wss.clients){if(!ws.isAlive?.()){ws.terminate();continue;}if(ws.readyState===WebSocket.OPEN)ws.ping();}
  for(const [id,room] of rooms){for(const role of ['host','guest']){const member=room[role];if(member&&member.claims.exp<=now)member.ws.close(4003,'Session expired');}if(!room.host&&!room.guest&&now-room.lastSeen>30000)rooms.delete(id);}
  for(const [ip,a] of attempts)if(now-a.at>120000)attempts.delete(ip);
 },15000);maintenance.unref();
 return {server,wss,rooms,close:async()=>{clearInterval(maintenance);for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}};
}
if(require.main===module){
 const allowedOrigins=new Set(String(process.env.FRONTEND_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean));if(!allowedOrigins.size)throw Error('Set FRONTEND_ORIGINS');
 const app=createRelayServer({secret:process.env.GAMES_RELAY_SECRET,allowedOrigins,webRoot:process.env.WEB_ROOT||null,maxRooms:Number(process.env.MAX_ROOMS)||16});
 app.server.listen(Number(process.env.PORT)||8080,'0.0.0.0',()=>console.log('UMK3 authenticated relay listening; protocol '+PROTOCOL));
 process.on('SIGTERM',()=>{void app.close().then(()=>process.exit(0));});
}
module.exports={createRelayServer,verifyToken,signToken,PROTOCOL};
