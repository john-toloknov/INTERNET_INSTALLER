'use strict';
class Umk3Relay {
 constructor(config,hooks){this.config=config;this.hooks=hooks;this.closed=false;this.ready=false;this.playing=false;this.attempt=0;this.seq=0;this.lastFrame=0;this.frames=0;this.bytes=0;this.mask=0;this.lastInputAt=0;this.decodeBusy=false;this.pending=null;this.audioAt=0;this.gains=new Set();this.audioPackets=0;this.audioPeak=0;this.receivedAudio=0;}
 connect(){
  const url=new URL(this.config.url);if(url.protocol!=='wss:'&&!(url.protocol==='ws:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw Error('Нужен защищённый адрес сетевой игры');
  this.socket=new WebSocket(url.href);this.socket.binaryType='arraybuffer';
  this.socket.onopen=()=>{this.socket.send(JSON.stringify({type:'auth',token:this.config.token}));};
  this.socket.onmessage=event=>{if(this.closed)return;if(typeof event.data==='string'){this.control(JSON.parse(event.data));return;}const data=new Uint8Array(event.data);if(data[0]===1&&this.config.role==='guest')this.frame(data);else if(data[0]===2&&this.config.role==='host'){this.lastInputAt=Date.now();this.hooks.input(new DataView(data.buffer).getUint16(1,true));}else if(data[0]===3&&this.config.role==='guest')this.audio(data);};
  this.socket.onclose=event=>{this.playing=false;this.hooks.waiting('Связь прервалась. Восстанавливаем соединение…');this.hooks.input?.(0);if(this.closed)return;if([4001,4003,4004,4005].includes(event.code)){this.hooks.failed('Сессия завершена. Откройте матч заново.');return;}if(this.attempt++<3)this.retry=setTimeout(()=>this.connect(),1000*Math.pow(2,this.attempt-1));else this.hooks.failed('Не удалось восстановить связь. Откройте матч заново.');};
  this.socket.onerror=()=>{};
  if(!this.heartbeat)this.heartbeat=setInterval(()=>{if(this.config.role==='guest'&&this.mask)this.input(this.mask);if(this.config.role==='host'&&Date.now()-this.lastInputAt>1000)this.hooks.input(0);},250);
 }
 control(message){
  if(message.type==='welcome'){this.attempt=0;if(this.ready)this.send({type:'ready'});this.send({type:'visibility',visible:!document.hidden});}
  else if(message.type==='peer-ready'){this.playing=true;this.lastFrame=0;this.audioAt=0;this.hooks.connected();}
  else if(message.type==='waiting'){this.playing=false;this.hooks.input?.(0);this.audioAt=0;this.hooks.waiting(!message.host?'Ждём первого игрока…':!message.guest?'Ждём соперника…':'Игра приостановлена, пока оба игрока не вернутся.');}
 }
 send(data){if(!this.closed&&this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify(data));}
 gameReady(){this.ready=true;this.send({type:'ready'});}
 visibility(visible){this.input(0);this.send({type:'visibility',visible});}
 input(mask){if(this.config.role!=='guest')return;this.mask=mask&4095;this.unlockAudio();if(!this.playing||this.socket?.readyState!==WebSocket.OPEN||this.socket.bufferedAmount>16384)return;const p=new Uint8Array(3);p[0]=2;new DataView(p.buffer).setUint16(1,this.mask,true);this.socket.send(p);}
 publish(canvas,emulator){
  const capture=document.createElement('canvas'),ctx=capture.getContext('2d',{alpha:false});let at=0,busy=false;
  const tick=now=>{if(this.closed)return;this.animation=requestAnimationFrame(tick);if(!this.playing||busy||now-at<1000/30||this.socket?.readyState!==WebSocket.OPEN||this.socket.bufferedAmount>524288)return;at=now;busy=true;
   const scale=Math.min(1,480/canvas.width,360/canvas.height);capture.width=Math.max(1,Math.round(canvas.width*scale));capture.height=Math.max(1,Math.round(canvas.height*scale));ctx.drawImage(canvas,0,0,capture.width,capture.height);
   capture.toBlob(async blob=>{try{if(!blob||this.closed||!this.playing||this.socket?.readyState!==WebSocket.OPEN)return;const bytes=new Uint8Array(await blob.arrayBuffer());if(bytes.length>220000)return;const p=new Uint8Array(bytes.length+5);p[0]=1;new DataView(p.buffer).setUint32(1,++this.seq,true);p.set(bytes,5);this.socket.send(p);}finally{busy=false;}},'image/jpeg',.84);
  };this.animation=requestAnimationFrame(tick);
  this.audioAttach=setInterval(()=>this.captureAudio(emulator),1000);this.captureAudio(emulator);
 }
 frame(packet){
  if(packet.length<6)return;const seq=new DataView(packet.buffer).getUint32(1,true);if(seq<=this.lastFrame)return;this.lastFrame=seq;this.pending=packet.slice(5);if(!this.decodeBusy)void this.decode();
 }
 async decode(){
  this.decodeBusy=true;try{while(this.pending&&!this.closed){const bytes=this.pending;this.pending=null;const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/jpeg'}));if(this.closed){bitmap.close();break;}const canvas=this.hooks.canvas;if(canvas.width!==bitmap.width)canvas.width=bitmap.width;if(canvas.height!==bitmap.height)canvas.height=bitmap.height;canvas.getContext('2d',{alpha:false}).drawImage(bitmap,0,0);bitmap.close();this.frames++;this.bytes+=bytes.length;this.hooks.frame?.();}}catch{this.hooks.failed('Не удалось прочитать изображение игры.');}finally{this.decodeBusy=false;}
 }
 captureAudio(emulator){
  if(this.closed||this.config.role!=='host')return;const al=emulator.gameManager?.Module?.AL?.currentCtx;if(!al?.audioCtx)return;const ctx=al.audioCtx;
  if(!this.processor){
   this.audioContext=ctx;this.processor=ctx.createScriptProcessor(2048,2,1);const silent=ctx.createGain();silent.gain.value=0;this.silent=silent;this.processor.connect(silent);silent.connect(ctx.destination);
   this.processor.onaudioprocess=e=>{if(!this.playing||this.socket?.readyState!==WebSocket.OPEN||this.socket.bufferedAmount>262144)return;const rate=22050,ratio=ctx.sampleRate/rate,input=e.inputBuffer.getChannelData(0),n=Math.floor(input.length/ratio),packet=new Uint8Array(5+n*2),view=new DataView(packet.buffer);packet[0]=3;view.setUint32(1,rate,true);for(let i=0;i<n;i++){const f=Math.max(-1,Math.min(1,input[Math.min(input.length-1,Math.floor(i*ratio))]));view.setInt16(5+i*2,f<0?f*32768:f*32767,true);}this.audioPackets++;for(let i=0;i<n;i++)this.audioPeak=Math.max(this.audioPeak,Math.abs(view.getInt16(5+i*2,true)));this.socket.send(packet);};
  }
  for(const source of Object.values(al.sources)){const gain=source.gain;if(gain&&!this.gains.has(gain)){gain.connect(this.processor);this.gains.add(gain);}}
 }
 unlockAudio(){if(this.config.role!=='guest')return;if(!this.audioContext){const Ctx=window.AudioContext||window.webkitAudioContext;if(!Ctx)return;this.audioContext=new Ctx();}if(this.audioContext.state==='suspended')void this.audioContext.resume().catch(()=>{});}
 audio(packet){
  if(!this.playing)return;this.receivedAudio++;this.unlockAudio();const ctx=this.audioContext;if(!ctx||ctx.state!=='running')return;const view=new DataView(packet.buffer),rate=view.getUint32(1,true),n=(packet.length-5)/2;if(n<1||n>8192||rate<16000||rate>48000)return;
  const now=ctx.currentTime;if(this.audioAt>now+.3)return;this.audioAt=Math.max(this.audioAt,now+.05);const buffer=ctx.createBuffer(1,n,rate),target=buffer.getChannelData(0);for(let i=0;i<n;i++)target[i]=view.getInt16(5+i*2,true)/32768;const source=ctx.createBufferSource();source.buffer=buffer;source.connect(ctx.destination);source.start(this.audioAt);this.audioAt+=n/rate;
 }
 close(){if(this.closed)return;this.input(0);this.closed=true;this.playing=false;clearTimeout(this.retry);clearInterval(this.heartbeat);clearInterval(this.audioAttach);cancelAnimationFrame(this.animation);this.socket?.close();this.pending=null;for(const gain of this.gains){try{gain.disconnect(this.processor);}catch{}}this.processor?.disconnect();this.silent?.disconnect();if(this.config.role==='guest')void this.audioContext?.close().catch(()=>{});}
}
window.Umk3Relay=Umk3Relay;
