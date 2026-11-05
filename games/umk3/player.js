'use strict';
const U={started:false,ready:false,closed:false,mode:'solo',mask:[0,0],keys:[0,0],held:new Set(),pulses:[0,0],touch:0,touchResets:[],stick:0,pads:[0,0],objects:[],pause:false,controller:new AbortController(),nonce:new URLSearchParams(location.search).get('embed')||'',romKey:null,relay:null};
// RetroArch requests an optional screen wake lock. Iframes/background tabs can
// legitimately be denied it; this does not affect emulation or controls.
window.addEventListener('unhandledrejection',event=>{if(event.reason?.name==='NotAllowedError'&&/wake lock/i.test(event.reason.message||''))event.preventDefault();});
const $=id=>document.getElementById(id);
const status=(text,error=false)=>{if($('status').textContent!==text)$('status').textContent=text;$('status').classList.toggle('error',error);};
const notify=(type,fields={})=>{if(parent!==window)parent.postMessage({type,nonce:U.nonce,...fields},location.origin);};
// Genesis defaults: X=high punch, A=low punch, Y=run, B=block, Z=high kick, C=low kick.
// event.code keeps these physical keys usable with either English or Russian keyboard layout.
const BASE_KEYMAP={KeyW:4,KeyS:5,KeyA:6,KeyD:7,KeyT:10,KeyG:1,KeyY:9,KeyH:0,KeyU:11,KeyJ:8,Enter:3};
const P2_KEYMAP={ArrowUp:4,ArrowDown:5,ArrowLeft:6,ArrowRight:7,Digit1:1,Numpad1:1,Digit4:10,Numpad4:10,Digit2:0,Numpad2:0,Digit5:9,Numpad5:9,Digit3:8,Numpad3:8,Digit6:11,Numpad6:11,NumpadEnter:3};
function keyBinding(code){if(BASE_KEYMAP[code]!==undefined)return [0,BASE_KEYMAP[code]];if(P2_KEYMAP[code]!==undefined)return [U.mode==='local'?1:0,P2_KEYMAP[code]];return null;}
function input(player,mask){
 if(!U.ready||U.closed)return;
 if(U.netWaiting&&mask!==0)return;
 if(U.mode==='net-guest'){if(U.mask[1]!==mask){U.mask[1]=mask;U.relay?.input(mask);}return;}
 const before=U.mask[player];if(before===mask)return;U.mask[player]=mask;
 for(let b=0;b<12;b++)if((before^mask)&(1<<b))EJS_emulator.gameManager.simulateInput(player,b,(mask>>b)&1);
}
function applyLocal(){const player=U.mode==='net-guest'?1:0;input(player,U.keys[0]|U.touch|U.stick|U.pads[0]|U.pulses[0]);if(U.mode==='local')input(1,U.keys[1]|U.pads[1]|U.pulses[1]);}
function release(){U.held.clear();U.pulses=[0,0];U.keys=[0,0];U.touch=0;U.touchResets.forEach(reset=>reset());U.stick=0;resetStick();U.pads=[0,0];applyLocal();document.querySelectorAll('.pressed').forEach(b=>b.classList.remove('pressed'));}
function pulse(player,button){if(!U.ready)return;U.pulses[player]|=1<<button;applyLocal();setTimeout(()=>{U.pulses[player]&=~(1<<button);applyLocal();},100);}
function closeGame(){if(U.closed)return;release();U.closed=true;U.restoreContext?.();U.controller.abort();cancelAnimationFrame(U.padLoop);U.relay?.close();for(const url of U.objects)URL.revokeObjectURL(url);U.objects=[];if(window.EJS_emulator?.gameManager)EJS_emulator.gameManager.toggleMainLoop(0);notify('umk3-closed');}
function keyboard(event,down){
 if(!U.ready||U.closed||event.target?.closest?.('.control-layout')||(/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName||'')||event.target?.isContentEditable))return;
 if(!keyBinding(event.code))return;event.preventDefault();event.stopImmediatePropagation();
 if(down)U.held.add(event.code);else U.held.delete(event.code);
 U.keys=[0,0];for(const code of U.held){const binding=keyBinding(code);if(binding)U.keys[binding[0]]|=1<<binding[1];}applyLocal();
}

function focusGame(){if(U.closed)return;try{window.focus();$('display').focus({preventScroll:true});}catch{}}
function unlockSound(){
 if(U.closed)return;U.relay?.unlockAudio(true);
 const ctx=window.EJS_emulator?.gameManager?.Module?.AL?.currentCtx?.audioCtx;
 if(ctx){$('soundBtn').hidden=ctx.state==='running';if(ctx.state==='suspended')void ctx.resume().then(()=>{$('soundBtn').hidden=ctx.state==='running';}).catch(()=>{});}
}
const keyDown=e=>{unlockSound();keyboard(e,true);},keyUp=e=>keyboard(e,false);
window.addEventListener('keydown',keyDown,{capture:true,signal:U.controller.signal});
window.addEventListener('keyup',keyUp,{capture:true,signal:U.controller.signal});
window.addEventListener('pointerdown',()=>{unlockSound();focusGame();},{capture:true,signal:U.controller.signal});
try{if(parent!==window&&parent.location.origin===location.origin){
 const active=()=>!U.closed&&window.frameElement?.isConnected&&window.frameElement.getClientRects().length>0;
 parent.addEventListener('keydown',e=>{if(active())keyDown(e);},{capture:true,signal:U.controller.signal});
 parent.addEventListener('keyup',e=>{if(active())keyUp(e);},{capture:true,signal:U.controller.signal});
 parent.addEventListener('focusin',e=>{if(active()&&(/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName||'')||e.target?.isContentEditable))release();},{signal:U.controller.signal});
 parent.addEventListener('blur',release,{signal:U.controller.signal});
}}catch{}
$('soundBtn').onclick=()=>{unlockSound();focusGame();};
window.addEventListener('blur',release);document.addEventListener('visibilitychange',()=>{if(document.hidden)release();U.relay?.visibility(!document.hidden);});window.addEventListener('pagehide',closeGame);
for(const b of document.querySelectorAll('[data-pad]')){
 const bit=1<<Number(b.dataset.pad);const pointers=new Set();U.touchResets.push(()=>pointers.clear());
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
 const response=await fetch((config.romUrl||'roms/umk3-v1.enc')+'?v=20261105-arcade3',{signal:U.controller.signal});if(!response.ok)throw Error('Не удалось загрузить файлы игры');const packed=new Uint8Array(await response.arrayBuffer());
 if(packed.length!==(config.romBytes||4194304)+28)throw Error('Размер игрового файла не совпадает с выпуском');
 const raw=Uint8Array.from(atob(config.key),c=>c.charCodeAt(0));if(raw.length!==32)throw Error('Некорректный ключ игры');
 const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);raw.fill(0);
 const decoded=await crypto.subtle.decrypt({name:'AES-GCM',iv:packed.slice(0,12)},key,packed.slice(12));
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',decoded))].map(n=>n.toString(16).padStart(2,'0')).join('');
 if(hash!==config.romSha256)throw Error('Контрольная сумма игры не совпала');
 const url=URL.createObjectURL(new Blob([decoded],{type:'application/octet-stream'}));U.objects.push(url);return url;
}
async function decodeStartState(config){
 const response=await fetch('release.json?v=20261104-direct1',{signal:U.controller.signal});if(!response.ok)throw Error('Не удалось проверить выпуск игры');const release=await response.json();
 if(release.release!=='umk3-md-original-v1'||release.romSha256!==config.romSha256)throw Error('Файлы разных выпусков игры');
 const meta=release.states[config.mode==='solo'?'title':'versus'];
 const state=await fetch(meta.url+'?v=20261104-direct1',{signal:U.controller.signal});if(!state.ok)throw Error('Не удалось подготовить начало игры');const packed=new Uint8Array(await state.arrayBuffer());
 if(packed.length!==meta.bytes+28)throw Error('Повреждён файл начала игры');
 const raw=Uint8Array.from(atob(config.key),c=>c.charCodeAt(0)),key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);raw.fill(0);
 const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:packed.slice(0,12)},key,packed.slice(12));
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');if(hash!==meta.sha256)throw Error('Контрольная сумма начала игры не совпала');return new Uint8Array(bytes);
}
async function boot(config){
 if(U.started||U.closed)return;U.started=true;
 if(!['solo','local','net-host','net-guest'].includes(config.mode))throw Error('Неизвестный режим игры');U.mode=config.mode;U.game=config.game||'umk3';U.title=config.title||'Mortal Kombat 3 Ultimate';document.body.classList.toggle('app-mobile-nav',config.mobileNavigation===true);document.title=U.title;$('gameTitle').textContent=U.title;$('gameLogo').src='../../assets/games/'+U.game+'.png?v=20261105-arcade3';document.body.dataset.game=U.game;
 if(config.theme==='light')document.body.classList.add('light');
 $('modeLabel').textContent=({solo:'Один игрок',local:'Двое рядом','net-host':'Матч · Игрок 1','net-guest':'Матч · Игрок 2'})[U.mode];
 $('p2Btn').hidden=U.mode!=='local';$('pauseBtn').disabled=U.mode.startsWith('net-');status('⏳ Загружаем '+U.title+'…');
 if(U.mode.startsWith('net-')){
  if(!config.relay||config.relay.role!==(U.mode==='net-host'?'host':'guest'))throw Error('Некорректная сетевая сессия');U.netWaiting=true;
  const waiting=text=>{release();U.netWaiting=true;if(U.mode==='net-guest')U.ready=false;else if(window.EJS_emulator?.gameManager)EJS_emulator.gameManager.toggleMainLoop(0);$('curtain').hidden=false;$('curtain').textContent=text;status(text);};
  U.relay=new Umk3Relay(config.relay,{canvas:$('remote'),input:mask=>{if(U.mode==='net-host')input(1,mask);},
   waiting,failed:text=>{waiting(text);status(text,true);notify('umk3-error',{message:text});},
   connected:()=>{focusGame();release();U.netWaiting=false;U.ready=true;if(U.mode==='net-host'&&window.EJS_emulator?.gameManager)EJS_emulator.gameManager.toggleMainLoop(1);$('curtain').hidden=true;status('Матч подключён');notify('umk3-connected');},
   transport:direct=>status(direct?'Матч подключён · Прямое соединение':'Матч подключён · Через сервер'),diagnostics:d=>{const n=$('networkStats');n.hidden=false;n.textContent=(d.direct?'Напрямую':'Через сервер')+' · Связь: '+Math.round(d.rtt||0)+' мс'+(d.bufferMs==null?'':' · Видеобуфер: '+Math.round(d.bufferMs)+' мс');},
   audio:running=>{$('soundBtn').hidden=running;},
   frame:()=>{if(U.relay.playing){$('curtain').hidden=true;status(U.relay.direct?'Матч подключён · Прямое соединение':'Матч подключён · Через сервер');}}
  });U.relay.connect();waiting('Ждём подключения соперника…');
  if(U.mode==='net-guest'){$('game').hidden=true;$('remote').hidden=false;U.relay.gameReady();focusGame();gamepads();notify('umk3-started',{mode:U.mode});return;}
 }
 const url=await decodeRom(config);
 const startState=U.game==='umk3'?await decodeStartState(config):null;
 Object.assign(window,{EJS_player:'#game',EJS_core:'genesis_plus_gx',EJS_controlScheme:'segaMD',EJS_gameUrl:url,EJS_gameName:config.release||'umk3-md-original-v1',EJS_gameID:config.gameId||31001,
  EJS_pathtodata:new URL('vendor/emulatorjs-4.2.3/data/',location.href).href,EJS_DEBUG_XX:true,EJS_startOnLoaded:true,EJS_threads:false,EJS_disableLocalStorage:true,EJS_disableDatabases:true,EJS_language:'ru-RU',EJS_color:'#b7ed55',EJS_defaultControls:{0:{},1:{},2:{},3:{}},
  EJS_defaultOptions:{'virtual-gamepad':'disabled','shader':'disabled'},EJS_Buttons:{playPause:false,restart:false,mute:false,settings:false,fullscreen:false,saveState:false,loadState:false,screenRecord:false,gamepad:false,cheat:false,volume:false,saveSavFiles:false,loadSavFiles:false,quickSave:false,quickLoad:false,screenshot:false,cacheManager:false,exitEmulation:false},
  EJS_onGameStart:()=>{U.restoreContext?.();if(U.closed)return;if(startState)EJS_emulator.gameManager.loadState(startState);U.ready=true;focusGame();unlockSound();status(U.game==='umk3'?'Выбирайте бойца · Start / A / B / C':'Start — меню игры · Для двух игроков выберите режим 2 Players');if(U.relay){EJS_emulator.gameManager.toggleMainLoop(0);U.relay.publish($('game').querySelector('canvas'),EJS_emulator);U.relay.gameReady();}gamepads();notify('umk3-started',{mode:U.mode});}

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

function stickMask(x,y){
 const distance=Math.hypot(x,y);if(distance<.22)return 0;
 const angle=Math.atan2(y,x),sector=(Math.round(angle/(Math.PI/4))+8)%8;
 return [(1<<7),(1<<7)|(1<<5),(1<<5),(1<<5)|(1<<6),(1<<6),(1<<6)|(1<<4),(1<<4),(1<<4)|(1<<7)][sector];
}
let stickPointer=null;
function resetStick(){stickPointer=null;U.stick=0;const knob=$('stickKnob');if(knob)knob.style.transform='translate(0px,0px)';$('joystick')?.classList.remove('pressed');}
const joystick=$('joystick');
function moveStick(e){if(e.pointerId!==stickPointer)return;e.preventDefault();const r=joystick.getBoundingClientRect(),radius=r.width*.34,dx=(e.clientX-r.left-r.width/2)/radius,dy=(e.clientY-r.top-r.height/2)/radius,d=Math.max(1,Math.hypot(dx,dy));$('stickKnob').style.transform=`translate(${dx/d*radius}px,${dy/d*radius}px)`;U.stick=stickMask(dx,dy);applyLocal();}
joystick.addEventListener('pointerdown',e=>{e.preventDefault();if(!U.ready||stickPointer!==null)return;stickPointer=e.pointerId;joystick.setPointerCapture(e.pointerId);joystick.classList.add('pressed');moveStick(e);},{signal:U.controller.signal});
joystick.addEventListener('pointermove',moveStick,{signal:U.controller.signal});
for(const name of ['pointerup','pointercancel','lostpointercapture'])joystick.addEventListener(name,e=>{if(e.pointerId!==stickPointer)return;e.preventDefault();resetStick();applyLocal();},{signal:U.controller.signal});

const CONTROL_LAYOUT_KEY='ii-game-control-layout-v1';
function setControlLayout(value,persist=true){
 const mode=value==='arrows'?'arrows':'joystick';release();U.controlLayout=mode;$('joystick').hidden=mode!=='joystick';$('arrows').hidden=mode!=='arrows';
 document.querySelectorAll('[data-control-layout]').forEach(button=>button.setAttribute('aria-checked',String(button.dataset.controlLayout===mode)));
 if(persist)try{localStorage.setItem(CONTROL_LAYOUT_KEY,mode);}catch{}
}
for(const button of document.querySelectorAll('[data-control-layout]'))button.addEventListener('click',()=>{setControlLayout(button.dataset.controlLayout);focusGame();},{signal:U.controller.signal});
$('controlLayout').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();const mode=event.key==='Home'?'joystick':event.key==='End'?'arrows':U.controlLayout==='arrows'?'joystick':'arrows';setControlLayout(mode);document.querySelector('[data-control-layout="'+mode+'"]').focus();},{signal:U.controller.signal});
let savedControlLayout='joystick';try{savedControlLayout=localStorage.getItem(CONTROL_LAYOUT_KEY)||'joystick';}catch{}setControlLayout(savedControlLayout,false);

async function playerNavigate(action){
 if(U.closed)return;release();if(document.fullscreenElement)try{await document.exitFullscreen();}catch{}notify('umk3-navigate',{action});
}
$('gameBack').addEventListener('click',()=>void playerNavigate('back'),{signal:U.controller.signal});
$('gameHome').addEventListener('click',()=>void playerNavigate('home'),{signal:U.controller.signal});

// Rotation cancels held touch input; the same DOM nodes retain their listeners.
const landscapeControls=window.matchMedia('(orientation:landscape) and (max-width:1100px) and (max-height:650px)');
landscapeControls.addEventListener('change',()=>release(),{signal:U.controller.signal});
