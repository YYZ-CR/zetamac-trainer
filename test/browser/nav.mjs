import { chromium } from 'playwright';
// Every page must show the SAME nav. There used to be two header builders that
// had drifted — one rendered Dashboard and never Play, the other Play and never
// Dashboard — so exactly one appeared depending on the page, which reads as
// links randomly disappearing. This is the regression guard for that.
const EXE=process.env.ZT_CHROMIUM;
const PAGES=['index.html','dashboard.html','daily.html','duel.html','leagues.html','practice.html','profile.html?u=x','results.html','settings.html','privacy.html','terms.html'];
const SUPA=(signedIn)=>`(function(){window.supabase={createClient:()=>({
 auth:{getSession:async()=>({data:{session:${signedIn?"{user:{id:'u1',email:'a@b.c'}}":'null'}},error:null}),
   getUser:async()=>({data:{user:${signedIn?"{id:'u1',email:'a@b.c'}":'null'}}}),
   onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})},
 from:()=>({select(){return this},eq(){return this},is(){return this},order(){return this},limit(){return this},
   single:async()=>({data:null,error:{message:'x'}}),maybeSingle:async()=>({data:null,error:null}),
   insert:async()=>({error:null}),update:async()=>({error:null}),upsert:async()=>({error:null}),
   then(r){r({data:[],error:null,count:0});return Promise.resolve({data:[],error:null,count:0});}}),
 rpc:async()=>({data:null,error:{message:'no fn'}})})};
window.Chart=function(){this.destroy=()=>{};this.update=()=>{};this.data={datasets:[{},{}]};this.options={scales:{x:{ticks:{}}}};};
window.Chart.defaults={font:{}};})();`;
let pass=0,fail=0;
const ok=(c,l)=>{c?(pass++):(fail++,console.log('  FAIL:',l));};
const b=await chromium.launch(EXE?{executablePath:EXE}:{});
for (const signedIn of [true,false]) {
  console.log(`\n=== signed ${signedIn?'IN':'OUT'} ===`);
  for (const pg of PAGES) {
    const ctx=await b.newContext(); const p=await ctx.newPage();
    await p.route('**/cdn.jsdelivr.net/**',r=>r.fulfill({status:200,contentType:'application/javascript',body:SUPA(signedIn)}));
    await p.addInitScript(()=>localStorage.setItem('zt_theme','dark'));
    await p.goto((process.env.ZT_BASE||'http://127.0.0.1:8099')+'/'+pg,{waitUntil:'networkidle'});
    await p.waitForTimeout(450);
    const bar=(await p.textContent('#top-bar'))||'';
    const want=['Play','Duel','Leagues','Dashboard', signedIn?'Settings':null, signedIn?'Log out':'Log in'].filter(Boolean);
    const missing=want.filter(w=>!bar.includes(w));
    const theme=/Light|Dark/i.test(bar);
    console.log(`  ${pg.padEnd(20)} [${bar.replace(/\s+/g,' ').trim()}]`);
    ok(missing.length===0, `${pg}: missing ${missing.join(', ')}`);
    ok(theme, `${pg}: theme toggle absent`);
    if (!signedIn) ok(!bar.includes('Settings'), `${pg}: Settings shown while signed out`);
    await ctx.close();
  }
}
await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
