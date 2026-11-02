'use strict';
const U={started:false,ready:false,closed:false,mode:'solo',mask:[0,0],keys:[0,0],touch:0,pads:[0,0],objects:[],pause:false,controller:new AbortController(),nonce:new URLSearchParams(location.search).get('embed')||'',romKey:null,relay:null};
// RetroArch requests an optional screen wake lock. Iframes/background tabs can
// legitimately be denied it; this does not affect emulation or controls.
window.addEventListener('unhandledrejection',event=>{if(event.reason?.name==='NotAllowedError'&&/wake lock/i.test(event.reason.message||''))event.preventDefault();});
const $=id=>document.getElementById(id);
const status=(text,error=false)=>{$('status').textContent=text;$('status').classList.toggle('error',error);};
const notify=(type,fields={})=>{if(parent!==window)parent.postMessage({type,nonce:U.nonce,...fields},location.origin);};
const BASE_KEYMAP={ArrowUp:4,ArrowDown:5,ArrowLeft:6,ArrowRight:7,KeyZ:1,KeyX:0,KeyC:8,KeyA:10,KeyS:9,KeyD:11,Enter:3};
const P2_KEYMAP={KeyI:4,KeyK:5,KeyJ:6,KeyL:7,KeyF:1,KeyG:0,KeyH:8,KeyR:10,KeyT:9,KeyY:11,KeyU:3};
function input(player,mask){
 if(!U.ready||U.closed)return;
 if(U.netWaiting&&mask!==0)return;
 if(U.mode==='net-guest'){if(U.mask[1]!==mask){U.mask[1]=mask;U.relay?.input(mask);}return;}
 const before=U.mask[player];if(before===mask)return;U.mask[player]=mask;
 for(let b=0;b<12;b++)if((before^mask)&(1<<b))EJS_emulator.gameManager.simulateInput(player,b,(mask>>b)&1);
}
function applyLocal(){const player=U.mode==='net-guest'?1:0;input(player,U.keys[0]|U.touch|U.pads[0]);if(U.mode==='local')input(1,U.keys[1]|U.pads[1]);}
function release(){U.keys=[0,0];U.touch=0;U.pads=[0,0];applyLocal();document.querySelectorAll('.pressed').forEach(b=>b.classList.remove('pressed'));}
function pulse(player,button){if(!U.ready)return;const old=U.keys[player];U.keys[player]|=1<<button;applyLocal();setTimeout(()=>{U.keys[player]=old&~(1<<button);applyLocal();},100);}
function closeGame(){if(U.closed)return;release();U.closed=true;U.restoreContext?.();U.controller.abort();cancelAnimationFrame(U.padLoop);U.relay?.close();for(const url of U.objects)URL.revokeObjectURL(url);U.objects=[];if(window.EJS_emulator?.gameManager)EJS_emulator.gameManager.toggleMainLoop(0);notify('umk3-closed');}
function keyboard(event,down){
 if(!U.ready||U.closed||/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName||''))return;
 let player=0,button=BASE_KEYMAP[event.code];if(button===undefined&&U.mode==='local'){button=P2_KEYMAP[event.code];player=1;}
 if(button===undefined)return;event.preventDefault();const bit=1<<button;U.keys[player]=down?U.keys[player]|bit:U.keys[player]&~bit;applyLocal();
}
window.addEventListener('keydown',e=>keyboard(e,true));window.addEventListener('keyup',e=>keyboard(e,false));window.addEventListener('blur',release);document.addEventListener('visibilitychange',()=>{if(document.hidden)release();U.relay?.visibility(!document.hidden);});window.addEventListener('pagehide',closeGame);
for(const b of document.querySelectorAll('[data-pad]')){
 const bit=1<<Number(b.dataset.pad);const pointers=new Set();
 b.onpointerdown=e=>{e.preventDefault();if(!U.ready)return;b.setPointerCapture(e.pointerId);pointers.add(e.pointerId);U.touch|=bit;b.classList.add('pressed');applyLocal();};
 const up=e=>{e.preventDefault();pointers.delete(e.pointerId);if(!pointers.size){U.touch&=~bit;b.classList.remove('pressed');applyLocal();}};b.onpointerup=up;b.onpointercancel=up;b.onlostpointercapture=up;
}
$('startBtn').onclick=()=>pulse(0,3);$('p2Btn').onclick=()=>pulse(1,3);
$('fullscreenBtn').onclick=()=>{if(!document.fullscreenElement)$('app').requestFullscreen?.().catch(()=>status('Полный экран недоступен',true));else void document.exitFullscreen();};
$('pauseBtn').onclick=()=>{if(!U.ready||U.mode.startsWith('net-'))return;release();U.pause=!U.pause;EJS_emulator.gameManager.toggleMainLoop(U.pause?0:1);$('pauseBtn').textContent=U.pause?'▶ Продолжить':'⏸ Пауза';};
$('closeBtn').onclick=closeGame;
function gamepads(){
 if(U.closed)return;const pads=navigator.getGamepads?.()||[];
 for(let p=0;p<(U.mode==='local'?2:1);p++){
  const pad=document.hidden?null:pads[p];let mask=0;
  if(pad){const pressed=i=>pad.buttons[i]?.pressed;
   for(const [index,bit] of [[0,0],[1,8],[2,1],[3,9],[4,10],[5,11],[8,2],[9,3],[12,4],[13,5],[14,6],[15,7]])if(pressed(index))mask|=1<<bit;
   if(pad.axes[0]<-.45)mask|=1<<6;if(pad.axes[0]>.45)mask|=1<<7;if(pad.axes[1]<-.45)mask|=1<<4;if(pad.axes[1]>.45)mask|=1<<5;
  }
  U.pads[p]=mask;
 }applyLocal();U.padLoop=requestAnimationFrame(gamepads);
}
async function decodeRom(config){
 const response=await fetch('roms/umk3-v1.enc',{signal:U.controller.signal});if(!response.ok)throw Error('Не удалось загрузить файлы игры');const packed=new Uint8Array(await response.arrayBuffer());
 if(packed.length!==4194304+28)throw Error('Размер игрового файла не совпадает с выпуском');
 const raw=Uint8Array.from(atob(config.key),c=>c.charCodeAt(0));if(raw.length!==32)throw Error('Некорректный ключ игры');
 const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);raw.fill(0);
 const decoded=await crypto.subtle.decrypt({name:'AES-GCM',iv:packed.slice(0,12)},key,packed.slice(12));
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',decoded))].map(n=>n.toString(16).padStart(2,'0')).join('');
 if(hash!==config.romSha256)throw Error('Контрольная сумма игры не совпала');
 const url=URL.createObjectURL(new Blob([decoded],{type:'application/octet-stream'}));U.objects.push(url);return url;
}
async function decodeStartState(config){
 const response=await fetch('release.json',{signal:U.controller.signal});if(!response.ok)throw Error('Не удалось проверить выпуск игры');const release=await response.json();
 if(release.release!=='umk3-md-original-v1'||release.romSha256!==config.romSha256)throw Error('Файлы разных выпусков игры');
 const meta=release.states[config.mode==='solo'?'title':'versus'];
 const state=await fetch(meta.url,{signal:U.controller.signal});if(!state.ok)throw Error('Не удалось подготовить начало игры');const packed=new Uint8Array(await state.arrayBuffer());
 if(packed.length!==meta.bytes+28)throw Error('Повреждён файл начала игры');
 const raw=Uint8Array.from(atob(config.key),c=>c.charCodeAt(0)),key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);raw.fill(0);
 const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:packed.slice(0,12)},key,packed.slice(12));
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');if(hash!==meta.sha256)throw Error('Контрольная сумма начала игры не совпала');return new Uint8Array(bytes);
}
async function boot(config){
 if(U.started||U.closed)return;U.started=true;
 if(!['solo','local','net-host','net-guest'].includes(config.mode))throw Error('Неизвестный режим игры');U.mode=config.mode;
 if(config.theme==='light')document.body.classList.add('light');
 $('modeLabel').textContent=({solo:'Один игрок',local:'Двое рядом','net-host':'Матч · Игрок 1','net-guest':'Матч · Игрок 2'})[U.mode];
 $('p2Btn').hidden=U.mode!=='local';$('p2Hint').hidden=U.mode!=='local';$('pauseBtn').disabled=U.mode.startsWith('net-');status('⏳ Загружаем Mortal Kombat 3 Ultimate…');
 if(U.mode.startsWith('net-')){
  if(!config.relay||config.relay.role!==(U.mode==='net-host'?'host':'guest'))throw Error('Некорректная сетевая сессия');U.netWaiting=true;
  const waiting=text=>{release();U.netWaiting=true;if(U.mode==='net-guest')U.ready=false;else if(window.EJS_emulator?.gameManager)EJS_emulator.gameManager.toggleMainLoop(0);$('curtain').hidden=false;$('curtain').textContent=text;status(text);};
  U.relay=new Umk3Relay(config.relay,{canvas:$('remote'),input:mask=>{if(U.mode==='net-host')input(1,mask);},
   waiting,failed:text=>{waiting(text);status(text,true);notify('umk3-error',{message:text});},
   connected:()=>{release();U.netWaiting=false;U.ready=true;if(U.mode==='net-host'&&window.EJS_emulator?.gameManager)EJS_emulator.gameManager.toggleMainLoop(1);$('curtain').hidden=true;status('Матч подключён');notify('umk3-connected');},
   frame:()=>{if(U.relay.playing){$('curtain').hidden=true;status('Матч подключён');}}
  });U.relay.connect();waiting('Ждём подключения соперника…');
  if(U.mode==='net-guest'){$('game').hidden=true;$('remote').hidden=false;U.relay.gameReady();gamepads();notify('umk3-started',{mode:U.mode});return;}
 }
 const url=await decodeRom(config);
 const startState=await decodeStartState(config);
 Object.assign(window,{EJS_player:'#game',EJS_core:'genesis_plus_gx',EJS_controlScheme:'segaMD',EJS_gameUrl:url,EJS_gameName:'umk3-md-original-v1',EJS_gameID:31001,
  EJS_pathtodata:new URL('vendor/emulatorjs-4.2.3/data/',location.href).href,EJS_DEBUG_XX:true,EJS_startOnLoaded:true,EJS_threads:false,EJS_disableLocalStorage:true,EJS_disableDatabases:true,EJS_language:'ru-RU',EJS_color:'#b7ed55',EJS_defaultControls:{0:{},1:{},2:{},3:{}},
  EJS_defaultOptions:{'virtual-gamepad':'disabled','shader':'disabled'},EJS_Buttons:{playPause:false,restart:false,mute:false,settings:false,fullscreen:false,saveState:false,loadState:false,screenRecord:false,gamepad:false,cheat:false,volume:false,saveSavFiles:false,loadSavFiles:false,quickSave:false,quickLoad:false,screenshot:false,cacheManager:false,exitEmulation:false},
  EJS_onGameStart:()=>{U.restoreContext?.();if(U.closed)return;EJS_emulator.gameManager.loadState(startState);U.ready=true;status('Выбирайте бойца · Start / A / B / C');if(U.relay){EJS_emulator.gameManager.toggleMainLoop(0);U.relay.publish($('game').querySelector('canvas'),EJS_emulator);U.relay.gameReady();}gamepads();notify('umk3-started',{mode:U.mode});}

 });
 // Video capture needs the last completed WebGL frame after presentation.
 // Scope the context option override to this game's startup, then restore it.
 if(U.mode==='net-host'){const original=HTMLCanvasElement.prototype.getContext;U.restoreContext=()=>{HTMLCanvasElement.prototype.getContext=original;U.restoreContext=null;};HTMLCanvasElement.prototype.getContext=function(type,options){return original.call(this,type,/^(webgl2?|experimental-webgl)$/.test(type)?{...options,preserveDrawingBuffer:true}:options);};}
 const script=document.createElement('script');script.src=EJS_pathtodata+'loader.js';script.onerror=()=>status('Не удалось загрузить движок игры',true);document.body.append(script);
}
window.addEventListener('message',event=>{
 if(event.origin!==location.origin||event.source!==parent||event.data?.nonce!==U.nonce)return;
 if(event.data.type==='umk3-close'){closeGame();return;}if(event.data.type!=='umk3-start')return;
 void boot(event.data.config).catch(error=>{status(error.message||String(error),true);notify('umk3-error',{message:error.message||String(error)});});
});
if(parent!==window){document.body.classList.add('embedded');notify('umk3-ready');}
