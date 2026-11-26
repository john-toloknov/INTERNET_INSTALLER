// INTERNET INSTALLER · network build 20261127-games-v3
'use strict';
class Umk3RelayBase {
 constructor(config,hooks){this.config=config;this.hooks=hooks;this.closed=false;this.ready=false;this.playing=false;this.attempt=0;this.seq=0;this.lastFrame=0;this.frames=0;this.bytes=0;this.mask=0;this.lastInputAt=0;this.decodeBusy=false;this.pending=null;this.audioAt=0;this.gains=new Set();this.audioPackets=0;this.audioPeak=0;this.receivedAudio=0;this.lastDrawAt=0;this.lastPongAt=Date.now();this.lastPingAt=0;this.rtt=0;this.reconnects=0;this.connection=0;this.slowLinkUntil=0;this.streamLevel=0;this.profileChangedAt=0;this.lastMetricsAt=0;}
 streamProfile(){
  const level=Math.max(0,Math.min(2,this.streamLevel||0)),mobile=this.config.mobileHost===true;
  return [{fps:mobile?30:50,bitrate:mobile?600000:900000,relayFps:mobile?20:24,width:320,quality:.60,scale:1},{fps:24,bitrate:400000,relayFps:18,width:288,quality:.53,scale:1},{fps:18,bitrate:250000,relayFps:14,width:256,quality:.46,scale:1.25}][level];
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
  if(!this.heartbeat)this.heartbeat=setInterval(()=>{const now=Date.now();if(this.config.role==='guest')this.input(this.mask);if(this.config.role==='host'&&now-this.lastInputAt>1500)this.hooks.input(0);if(this.socket?.readyState!==WebSocket.OPEN)return;if(now-this.lastPingAt>2000){this.lastPingAt=now;this.send({type:'ping',at:now});}if(!document.hidden&&now-this.lastPongAt>16000){this.lastPongAt=now;this.socket.close(4000,'Recover stalled connection');}else if(!document.hidden&&this.config.role==='guest'&&this.playing&&this.lastDrawAt&&now-this.lastDrawAt>3000){this.lastDrawAt=now;if(!this.recoverVideoStall?.())this.socket.close(4000,'Recover stalled stream');}if(!this.direct&&now-this.lastMetricsAt>2000){this.lastMetricsAt=now;this.hooks.diagnostics?.({direct:false,rtt:this.rtt,bufferMs:null,profile:this.streamLevel});}},50);
 }
 control(message){
  if(message.type==='pong'){this.lastPongAt=Date.now();this.rtt=Math.max(0,Date.now()-Number(message.at||Date.now()));if(this.rtt>500){this.slowLinkUntil=Date.now()+5000;this.setStreamLevel(Math.max(1,this.streamLevel));}return;}
  if(message.type==='welcome'){this.lastPongAt=Date.now();this.lastFrame=0;this.pending=null;this.attempt=0;if(this.ready)this.send({type:'ready'});this.send({type:'visibility',visible:!document.hidden});}
  else if(message.type==='peer-ready'){this.playing=true;this.lastFrame=0;this.audioAt=0;this.lastDrawAt=Date.now();this.hooks.connected();}
  else if(message.type==='waiting'){this.playing=false;this.hooks.input?.(0);this.audioAt=0;this.hooks.waiting(!message.host?'Ждём первого игрока…':!message.guest?'Ждём соперника…':message.hostVisible===false?'Первый игрок свернул игру. Ждём его возвращения.':message.guestVisible===false?'Соперник свернул игру. Ждём его возвращения.':'Ждём готовности обоих игроков.');}
 }
 send(data){if(!this.closed&&this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify(data));}
 gameReady(){this.ready=true;this.send({type:'ready'});}
 visibility(visible){this.input(0);this.send({type:'visibility',visible});}
 input(mask){if(this.config.role!=='guest')return;this.mask=mask&4095;this.unlockAudio();if(!this.playing||this.socket?.readyState!==WebSocket.OPEN||this.socket.bufferedAmount>16384)return;const p=new Uint8Array(3);p[0]=2;new DataView(p.buffer).setUint16(1,this.mask,true);this.socket.send(p);}
 publish(canvas,emulator){
  const capture=document.createElement('canvas'),ctx=capture.getContext('2d',{alpha:false});let at=0,busy=false;
  const tick=now=>{if(this.closed)return;this.animation=requestAnimationFrame(tick);const slow=Date.now()<this.slowLinkUntil,profile=this.streamProfile();if(this.socket?.bufferedAmount>49152)this.setStreamLevel(Math.max(1,this.streamLevel));if(!this.playing||this.direct||busy||now-at<1000/(slow?14:profile.relayFps)||this.socket?.readyState!==WebSocket.OPEN||this.socket.bufferedAmount>49152)return;if(!canvas.width||!canvas.height)return;at=now;busy=true;const connection=this.connection;
   try{const scale=Math.min(1,Math.min(slow?256:320,profile.width)/canvas.width,240/canvas.height);const width=Math.max(1,Math.round(canvas.width*scale)),height=Math.max(1,Math.round(canvas.height*scale));if(capture.width!==width)capture.width=width;if(capture.height!==height)capture.height=height;ctx.drawImage(canvas,0,0,capture.width,capture.height);
   capture.toBlob(async blob=>{try{if(!blob||this.closed||!this.playing||this.socket?.readyState!==WebSocket.OPEN)return;const bytes=new Uint8Array(await blob.arrayBuffer());if(this.closed||!this.playing||connection!==this.connection||this.socket?.readyState!==WebSocket.OPEN)return;if(bytes.length>65536||this.socket.bufferedAmount>49152)return;const p=new Uint8Array(bytes.length+5);p[0]=1;new DataView(p.buffer).setUint32(1,++this.seq,true);p.set(bytes,5);this.socket.send(p);}catch{}finally{busy=false;}},'image/jpeg',slow?.46:profile.quality);}catch{busy=false;}
  };this.animation=requestAnimationFrame(tick);
  this.audioAttach=setInterval(()=>this.captureAudio(emulator),250);this.captureAudio(emulator);
 }
 frame(packet){
  if(packet.length<6)return;const seq=new DataView(packet.buffer).getUint32(1,true);if(seq<=this.lastFrame)return;this.lastFrame=seq;this.pending=packet.slice(5);if(!this.decodeBusy)void this.decode();
 }
 async decode(){
  this.decodeBusy=true;try{while(this.pending&&!this.closed){const bytes=this.pending;this.pending=null;const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/jpeg'}));if(this.closed){bitmap.close();break;}const canvas=this.hooks.canvas;if(canvas.width!==bitmap.width)canvas.width=bitmap.width;if(canvas.height!==bitmap.height)canvas.height=bitmap.height;canvas.getContext('2d',{alpha:false}).drawImage(bitmap,0,0);bitmap.close();this.frames++;this.lastDrawAt=Date.now();this.bytes+=bytes.length;this.hooks.frame?.();}}catch{this.pending=null;if(!this.closed)this.socket?.close(4000,'Recover video decoder');}finally{this.decodeBusy=false;}
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
 close(){if(this.closed)return;this.input(0);this.closed=true;this.playing=false;clearTimeout(this.retry);clearInterval(this.heartbeat);clearInterval(this.audioAttach);cancelAnimationFrame(this.animation);this.socket?.close();this.pending=null;for(const gain of this.gains){try{gain.disconnect(this.processor);}catch{}}this.processor?.disconnect();this.silent?.disconnect();if(this.config.role==='guest')void this.audioContext?.close().catch(()=>{});}
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
  if(m.type==='rtc'){this.signalQueue=(this.signalQueue||Promise.resolve()).then(()=>this.peerSignal(m)).catch(()=>this.peerFallback());return;}
  if(m.type==='welcome')this.rtcSupported=m.features?.includes('rtc-v1')===true;
  super.control(m);
  if(m.type==='peer-ready'&&Date.now()>(this.peerCooldownUntil||0))this.beginPeer(m.generation);
 }
 beginPeer(generation){
  if(this.closed||!this.rtcSupported||!window.RTCPeerConnection||this.generation===generation)return;
  this.stopPeer();this.generation=generation;this.ice=[];this.inputSeq=0;this.remoteInputSeq=-1;this.audioSeq=0;this.lastAudioSeq=-1;
  try{
   const pc=this.pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
   const current=()=>!this.closed&&this.pc===pc;
   pc.onicecandidate=e=>{if(current()&&e.candidate)this.send({type:'rtc',generation,candidate:e.candidate.toJSON()});};
   pc.onconnectionstatechange=()=>{if(current()&&['failed','closed'].includes(pc.connectionState))this.peerFallback();};
   if(this.config.role==='host'){
    if(!this.publishCanvas?.captureStream)throw Error('Canvas streaming unavailable');
    const profile=this.streamProfile();this.mediaStream=this.publishCanvas.captureStream(profile.fps);const track=this.mediaStream.getVideoTracks()[0];if(!track)throw Error('No video track');
    track.contentHint='motion';const sender=this.videoSender=pc.addTrack(track,this.mediaStream),params=sender.getParameters();if(!params.encodings?.length)params.encodings=[{}];params.encodings[0].maxBitrate=profile.bitrate;params.encodings[0].maxFramerate=profile.fps;params.degradationPreference='maintain-framerate';void sender.setParameters(params).catch(()=>{});
    this.bindChannel(pc.createDataChannel('game',{ordered:false,maxRetransmits:0}),pc);
    void (async()=>{await pc.setLocalDescription(await pc.createOffer());if(current())this.send({type:'rtc',generation,description:{type:'offer',sdp:pc.localDescription.sdp}});})().catch(()=>{if(current())this.peerFallback();});
   }else{
    pc.ondatachannel=e=>{if(current())this.bindChannel(e.channel,pc);};
    pc.ontrack=e=>{if(current()&&e.track.kind==='video'){try{if('jitterBufferTarget' in e.receiver)e.receiver.jitterBufferTarget=0;if('playoutDelayHint' in e.receiver)e.receiver.playoutDelayHint=0;}catch{}this.showPeerVideo(e.track,pc);}};
   }
   this.metricsTimer=setInterval(()=>void this.measureNetwork(),2000);
   this.peerTimer=setTimeout(()=>{if(current()&&!this.direct)this.peerFallback();},12000);
  }catch{this.peerFallback();}
 }
 bindChannel(channel,pc){
  if(channel.label!=='game'){channel.close();return;}this.channel=channel;channel.binaryType='arraybuffer';
  channel.onmessage=e=>{
   if(this.pc!==pc||!this.playing)return;
   if(e.data instanceof ArrayBuffer){const bytes=new Uint8Array(e.data);if(this.config.role==='guest'&&this.direct&&bytes[0]===4&&bytes.length>=11&&bytes.length<=4096){const seq=new DataView(bytes.buffer).getUint32(1,true);if(seq<=this.lastAudioSeq)return;this.lastAudioSeq=seq;const packet=new Uint8Array(bytes.length-4);packet[0]=3;packet.set(bytes.subarray(5),1);this.audio(packet);}return;}
   if(typeof e.data!=='string'||e.data.length>200)return;
   let m;try{m=JSON.parse(e.data);}catch{return;}
   if(m.type==='latency-ping'){this.peerSend({type:'latency-pong',at:m.at});return;}if(m.type==='latency-pong'&&Number.isFinite(m.at)){this.inputRtt=Math.max(0,Date.now()-m.at);return;}
   if(m.type==='quality'&&this.config.role==='host'&&Number.isInteger(m.level)&&m.level>=0&&m.level<=2){this.setStreamLevel(m.level);return;}
   if(m.type==='media-confirmed'&&this.config.role==='guest'){this.peerMediaConfirmed=true;return;}
   if(m.type==='media-ready'&&this.config.role==='host'){this.peerSend({type:'media-confirmed'});this.direct=true;clearTimeout(this.peerTimer);this.hooks.transport?.(true);return;}
   if(m.type==='input'&&this.config.role==='host'&&Number.isInteger(m.seq)&&m.seq>this.remoteInputSeq&&Number.isInteger(m.mask)&&m.mask>=0&&m.mask<=4095){this.remoteInputSeq=m.seq;this.lastInputAt=Date.now();this.hooks.input(m.mask);}
  };
  channel.onclose=()=>{if(this.pc===pc&&!this.closed)this.peerFallback();};
  channel.onopen=()=>{if(this.pc===pc&&this.config.role==='guest')this.input(this.mask);};
 }
 peerSend(data){if(this.channel?.readyState!=='open'||this.channel.bufferedAmount>4096)return false;try{this.channel.send(typeof data==='object'&&!(data instanceof Uint8Array)?JSON.stringify(data):data);return true;}catch{return false;}}
 async peerSignal(m){
  if(!this.pc||m.generation!==this.generation)return;if(m.disabled){this.stopPeer();return;}const pc=this.pc;
  try{
   if(m.description){await pc.setRemoteDescription(m.description);if(this.pc!==pc)return;for(const candidate of this.ice.splice(0))await pc.addIceCandidate(candidate);
    if(this.config.role==='guest'){await pc.setLocalDescription(await pc.createAnswer());if(this.pc===pc)this.send({type:'rtc',generation:this.generation,description:{type:'answer',sdp:pc.localDescription.sdp}});}
   }else if(m.candidate){if(pc.remoteDescription)await pc.addIceCandidate(m.candidate);else if(this.ice.length<200)this.ice.push(m.candidate);}
  }catch{if(this.pc===pc)this.peerFallback();}
 }
 showPeerVideo(track,pc){
  const video=this.peerVideo=document.createElement('video');video.id='rtcVideo';video.autoplay=true;video.playsInline=true;video.muted=true;video.hidden=true;video.srcObject=new MediaStream([track]);this.hooks.canvas.after(video);
  let last=-1;const painted=()=>{
   if(this.closed||this.pc!==pc)return;
   if(video.readyState>=2&&video.currentTime!==last&&this.playing){last=video.currentTime;this.lastDrawAt=Date.now();this.frames++;
    if(!this.direct){this.direct=true;clearTimeout(this.peerTimer);video.hidden=false;this.hooks.canvas.hidden=true;this.clearAudio();this.peerSend({type:'media-ready'});this.hooks.transport?.(true);}
    this.hooks.frame?.();
   }if(video.requestVideoFrameCallback)this.peerVideoFrame=video.requestVideoFrameCallback(painted);else this.peerPaint=requestAnimationFrame(painted);
  };let started=false;const start=()=>{if(!started&&video.readyState>=2){started=true;painted();}};video.addEventListener('loadeddata',start,{once:true});void video.play().then(start).catch(()=>this.peerFallback());
 }
 peerFallback(){if(this.closed)return;const generation=this.generation;this.peerCooldownUntil=Date.now()+30000;this.stopPeer();if(this.playing)this.send({type:'rtc',generation,disabled:true});}
 stopPeer(){
  this.direct=false;this.peerMediaConfirmed=false;this.videoSender=null;this.videoMetric=null;clearTimeout(this.peerTimer);clearInterval(this.metricsTimer);cancelAnimationFrame(this.peerPaint);const pc=this.pc;this.pc=null;this.channel=null;pc?.close();
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
  if(!this.audioContext){const Context=window.AudioContext||window.webkitAudioContext;if(!Context)return;this.audioContext=new Context({latencyHint:'interactive'});this.audioContext.onstatechange=()=>this.hooks.audio?.(this.audioContext.state==='running');}
  this.hooks.audio?.(this.audioContext.state==='running');if(interaction&&this.audioContext.state==='suspended')void this.audioContext.resume().then(()=>this.hooks.audio?.(this.audioContext.state==='running')).catch(()=>{});
 }
 async captureAudio(emulator){
  if(this.closed||this.config.role!=='host')return;const al=emulator.gameManager?.Module?.AL?.currentCtx,ctx=al?.audioCtx;if(!ctx)return;
  if(this.audioContext!==ctx){this.disposeTap();this.audioContext=ctx;}
  if(!this.processor&&!this.tapLoading){
   this.tapLoading=true;
   try{
    if(ctx.audioWorklet){await ctx.audioWorklet.addModule('audio-tap.js?v=20261127-games-v3');if(this.closed||this.audioContext!==ctx)return;this.processor=new AudioWorkletNode(ctx,'umk3-audio-tap',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});this.processor.port.onmessage=e=>this.sendAudioSamples(e.data,ctx.sampleRate);}
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
  if(this.closed||!this.playing)return;const rate=16000,ratio=sampleRate/rate,n=Math.floor(samples.length/ratio);if(!n)return;const packet=new Uint8Array(5+n*2),view=new DataView(packet.buffer);packet[0]=3;view.setUint32(1,rate,true);
  for(let i=0;i<n;i++){const f=Math.max(-1,Math.min(1,samples[Math.floor(i*ratio)]));const value=f<0?f*32768:f*32767;view.setInt16(5+i*2,value,true);this.audioPeak=Math.max(this.audioPeak,Math.abs(value));}
  if(this.direct){const tagged=new Uint8Array(packet.length+4);tagged[0]=4;new DataView(tagged.buffer).setUint32(1,++this.audioSeq,true);tagged.set(packet.subarray(1),5);if(this.peerSend(tagged))this.audioPackets++;return;}
  if(this.socket?.readyState===WebSocket.OPEN&&this.socket.bufferedAmount<24576){this.socket.send(packet);this.audioPackets++;}
 }
 audio(packet){
  if(!this.playing||packet.length<7||packet.length%2!==1)return;const view=new DataView(packet.buffer,packet.byteOffset,packet.byteLength),rate=view.getUint32(1,true),n=(packet.length-5)/2;if(n>8192||rate<16000||rate>48000)return;
  this.receivedAudio++;this.unlockAudio();const ctx=this.audioContext;if(!ctx||ctx.state!=='running')return;const now=ctx.currentTime;if(this.audioAt>now+.10){this.clearAudio();}this.audioAt=Math.max(this.audioAt,now+.025);
  const buffer=ctx.createBuffer(1,n,rate),target=buffer.getChannelData(0);for(let i=0;i<n;i++)target[i]=view.getInt16(5+i*2,true)/32768;
  const source=ctx.createBufferSource();source.buffer=buffer;source.connect(ctx.destination);this.audioSources.add(source);source.onended=()=>{source.disconnect();this.audioSources.delete(source);};source.start(this.audioAt);this.audioAt+=n/rate;
 }

 recoverVideoStall(){if(!this.direct)return false;this.peerFallback();this.hooks.transport?.(false);return true;}
 async applyStreamProfile(){
  const sender=this.videoSender;if(!sender)return;const profile=this.streamProfile();
  try{const params=sender.getParameters();if(!params.encodings?.length)params.encodings=[{}];Object.assign(params.encodings[0],{maxBitrate:profile.bitrate,maxFramerate:profile.fps,scaleResolutionDownBy:profile.scale});await sender.setParameters(params);}catch{}
 }
 async measureNetwork(){
  if(this.closed||!this.playing)return;const pc=this.pc;
  if(this.direct){this.peerSend({type:'latency-ping',at:Date.now()});if(this.config.role==='guest'&&!this.peerMediaConfirmed)this.peerSend({type:'media-ready'});}
  let bufferMs=null;
  try{if(pc){const stats=await pc.getStats();if(this.pc!==pc)return;stats.forEach(s=>{if(s.type==='inbound-rtp'&&s.kind==='video'&&s.jitterBufferEmittedCount){const old=this.videoMetric;this.videoMetric={delay:s.jitterBufferDelay,count:s.jitterBufferEmittedCount,frames:s.framesDecoded||0,at:Date.now()};if(old&&s.jitterBufferEmittedCount>old.count){bufferMs=1000*(s.jitterBufferDelay-old.delay)/(s.jitterBufferEmittedCount-old.count);const fps=1000*((s.framesDecoded||0)-old.frames)/Math.max(1,Date.now()-old.at),bad=bufferMs>180||(fps>0&&fps<12);this.badSamples=bad?(this.badSamples||0)+1:0;this.goodSamples=bad?0:(this.goodSamples||0)+1;if(this.badSamples>=2&&this.streamLevel<2){this.setStreamLevel(this.streamLevel+1);this.peerSend({type:'quality',level:this.streamLevel});this.badSamples=0;}else if(this.goodSamples>=8&&this.streamLevel>0){this.setStreamLevel(this.streamLevel-1);this.peerSend({type:'quality',level:this.streamLevel});this.goodSamples=0;}}}});}}catch{}
  if(!Number.isFinite(bufferMs))bufferMs=null;
  this.hooks.diagnostics?.({direct:this.direct,rtt:this.direct?(this.inputRtt||0):this.rtt,bufferMs,profile:this.streamLevel});
 }
 clearAudio(){this.audioAt=0;for(const source of this.audioSources){try{source.stop();source.disconnect();}catch{}}this.audioSources.clear();}
 disposeTap(){for(const gain of this.gains){try{gain.disconnect(this.processor);}catch{}}this.gains.clear();if(this.processor?.port){this.processor.port.onmessage=null;this.processor.port.close();}if(this.processor)this.processor.onaudioprocess=null;this.processor?.disconnect();this.processor=null;}
 close(){this.stopPeer();this.clearAudio();this.disposeTap();super.close();}
}
window.Umk3Relay=Umk3Relay;

window.II_GAME_NETWORK_BUILD='20261127-games-v3';
