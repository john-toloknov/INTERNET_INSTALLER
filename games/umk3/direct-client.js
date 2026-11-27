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
