import { chromium } from 'playwright';
// Playwright's bundled build and the one on PATH disagree; point ZT_CHROMIUM
// at a specific binary when the default launch fails.
const EXE = process.env.ZT_CHROMIUM || undefined;
let pass=0, fail=0;
const ok=(c,l)=>{c?(pass++,console.log('  pass:',l)):(fail++,console.log('  FAIL:',l));};
const SUPA = (profileRows, avail) => `(function(){
const REC='__ins';
if(!sessionStorage.getItem(REC)) sessionStorage.setItem(REC,'[]');
window.__inserts=()=>JSON.parse(sessionStorage.getItem(REC)||'[]');
const rec=(t,r)=>{const a=JSON.parse(sessionStorage.getItem(REC)||'[]');a.push([t,r]);sessionStorage.setItem(REC,JSON.stringify(a));};
window.supabase={createClient:()=>({
 auth:{getSession:async()=>({data:{session:{user:{id:'u1',email:'a@b.c'}}},error:null}),
       getUser:async()=>({data:{user:{id:'u1',email:'a@b.c'}}}),
       onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})},
 from:(t)=>({ _t:t, select(){return this}, eq(){return this}, is(){return this},
   order(){return this}, limit(){return this},
   single:async function(){ return this._t==='profiles'
      ? {data:${JSON.stringify(profileRows)}, error:${profileRows?'null':"{message:'no rows'}"}}
      : {data:null,error:{message:'x'}}; },
   maybeSingle:async()=>({data:null,error:null}),
   insert:async function(row){ rec(this._t,row); return {error:null}; },
   update:async()=>({error:null}), upsert:async()=>({error:null}),
   then(r){ r({data:[],error:null,count:0}); return Promise.resolve({data:[],error:null,count:0}); } }),
 rpc:async(n)=> n==='username_available'?{data:${avail},error:null}:{data:null,error:{message:'no fn'}},
})};
window.Chart=function(){this.destroy=()=>{};this.update=()=>{};this.data={datasets:[{},{}]};this.options={scales:{x:{ticks:{}}}};};
window.Chart.defaults={font:{}};
})();`;
const b=await chromium.launch(EXE?{executablePath:EXE}:{});
async function page(profileRows, avail){
  const ctx=await b.newContext({viewport:{width:1100,height:900}});
  const p=await ctx.newPage(); const errs=[];
  p.on('pageerror',e=>errs.push(String(e)));
  await p.route('**/cdn.jsdelivr.net/**',r=>r.fulfill({status:200,contentType:'application/javascript',body:SUPA(profileRows,avail)}));
  await p.addInitScript(()=>localStorage.setItem('zt_theme','dark'));
  await p.goto((process.env.ZT_BASE||'http://127.0.0.1:8099')+'/dashboard.html',{waitUntil:'networkidle'});
  await p.waitForTimeout(700);
  return {ctx,p,errs};
}
console.log('[no profile row -> claim panel shown]');
{ const {ctx,p,errs}=await page(null,true);
  ok(await p.isVisible('#username-claim'),'claim panel is visible when the profile is missing');
  const t=await p.textContent('body');
  ok(/username/i.test(t),'it explains what is missing');
  ok(/games are already saved/i.test(t),'it reassures that games are not lost');
  await p.fill('#claim-username','hexadecimal'); await p.click('#claim-btn'); await p.waitForTimeout(500);
  const ins=await p.evaluate(()=>window.__inserts());
  ok(ins.some(([t,r])=>t==='profiles'&&r.username==='hexadecimal'&&r.id==='u1'),
     'saving inserts the profile row with the right id and username');
  ok(errs.length===0,'no uncaught errors ('+(errs[0]??'')+')');
  await p.screenshot({path:(process.env.ZT_SHOTS||'/tmp/shots')+'/claim-panel.png'}); await ctx.close(); }
console.log('[username taken -> refused, no insert]');
{ const {ctx,p,errs}=await page(null,false);
  await p.fill('#claim-username','taken'); await p.click('#claim-btn'); await p.waitForTimeout(500);
  const err=await p.textContent('#claim-error');
  ok(/taken/i.test(err),'a taken username is refused with a clear message');
  ok((await p.evaluate(()=>window.__inserts())).length===0,'no insert was attempted for a taken name');
  ok(await p.isEnabled('#claim-btn'),'the button re-enables after a refusal');
  ok(errs.length===0,'no uncaught errors'); await ctx.close(); }
console.log('[profile exists -> panel hidden]');
{ const {ctx,p,errs}=await page({id:'u1',username:'already'},true);
  ok(!(await p.isVisible('#username-claim')),'claim panel stays hidden when a profile exists');
  ok((await p.textContent('#username-display')).includes('already'),'the existing username is shown');
  ok(errs.length===0,'no uncaught errors'); await ctx.close(); }
console.log('[empty input -> refused]');
{ const {ctx,p}=await page(null,true);
  await p.click('#claim-btn'); await p.waitForTimeout(300);
  ok(/pick a username/i.test(await p.textContent('#claim-error')),'empty input is refused');
  ok((await p.evaluate(()=>window.__inserts())).length===0,'no insert on empty input'); await ctx.close(); }
await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
