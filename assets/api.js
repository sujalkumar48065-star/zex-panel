async function zexApi(p,method='GET',body){
  const t=sessionStorage.getItem('zex_token')||'';
  const attempts=method==='GET'?3:1;let lastErr=null;
  for(let i=0;i<attempts;i++){
    try{
      const r=await fetch(p,{method,headers:Object.assign({'Content-Type':'application/json'},t?{'Authorization':'Bearer '+t}:{}),body:body?JSON.stringify(body):undefined});
      const txt=await r.text();let d;try{d=JSON.parse(txt)}catch(e){d={error:txt}};
      if(r.status===401){try{sessionStorage.removeItem('zex_token');sessionStorage.removeItem('zex_panel_auth_v1')}catch(e){};if(!/login\.html$/.test(location.pathname))location.replace('login.html')}
      if(r.status>=500&&method==='GET'&&i<attempts-1){await new Promise(x=>setTimeout(x,700*(i+1)));continue}
      if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d
    }catch(e){lastErr=e;if(method==='GET'&&i<attempts-1){await new Promise(x=>setTimeout(x,700*(i+1)));continue}throw e}
  }
  throw lastErr||new Error('request failed')
}
function rtTime(ts){if(!ts)return '—';const s=Math.max(0,Math.floor((Date.now()-ts)/1000));const h=Math.floor(s/3600),m=Math.floor((s%3600)/60);return (h?h+'h ':'')+m+'m'}
const zpEsc=s=>String(s==null?'':s).replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
let zexProjectsMap={};let overviewRetries=0;let projectsRetries=0;let runtimeMap={};let runtimePollTimer=null;

function siteUrl(p){return p&&p.kind==='website'?(location.origin+(p.public_url||('/s/'+p.id+'/'))):''}
function fileTextName(name){return /\.(html?|css|js|mjs|cjs|json|py|txt|md|markdown|ya?ml|toml|ini|cfg|conf|env|sh|bash|jsx|tsx?|vue|svelte|sql|xml|svg|csv|log)$/i.test(String(name||''))}
function b64FromBuffer(buf){const bytes=new Uint8Array(buf);let bin='';for(let i=0;i<bytes.length;i+=0x8000)bin+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));return btoa(bin)}
function readFileContent(file){return new Promise((resolve,reject)=>{if(fileTextName(file.name)){const fr=new FileReader();fr.onload=()=>resolve(String(fr.result||''));fr.onerror=()=>reject(new Error('Could not read '+file.name));fr.readAsText(file)}else{const fr=new FileReader();fr.onload=()=>resolve({__zex_b64:b64FromBuffer(fr.result)});fr.onerror=()=>reject(new Error('Could not read '+file.name));fr.readAsArrayBuffer(file)}})}
async function readFilesToMap(files){const out={};let total=0;for(const f of [...(files||[])]){const rel=String(f.webkitRelativePath||f.name||'').replace(/\\/g,'/').replace(/^\/+/,'');if(!rel)continue;const content=await readFileContent(f);out[rel]=content;total+=f.size||0;if(total>20*1024*1024)throw new Error('Files exceed the 20 MB project limit')}return out}

function refreshSidebar(s){
  const count=(s&&s.projects&&s.projects.count)!=null?s.projects.count:liveProjects.length;
  const nc=document.getElementById('navProjectCount');if(nc)nc.textContent=String(count);
  const st=document.getElementById('platformStatusText');const badge=document.getElementById('platformStatusBadge');
  if(s&&st){const active=(s.active||'—').toUpperCase();const sess=s.sessions||{};const a=(sess.a&&sess.a.status)||'—';const b=(sess.b&&sess.b.status)||'—';st.textContent='Session '+active+' · A '+a+' · B '+b;if(badge){badge.textContent='Live';badge.style.color='var(--green)'}}
  else if(st&&!s){st.textContent='Backend check pending…'}
}
function applySettings(settings){
  if(!settings)return;
  const brand=document.getElementById('brandName');const tag=document.getElementById('brandTag');
  if(brand&&settings.name)brand.textContent=String(settings.name).split(' ')[0]||'ZEX';
  if(tag&&settings.name)tag.textContent=String(settings.name).split(' ').slice(1).join(' ')||'PERSONAL PANEL';
  document.documentElement.style.scrollBehavior=settings.reducedMotion?'auto':'';
  if(document.body)document.body.dataset.compact=settings.compact?'1':'';
  const css=[];
  if(settings.reducedMotion)css.push('*{animation:none!important;transition:none!important;scroll-behavior:auto!important}');
  if(settings.compact)css.push('@media(min-width:900px){.content{padding:18px 22px 34px}.page-head{margin-bottom:16px}}');
  let st=document.getElementById('zexPrefsStyle');if(!st){st=document.createElement('style');st.id='zexPrefsStyle';document.head.appendChild(st)}
  st.textContent=css.join('\n');
}
function statById(id,v){const e=document.getElementById(id);if(e)e.textContent=v}
function fillActivity(s){
  const el=document.getElementById('activityLog');if(!el)return;
  const rows=[];
  (s.history||[]).slice(-3).reverse().forEach(h=>rows.push(`<div><span class="time">${zpEsc((h.at?new Date(h.at).toLocaleTimeString():'—'))}</span>　<span class="ok">✓</span> Handover · ${zpEsc(String(h.reason||'sync'))}</div>`));
  (s.log||[]).slice(-3).reverse().forEach(l=>rows.push(`<div><span class="time">—</span>　<span class="ok">✓</span> ${zpEsc(String(l).replace(/^\[[^\]]+\]\s*/, ''))}</div>`));
  el.innerHTML=rows.join('')||'<div><span class="time">—</span>　<span class="ok">✓</span> Backend online</div>';
}

function setMetricBar(id,pct){const el=document.getElementById(id);if(!el)return;const n=Math.max(0,Math.min(100,Number(pct)||0));el.style.width=n+'%';el.className=n>=90?'danger':n>=70?'warn':''}
function workerInfo(){const w=(lastMetrics&&lastMetrics.worker)||(panelStatus&&panelStatus.worker)||null;return w&&w.active?w:null}
function updateSystemHealth(){
  const m=lastMetrics||null;const worker=workerInfo();const kg=!!(worker&&worker.system);
  const sys=(kg?worker.system:null)||(m&&m.system)||(panelStatus&&panelStatus.system)||null;const totals=(m&&m.totals)||{};
  if(!sys)return;
  const ram=sys.memory||{};const disk=sys.disk||{};
  statById('sysCpu',fmtPct(sys.cpuPercent));setMetricBar('sysCpuBar',sys.cpuPercent);
  statById('sysLoad','load '+(sys.loadavg||[]).join(' / ')+' · '+(sys.cpuCount||'—')+' cores');
  statById('sysRam',fmtPct(ram.percent));setMetricBar('sysRamBar',ram.percent);
  statById('sysRamFoot',fmtBytes(ram.usedBytes)+' / '+fmtBytes(ram.totalBytes)+' · '+(kg?'Kaggle session':(ram.source==='container'?'container':'system')));
  statById('sysDisk',fmtPct(disk.percent));setMetricBar('sysDiskBar',disk.percent);
  statById('sysDiskFoot',fmtBytes(disk.usedBytes)+' / '+fmtBytes(disk.totalBytes)+' disk');
  statById('sysUptime',fmtDuration(kg?sys.uptimeMs:sys.panelUptimeMs));
  statById('sysUptimeLabel',kg?'Worker uptime':'Panel uptime');
  statById('sysPanelUptime',kg?('Session '+String(worker.slot||'').toUpperCase()+' · heartbeat '+rtTime(worker.receivedAt)+' ago'):('system up '+fmtDuration(sys.uptimeMs)));
  statById('sysRunning',(totals.running||0)+' running');statById('sysErrors',(totals.errors||0)+' errors');
  statById('sysProjectStorage',fmtBytes(totals.storageBytes||0));statById('sysProjectRam',(totals.memoryMb||0)+' MB');statById('sysCpuCores',(sys.cpuCount||'—')+' cores');
  statById('statProjects',totals.projects!=null?totals.projects:liveProjects.length);
  statById('statRunning',totals.running!=null?totals.running:0);
  statById('statRam',fmtPct(ram.percent));statById('statRamFoot',fmtBytes(ram.usedBytes)+' of '+fmtBytes(ram.totalBytes));
  statById('statStorage',fmtBytes(totals.storageBytes||0));statById('statStorageFoot',kg?'Kaggle code + installed deps':'project code + installed deps');
  statById('statProjectsFoot',(totals.running||0)+' running · '+(totals.errors||0)+' errors');
  statById('sysHealthTitle',kg?'Kaggle worker health':'Panel health');
  if(document.getElementById('sysHealthAt'))statById('sysHealthAt',kg?('KAGGLE '+String(worker.slot||'').toUpperCase()+' · '+new Date(worker.receivedAt).toLocaleTimeString()):(m&&m.at?'UPDATED '+new Date(m.at).toLocaleTimeString():'LIVE METRICS'));
}
function renderMonitoringTable(){
  const el=document.getElementById('monProjectTable');if(!el)return;
  if(!liveProjects.length){el.innerHTML='<div class="empty">No projects yet. Create one from Projects page.</div>';return}
  el.innerHTML=`<div class="table-wrap"><table class="table"><thead><tr><th>Project</th><th>Type</th><th>Status</th><th>CPU</th><th>RAM</th><th>Storage</th><th>Uptime</th><th>Restarts</th><th>Action</th></tr></thead><tbody>${liveProjects.map(p=>{const m=metricsMap[p.id]||{};const live=p.kind!=='website';const st=p.kind==='website'?'static':(m.status||'stopped');const rr={status:st};return `<tr><td><b>${zpEsc(p.name||p.id)}</b><div class="key-note" style="margin:2px 0 0">${zpEsc(p.id)}</div></td><td>${zpEsc(kindLabel(p.kind))}</td><td>${runtimeBadge(rr)}</td><td>${live?fmtPct(m.cpuPercent):'—'}</td><td>${live&&m.memoryMb!=null?m.memoryMb+' MB':'—'}</td><td>${fmtBytes(m.storageBytes!=null?m.storageBytes:projectStorageBytes(p))}</td><td>${m.uptimeMs?rtUptime(m.uptimeMs):'—'}</td><td>${m.restarts||0}</td><td><div class="runtime-actions">${btn('Manage','manage-'+liveProjects.indexOf(p),'btn ghost')}${live?btn('Logs','rt-live-logs:'+p.id,'btn ghost'):''}</div></td></tr>`}).join('')}</tbody></table></div>`;
}
function kgSet(id,v){const e=document.getElementById(id);if(e)e.textContent=v}
function kgPill(id,status){const e=document.getElementById(id);if(!e)return;const st=String(status||'').toLowerCase();e.className='runtime-pill '+(st==='running'?'ok':st==='error'?'err':(st==='queued'||st==='pending'||st==='starting'||st==='restarting'||st==='installing')?'warn':'muted');e.textContent=status||'—'}
function renderKaggleSessions(){
  const s=panelStatus||{};const w=s.worker||(lastMetrics&&lastMetrics.worker)||{};const sessions=s.sessions||{};const active=String(s.active||'a').toLowerCase();const act=sessions[active]||{};const sa=sessions.a||{},sb=sessions.b||{};const wa=w.active||null;
  kgSet('kgAt','LIVE · '+new Date().toLocaleTimeString());kgSet('kgActive',active.toUpperCase());
  kgPill('kgActiveStatus',act.status||'—');
  kgSet('kgActiveMeta','Role '+(act.role||'—')+' · version '+(act.version||'—')+' · started '+(act.startedAt?rtTime(act.startedAt)+' ago':'—'));
  kgSet('kgActiveRemaining',act.remainingMs!=null?fmtDuration(act.remainingMs):'—');
  const wp=wa&&wa.projects?wa.projects:[];kgSet('kgActiveProjects',wa?wp.filter(p=>p.status==='running').length+' / '+wp.length+' running':'—');
  kgSet('kgActiveHeartbeat',wa?(wa.stale?'STALE':'live '+rtTime(wa.receivedAt)+' ago'):'waiting');
  kgPill('kgAStatus',sa.status||'—');kgPill('kgBStatus',sb.status||'—');
  kgSet('kgA',(sa.role||'role')+' · '+(sa.startedAt?rtTime(sa.startedAt)+' ago':'not started')+' · v'+(sa.version||'—'));
  kgSet('kgB',(sb.role||'role')+' · '+(sb.startedAt?rtTime(sb.startedAt)+' ago':'not started')+' · v'+(sb.version||'—'));
  kgSet('kgARemaining',sa.remainingMs!=null?fmtDuration(sa.remainingMs)+' left':'—');
  kgSet('kgBRemaining',sb.remainingMs!=null?fmtDuration(sb.remainingMs)+' left':'—');
  const ws=wa&&wa.system;kgSet('kgWorkerCpu',ws?fmtPct(ws.cpuPercent):'—');
  kgSet('kgWorkerRam',ws&&ws.memory?fmtBytes(ws.memory.usedBytes)+' / '+fmtBytes(ws.memory.totalBytes):'—');
  kgSet('kgWorkerStorage',ws&&ws.disk?fmtBytes(ws.disk.usedBytes)+' / '+fmtBytes(ws.disk.totalBytes):'—');
  kgSet('kgWorkerAt',wa?new Date(wa.receivedAt).toLocaleTimeString()+(wa.stale?' · STALE':''):'—');
  let next='Exactly one Kaggle session runs projects. Next session is prepared before the 12h stop so there is no duplicate bot.';
  if(s.pending&&s.pending.startAt)next='Next '+String(s.pending.slot||'').toUpperCase()+' starts '+new Date(s.pending.startAt).toLocaleString()+' · '+String(s.pending.reason||'handover');
  else if(s.handover&&s.handover.startAt)next='Handover ready: next session starts '+new Date(s.handover.startAt).toLocaleString();
  else if(s.enabled===false)next='Auto-rotation paused. Current Kaggle worker keeps running until its 12h stop.';
  kgSet('kgNext',next);
}
async function loadMetrics(){
  try{const m=await zexApi('/api/metrics');lastMetrics=m;metricsMap={};(m.projects||[]).forEach(x=>{metricsMap[x.id]=x});updateSystemHealth();renderKaggleSessions();const cards=document.getElementById('liveProjectCards');if(cards)cards.innerHTML=projectCards();renderRuntimePanel('liveRuntimePanel');renderRuntimePanel('runtimeLivePanel');if(document.getElementById('monProjectTable'))renderMonitoringTable();if(current==='projects')refreshProjectPage();if(current==='project')refreshProjectDetail();return m}
  catch(e){return null}
}

function fillSessionStats(s){
  statById('statProjects',(s.projects&&s.projects.count)!=null?s.projects.count:liveProjects.length);
  statById('statDeploys',String((s.history||[]).length));
  const sess=s.sessions||{};const active=s.active||'—';
  const running=sess[active]&&sess[active].status;
  statById('statUptime',running?String(running):'IDLE');
  statById('statUptimeFoot',sess[active]?('Session '+String(active).toUpperCase()+' · '+rtTime(sess[active].remainingMs)+' left'):'Kaggle runtime');
  statById('statRequests',Number(s.apiRequests||0).toLocaleString());
  statById('statAdminProjects',(s.projects&&s.projects.count)!=null?s.projects.count:liveProjects.length);
  statById('statAdminFailures',String(s.failures||0));
  fillActivity(s);refreshSidebar(s);
}

async function loadProjects(){
  try{
    const [d,s,rt,mt]=await Promise.all([zexApi('/api/projects'),zexApi('/api/status'),zexApi('/api/runtime').catch(()=>({projects:[]})),zexApi('/api/metrics').catch(()=>({projects:[],totals:{}}))]);
    liveProjects=d.projects||[];panelStatus=s;projectsRetries=0;
    runtimeMap={};(rt.projects||[]).forEach(r=>{runtimeMap[r.id]=r});
    lastMetrics=mt;metricsMap={};(mt.projects||[]).forEach(x=>{metricsMap[x.id]=x});
    zexProjectsMap={};liveProjects.forEach(p=>zexProjectsMap[p.id]=p);
    const el=document.getElementById('zexProjects');
    if(el)el.innerHTML=liveProjects.map(p=>`<div class="switch"><div><b>${zpEsc(p.name||p.id)}</b><div class="key-note" style="margin:4px 0 0">${zpEsc(kindLabel(p.kind))} · ${zpEsc(p.id)} · ${p.kind==='website'?(p.public_url||('/s/'+p.id+'/')):zpEsc(p.start_command||'auto-detect')} · ${Object.keys(p.files||{}).length} file(s)</div></div><div style="display:flex;gap:6px;align-items:center">${p.kind!=='website'?runtimeBadge(runtimeMap[p.id]):'<span class="runtime-pill ok">Static</span>'}${btn('Manage','manage-'+liveProjects.indexOf(p),'btn ghost')}</div></div>`).join('')||'<div class="empty">No projects yet. Create your first project.</div>';
    const cards=document.getElementById('liveProjectCards');if(cards)cards.innerHTML=projectCards();
    renderRuntimePanel('liveRuntimePanel');updateRuntimeBanner();updateSystemHealth();renderKaggleSessions();
    const info=document.getElementById('projectsKaggleInfo');
    if(info&&s){const sa=(s.sessions&&s.sessions.a)||{};const sb=(s.sessions&&s.sessions.b)||{};info.textContent='Kaggle-first runtime · active '+String(s.active||'—').toUpperCase()+' · A v'+(sa.version||'—')+' ('+(sa.status||'—')+') · B v'+(sb.version||'—')+' ('+(sb.status||'—')+') · worker '+(s.worker&&s.worker.active?'live':'waiting')+' · last backup '+(s.lastBackup?new Date(s.lastBackup).toLocaleString():'—')}
    fillSessionStats(s);updateSystemHealth();fillFileSelect();
    if(current==='projects')refreshProjectPage();
    if(current==='project')refreshProjectDetail();
  }catch(e){const el=document.getElementById('zexProjects');if(el)el.innerHTML='<div style="color:var(--amber)">'+zpEsc(e.message)+'</div>';const info=document.getElementById('projectsKaggleInfo');if(info)info.textContent='Backend: '+e.message;if(projectsRetries<5){projectsRetries++;setTimeout(()=>{if(current==='projects'||current==='overview')loadProjects()},4000)}}
}
async function loadProjectDetail(){
  if(!selectedProjectId)return;
  const id=selectedProjectId;
  await loadProjects();
  if(current!=='project'||selectedProjectId!==id)return;
  refreshProjectDetail();
  if(projectTab==='console')await loadProjectConsole();
}
async function loadProjectConsole(){
  const el=document.getElementById('projectConsoleLogs');if(!el||!selectedProjectId)return;
  const st=document.getElementById('projectConsoleStatus');if(st)st.textContent='LOADING…';
  try{
    const d=await zexApi('/api/runtime/logs?id='+encodeURIComponent(selectedProjectId));
    const lines=(d.log||[]).slice(-300);
    el.innerHTML=lines.map(l=>'<div>'+zpEsc(l)+'</div>').join('')||'No logs yet. Worker report ke baad output yahan aayega.';
    if(st)st.textContent='LIVE · '+lines.length+' LINES';
  }catch(e){el.innerHTML='<div style="color:var(--amber)">'+zpEsc(e.message)+'</div>';if(st)st.textContent='ERROR'}
}
async function loadOverview(){try{const s=await zexApi('/api/status');panelStatus=s;overviewRetries=0;try{const k=await zexApi('/api/key');masterKeyValue=k.key||''}catch(e){}fillSessionStats(s);refreshSidebar(s);await loadProjects();await loadLiveRuntime();fillSessionStats(s);updateSystemHealth();renderKaggleSessions();refreshSidebar(s)}catch(e){const st=document.getElementById('platformStatusText');if(st)st.textContent='Backend wake-up · retrying…';if(overviewRetries<5){overviewRetries++;setTimeout(()=>{if(current==='overview')loadOverview()},4000)}else toast('Backend: '+e.message)}}
async function loadConsole(){
  const el=document.getElementById('consoleLogs');if(!el)return;
  if(!liveProjects.length){try{const d=await zexApi('/api/projects');liveProjects=d.projects||[];liveProjects.forEach(p=>zexProjectsMap[p.id]=p)}catch(e){}}
  const sel=document.getElementById('consoleProject');
  if(sel){const prev=sel.value;sel.innerHTML='<option value="">Backend / panel logs</option><option value="session:a">Kaggle Session A · worker logs</option><option value="session:b">Kaggle Session B · worker logs</option>'+liveProjects.map(p=>`<option value="${zpEsc(p.id)}">${zpEsc(p.name||p.id)} · ${zpEsc(kindLabel(p.kind))}</option>`).join('');if(prev&&[...sel.options].some(o=>o.value===prev))sel.value=prev}
  const id=sel?sel.value:'';const p=liveProjects.find(x=>x.id===id);const session=id.startsWith('session:')?id.split(':')[1]:'';
  const note=document.getElementById('consoleNote');
  try{
    let d;
    if(session)d=await zexApi('/api/session/logs?slot='+encodeURIComponent(session));
    else if(id)d=await zexApi('/api/runtime/logs?id='+encodeURIComponent(id));
    else d=await zexApi('/api/logs');
    const lines=(d.log||[]).slice(-300);
    el.innerHTML=lines.map(l=>'<div>'+zpEsc(l)+'</div>').join('')||(id?'No logs yet. Worker report ke baad output yahan aayega.':'No log lines yet.');
    const st=document.getElementById('consoleStatus');if(st)st.innerHTML='<i class="pulse" style="display:inline-block"></i> '+(session?'KAGGLE '+session.toUpperCase():id?'PROJECT':'BACKEND')+' · '+lines.length+' LINES';
    if(note)note.textContent=session?'Kaggle session ka full worker output (kaggle_ctl logs). Refresh dabao for latest.':id?(p&&p.kind==='website'?'Website static hai; iska console nahi hota.':'Live Kaggle project output · auto-refresh nahi, Refresh dabao.'):'Panel backend log. Kaggle session ya project logs ke liye upar se select karo.';
  }catch(e){el.innerHTML='<div style="color:var(--amber)">'+zpEsc(e.message)+'</div>'}
}
async function loadFiles(){
  if(!liveProjects.length){try{const d=await zexApi('/api/projects');liveProjects=d.projects||[];liveProjects.forEach(p=>zexProjectsMap[p.id]=p)}catch(e){toast(e.message)}}
  fillFileSelect();
  const sel=document.getElementById('fmSelect');if(!sel)return;
  const p=liveProjects.find(x=>x.id===sel.value)||liveProjects[0];
  const title=document.getElementById('fmProjectName');const table=document.getElementById('fmTable');const note=document.getElementById('fmNote');
  if(!p){if(title)title.textContent='Project files';if(table)table.innerHTML='<div class="empty">No projects yet. Create one first.</div>';return}
  sel.value=p.id;fmTargetId=p.id;
  if(title)title.textContent='▱　/'+p.id;
  if(note)note.textContent=p.kind==='website'?('Public URL: '+siteUrl(p)+' · uploads are live within 60 seconds.'):('Kaggle worker me live · save ke baad next deploy/handover par auto-restart hoga · '+(p.start_command||'auto-detect pending'));
  const files=Object.entries(p.files||{}).sort((a,b)=>a[0].localeCompare(b[0]));
  if(table)table.innerHTML=files.length?`<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Kind</th><th>Size</th><th>Modified</th></tr></thead><tbody>${files.map(([name,content])=>`<tr><td>${/\.html?$/i.test(name)?'◇':'◇'} ${zpEsc(name)}</td><td>${zpEsc(name.split('.').pop()||'file')}</td><td>${fmtBytes(contentSize(content))}</td><td>—</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No files in this project yet.</div>';
}
function fillFileSelect(){
  const sel=document.getElementById('fmSelect');if(!sel)return;
  const prev=sel.value;
  sel.innerHTML=liveProjects.map(p=>`<option value="${zpEsc(p.id)}">${zpEsc(p.name||p.id)} · ${zpEsc(kindLabel(p.kind))}</option>`).join('')||'<option value="">No projects</option>';
  if(prev&&liveProjects.some(p=>p.id===prev))sel.value=prev;else if(liveProjects[0])sel.value=liveProjects[0].id;
}
async function uploadFilesToProject(id,files){
  const p=zexProjectsMap[id]||liveProjects.find(x=>x.id===id);if(!p)throw new Error('Select a project first');
  const added=await readFilesToMap(files);if(!Object.keys(added).length)throw new Error('No files selected');
  const project=Object.assign({},p,{files:Object.assign({},p.files||{},added)});
  await zexApi('/api/projects','POST',{project});
  toast('Added '+Object.keys(added).length+' file(s) to '+p.id);await loadProjects();await loadFiles();
}

async function loadDeployments(){
  const el=document.getElementById('liveDeployments');if(!el)return;
  try{
    const s=await zexApi('/api/status');panelStatus=s;const sess=s.sessions||{};const rows=[];
    if(s.handover)rows.push(`<div class="switch"><div><b>Next handover: ${zpEsc(String(s.handover.slot||'').toUpperCase())}</b><div class="key-note" style="margin:4px 0 0">starts ${new Date(s.handover.startAt).toLocaleString()} · ${zpEsc(s.handover.reason||'rotation')}</div></div><span class="tag">SCHEDULED</span></div>`);
    (s.history||[]).slice().reverse().forEach(h=>rows.push(`<div class="switch"><div><b>${zpEsc(String(h.reason||'sync'))}</b><div class="key-note" style="margin:4px 0 0">${new Date(h.at).toLocaleString()} · active ${zpEsc(h.active||'—')}</div></div><span class="tag">OK</span></div>`));
    rows.push(`<div class="switch"><div><b>Session A</b><div class="key-note" style="margin:4px 0 0">${zpEsc((sess.a&&sess.a.status)||'—')} · ${zpEsc((sess.a&&sess.a.role)||'—')} · ${rtTime(sess.a&&sess.a.remainingMs)} left</div></div><span class="tag">v${zpEsc(String((sess.a&&sess.a.version)||'—'))}</span></div>`);
    rows.push(`<div class="switch"><div><b>Session B</b><div class="key-note" style="margin:4px 0 0">${zpEsc((sess.b&&sess.b.status)||'—')} · ${zpEsc((sess.b&&sess.b.role)||'—')} · ${rtTime(sess.b&&sess.b.remainingMs)} left</div></div><span class="tag">v${zpEsc(String((sess.b&&sess.b.version)||'—'))}</span></div>`);
    el.innerHTML=rows.join('')||'<div class="empty">No handovers recorded yet.</div>';
    const bi=document.getElementById('deployBackupInfo');if(bi)bi.textContent='Last backup: '+(s.lastBackup?new Date(s.lastBackup).toLocaleString():'—')+' · Last sync: '+(s.lastSync?new Date(s.lastSync).toLocaleString():'—');
    fillSessionStats(s);
  }catch(e){el.innerHTML='<div style="color:var(--amber)">'+zpEsc(e.message)+'</div>'}
}
async function loadBackups(){
  const el=document.getElementById('backupsPanel');if(!el)return;
  try{const d=await zexApi('/api/backups');const rows=[];
    rows.push(`<div class="switch"><div><b>Latest Kaggle backup</b><div class="key-note" style="margin:4px 0 0">${d.lastBackup?new Date(d.lastBackup).toLocaleString():'not written yet'} · ${d.lastSync?'last sync '+new Date(d.lastSync).toLocaleString():'no sync yet'}</div></div><span class="tag">${d.lastBackup?'READY':'PENDING'}</span></div>`);
    (d.history||[]).forEach(h=>rows.push(`<div class="switch"><div><b>${zpEsc(String(h.reason||'handover'))}</b><div class="key-note" style="margin:4px 0 0">${new Date(h.at).toLocaleString()} · active ${zpEsc(h.active||'—')}</div></div><span class="tag">OK</span></div>`));
    el.innerHTML=rows.join('');
  }catch(e){el.innerHTML='<div style="color:var(--amber)">'+zpEsc(e.message)+'</div>'}
}
async function loadMonitoring(){
  try{const [s,m,pd]=await Promise.all([zexApi('/api/status'),zexApi('/api/metrics').catch(()=>null),zexApi('/api/projects').catch(()=>({projects:[]}))]);panelStatus=s;liveProjects=pd.projects||liveProjects;
    if(m){lastMetrics=m;metricsMap={};(m.projects||[]).forEach(x=>{metricsMap[x.id]=x})}
    updateSystemHealth();renderMonitoringTable();
    const el=document.getElementById('monHistory');if(el){const rows=[];(s.log||[]).slice(-14).reverse().forEach(l=>rows.push('<div>'+zpEsc(l)+'</div>'));el.innerHTML=rows.join('')||'No activity yet.'}
    if(document.getElementById('monAt'))statById('monAt',m&&m.at?'UPDATED '+new Date(m.at).toLocaleTimeString():'LIVE');
    fillSessionStats(s);updateSystemHealth();renderKaggleSessions();
  }catch(e){toast('Monitoring: '+e.message)}
}
async function loadApi(){
  try{
    const [k,s]=await Promise.all([zexApi('/api/key'),zexApi('/api/status')]);panelStatus=s;masterKeyValue=k.key||'';
    const mk=document.getElementById('apiMasterKey');if(mk)mk.textContent=masterVisible?(masterKeyValue||'server-side'):'••••••••••••••••';
    const q=document.getElementById('apiQuickStart');if(q)q.textContent='curl -s '+location.origin+'/api/status -H "X-API-Key: '+(masterVisible?masterKeyValue:'YOUR_KEY')+'"';
    const sess=s.sessions||{};const conn=[
      {name:'Kaggle sessions',extra:'A: '+((sess.a&&sess.a.status)||'—')+' · B: '+((sess.b&&sess.b.status)||'—'),value:s.kaggle?'configured server-side':'missing credentials'},
      {name:'Render hosting',extra:'panel: '+(s.render&&s.render.configured?'fallback configured':'live (no fallback)'),value:s.renderKey?'configured server-side':'missing key'},
      {name:'GitHub state',extra:'projects + state persistence',value:s.github?'connected (private repo)':'not configured'}
    ];
    const c=document.getElementById('apiConnections');if(c)c.innerHTML=conn.map((x,i)=>`<div style="display:flex;gap:10px;align-items:center;padding:12px 0;border-bottom:1px solid var(--line)"><div style="flex:1;min-width:0"><b style="font:700 13px Manrope">${zpEsc(x.name)}</b><div style="margin-top:4px;font-size:11px;color:var(--dim)">${zpEsc(x.extra)}</div><code style="display:block;margin-top:6px;font-family:'DM Mono',monospace;font-size:12px;word-break:break-all;color:var(--muted)">${zpEsc(x.value)}</code></div></div>`).join('');
    fillSessionStats(s);
  }catch(e){toast('API: '+e.message)}
}
async function loadSettings(){
  try{const d=await zexApi('/api/settings');const st=d.settings||{};applySettings(st);
    const n=document.getElementById('setName');if(n)n.value=st.name||'';const sl=document.getElementById('setSlug');if(sl)sl.value=st.slug||'';
    const r=document.getElementById('setReduced');if(r)r.checked=!!st.reducedMotion;const c=document.getElementById('setCompact');if(c)c.checked=!!st.compact;
  }catch(e){toast('Settings: '+e.message)}
}
async function saveSettings(){
  const st={name:(document.getElementById('setName')||{}).value||'',slug:(document.getElementById('setSlug')||{}).value||'',reducedMotion:!!(document.getElementById('setReduced')||{}).checked,compact:!!(document.getElementById('setCompact')||{}).checked};
  try{const d=await zexApi('/api/settings','POST',st);applySettings(d.settings);toast('Settings saved');}catch(e){toast('Save failed: '+e.message)}
}
async function loadWebhooks(){
  const el=document.getElementById('webhooksPanel');if(!el)return;
  try{const d=await zexApi('/api/webhooks');const list=d.webhooks||[];
    el.innerHTML=list.length?list.map(w=>`<div class="switch"><div><b>${zpEsc(w.event||'project.saved')}</b><div class="key-note" style="margin:4px 0 0">${zpEsc(w.url)} · ${w.enabled===false?'paused':'enabled'}</div></div>${btn('Delete','webhook-del:'+w.id,'btn ghost')}</div>`).join(''):'<div class="empty">No webhooks configured yet.</div>';
  }catch(e){el.innerHTML='<div style="color:var(--amber)">'+zpEsc(e.message)+'</div>'}
}
function webhookModal(){
  openModal('Add webhook','ZEX sends a JSON POST to this URL when the event fires.',`<div class="field"><label>Event</label><select id="whEvent"><option value="project.saved">project.saved</option><option value="project.deleted">project.deleted</option></select></div><div class="field"><label>Destination URL</label><input id="whUrl" placeholder="https://example.com/hook"></div>`,'Save webhook',async()=>{const url=(document.getElementById('whUrl')||{}).value||'';if(!/^https?:\/\//i.test(url)){toast('Enter a valid http(s) URL');return false}await zexApi('/api/webhooks','POST',{webhook:{event:(document.getElementById('whEvent')||{}).value||'project.saved',url}});toast('Webhook saved');await loadWebhooks()})
}
async function loadAdmin(){
  try{const [s,d]=await Promise.all([zexApi('/api/status'),zexApi('/api/projects')]);panelStatus=s;liveProjects=d.projects||[];
    statById('statAdminProjects',liveProjects.length);statById('statAdminFailures',String(s.failures||0));fillSessionStats(s);
  }catch(e){toast('Admin: '+e.message)}
}

async function loadRuntime(){
  const out=document.getElementById('rtOut');
  try{const [s,rt]=await Promise.all([zexApi('/api/status'),zexApi('/api/runtime').catch(()=>({projects:[]}))]);panelStatus=s;
    runtimeMap={};(rt.projects||[]).forEach(r=>{runtimeMap[r.id]=r});
    const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v};
    set('rtEnabled',s.enabled?(s.syncing?'SYNCING':'ON'):'PAUSED');const sa=s.sessions&&s.sessions.a||{},sb=s.sessions&&s.sessions.b||{};
    set('rtActive',(s.active||'—').toUpperCase());set('rtA',(sa.status||'—')+' · '+rtTime(sa.startedAt));set('rtB',(sb.status||'—')+' · '+rtTime(sb.startedAt));set('rtRoleA',(sa.role||'role')+(s.worker&&s.worker.sessions&&s.worker.sessions.a?' · worker':' · no worker'));set('rtRoleB',(sb.role||'role')+(s.worker&&s.worker.sessions&&s.worker.sessions.b?' · worker':' · no worker'));set('rtProj',(s.projects&&s.projects.count)!=null?s.projects.count:'0');
    renderRuntimePanel('runtimeLivePanel');updateRuntimeBanner();
    if(out)out.innerHTML=(s.log||[]).slice(-40).map(l=>'<div>'+zpEsc(l)+'</div>').join('')||'No log yet.';
    renderKaggleSessions();fillSessionStats(s);
  }catch(e){if(out)out.innerHTML='<div style="color:var(--amber)">Backend not reachable: '+zpEsc(e.message)+'</div>'}
}

function manageProject(p){
  if(!p)return;
  const url=siteUrl(p);const r=runtimeMap[p.id]||{status:'stopped',autoStart:p.auto_start!==false};const m=metricsMap[p.id]||{};
  const live=p.kind!=='website';const mode=(panelStatus&&panelStatus.runtimeMode)||'kaggle';const isKg=r.source==='kaggle'||mode==='kaggle';
  const controls=live?`<div class="runtime-actions">${isKg?'':btn('Start','rt-live-start:'+p.id,'btn')+btn('Stop','rt-live-stop:'+p.id,'btn ghost')+btn('Restart','rt-live-restart:'+p.id,'btn ghost')}${btn('Console','rt-live-logs:'+p.id,'btn ghost')}</div>`:'';
  openModal(p.name||p.id,'Project details',`<div class="switch">Type <span class="tag">${zpEsc(kindLabel(p.kind))}</span></div><div class="switch">ID <span class="tag">${zpEsc(p.id)}</span></div><div class="switch">Runtime <span class="tag">${p.kind==='website'?'Panel static hosting':zpEsc(p.start_command||'auto-detect')}</span></div><div class="switch">Live status ${runtimeBadge({status:p.kind==='website'?'static':(m.status||r.status)})}</div><div class="switch">Auto-start <span class="tag">${p.auto_start!==false?'ON':'OFF'}</span></div><div class="switch">Files <span class="tag">${Object.keys(p.files||{}).length}</span></div><div class="switch">CPU <span class="tag">${live?fmtPct(m.cpuPercent):'—'}</span></div><div class="switch">RAM <span class="tag">${live&&m.memoryMb!=null?m.memoryMb+' MB':'—'}</span></div><div class="switch">Storage <span class="tag">${fmtBytes(m.storageBytes!=null?m.storageBytes:projectStorageBytes(p))}${m.codeBytes!=null?' · code '+fmtBytes(m.codeBytes):''}${m.depsBytes!=null?' · deps '+fmtBytes(m.depsBytes):''}</span></div><div class="switch">Uptime <span class="tag">${m.uptimeMs?rtUptime(m.uptimeMs):'—'}</span></div>${url?`<div class="switch">Public URL <a href="${zpEsc(url)}" target="_blank" rel="noopener" style="color:var(--blue)">${zpEsc(url)}</a></div>`:''}${r.error?`<div class="runtime-inline-error">${zpEsc(r.error)}</div>`:''}<p class="key-note">${p.kind==='website'?'Website files are served immediately.':'Bot/worker active Kaggle session me live chalta hai. Start/stop controls sirf Render fallback ke liye hain; Kaggle mode me worker auto-start hota hai.'}</p>${controls}<div style="display:flex;gap:8px;margin-top:14px">${btn('Edit','zex-edit:'+p.id,'btn')}${btn('Delete','zex-del:'+p.id,'btn danger')}</div>`,'Close',()=>{})
}
function rtUptime(ms){const s=Math.max(0,Math.floor(Number(ms||0)/1000));const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),x=s%60;return h?h+'h '+m+'m':m?m+'m '+x+'s':x+'s'}
function runtimeBadge(r){const st=(r&&r.status)||'stopped';const cls=st==='running'?'ok':st==='error'?'err':(st==='restarting'||st==='installing'||st==='starting')?'warn':'muted';return `<span class="runtime-pill ${cls}">${RUNTIME_STATUS_LABEL[st]||st}</span>`}
function renderRuntimePanel(containerId){
  const el=document.getElementById(containerId);if(!el)return;
  const items=liveProjects.filter(p=>p.kind!=='website');const mode=(panelStatus&&panelStatus.runtimeMode)||'kaggle';
  if(!items.length){el.innerHTML=`<div class="card panel"><div class="panel-title"><h3>Live runtime</h3><span>${mode==='kaggle'?'KAGGLE':'RENDER'}</span></div><div class="empty">Abhi koi bot/worker nahi hai. New project banakar Telegram/Discord bot add karein.</div></div>`;return}
  el.innerHTML=`<div class="card panel"><div class="panel-title"><h3>Live runtime</h3><span>${mode==='kaggle'?'KAGGLE · ACTIVE SESSION':'RENDER · AUTO-RESTART'}</span></div>${items.map(p=>{const r=runtimeMap[p.id]||{status:'stopped',restarts:0,autoStart:p.auto_start!==false};const m=metricsMap[p.id]||{};const mem=m.memoryMb!=null?m.memoryMb:r.memoryMb;const isKg=r.source==='kaggle'||mode==='kaggle';const src=p.kind==='website'?'Panel':isKg?('Kaggle '+String(r.slot||'A').toUpperCase()):'Render';return `<div class="runtime-row"><div class="runtime-main"><div class="runtime-name">${zpEsc(p.name||p.id)} ${runtimeBadge(r)} <span class="tag">${zpEsc(src)}</span></div><div class="runtime-sub">${zpEsc(kindLabel(p.kind))} · ${r.uptimeMs?rtUptime(r.uptimeMs)+' uptime':'not running'}${m.cpuPercent!=null?' · CPU '+fmtPct(m.cpuPercent):''}${mem!=null?' · '+mem+' MB':''}${m.storageBytes!=null?' · '+fmtBytes(m.storageBytes):''} · ${r.restarts||0} restart(s) · ${r.autoStart?'auto-start ON':'auto-start OFF'}</div>${r.error?`<div class="runtime-inline-error">${zpEsc(r.error)}</div>`:''}</div><div class="runtime-actions">${isKg?'':btn('Start','rt-live-start:'+p.id,'btn')+btn('Stop','rt-live-stop:'+p.id,'btn ghost')+btn('Restart','rt-live-restart:'+p.id,'btn ghost')}${btn('Console','rt-live-logs:'+p.id,'btn ghost')}</div></div>`}).join('')}<p class="key-note">${mode==='kaggle'?'Active Kaggle worker hi bot chalata hai. Start/stop Render runtime ko control karta hai, isliye Kaggle mode me hide hai. Session rotate hone par worker apne aap restart hota hai.':'Stop karne par auto-start OFF hota hai. Start karne par dobara ON. Crash hone par 5 baar tak khud restart hota hai; phir error banner dikhta hai.'}</p></div>`;
}
function updateRuntimeBanner(){
  const el=document.getElementById('runtimeBanner');if(!el)return;
  const bad=Object.values(runtimeMap).filter(r=>r.status==='error'||r.status==='restarting');
  if(!bad.length){el.hidden=true;el.innerHTML='';return}
  const first=bad[0];const isErr=first.status==='error';
  el.hidden=false;el.className='runtime-banner '+(isErr?'error':'warn');
  el.innerHTML=`<div><b>${isErr?'Bot error':'Bot restarting'}:</b> ${zpEsc(first.name||first.id)} — ${zpEsc(first.error||first.status)}${bad.length>1?' · +'+(bad.length-1)+' more':''}</div><div class="runtime-actions">${btn('Open logs','rt-live-logs:'+first.id,'btn')}${isErr?btn('Restart','rt-live-restart:'+first.id,'btn ghost'):''}</div>`;
}
async function loadLiveRuntime(){
  try{const d=await zexApi('/api/runtime');runtimeMap={};(d.projects||[]).forEach(r=>{runtimeMap[r.id]=r});renderRuntimePanel('liveRuntimePanel');renderRuntimePanel('runtimeLivePanel');updateRuntimeBanner();const cards=document.getElementById('liveProjectCards');if(cards)cards.innerHTML=projectCards();const el=document.getElementById('zexProjects');if(el&&current==='projects'&&!document.getElementById('modalBackdrop').classList.contains('show')){el.innerHTML=liveProjects.map(p=>`<div class="switch"><div><b>${zpEsc(p.name||p.id)}</b><div class="key-note" style="margin:4px 0 0">${zpEsc(kindLabel(p.kind))} · ${zpEsc(p.id)} · ${p.kind==='website'?(p.public_url||('/s/'+p.id+'/')):zpEsc(p.start_command||'auto-detect')} · ${Object.keys(p.files||{}).length} file(s)</div></div><div style="display:flex;gap:6px;align-items:center">${p.kind!=='website'?runtimeBadge(runtimeMap[p.id]):'<span class="runtime-pill ok">Static</span>'}${btn('Manage','manage-'+liveProjects.indexOf(p),'btn ghost')}</div></div>`).join('')||'<div class="empty">No projects yet. Create your first project.</div>'}
    await loadMetrics();
    if(current==='projects')refreshProjectPage();
    if(current==='project'){refreshProjectDetail();if(projectTab==='console')loadProjectConsole()}
  }catch(e){/* keep last known state */}
}
async function runtimeAction(id,action){
  const labels={start:'Starting',stop:'Stopping',restart:'Restarting'};toast((labels[action]||'Working')+'…');
  try{await zexApi('/api/runtime/'+action,'POST',{id});toast(action==='stop'?'Stopped · auto-start OFF':action==='start'?'Started':'Restarted');await loadLiveRuntime();await loadProjects()}catch(e){toast('Runtime: '+e.message);await loadLiveRuntime()}
}
async function showRuntimeLogs(id){
  try{const d=await zexApi('/api/runtime/logs?id='+encodeURIComponent(id));const p=zexProjectsMap[id]||liveProjects.find(x=>x.id===id)||{};const lines=(d.log||[]).slice(-300);openModal('Logs · '+(p.name||id),'Live project output · Kaggle worker',`<div class="logs" style="max-height:380px;overflow:auto">${lines.map(l=>'<div>'+zpEsc(l)+'</div>').join('')||'No logs yet. Start the project.'}</div>`,'Close',()=>{})}catch(e){toast('Logs: '+e.message)}
}

function projectModal(project){
  const editing=!!(project&&project.id);
  const p=project||{};
  const data={step:(project&&project.kind)?2:1,kind:p.kind||'',name:p.name||'',id:p.id||'',start_command:p.start_command||'',auto_start:p.auto_start!==false,files:Object.assign({},p.files||{}),env:Object.assign({},p.env||{}),token:'',touchedId:!!p.id};
  const body=$('#modalBody');
  openModal(editing?'Edit project':'New project','Choose a category, fill only what is needed, then review and finish.','<div class="empty">Loading…</div>','Continue',()=>{});
  body.onclick=e=>{
    const card=e.target.closest('[data-wiz-kind]');if(card){data.kind=card.dataset.wizKind;data.step=2;renderStep();return}
    const back=e.target.closest('[data-wiz-back]');if(back){data.step=Math.max(1,data.step-1);renderStep()}
  };
  function setSave(label,show){const b=$('#modalSave');b.style.display=show===false?'none':'';b.textContent=label;b.disabled=false}
  function collectStep2(){
    const get=id=>{const el=document.getElementById(id);return el?el.value:null};
    if(get('wzName')!=null)data.name=get('wzName').trim();
    if(get('wzId')!=null)data.id=slugify(get('wzId'));
    if(get('wzCmd')!=null)data.start_command=get('wzCmd').trim();
    const auto=document.getElementById('wzAuto');if(auto)data.auto_start=!!auto.checked;
    const tok=document.getElementById('wzToken');if(tok)data.token=tok.value.trim();
    const envEl=document.getElementById('wzEnv');if(envEl){const env={};envEl.value.split(/\r?\n/).forEach(line=>{const m=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);if(m)env[m[1]]=m[2]});data.env=env}
    const fname=document.getElementById('wzFileName');const code=document.getElementById('wzCode');if(fname&&code&&fname.value.trim()&&code.value){data.files[fname.value.trim().replace(/^\/+/,'')]=code.value}
  }
  function validate(){
    if(!data.name.trim())return 'Project name likho';
    if(!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(data.id))return 'Project ID lowercase slug hona chahiye (2-64 chars)';
    if(data.kind==='website'&&!Object.keys(data.files).some(n=>/\.html?$/i.test(n)))return 'Website ke liye index.html upload karo';
    if(data.kind!=='website'&&!Object.keys(data.files).length&&!data.start_command)return 'Files upload karo ya start command do';
    return '';
  }
  function kindCard(k){const m=kindMeta(k);return `<button type="button" class="kind-card${data.kind===k?' active':''}" data-wiz-kind="${k}"><span class="kind-icon">${m.icon}</span><span class="kind-copy"><b>${m.title}</b><small>${m.short}</small><span>${m.desc}</span></span><span class="kind-arrow">→</span></button>`}
  function renderStep(){
    if(data.step===1){
      setSave('Continue',false);
      body.innerHTML=`<div class="wizard-step"><div class="wizard-progress"><span class="on"></span><span></span><span></span></div><div class="wizard-kicker">STEP 1 OF 3</div><h3 class="wizard-title">Kya host karna hai?</h3><p class="key-note">Category chuno — sirf usi category ke fields aage aayenge.</p><div class="wizard-cards">${KIND_ORDER.map(kindCard).join('')}</div><p class="key-note">Website turant live hoti hai. Bots aur workers active Kaggle session me auto-start hote hain.</p></div>`;
      return;
    }
    if(data.step===2){
      collectStep2();const m=kindMeta(data.kind);const isWeb=data.kind==='website';const bot=data.kind==='telegram_bot'||data.kind==='discord_bot';const existing=Object.keys(data.files||{}).length;const tokenSet=!!(data.env.BOT_TOKEN||data.env.TELEGRAM_BOT_TOKEN||data.env.DISCORD_TOKEN);const envText=Object.entries(data.env||{}).map(([k,v])=>k+'='+v).join('\n');
      const tokenBlock=bot?`<div class="field"><label>${data.kind==='telegram_bot'?'Telegram bot token':'Discord bot token'}${tokenSet?' · already saved':''}</label><input id="wzToken" type="password" autocomplete="off" placeholder="${tokenSet?'Naya token paste karo to replace hoga':'Token paste karo (optional)'}"><p class="key-note">${zpEsc(KIND_TOKEN_HELP[data.kind]||'')}</p></div>`:'';
      const pasteLabel=isWeb?'index.html paste karo (optional)':'Ek file paste karo (optional)';
      body.innerHTML=`<div class="wizard-step"><div class="wizard-progress"><span class="on"></span><span class="on"></span><span></span></div><div class="wizard-kicker">STEP 2 OF 3</div><div class="wizard-kind-head"><span class="kind-icon">${m.icon}</span><div><h3 class="wizard-title">${m.title}</h3><p class="key-note">${m.desc}</p></div><button type="button" class="btn ghost" data-wiz-back>← Back</button></div><div class="wizard-grid"><div class="field"><label>Project name</label><input id="wzName" value="${zpEsc(data.name)}" placeholder="My project"></div><div class="field"><label>Project ID</label><input id="wzId" value="${zpEsc(data.id)}" placeholder="my-project"${editing?' readonly':''}></div></div><div class="field"><label>Files</label><div class="upload-row"><label class="btn upload-btn">＋ Files<input id="wzFiles" type="file" multiple hidden></label><label class="btn ghost upload-btn">▱ Folder<input id="wzFolder" type="file" webkitdirectory directory multiple hidden></label><span class="key-note">${existing?existing+' file(s) already saved':'No files yet'}</span></div><p class="key-note">${isWeb?'index.html root me rakho; CSS/JS/images bhi upload kar sakte ho.':'Requirements.txt / package.json bhi upload karo to dependencies install hongi.'}</p></div><div class="wizard-grid"><div class="field"><label>${pasteLabel}</label><input id="wzFileName" placeholder="${isWeb?'index.html':'bot.py / main.js'}"></div><div class="field"><label>File content</label><textarea id="wzCode" style="min-height:82px" placeholder="Paste code here"></textarea></div></div>${tokenBlock}<div class="field"><label>Environment variables (optional)</label><textarea id="wzEnv" style="min-height:72px" placeholder="KEY=value&#10;OWNER_ID=123456789">${zpEsc(envText)}</textarea></div><div class="wizard-grid"><div class="field"><label>Start command (blank = auto-detect)</label><input id="wzCmd" value="${zpEsc(data.start_command)}" placeholder="Auto-detect: ${zpEsc(detectStartCommandFromFiles(data.kind,data.files)||'python3 -u main.py')}"></div><label class="switch" style="margin-top:22px">Auto-start in Kaggle <input id="wzAuto" type="checkbox" ${data.auto_start?'checked':''}></label></div><p class="key-note">Sirf apni category ke fields dikh rahe hain. Next dabao review ke liye.</p></div>`;
      setSave('Review');$('#modalSave').onclick=()=>{collectStep2();const err=validate();if(err){toast(err);return}data.step=3;renderStep()};
      const nameEl=document.getElementById('wzName');const idEl=document.getElementById('wzId');
      if(nameEl&&idEl){nameEl.oninput=()=>{if(!data.touchedId)idEl.value=slugify(nameEl.value)};idEl.oninput=()=>{data.touchedId=!!idEl.value}}
      const bindUpload=input=>{if(!input)return;input.onchange=async e=>{try{collectStep2();const added=await readFilesToMap(e.target.files);const n=Object.keys(added).length;if(!n)return;Object.assign(data.files,added);toast('Added '+n+' file(s)');renderStep()}catch(err){toast(err.message)}}};
      bindUpload(document.getElementById('wzFiles'));bindUpload(document.getElementById('wzFolder'));
      return;
    }
    const m=kindMeta(data.kind);const files=Object.keys(data.files||{}).sort();const total=files.reduce((a,f)=>a+contentSize(data.files[f]),0);const tokenSet=!!(data.token||data.env.BOT_TOKEN||data.env.TELEGRAM_BOT_TOKEN||data.env.DISCORD_TOKEN);const envKeys=Object.keys(data.env||{});const warn=[];
    if(data.kind==='website'&&!files.some(f=>/\.html?$/i.test(f)))warn.push('index.html nahi mila — website blank khul sakti hai.');
    if((data.kind==='telegram_bot'||data.kind==='discord_bot')&&!tokenSet)warn.push('Token nahi diya — agar code me hardcoded hai to chalega, warna bot start nahi hoga.');
    if(!files.length)warn.push('Koi file upload nahi hui.');
    body.innerHTML=`<div class="wizard-step"><div class="wizard-progress"><span class="on"></span><span class="on"></span><span class="on"></span></div><div class="wizard-kicker">STEP 3 OF 3</div><h3 class="wizard-title">Review & finish</h3><p class="key-note">Sab sahi lag raha hai? Create dabao — project save hoke active Kaggle session me start hoga.</p><div class="review-card"><div class="review-row"><span>Category</span><b>${m.icon} ${m.title}</b></div><div class="review-row"><span>Name</span><b>${zpEsc(data.name)}</b></div><div class="review-row"><span>ID</span><b>${zpEsc(data.id)}</b></div><div class="review-row"><span>Start command</span><b>${data.kind==='website'?'Static site':zpEsc(data.start_command||detectStartCommandFromFiles(data.kind,data.files)||'Auto-detect')}</b></div><div class="review-row"><span>Auto-start</span><b>${data.kind==='website'?'Always on':(data.auto_start?'ON':'OFF')}</b></div><div class="review-row"><span>Environment</span><b>${envKeys.length?envKeys.length+' key(s)':(tokenSet?'token saved':'none')}</b></div><div class="review-row"><span>Files</span><b>${files.length} file(s) · ${fmtBytes(total)}</b></div></div><div class="review-files">${files.slice(0,8).map(f=>`<div><span>${zpEsc(f)}</span><span>${fmtBytes(contentSize(data.files[f]))}</span></div>`).join('')||'<div>No files</div>'}${files.length>8?`<div><span>+${files.length-8} more</span><span></span></div>`:''}</div>${warn.length?`<div class="wizard-warn">${warn.map(w=>`<div>⚠ ${zpEsc(w)}</div>`).join('')}</div>`:''}<div class="wizard-actions"><button type="button" class="btn ghost" data-wiz-back>← Back</button></div></div>`;
    setSave(editing?'Save changes':'Create & start');$('#modalSave').onclick=save;
  }
  async function save(){
    const btnEl=$('#modalSave');btnEl.disabled=true;btnEl.textContent='Saving…';
    try{
      const env=Object.assign({},data.env||{});
      if(data.token){if(data.kind==='telegram_bot'){env.TELEGRAM_BOT_TOKEN=data.token;env.BOT_TOKEN=data.token}else if(data.kind==='discord_bot'){env.DISCORD_TOKEN=data.token;env.BOT_TOKEN=data.token}else env.BOT_TOKEN=data.token}
      const out=Object.assign({},p,{id:data.id,name:data.name.trim(),kind:data.kind,start_command:data.kind==='website'?'':data.start_command.trim(),files:data.files,env,enabled:true,auto_start:data.kind==='website'?true:data.auto_start});
      const r=await zexApi('/api/projects','POST',{project:out});
      toast(r.public_url?('Saved · live at '+location.origin+r.public_url):'Saved · Kaggle worker me start ho raha hai');
      await loadProjects();await loadLiveRuntime();
      if(current==='files')await loadFiles();
      if(current==='overview')await loadOverview();
      if(current==='monitoring')await loadMonitoring();
      showProjectReady(r.project||out,r.public_url);
    }catch(e){toast('Save failed: '+e.message);btnEl.disabled=false;btnEl.textContent=editing?'Save changes':'Create & start'}
  }
  function showProjectReady(proj,publicUrl){
    const isWeb=proj.kind==='website';const link=isWeb?(publicUrl?location.origin+publicUrl:siteUrl(proj)):'';
    const body=`<div class="ready-icon">✓</div><div class="review-row"><span>Project</span><b>${zpEsc(proj.name||proj.id)}</b></div><div class="review-row"><span>Type</span><b>${zpEsc(kindLabel(proj.kind))}</b></div><div class="review-row"><span>Status</span><b>${isWeb?'Live website':'Saved · Kaggle auto-start'}</b></div>${link?`<div class="review-row"><span>Link</span><a href="${zpEsc(link)}" target="_blank" rel="noopener">${zpEsc(link)}</a></div>`:''}<p class="key-note">${isWeb?'Website turant serve ho rahi hai.':'Bot/worker save ho gaya. Active Kaggle worker ke next deploy/handover par khud start hoga; Console page se logs dekho.'}</p>${link?`<div style="margin-top:12px"><a class="btn" href="${zpEsc(link)}" target="_blank" rel="noopener">Open site</a></div>`:''}`;
    $('#modalSave').disabled=false;$('#modalSave').textContent='Done';
    openModal('Project ready',isWeb?'Website live hai.':'Project save ho gaya.',body,'Done',()=>{if(current!=='projects'){current='projects';render()}else{loadProjects();loadLiveRuntime()}});
  }
  renderStep();
}
