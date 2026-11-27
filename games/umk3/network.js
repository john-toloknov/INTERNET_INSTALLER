'use strict';
class Umk3RelayBase {
 constructor(config,hooks){this.config=config;this.hooks=hooks;this.closed=false;this.ready=false;this.playing=false;this.attempt=0;this.seq=0;this.lastFrame=0;this.frames=0;this.bytes=0;this.mask=0;this.lastInputAt=0;this.decodeBusy=false;this.pending=null;this.audioAt=0;this.gains=new Set();this.audioPackets=0;this.audioPeak=0;this.receivedAudio=0;this.lastDrawAt=0;this.lastPongAt=Date.now();this.lastPingAt=0;this.rtt=0;this.reconnects=0;this.connection=0;this.slowLinkUntil=0;this.streamLevel=0;this.profileChangedAt=0;this.lastMetricsAt=0;this.diag={};this.diagEvents=[];this.probes=new Map();this.probeSeq=0;this.sentFrames=0;this.rafFrames=0;this.encodeSum=0;this.encodeCount=0;this.decodeSum=0;this.decodeCount=0;}
 streamProfile(){
  const level=Math.max(0,Math.min(2,this.streamLevel||0)),mobile=this.config.mobileHost===true;
  // Через сервер меняем размер и сжатие кадра, сохраняя плавность передачи.
  return [{fps:mobile?30:50,bitrate:mobile?600000:900000,relayFps:24,width:320,quality:mobile?.52:.60,scale:1},{fps:24,bitrate:400000,relayFps:24,width:288,quality:.46,scale:1},{fps:18,bitrate:250000,relayFps:24,width:256,quality:.40,scale:1.25}][level];
 }
 setStreamLevel(level){
  const next=Math.max(0,Math.min(2,Math.round(level)));if(this.streamLevel===next)return;this.streamLevel=next;this.profileChangedAt=Date.now();this.applyStreamProfile?.();
 }
 connect(){
  const url=new URL(this.config.url);if(url.protocol!=='wss:'&&!(url.protocol==='ws:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw Error('Нужен защищённый адрес сетевой игры');
  const connection=++this.connection;this.socket=new WebSocket(url.href);this.socket.binaryType='arraybuffer';
  this.socket.onopen=()=>{if(this.closed||connection!==this.connection)return;this.lastPongAt=Date.now();this.socket.send(JSON.stringify({type:'auth',token:this.config.token}));};
  this.socket.onmessage=event=>{if(this.closed||connection!==this.connection)return;if(typeof event.data==='string'){this.control(JSON.parse(event.data));return;}const data=new Uint8Array(event.data);if(data[0]===1&&this.config.role==='guest')this.frame(data);else if(data[0]===2&&this.config.role==='host'){this.lastInputAt=Date.now();this.hooks.input(new DataView(data.buffer).getUint16(1,true));}else if(data[0]===3&&this.config.role==='guest'&&!this.direct)this.audio(data);};
  this.socket.onclose=event=>{if(this.closed||connection!==this.connection)return;this.playing=false;this.hooks.waiting('Связь прервалась. Восстанавливаем соединение…');this.hooks.input?.(0);if(this.closed)return;if([4001,4003,4004,4005].includes(event.code)){this.hooks.failed('Сессия завершена. Откройте матч заново.');return;}if(this.attempt++<3){this.reconnects++;this.retry=setTimeout(()=>this.connect(),1000*Math.pow(2,this.attempt-1));}else this.hooks.failed('Не удалось восстановить связь. Откройте матч заново.');};
  this.socket.onerror=()=>{};
  if(!this.heartbeat)this.heartbeat=setInterval(()=>{const now=Date.now();if(this.config.role==='guest')this.input(this.mask);if(this.config.role==='host'&&now-this.lastInputAt>1500)this.hooks.input(0);if(this.socket?.readyState!==WebSocket.OPEN)return;if(now-this.lastPingAt>2000){this.lastPingAt=now;this.send({type:'ping',at:now});}if(!document.hidden&&now-this.lastPongAt>16000){this.lastPongAt=now;this.socket.close(4000,'Recover stalled connection');}else if(!document.hidden&&this.config.role==='guest'&&this.playing&&this.lastDrawAt&&now-this.lastDrawAt>3000){this.lastDrawAt=now;if(!this.recoverVideoStall?.())this.socket.close(4000,'Recover stalled stream');}if(now-this.lastMetricsAt>2000){this.lastMetricsAt=now;this.sampleDiagnostics(now);}},50);
 }
 control(message){
  if(message.type==='net-probe'&&message.generation===this.roomGeneration&&this.playing){this.receiveProbe(message,'websocket');return;}
  if(message.type==='net-metrics'&&message.generation===this.roomGeneration&&this.playing){this.remoteMetrics={at:Date.now(),...this.safeMetrics(message.metrics)};return;}
  if(message.type==='pong'){this.lastPongAt=Date.now();this.rtt=Math.max(0,Date.now()-Number(message.at||Date.now()));this.rttAt=Date.now();return;}
  if(message.type==='welcome'){this.rttAt=0;this.diagSupported=message.features?.includes('net-diagnostics-v1')===true;this.probes.clear();this.wsPeerRtt=null;this.remoteMetrics=null;this.lastPongAt=Date.now();this.lastFrame=0;this.pending=null;this.attempt=0;if(this.ready)this.send({type:'ready'});this.send({type:'visibility',visible:!document.hidden});}
  else if(message.type==='peer-ready'){this.waitingReason=null;if(this.roomGeneration!==message.generation){this.probes.clear();this.wsPeerRtt=null;this.remoteMetrics=null;}this.roomGeneration=message.generation;this.playing=true;this.lastFrame=0;this.audioAt=0;this.lastDrawAt=Date.now();this.hooks.connected();}
  else if(message.type==='waiting'){this.waitingReason=!message.host?'host-offline':!message.guest?'guest-offline':message.hostVisible===false?'host-hidden':message.guestVisible===false?'guest-hidden':'not-ready';this.playing=false;this.probes.clear();this.wsPeerRtt=null;this.remoteMetrics=null;this.hooks.input?.(0);this.audioAt=0;this.hooks.waiting(!message.host?'Ждём первого игрока…':!message.guest?'Ждём соперника…':message.hostVisible===false?'Первый игрок свернул игру. Ждём его возвращения.':message.guestVisible===false?'Соперник свернул игру. Ждём его возвращения.':'Ждём готовности обоих игроков.');}
 }
 safeMetrics(value){
  const out={};if(!value||typeof value!=='object')return out;
  const limits={relayRtt:30000,peerRtt:30000,rafFps:240,sendFps:120,fps:120,sourceFps:240,encodeMs:10000,decodeMs:10000,bufferMs:30000,lossPct:100,queueBytes:10000000,iceRtt:30000,maxFrameGapMs:30000,frameStalls:10000,rafGapMs:30000};
  for(const [key,max] of Object.entries(limits))if(Number.isFinite(value[key])&&value[key]>=0&&value[key]<=max)out[key]=Math.round(value[key]*10)/10;
  if(['websocket','webrtc','turn'].includes(value.route))out.route=value.route;return out;
 }
 trace(code){
  if(!/^[a-z0-9_-]{1,48}$/.test(code))return;
  const now=Date.now(),last=this.diagEvents.at(-1);if(last?.code===code&&now-last.at<2000)return;
  this.diagEvents.push({at:now,code});if(this.diagEvents.length>8)this.diagEvents.shift();this.diag.reason=code;
 }
 probe(route){
  const now=Date.now();for(const [id,p] of this.probes)if(now-p.at>10000)this.probes.delete(id);
  if(this.probes.size>=4)return;const id=this.probeSeq=this.probeSeq%4294967295+1;
  const m={type:route==='websocket'?'net-probe':'latency-ping',generation:this.roomGeneration,kind:'ping',id};
  if(route==='websocket'){if(!this.diagSupported||this.socket?.bufferedAmount>16384)return;this.send(m);}else if(!this.peerSend?.(m))return;
  this.probes.set(id,{at:now,route});
 }
 receiveProbe(m,route){
  if(!Number.isSafeInteger(m.id)||m.id<1||m.id>4294967295)return;
  if(m.kind==='ping'||m.type==='latency-ping'){
   if(route==='websocket')this.send({type:'net-probe',generation:this.roomGeneration,kind:'pong',id:m.id});else this.peerSend({type:'latency-pong',id:m.id});return;
  }
  const p=this.probes.get(m.id);if(!p||p.route!==route)return;this.probes.delete(m.id);const rtt=Date.now()-p.at;if(rtt<0||rtt>10000)return;
  if(route==='websocket'){this.wsPeerRtt=rtt;this.wsPeerRttAt=Date.now();}else{this.inputRtt=rtt;this.inputRttAt=Date.now();}
 }
 sampleDiagnostics(now=Date.now()){
  const prev=this.metricSample,seconds=prev?Math.max(.001,(now-prev.at)/1000):0;
  const fps=(key)=>seconds?Math.max(0,(this[key]-(prev?.[key]||0))/seconds):null;
  const recent=(at)=>Number.isFinite(at)&&now-at<6500;
  const peerRtt=this.direct?(recent(this.inputRttAt)?this.inputRtt:null):(recent(this.wsPeerRttAt)?this.wsPeerRtt:null);
  const local={maxFrameGapMs:this.frameGapMax||0,frameStalls:this.frameStalls||0,rafGapMs:this.rafGapMax||0,...this.safeMetrics(this.diag),route:this.direct?(this.diag.route==='turn'?'turn':'webrtc'):'websocket',relayRtt:recent(this.rttAt)?this.rtt:null,peerRtt,
   rafFps:this.config.role==='host'?fps('rafFrames'):null,sendFps:this.config.role==='host'&&!this.direct?fps('sentFrames'):this.diag.sendFps??null,
   fps:this.config.role==='guest'?fps('frames'):null,encodeMs:!this.direct&&this.encodeCount?this.encodeSum/this.encodeCount:this.diag.encodeMs??null,
   decodeMs:!this.direct&&this.decodeCount?this.decodeSum/this.decodeCount:this.diag.decodeMs??null,queueBytes:this.socket?.bufferedAmount||0};
  this.frameGapMax=this.frameStalls=this.rafGapMax=0;this.metricSample={at:now,frames:this.frames,sentFrames:this.sentFrames,rafFrames:this.rafFrames};this.encodeSum=this.encodeCount=this.decodeSum=this.decodeCount=0;
  if(this.playing){this.probe('websocket');if(this.direct)this.probe('webrtc');if(this.diagSupported&&this.socket?.bufferedAmount<16384)this.send({type:'net-metrics',generation:this.roomGeneration,metrics:this.safeMetrics(local)});}
  this.hooks.diagnostics?.({...local,direct:!!this.direct,profile:this.streamLevel,playing:this.playing,role:this.config.role,turnConfigured:!!this.turnConfigured,region:this.relayRegion||'',
   turnError:this.turnError||null,waitingReason:this.waitingReason||null,audio:this.audioStats?{queueMs:this.audioStats.queueMs,jitterMs:this.audioStats.jitterMs,underruns:this.audioStats.underruns,droppedMs:this.audioStats.droppedMs}:null,audioMode:this.audioSink?'buffered':this.sinkFallback?'compatibility':'starting',iceState:this.diag.iceState||'new',gathering:this.diag.gathering||'new',candidateTypes:this.diag.candidateTypes||[],candidatePair:this.diag.candidatePair||null,
   reason:this.diag.reason||null,events:this.diagEvents.slice(),remote:this.remoteMetrics&&now-this.remoteMetrics.at<6500?this.remoteMetrics:null});
 }
 send(data){if(!this.closed&&this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify(data));}
 gameReady(){this.ready=true;this.send({type:'ready'});}
 markFrame(){const now=Date.now();if(this.lastDrawAt&&this.playing){const gap=Math.max(0,now-this.lastDrawAt);this.frameGapMax=Math.max(this.frameGapMax||0,gap);if(gap>150)this.frameStalls=(this.frameStalls||0)+1;}this.lastDrawAt=now;this.frames++;}
 visibility(visible){this.lastRafAt=0;this.rafGapMax=0;this.input(0);this.send({type:'visibility',visible});}
 input(mask){if(this.config.role!=='guest')return;this.mask=mask&4095;this.unlockAudio();if(!this.playing||this.socket?.readyState!==WebSocket.OPEN||this.socket.bufferedAmount>16384)return;const p=new Uint8Array(3);p[0]=2;new DataView(p.buffer).setUint16(1,this.mask,true);this.socket.send(p);}
 publish(canvas,emulator){
  const capture=document.createElement('canvas'),ctx=capture.getContext('2d',{alpha:false,desynchronized:true});let nextAt=0,busy=false,lastBacklog=0,lastQualityChange=0;
  const tick=now=>{
   if(this.closed)return;this.animation=requestAnimationFrame(tick);if(this.playing){this.rafFrames++;if(this.lastRafAt)this.rafGapMax=Math.max(this.rafGapMax||0,Date.now()-this.lastRafAt);this.lastRafAt=Date.now();}else this.lastRafAt=0;if(!this.playing||this.direct||this.socket?.readyState!==WebSocket.OPEN)return;
   const queued=this.socket.bufferedAmount,clock=Date.now();if(queued>24576){lastBacklog=clock;if(clock-lastQualityChange>1500){this.setStreamLevel(this.streamLevel+1);lastQualityChange=clock;}}
   else if(this.streamLevel>0&&clock-Math.max(lastBacklog,lastQualityChange,this.profileChangedAt||0)>6000){this.setStreamLevel(this.streamLevel-1);lastQualityChange=clock;}
   if(busy||queued>24576)return;const profile=this.streamProfile(),interval=1000/profile.relayFps;if(now<nextAt)return;
   // Accumulated deadlines avoid turning a 24 fps target into 20/15/12 fps on 60 Hz displays.
   nextAt=nextAt?nextAt+interval:now+interval;if(nextAt<now-interval)nextAt=now+interval;
   if(!canvas.width||!canvas.height)return;busy=true;const connection=this.connection,encodeAt=Date.now();
   try{
    const scale=Math.min(1,profile.width/canvas.width,240/canvas.height),width=Math.max(1,Math.round(canvas.width*scale)),height=Math.max(1,Math.round(canvas.height*scale));if(capture.width!==width)capture.width=width;if(capture.height!==height)capture.height=height;ctx.drawImage(canvas,0,0,width,height);
    capture.toBlob(async blob=>{this.encodeSum+=Math.max(0,Date.now()-encodeAt);this.encodeCount++;try{if(!blob||this.closed||!this.playing||this.direct||this.socket?.readyState!==WebSocket.OPEN)return;const bytes=new Uint8Array(await blob.arrayBuffer());if(this.closed||!this.playing||this.direct||connection!==this.connection||this.socket?.readyState!==WebSocket.OPEN)return;if(bytes.length>65536||this.socket.bufferedAmount>24576)return;const packet=new Uint8Array(bytes.length+5);packet[0]=1;new DataView(packet.buffer).setUint32(1,++this.seq,true);packet.set(bytes,5);this.socket.send(packet);this.sentFrames++;}catch{}finally{busy=false;}},'image/jpeg',profile.quality);
   }catch{busy=false;}
  };this.animation=requestAnimationFrame(tick);this.audioAttach=setInterval(()=>this.captureAudio(emulator),250);this.captureAudio(emulator);
 }
 frame(packet){
  if(packet.length<6)return;const seq=new DataView(packet.buffer).getUint32(1,true);if(seq<=this.lastFrame)return;this.lastFrame=seq;this.pending=packet.slice(5);if(!this.decodeBusy)void this.decode();
 }
 async decode(){
  this.decodeBusy=true;try{while(this.pending&&!this.closed){const bytes=this.pending;this.pending=null;const decodeAt=Date.now();const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/jpeg'}));if(this.closed){bitmap.close();break;}const canvas=this.hooks.canvas;if(canvas.width!==bitmap.width)canvas.width=bitmap.width;if(canvas.height!==bitmap.height)canvas.height=bitmap.height;canvas.getContext('2d',{alpha:false}).drawImage(bitmap,0,0);bitmap.close();this.decodeSum+=Math.max(0,Date.now()-decodeAt);this.decodeCount++;this.markFrame();this.decodeErrors=0;this.bytes+=bytes.length;this.hooks.frame?.();}}catch{this.decodeErrors=(this.decodeErrors||0)+1;}finally{this.decodeBusy=false;if(this.pending&&!this.closed)void this.decode();}
 }
 captureAudio(emulator){
  if(this.closed||this.config.role!=='host')return;const al=emulator.gameManager?.Module?.AL?.currentCtx;if(!al?.audioCtx)return;const ctx=al.audioCtx;
  if(!this.processor){
   this.audioContext=ctx;this.processor=ctx.createScriptProcessor(2048,2,1);const silent=ctx.createGain();silent.gain.value=0;this.silent=silent;this.processor.connect(silent);silent.connect(ctx.destination);
   this.processor.onaudioprocess=e=>{if(!this.playing||this.socket?.readyState!==WebSocket.OPEN||this.socket.bufferedAmount>24576)return;const rate=16000,ratio=ctx.sampleRate/rate,input=e.inputBuffer.getChannelData(0),n=Math.floor(input.length/ratio),packet=new Uint8Array(5+n*2),view=new DataView(packet.buffer);packet[0]=3;view.setUint32(1,rate,true);for(let i=0;i<n;i++){const f=Math.max(-1,Math.min(1,input[Math.min(input.length-1,Math.floor(i*ratio))]));view.setInt16(5+i*2,f<0?f*32768:f*32767,true);}this.audioPackets++;for(let i=0;i<n;i++)this.audioPeak=Math.max(this.audioPeak,Math.abs(view.getInt16(5+i*2,true)));this.socket.send(packet);};
  }
  const live=new Set(Object.values(al.sources||{}).map(source=>source?.gain).filter(Boolean));for(const gain of this.gains)if(!live.has(gain)){try{gain.disconnect(this.processor);}catch{}this.gains.delete(gain);}for(const gain of live)if(!this.gains.has(gain)){gain.connect(this.processor);this.gains.add(gain);}
 }
 unlockAudio(){if(this.config.role!=='guest')return;if(!this.audioContext){const Ctx=window.AudioContext||window.webkitAudioContext;if(!Ctx)return;this.audioContext=new Ctx();}if(this.audioContext.state==='suspended')void this.audioContext.resume().catch(()=>{});}
 audio(packet){
  if(!this.playing)return;this.receivedAudio++;this.unlockAudio();const ctx=this.audioContext;if(!ctx||ctx.state!=='running')return;const view=new DataView(packet.buffer),rate=view.getUint32(1,true),n=(packet.length-5)/2;if(n<1||n>8192||rate<16000||rate>48000)return;
  const now=ctx.currentTime;if(this.audioAt>now+.3)return;this.audioAt=Math.max(this.audioAt,now+.05);const buffer=ctx.createBuffer(1,n,rate),target=buffer.getChannelData(0);for(let i=0;i<n;i++)target[i]=view.getInt16(5+i*2,true)/32768;const source=ctx.createBufferSource();source.buffer=buffer;source.connect(ctx.destination);source.start(this.audioAt);this.audioAt+=n/rate;
 }
 close(){if(this.closed)return;this.input(0);this.closed=true;this.playing=false;clearTimeout(this.retry);clearInterval(this.heartbeat);clearInterval(this.audioAttach);cancelAnimationFrame(this.animation);this.socket?.close();this.pending=null;this.probes.clear();for(const gain of this.gains){try{gain.disconnect(this.processor);}catch{}}this.processor?.disconnect();this.silent?.disconnect();if(this.config.role==='guest')void this.audioContext?.close().catch(()=>{});}
}
window.Umk3RelayBase=Umk3RelayBase;

'use strict';
// The authenticated WebSocket negotiates direct video, PCM sound and input.
// Restrictive NAT/firewalls fall back to the existing bounded WebSocket stream.
class Umk3Relay extends Umk3RelayBase {
 constructor(config,hooks){
  super(config,hooks);this.direct=false;this.generation=null;this.audioSources=new Set();this.inputSeq=0;this.remoteInputSeq=-1;this.audioSeq=0;this.lastAudioSeq=-1;
  this.hooks={...hooks,waiting:text=>{this.stopPeer();this.generation=null;this.clearAudio();hooks.waiting(text);}};
 }
 control(m){
  if(m.type==='rtc'){this.signalQueue=(this.signalQueue||Promise.resolve()).then(()=>this.peerSignal(m)).catch(()=>this.peerFallback('signal-queue'));return;}
  if(m.type==='welcome'){
   this.rtcSupported=m.features?.includes('rtc-v1')===true;this.iceServers=m.network?.iceServers||[{urls:'stun:stun.l.google.com:19302'}];
   this.turnError=m.network?.turnError||null;this.turnConfigured=m.network?.turnConfigured===true;if(m.network?.turnError==='turn-provider-unavailable')this.trace('turn-provider-unavailable');this.relayRegion=typeof m.network?.region==='string'&&/^[a-zA-Z0-9 ._-]{1,48}$/.test(m.network.region)?m.network.region:'';
  }
  super.control(m);
  if(m.type==='peer-ready'&&Date.now()>(this.peerCooldownUntil||0))this.beginPeer(m.generation);
 }
 beginPeer(generation){
  if(this.closed||this.generation===generation)return;
  if(!this.rtcSupported||!window.RTCPeerConnection){this.trace('webrtc-unavailable');return;}
  this.stopPeer();this.generation=generation;this.ice=[];this.inputSeq=0;this.remoteInputSeq=-1;this.audioSeq=0;this.lastAudioSeq=-1;this.inputRtt=null;this.inputRttAt=0;this.videoMetric=null;this.badSamples=this.goodSamples=0;this.diag={iceState:'new',gathering:'new',candidateTypes:[]};this.trace('ice-start');
  try{
   const pc=this.pc=new RTCPeerConnection({iceServers:this.iceServers||[{urls:'stun:stun.l.google.com:19302'}],iceTransportPolicy:'all'});
   const current=()=>!this.closed&&this.pc===pc;
   pc.onicecandidate=e=>{if(current()&&e.candidate){const type=e.candidate.type;if(['host','srflx','prflx','relay'].includes(type)&&!this.diag.candidateTypes.includes(type))this.diag.candidateTypes.push(type);this.send({type:'rtc',generation,candidate:e.candidate.toJSON()});}};
   pc.onicegatheringstatechange=()=>{if(current())this.diag.gathering=pc.iceGatheringState;};
   pc.onicecandidateerror=e=>{if(current()&&Number.isInteger(e.errorCode))this.trace(e.errorCode===701?'ice-server-unreachable':e.errorCode===401||e.errorCode===438?'turn-auth-error':'ice-server-error');};
   pc.oniceconnectionstatechange=()=>{if(!current())return;this.diag.iceState=pc.iceConnectionState;if(pc.iceConnectionState==='failed')this.peerFallback('ice-failed');else if(['connected','completed'].includes(pc.iceConnectionState))void this.startPeerCapture(pc);};
   pc.onconnectionstatechange=()=>{if(current()&&['failed','closed'].includes(pc.connectionState))this.peerFallback('connection-failed');};
   if(this.config.role==='host'){
    if(!this.publishCanvas?.captureStream)throw Error('Canvas streaming unavailable');
    if(pc.addTransceiver)this.videoSender=pc.addTransceiver('video',{direction:'sendonly'}).sender;else this.startPeerCapture(pc);
    this.bindChannel(pc.createDataChannel('game',{ordered:false,maxRetransmits:0}),pc);
    void (async()=>{await pc.setLocalDescription(await pc.createOffer());if(current())this.send({type:'rtc',generation,description:{type:'offer',sdp:pc.localDescription.sdp}});})().catch(()=>{if(current())this.peerFallback('offer-failed');});
   }else{
    pc.ondatachannel=e=>{if(current())this.bindChannel(e.channel,pc);};
    pc.ontrack=e=>{if(current()&&e.track.kind==='video'){try{if('jitterBufferTarget' in e.receiver)e.receiver.jitterBufferTarget=0;if('playoutDelayHint' in e.receiver)e.receiver.playoutDelayHint=0;}catch{}this.showPeerVideo(e.track,pc);}};
   }
   this.metricsTimer=setInterval(()=>void this.measureNetwork(),2000);
   this.peerTimer=setTimeout(()=>{if(current()&&!this.direct)this.peerFallback(this.diag.iceState==='connected'||this.diag.iceState==='completed'?'video-timeout':this.diag.candidateTypes.length?'ice-timeout':'ice-no-candidates');},this.turnConfigured?20000:12000);
  }catch{this.peerFallback('peer-setup-failed');}
 }
 async startPeerCapture(pc){
  if(this.config.role!=='host'||this.pc!==pc||this.mediaStream||this.closed)return;
  try{
   const profile=this.streamProfile();this.mediaStream=this.publishCanvas.captureStream(profile.fps);const track=this.mediaStream.getVideoTracks()[0];if(!track)throw Error();track.contentHint='motion';
   if(this.videoSender)await this.videoSender.replaceTrack(track);else this.videoSender=pc.addTrack(track,this.mediaStream);
   if(this.pc===pc)await this.applyStreamProfile();
  }catch{if(this.pc===pc)this.peerFallback('capture-start-failed');}
 }
 bindChannel(channel,pc){
  if(channel.label!=='game'){channel.close();return;}this.channel=channel;channel.binaryType='arraybuffer';
  channel.onmessage=e=>{
   if(this.pc!==pc||!this.playing)return;
   if(e.data instanceof ArrayBuffer){const bytes=new Uint8Array(e.data);if(this.config.role==='guest'&&this.direct&&bytes[0]===4&&bytes.length>=11&&bytes.length<=4096){const seq=new DataView(bytes.buffer).getUint32(1,true);if(seq<=this.lastAudioSeq)return;this.lastAudioSeq=seq;const packet=new Uint8Array(bytes.length-4);packet[0]=3;packet.set(bytes.subarray(5),1);this.audio(packet);}return;}
   if(typeof e.data!=='string'||e.data.length>200)return;
   let m;try{m=JSON.parse(e.data);}catch{return;}
   if(m.type==='latency-ping'||m.type==='latency-pong'){if(m.id)this.receiveProbe(m,'webrtc');else if(m.type==='latency-ping'&&Number.isFinite(m.at))this.peerSend({type:'latency-pong',at:m.at});return;}
   if(m.type==='quality'&&this.config.role==='host'&&Number.isInteger(m.level)&&m.level>=0&&m.level<=2){this.setStreamLevel(m.level);return;}
   if(m.type==='media-confirmed'&&this.config.role==='guest'){this.peerMediaConfirmed=true;return;}
   if(m.type==='media-ready'&&this.config.role==='host'){this.peerSend({type:'media-confirmed'});this.direct=true;clearTimeout(this.peerTimer);this.trace('media-connected');void this.measureNetwork();this.hooks.transport?.(true);return;}
   if(m.type==='input'&&this.config.role==='host'&&Number.isInteger(m.seq)&&m.seq>this.remoteInputSeq&&Number.isInteger(m.mask)&&m.mask>=0&&m.mask<=4095){this.remoteInputSeq=m.seq;this.lastInputAt=Date.now();this.hooks.input(m.mask);}
  };
  channel.onclose=()=>{if(this.pc===pc&&!this.closed)this.peerFallback('channel-closed');};
  channel.onopen=()=>{if(this.pc===pc&&this.config.role==='guest')this.input(this.mask);};
 }
 peerSend(data){if(this.channel?.readyState!=='open'||this.channel.bufferedAmount>4096)return false;try{this.channel.send(typeof data==='object'&&!(data instanceof Uint8Array)?JSON.stringify(data):data);return true;}catch{return false;}}
 async peerSignal(m){
  if(!this.pc||m.generation!==this.generation)return;if(m.disabled){this.peerCooldownUntil=Date.now()+30000;this.trace('peer-fallback');this.stopPeer();return;}const pc=this.pc;
  try{
   if(m.description){await pc.setRemoteDescription(m.description);if(this.pc!==pc)return;for(const candidate of this.ice.splice(0))await pc.addIceCandidate(candidate);
    if(this.config.role==='guest'){await pc.setLocalDescription(await pc.createAnswer());if(this.pc===pc)this.send({type:'rtc',generation:this.generation,description:{type:'answer',sdp:pc.localDescription.sdp}});}else await this.applyStreamProfile();
   }else if(m.candidate){if(pc.remoteDescription)await pc.addIceCandidate(m.candidate);else if(this.ice.length<200)this.ice.push(m.candidate);}
  }catch{if(this.pc===pc)this.peerFallback(m.description?'description-failed':'candidate-failed');}
 }
 showPeerVideo(track,pc){
  const video=this.peerVideo=document.createElement('video');video.id='rtcVideo';video.autoplay=true;video.playsInline=true;video.muted=true;video.hidden=true;video.srcObject=new MediaStream([track]);this.hooks.canvas.after(video);
  let last=-1;const painted=()=>{
   if(this.closed||this.pc!==pc)return;
   if(video.readyState>=2&&video.currentTime!==last&&this.playing){last=video.currentTime;this.markFrame();
    if(!this.direct){this.direct=true;clearTimeout(this.peerTimer);video.hidden=false;this.hooks.canvas.hidden=true;this.clearAudio();this.peerSend({type:'media-ready'});this.trace('media-connected');void this.measureNetwork();this.hooks.transport?.(true);}
    this.hooks.frame?.();
   }if(video.requestVideoFrameCallback)this.peerVideoFrame=video.requestVideoFrameCallback(painted);else this.peerPaint=requestAnimationFrame(painted);
  };let started=false;const start=()=>{if(!started&&video.readyState>=2){started=true;painted();}};video.addEventListener('loadeddata',start,{once:true});void video.play().then(start).catch(()=>{if(this.pc===pc)this.peerFallback('video-play-failed');});
 }
 peerFallback(reason='peer-fallback'){if(this.closed)return;this.trace(reason);const generation=this.generation;this.peerCooldownUntil=Date.now()+30000;this.stopPeer();if(this.playing)this.send({type:'rtc',generation,disabled:true});}
 stopPeer(){
  this.direct=false;this.peerMediaConfirmed=false;this.videoSender=null;this.videoMetric=null;this.rtcMetric=null;this.probes.clear();this.inputRtt=null;this.inputRttAt=0;for(const key of ['sendFps','sourceFps','encodeMs','decodeMs','bufferMs','lossPct','iceRtt'])delete this.diag[key];clearTimeout(this.peerTimer);clearInterval(this.metricsTimer);cancelAnimationFrame(this.peerPaint);const pc=this.pc;this.pc=null;this.channel=null;pc?.close();
  if(this.peerVideoFrame&&this.peerVideo?.cancelVideoFrameCallback)this.peerVideo.cancelVideoFrameCallback(this.peerVideoFrame);this.peerVideoFrame=null;this.mediaStream?.getTracks().forEach(t=>t.stop());this.mediaStream=null;this.peerVideo?.pause();if(this.peerVideo)this.peerVideo.srcObject=null;this.peerVideo?.remove();this.peerVideo=null;
  if(this.config.role==='guest')this.hooks.canvas.hidden=false;this.hooks.transport?.(false);
 }
 input(mask){
  if(this.config.role!=='guest')return;this.mask=mask&4095;
  if(this.direct&&this.playing&&this.peerSend({type:'input',seq:++this.inputSeq,mask:this.mask})){return;}
  super.input(this.mask);
 }
 publish(canvas,emulator){this.publishCanvas=canvas;super.publish(canvas,emulator);}
 frame(packet){if(!this.direct)super.frame(packet);}
 unlockAudio(interaction=false){
  if(this.config.role!=='guest')return;
  if(!this.audioContext){const Context=window.AudioContext||window.webkitAudioContext;if(!Context)return;this.audioContext=new Context({latencyHint:'interactive'});this.audioContext.onstatechange=()=>this.hooks.audio?.(this.audioContext.state==='running');this.startAudioSink();}
  this.hooks.audio?.(this.audioContext.state==='running');if(interaction&&this.audioContext.state==='suspended')void this.audioContext.resume().then(()=>this.hooks.audio?.(this.audioContext.state==='running')).catch(()=>{});
 }
 async captureAudio(emulator){
  if(this.closed||this.config.role!=='host')return;const al=emulator.gameManager?.Module?.AL?.currentCtx,ctx=al?.audioCtx;if(!ctx)return;
  if(this.audioContext!==ctx){this.disposeTap();this.audioContext=ctx;}
  if(!this.processor&&!this.tapLoading){
   this.tapLoading=true;
   try{
    if(ctx.audioWorklet){await ctx.audioWorklet.addModule('audio-tap.js?v=20261127-games-v6');if(this.closed||this.audioContext!==ctx)return;this.processor=new AudioWorkletNode(ctx,'umk3-audio-tap',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});this.processor.port.onmessage=e=>this.sendAudioSamples(e.data,ctx.sampleRate);}
   }catch{}
   if(!this.processor&&!this.closed&&this.audioContext===ctx){this.processor=ctx.createScriptProcessor(1024,2,1);this.processor.onaudioprocess=e=>{e.outputBuffer.getChannelData(0).fill(0);const channels=Array.from({length:e.inputBuffer.numberOfChannels},(_,i)=>e.inputBuffer.getChannelData(i)),mono=new Float32Array(e.inputBuffer.length);for(let i=0;i<mono.length;i++)for(const c of channels)mono[i]+=c[i]/channels.length;this.sendAudioSamples(mono,ctx.sampleRate);};}
   this.tapLoading=false;if(this.closed||!this.processor)return;this.processor.connect(ctx.destination);
  }
  if(!this.processor)return;
  // OpenAL rewires individual source gains when it changes their panners.
  // Tap the stable context mixer so those disconnects cannot silence the guest.
  const live=new Set(al.gain?[al.gain]:Object.values(al.sources||{}).map(s=>s?.gain).filter(Boolean));for(const gain of this.gains)if(!live.has(gain)){try{gain.disconnect(this.processor);}catch{}this.gains.delete(gain);}for(const gain of live){gain.connect(this.processor);this.gains.add(gain);}
 }
 sendAudioSamples(samples,sampleRate){
  if(this.closed||!this.playing||!samples?.length)return;
  const rate=32000,ratio=sampleRate/rate,state=this.resampleState?.rate===sampleRate?this.resampleState:{rate:sampleRate,phase:0,last:0};this.resampleState=state;
  const converted=[];let at=state.phase;for(;at<samples.length-1;at+=ratio){const i=Math.floor(at),a=i<0?state.last:samples[i],b=samples[i+1];converted.push(Math.max(-1,Math.min(1,a+(b-a)*(at-i))));}state.phase=at-samples.length;state.last=samples.at(-1);
  const n=converted.length;if(!n)return;const packet=new Uint8Array(5+n*2),view=new DataView(packet.buffer);packet[0]=3;view.setUint32(1,rate,true);
  for(let i=0;i<n;i++){const f=converted[i],value=f<0?f*32768:f*32767;view.setInt16(5+i*2,value,true);this.audioPeak=Math.max(this.audioPeak,Math.abs(value));}
  if(this.direct){const tagged=new Uint8Array(packet.length+4);tagged[0]=4;new DataView(tagged.buffer).setUint32(1,++this.audioSeq,true);tagged.set(packet.subarray(1),5);if(this.peerSend(tagged))this.audioPackets++;return;}
  if(this.socket?.readyState===WebSocket.OPEN&&this.socket.bufferedAmount<24576){this.socket.send(packet);this.audioPackets++;}
 }
 async startAudioSink(){
  const ctx=this.audioContext;if(this.sinkLoading||this.audioSink||this.sinkFallback||!ctx)return;
  if(!ctx.audioWorklet){this.sinkFallback=true;return;}this.sinkLoading=true;
  try{
   await ctx.audioWorklet.addModule('audio-tap.js?v=20261127-games-v6');if(this.closed||ctx!==this.audioContext)return;
   const node=this.audioSink=new AudioWorkletNode(ctx,'umk3-audio-playback',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[1]});
   node.port.onmessage=e=>{if(e.data?.type==='stats')this.audioStats=e.data;};node.connect(ctx.destination);
   for(const m of this.audioStartupPending||[])node.port.postMessage(m,[m.samples.buffer]);this.audioStartupPending=[];
  }catch{this.sinkFallback=true;this.audioStartupPending=[];}finally{this.sinkLoading=false;}
 }
 audio(packet){
  if(!this.playing||packet.length<7||packet.length%2!==1)return;const view=new DataView(packet.buffer,packet.byteOffset,packet.byteLength),rate=view.getUint32(1,true),n=(packet.length-5)/2;if(n>8192||rate<16000||rate>48000)return;
  this.receivedAudio++;this.unlockAudio();const ctx=this.audioContext;if(!ctx||ctx.state!=='running')return;
  const samples=new Float32Array(n);for(let i=0;i<n;i++)samples[i]=view.getInt16(5+i*2,true)/32768;
  if(this.audioSink){this.audioSink.port.postMessage({type:'samples',samples,rate,at:performance.now()},[samples.buffer]);return;}
  if(!this.sinkFallback){const queue=this.audioStartupPending||(this.audioStartupPending=[]);queue.push({type:'samples',samples,rate,at:performance.now()});if(queue.length>8)queue.shift();return;}
  // Compatibility path: never cancel already-playing audio on a normal burst.
  const now=ctx.currentTime;if(this.audioAt>now+.35)return;this.audioAt=Math.max(this.audioAt,now+.06);
  const buffer=ctx.createBuffer(1,n,rate);buffer.getChannelData(0).set(samples);const source=ctx.createBufferSource();source.buffer=buffer;source.connect(ctx.destination);this.audioSources.add(source);source.onended=()=>{source.disconnect();this.audioSources.delete(source);};source.start(this.audioAt);this.audioAt+=n/rate;
 }

 recoverVideoStall(){if(!this.direct)return false;this.peerFallback('video-stalled');this.hooks.transport?.(false);return true;}
 async applyStreamProfile(){
  const sender=this.videoSender;if(!sender)return;const profile=this.streamProfile();
  try{const params=sender.getParameters();if(!params.encodings?.length)params.encodings=[{}];Object.assign(params.encodings[0],{maxBitrate:profile.bitrate,maxFramerate:profile.fps,scaleResolutionDownBy:profile.scale});params.degradationPreference='maintain-framerate';await sender.setParameters(params);}catch{}
 }
 async measureNetwork(){
  if(this.closed||!this.playing||this.measuring)return;const pc=this.pc;if(!pc)return;this.measuring=true;
  if(this.direct&&this.config.role==='guest'&&!this.peerMediaConfirmed)this.peerSend({type:'media-ready'});
  try{
   const stats=await pc.getStats();if(this.pc!==pc)return;const now=Date.now();let pair=null;
   stats.forEach(s=>{if(s.type==='transport'&&s.selectedCandidatePairId)pair=stats.get(s.selectedCandidatePairId);});
   // Candidate text/addresses, SDP, usernames and credentials are deliberately excluded.
   if(pair){
    const local=stats.get(pair.localCandidateId),remote=stats.get(pair.remoteCandidateId),type=s=>['host','srflx','prflx','relay'].includes(s?.candidateType)?s.candidateType:'unknown';
    this.diag.candidatePair={local:type(local),remote:type(remote),protocol:['udp','tcp'].includes(local?.protocol)?local.protocol:'unknown',relayProtocol:['udp','tcp','tls'].includes(local?.relayProtocol)?local.relayProtocol:null};
    this.diag.route=type(local)==='relay'||type(remote)==='relay'?'turn':'webrtc';
    if(Number.isFinite(pair.currentRoundTripTime))this.diag.iceRtt=pair.currentRoundTripTime*1000;
   }
   stats.forEach(s=>{
    if(s.type==='media-source'&&s.kind==='video'&&Number.isFinite(s.framesPerSecond))this.diag.sourceFps=s.framesPerSecond;
    if((s.type!=='inbound-rtp'&&s.type!=='outbound-rtp')||s.kind!=='video'||s.isRemote)return;
    const old=this.rtcMetric,stamp=Number.isFinite(s.timestamp)?s.timestamp:now;
    const frames=s.type==='inbound-rtp'?s.framesDecoded:s.framesEncoded;
    this.rtcMetric={id:s.id,at:stamp,frames,encode:s.totalEncodeTime,decode:s.totalDecodeTime,delay:s.jitterBufferDelay,count:s.jitterBufferEmittedCount,lost:s.packetsLost,received:s.packetsReceived};
    if(!old||old.id!==s.id||stamp<=old.at)return;const seconds=(stamp-old.at)/1000,delta=frames-old.frames;
    if(delta>=0){
     if(s.type==='outbound-rtp'){this.diag.sendFps=delta/seconds;if(delta>0&&s.totalEncodeTime>=old.encode)this.diag.encodeMs=1000*(s.totalEncodeTime-old.encode)/delta;}
     else if(delta>0&&s.totalDecodeTime>=old.decode)this.diag.decodeMs=1000*(s.totalDecodeTime-old.decode)/delta;
    }
    if(s.type==='inbound-rtp'){
     const total=(s.packetsReceived-old.received)+(s.packetsLost-old.lost);if(total>0)this.diag.lossPct=100*Math.max(0,s.packetsLost-old.lost)/total;
     if(s.jitterBufferEmittedCount>old.count){
      const bufferMs=1000*(s.jitterBufferDelay-old.delay)/(s.jitterBufferEmittedCount-old.count);this.diag.bufferMs=bufferMs;
      const fps=delta/seconds,bad=bufferMs>180||(fps>0&&fps<12);this.badSamples=bad?(this.badSamples||0)+1:0;this.goodSamples=bad?0:(this.goodSamples||0)+1;
      if(this.badSamples>=2&&this.streamLevel<2){this.setStreamLevel(this.streamLevel+1);this.peerSend({type:'quality',level:this.streamLevel});this.badSamples=0;}
      else if(this.goodSamples>=8&&this.streamLevel>0){this.setStreamLevel(this.streamLevel-1);this.peerSend({type:'quality',level:this.streamLevel});this.goodSamples=0;}
     }
    }
   });
  }catch{this.trace('stats-unavailable');}finally{this.measuring=false;}
 }
 clearAudio(){this.audioAt=0;this.audioStartupPending=[];this.audioSink?.port.postMessage({type:'reset'});this.resampleState=null;for(const source of this.audioSources){try{source.stop();source.disconnect();}catch{}}this.audioSources.clear();}
 disposeTap(){for(const gain of this.gains){try{gain.disconnect(this.processor);}catch{}}this.gains.clear();if(this.processor?.port){this.processor.port.onmessage=null;this.processor.port.close();}if(this.processor)this.processor.onaudioprocess=null;this.processor?.disconnect();this.processor=null;}
 close(){this.stopPeer();this.clearAudio();this.disposeTap();if(this.audioSink){this.audioSink.port.onmessage=null;this.audioSink.port.close();this.audioSink.disconnect();this.audioSink=null;}super.close();}
}
window.Umk3Relay=Umk3Relay;
