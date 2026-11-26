'use strict';
// Сохранения принадлежат учётной записи и конкретному прохождению на этом устройстве.
// В базе нет паролей, токенов бота, ключей ROM или сетевых токенов.
(() => {
 const DB_NAME='ii-game-progress-v1',LIMIT=8*1024*1024;
 let opening=null;
 const fail=(code,message)=>Object.assign(new Error(message),{code});
 const keyOf=m=>JSON.stringify([m.owner,m.game,m.mode,m.partner||'']);
 const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
 function open(){
  if(opening)return opening;
  opening=new Promise((resolve,reject)=>{
   if(!window.indexedDB){reject(fail('SAVE_STORAGE_UNAVAILABLE','Браузер не разрешил сохранять игры на этом устройстве.'));return;}
   const request=indexedDB.open(DB_NAME,1);
   request.onupgradeneeded=()=>{const db=request.result;db.createObjectStore('states',{keyPath:'key'});const meta=db.createObjectStore('meta',{keyPath:'key'});meta.createIndex('owner','owner',{unique:false});};
   request.onerror=()=>reject(fail('SAVE_STORAGE_UNAVAILABLE','Не удалось открыть сохранения в этом браузере.'));
   request.onblocked=()=>reject(fail('SAVE_STORAGE_BLOCKED','Закройте старые вкладки игры и повторите сохранение.'));
   request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();opening=null;};resolve(db);};
  }).catch(error=>{opening=null;throw error;});return opening;
 }
 async function transaction(mode,stores,work){
  const db=await open();return new Promise((resolve,reject)=>{
   const tx=db.transaction(stores,mode);let result,failed=false;
   const error=()=>{if(failed)return;failed=true;reject(fail('SAVE_STORAGE_FAILED',tx.error?.name==='QuotaExceededError'?'Не хватает места для сохранения игры на этом устройстве.':'Браузер не подтвердил запись сохранения. Игра остаётся открытой.'));};
   tx.oncomplete=()=>{if(!failed)resolve(result);};tx.onerror=error;tx.onabort=error;
   try{work(tx,value=>{result=value;});}catch(cause){failed=true;try{tx.abort();}catch{}reject(cause?.name==='QuotaExceededError'?fail('SAVE_STORAGE_FAILED','Не хватает места для сохранения игры на этом устройстве.'):cause);}
  });
 }
 function cleanMeta(value,bytes,digest){
  if(!value||typeof value.owner!=='string'||!value.owner||value.owner.length>500||!/^\w{1,24}$/.test(value.game)||!['solo','local','coop'].includes(value.mode)||!/^[a-f0-9]{32}$/.test(value.savedId)||typeof value.release!=='string'||value.release.length>100||!/^[a-f0-9]{64}$/.test(value.romSha256))throw fail('SAVE_INVALID','Не удалось определить игру для сохранения.');
  if(value.mode==='coop'&&(!/^mk_[A-Za-z0-9_-]{20,100}$/.test(value.matchId||'')||!value.partner))throw fail('SAVE_INVALID','Не удалось определить совместное прохождение.');
  const m={version:1,owner:value.owner,game:value.game,mode:value.mode,partner:String(value.partner||'').toLowerCase().slice(0,160),partnerName:String(value.partnerName||'').slice(0,160),matchId:String(value.matchId||'').slice(0,120),savedId:value.savedId,release:value.release,romSha256:value.romSha256,bytes,hash:digest,savedAt:Date.now()};
  if(value.pauseRequest)m.pauseRequest={requestId:String(value.pauseRequest.requestId||''),requestTime:Number(value.pauseRequest.requestTime),session:String(value.pauseRequest.session||'')};
  m.key=keyOf(m);return m;
 }
 async function save(value,input){
  const bytes=input instanceof ArrayBuffer?new Uint8Array(input):ArrayBuffer.isView(input)?new Uint8Array(input.buffer,input.byteOffset,input.byteLength):null;
  if(!bytes||!bytes.byteLength||bytes.byteLength>LIMIT)throw fail('SAVE_INVALID','Получен некорректный снимок игры.');
  const state=bytes.slice().buffer,meta=cleanMeta(value,state.byteLength,await hash(state));
  await transaction('readwrite',['states','meta'],tx=>{tx.objectStore('states').put({key:meta.key,owner:meta.owner,state});tx.objectStore('meta').put(meta);});return meta;
 }
 async function list(owner){
  const values=await transaction('readonly',['meta'],(tx,result)=>{const request=tx.objectStore('meta').index('owner').getAll(owner);request.onsuccess=()=>result(request.result);});
  return values.filter(m=>m.owner===owner&&m.key===keyOf(m)).sort((a,b)=>b.savedAt-a.savedAt);
 }
 async function read(owner,key,expected={}){
  let meta,state;
  await transaction('readonly',['states','meta'],tx=>{const a=tx.objectStore('meta').get(key),b=tx.objectStore('states').get(key);a.onsuccess=()=>{meta=a.result;};b.onsuccess=()=>{state=b.result;};});
  if(!meta||!state||meta.owner!==owner||state.owner!==owner||meta.key!==keyOf(meta))throw fail('SAVE_NOT_FOUND','На этом устройстве сохранение не найдено.');
  for(const field of ['game','mode','matchId','savedId','release','romSha256'])if(expected[field]!==undefined&&meta[field]!==expected[field])throw fail('SAVE_INCOMPATIBLE','Сохранение относится к другому прохождению или выпуску игры.');
  if(!(state.state instanceof ArrayBuffer)||state.state.byteLength!==meta.bytes||meta.bytes>LIMIT||await hash(state.state)!==meta.hash)throw fail('SAVE_CORRUPT','Сохранение повреждено и не может быть загружено.');
  return {meta,state:state.state};
 }
 async function settle(owner,key,savedId){
  return transaction('readwrite',['meta'],tx=>{const store=tx.objectStore('meta'),request=store.get(key);request.onsuccess=()=>{const m=request.result;if(m?.owner===owner&&m.savedId===savedId){delete m.pauseRequest;store.put(m);}};});
 }
 async function remove(owner,key){
  return transaction('readwrite',['states','meta'],tx=>{const store=tx.objectStore('meta'),request=store.get(key);request.onsuccess=()=>{if(request.result?.owner!==owner)return;store.delete(key);tx.objectStore('states').delete(key);};});
 }
 window.IIGameProgress=Object.freeze({save,list,read,settle,remove,keyOf});
})();
