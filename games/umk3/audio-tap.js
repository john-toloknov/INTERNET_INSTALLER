'use strict';
// Tap emulator output on the audio thread; never duplicate it at the host's speakers.
class Umk3AudioTap extends AudioWorkletProcessor {
 constructor(){super();this.samples=new Float32Array(1024);this.at=0;}
 process(inputs,outputs){
  for(const channel of outputs[0]||[])channel.fill(0);
  const channels=inputs[0];if(!channels?.length)return true;
  for(let i=0;i<channels[0].length;i++){
   let value=0;for(const channel of channels)value+=channel[i];this.samples[this.at++]=value/channels.length;
   if(this.at===this.samples.length){this.port.postMessage(this.samples,[this.samples.buffer]);this.samples=new Float32Array(1024);this.at=0;}
  }return true;
 }
}
registerProcessor('umk3-audio-tap',Umk3AudioTap);

// A bounded jitter buffer on the audio thread. A network burst must not stop
// sources which are already audible. No shared memory or cross-origin headers.
class Umk3AudioPlayback extends AudioWorkletProcessor {
 constructor(){
  super();this.ring=new Float32Array(131072);this.read=0;this.write=0;this.count=0;this.phase=0;this.rate=32000;this.running=false;this.target=.06;this.jitter=0;this.lastArrival=null;this.previousDuration=0;this.last=0;this.fade=0;this.underruns=0;this.dropped=0;this.ticks=0;
  this.port.onmessage=e=>{const m=e.data;if(m?.type==='reset'){this.reset();return;}if(m?.type==='samples')this.push(m);};
 }
 reset(){this.read=this.write=this.count=this.phase=0;this.running=false;this.last=0;this.lastArrival=null;this.fade=0;}
 push(m){
  let samples=m.samples;const rate=m.rate;if(!(samples instanceof Float32Array)||!samples.length||samples.length>8192||!Number.isFinite(rate)||rate<16000||rate>48000)return;
  if(rate!==this.rate){this.reset();this.rate=rate;}
  const arrival=Number.isFinite(m.at)?m.at/1000:null;
  if(arrival!==null&&this.lastArrival!==null){const delta=Math.abs(arrival-this.lastArrival-this.previousDuration);this.jitter+=.08*(Math.min(.25,delta)-this.jitter);this.target=Math.max(.06,Math.min(.14,.06+this.jitter*2));}
  this.lastArrival=arrival;this.previousDuration=samples.length/rate;
  const limit=Math.ceil(rate*.30);if(samples.length>limit){this.dropped+=samples.length-limit;samples=samples.subarray(samples.length-limit);}
  if(this.count+samples.length>limit){const keep=Math.ceil(rate*this.target),drop=Math.max(0,this.count+samples.length-keep);const remove=Math.min(this.count,drop);this.read=(this.read+remove)%this.ring.length;this.count-=remove;this.dropped+=remove;this.phase=0;this.fade=Math.ceil(sampleRate*.004);}
  for(const value of samples){this.ring[this.write]=Number.isFinite(value)?Math.max(-1,Math.min(1,value)):0;this.write=(this.write+1)%this.ring.length;this.count++;}
 }
 process(inputs,outputs){
  const out=outputs[0]?.[0];if(!out)return true;
  if(!this.running&&this.count>=Math.ceil(this.rate*this.target)+1){this.running=true;this.fade=Math.ceil(sampleRate*.004);}
  // Small clock corrections prevent gradual drift between the two devices.
  const level=this.count/this.rate,correction=this.running?Math.max(.98,Math.min(1.02,1+(level-this.target)*.12)):1,step=this.rate/sampleRate*correction;
  for(let i=0;i<out.length;i++){
   if(this.running&&this.count<2){this.running=false;this.phase=0;this.underruns++;}
   let value=0;
   if(this.running){const a=this.ring[this.read],b=this.ring[(this.read+1)%this.ring.length];value=a+(b-a)*this.phase;this.phase+=step;const used=Math.min(this.count,Math.floor(this.phase));this.phase-=used;this.read=(this.read+used)%this.ring.length;this.count-=used;
    if(this.fade>0){value=this.last+(value-this.last)/this.fade;this.fade--;}
   }else value=Math.abs(this.last)>.00001?this.last*.95:0;
   out[i]=value;this.last=value;
  }
  for(let ch=1;ch<(outputs[0]?.length||0);ch++)outputs[0][ch].set(out);
  this.ticks+=out.length;if(this.ticks>=sampleRate){this.ticks=0;this.port.postMessage({type:'stats',queueMs:1000*this.count/this.rate,jitterMs:1000*this.jitter,underruns:this.underruns,droppedMs:1000*this.dropped/this.rate});}
  return true;
 }
}
registerProcessor('umk3-audio-playback',Umk3AudioPlayback);
