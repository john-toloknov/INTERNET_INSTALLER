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
