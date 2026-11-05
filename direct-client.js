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
  if(m.type==='peer-ready')this.beginPeer(m.generation);
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
    this.mediaStream=this.publishCanvas.captureStream(50);const track=this.mediaStream.getVideoTracks()[0];if(!track)throw Error('No video track');
    track.contentHint='motion';const sender=pc.addTrack(track,this.mediaStream),params=sender.getParameters();if(!params.encodings?.length)params.encodings=[{}];params.encodings[0].maxBitrate=900000;params.encodings[0].maxFramerate=50;params.degradationPreference='maintain-framerate';void sender.setParameters(params).catch(()=>{});
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
   if(m.type==='media-ready'&&this.config.role==='host'){this.direct=true;clearTimeout(this.peerTimer);this.hooks.transport?.(true);return;}
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
    if(!this.direct){this.direct=true;clearTimeout(this.peerTimer);video.hidden=false;this.hooks.canvas.hidden=true;this.clearAudio();this.hooks.transport?.(true);}
    this.peerSend({type:'media-ready'});this.hooks.frame?.();
   }this.peerPaint=requestAnimationFrame(painted);
  };this.peerPaint=requestAnimationFrame(painted);void video.play().catch(()=>this.peerFallback());
 }
 peerFallback(){if(this.closed)return;const generation=this.generation;this.stopPeer();if(this.playing)this.send({type:'rtc',generation,disabled:true});}
 stopPeer(){
  this.direct=false;clearTimeout(this.peerTimer);clearInterval(this.metricsTimer);cancelAnimationFrame(this.peerPaint);const pc=this.pc;this.pc=null;this.channel=null;pc?.close();
  this.mediaStream?.getTracks().forEach(t=>t.stop());this.mediaStream=null;this.peerVideo?.pause();if(this.peerVideo)this.peerVideo.srcObject=null;this.peerVideo?.remove();this.peerVideo=null;
  if(this.config.role==='guest')this.hooks.canvas.hidden=false;this.hooks.transport?.(false);
 }
 input(mask){
  if(this.config.role!=='guest')return;this.mask=mask&4095;
  if(this.direct&&this.playing&&this.peerSend({type:'input',seq:++this.inputSeq,mask:this.mask})){this.peerSend({type:'media-ready'});return;}
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
    if(ctx.audioWorklet){await ctx.audioWorklet.addModule('audio-tap.js?v=20261105-arcade1');if(this.closed||this.audioContext!==ctx)return;this.processor=new AudioWorkletNode(ctx,'umk3-audio-tap',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});this.processor.port.onmessage=e=>this.sendAudioSamples(e.data,ctx.sampleRate);}
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

 async measureNetwork(){
  if(this.closed||!this.playing)return;const pc=this.pc;
  if(this.direct)this.peerSend({type:'latency-ping',at:Date.now()});
  let bufferMs=null;
  try{if(pc){const stats=await pc.getStats();if(this.pc!==pc)return;stats.forEach(s=>{if(s.type==='inbound-rtp'&&s.kind==='video'&&s.jitterBufferEmittedCount){const old=this.videoMetric;this.videoMetric={delay:s.jitterBufferDelay,count:s.jitterBufferEmittedCount};if(old&&s.jitterBufferEmittedCount>old.count)bufferMs=1000*(s.jitterBufferDelay-old.delay)/(s.jitterBufferEmittedCount-old.count);}});}}catch{}
  if(!Number.isFinite(bufferMs))bufferMs=null;
  this.hooks.diagnostics?.({direct:this.direct,rtt:this.direct?(this.inputRtt||0):this.rtt,bufferMs});
 }
 clearAudio(){this.audioAt=0;for(const source of this.audioSources){try{source.stop();source.disconnect();}catch{}}this.audioSources.clear();}
 disposeTap(){for(const gain of this.gains){try{gain.disconnect(this.processor);}catch{}}this.gains.clear();if(this.processor?.port){this.processor.port.onmessage=null;this.processor.port.close();}if(this.processor)this.processor.onaudioprocess=null;this.processor?.disconnect();this.processor=null;}
 close(){this.stopPeer();this.clearAudio();this.disposeTap();super.close();}
}
window.Umk3Relay=Umk3Relay;
