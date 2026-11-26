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
    const [d,s,rt]=await Promise.all([zexApi('/api/projects'),zexApi('/api/status'),zexApi('/api/runtime').catch(()=>({projects:[]}))]);
    liveProjects=d.projects||[];panelStatus=s;projectsRetries=0;
    runtimeMap={};(rt.projects||[]).forEach(r=>{runtimeMap[r.id]=r});
    zexProjectsMap={};liveProjects.forEach(p=>zexProjectsMap[p.id]=p);
    const el=document.getElementById('zexProjects');
    if(el)el.innerHTML=liveProjects.map(p=>`<div class="switch"><div><b>${zpEsc(p.name||p.id)}</b><div class="key-note" style="margin:4px 0 0">${zpEsc(kindLabel(p.kind))} · ${zpEsc(p.id)} · ${p.kind==='website'?(p.public_url||('/s/'+p.id+'/')):zpEsc(p.start_command||'auto-detect')} · ${Object.keys(p.files||{}).length} file(s)</div></div><div style="display:flex;gap:6px;align-items:center">${p.kind!=='website'?runtimeBadge(runtimeMap[p.id]):'<span class="runtime-pill ok">Static</span>'}${btn('Manage','manage-'+liveProjects.indexOf(p),'btn ghost')}</div></div>`).join('')||'<div class="empty">No projects yet. Create your first project.</div>';
    const cards=document.getElementById('liveProjectCards');if(cards)cards.innerHTML=projectCards();
    renderRuntimePanel('liveRuntimePanel');
    updateRuntimeBanner();
    const info=document.getElementById('projectsKaggleInfo');
    if(info&&s){const sa=(s.sessions&&s.sessions.a)||{};const sb=(s.sessions&&s.sessions.b)||{};info.textContent='Render live runtime · Kaggle backup A v'+(sa.version||'—')+' ('+(sa.status||'—')+') · B v'+(sb.version||'—')+' ('+(sb.status||'—')+') · last backup '+(s.lastBackup?new Date(s.lastBackup).toLocaleString():'—')}
    fillSessionStats(s);
    fillFileSelect();
  }catch(e){const el=document.getElementById('zexProjects');if(el)el.innerHTML='<div style="color:var(--amber)">'+zpEsc(e.message)+'</div>';const info=document.getElementById('projectsKaggleInfo');if(info)info.textContent='Backend: '+e.message;if(projectsRetries<5){projectsRetries++;setTimeout(()=>{if(current==='projects'||current==='overview')loadProjects()},4000)}}
}
async function loadOverview(){try{const s=await zexApi('/api/status');panelStatus=s;overviewRetries=0;try{const k=await zexApi('/api/key');masterKeyValue=k.key||''}catch(e){}fillSessionStats(s);refreshSidebar(s);await loadProjects();await loadLiveRuntime();fillSessionStats(s);refreshSidebar(s)}catch(e){const st=document.getElementById('platformStatusText');if(st)st.textContent='Backend wake-up · retrying…';if(overviewRetries<5){overviewRetries++;setTimeout(()=>{if(current==='overview')loadOverview()},4000)}else toast('Backend: '+e.message)}}

async function loadConsole(){
  const el=document.getElementById('consoleLogs');if(!el)return;
  try{const d=await zexApi('/api/logs');const lines=d.log||[];el.innerHTML=lines.slice(-120).map(l=>'<div>'+zpEsc(l)+'</div>').join('')||'No log lines yet.';const st=document.getElementById('consoleStatus');if(st)st.innerHTML='<i class="pulse" style="display:inline-block"></i> LIVE · '+lines.length+' LINES'}catch(e){el.innerHTML='<div style="color:var(--amber)">'+zpEsc(e.message)+'</div>'}
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
  if(note)note.textContent=p.kind==='website'?('Public URL: '+siteUrl(p)+' · uploads are live within 60 seconds.'):('Render par live · save ke baad bot auto-restart hoga · '+(p.start_command||'auto-detect pending'));
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
  try{const s=await zexApi('/api/status');panelStatus=s;const sess=s.sessions||{};const a=sess[s.active]||{};
    statById('monActive',String(s.active||'—').toUpperCase());statById('monActiveFoot',(a.status||'—')+' · '+(a.role||'—'));
    statById('monRemaining',rtTime(a.remainingMs));statById('monProjects',(s.projects&&s.projects.count)!=null?s.projects.count:0);statById('monRequests',Number(s.apiRequests||0).toLocaleString());
    const el=document.getElementById('monHistory');if(el){const rows=[];(s.log||[]).slice(-12).reverse().forEach(l=>rows.push('<div>'+zpEsc(l)+'</div>'));el.innerHTML=rows.join('')||'No activity yet.'}
    fillSessionStats(s);
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
    set('rtActive',(s.active||'—').toUpperCase());set('rtA',(sa.status||'—')+' · '+rtTime(sa.startedAt));set('rtB',(sb.status||'—')+' · '+rtTime(sb.startedAt));set('rtRoleA',sa.role||'role');set('rtRoleB',sb.role||'role');set('rtProj',(s.projects&&s.projects.count)!=null?s.projects.count:'0');
    renderRuntimePanel('runtimeLivePanel');updateRuntimeBanner();
    if(out)out.innerHTML=(s.log||[]).slice(-40).map(l=>'<div>'+zpEsc(l)+'</div>').join('')||'No log yet.';
    fillSessionStats(s);
  }catch(e){if(out)out.innerHTML='<div style="color:var(--amber)">Backend not reachable: '+zpEsc(e.message)+'</div>'}
}

function manageProject(p){
  if(!p)return;
  const url=siteUrl(p);const r=runtimeMap[p.id]||{status:'stopped',autoStart:p.auto_start!==false};
  const live=p.kind!=='website';
  const controls=live?`<div class="runtime-actions">${btn('Start','rt-live-start:'+p.id,'btn')}${btn('Stop','rt-live-stop:'+p.id,'btn ghost')}${btn('Restart','rt-live-restart:'+p.id,'btn ghost')}${btn('Logs','rt-live-logs:'+p.id,'btn ghost')}</div>`:'';
  openModal(p.name||p.id,'Project details',`<div class="switch">Type <span class="tag">${zpEsc(kindLabel(p.kind))}</span></div><div class="switch">ID <span class="tag">${zpEsc(p.id)}</span></div><div class="switch">Runtime <span class="tag">${p.kind==='website'?'Panel static hosting':zpEsc(p.start_command||'auto-detect')}</span></div><div class="switch">Live status ${runtimeBadge(r)}</div><div class="switch">Auto-start <span class="tag">${p.auto_start!==false?'ON':'OFF'}</span></div><div class="switch">Files <span class="tag">${Object.keys(p.files||{}).length}</span></div>${url?`<div class="switch">Public URL <a href="${zpEsc(url)}" target="_blank" rel="noopener" style="color:var(--blue)">${zpEsc(url)}</a></div>`:''}${r.error?`<div class="runtime-inline-error">${zpEsc(r.error)}</div>`:''}<p class="key-note">${p.kind==='website'?'Website files are served immediately.':'Bot/worker Render par live chalta hai. Stop karne par auto-start OFF ho jata hai; Start karne par wapas ON.'}</p>${controls}<div style="display:flex;gap:8px;margin-top:14px">${btn('Edit','zex-edit:'+p.id,'btn')}${btn('Delete','zex-del:'+p.id,'btn danger')}</div>`,'Close',()=>{})
}

function rtUptime(ms){const s=Math.max(0,Math.floor(Number(ms||0)/1000));const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),x=s%60;return h?h+'h '+m+'m':m?m+'m '+x+'s':x+'s'}
function runtimeBadge(r){const st=(r&&r.status)||'stopped';const cls=st==='running'?'ok':st==='error'?'err':(st==='restarting'||st==='installing'||st==='starting')?'warn':'muted';return `<span class="runtime-pill ${cls}">${RUNTIME_STATUS_LABEL[st]||st}</span>`}
function renderRuntimePanel(containerId){
  const el=document.getElementById(containerId);if(!el)return;
  const items=liveProjects.filter(p=>p.kind!=='website');
  if(!items.length){el.innerHTML='<div class="card panel"><div class="panel-title"><h3>Live runtime</h3><span>RENDER</span></div><div class="empty">Abhi koi bot/worker nahi hai. New project banakar Telegram/Discord bot add karein.</div></div>';return}
  el.innerHTML=`<div class="card panel"><div class="panel-title"><h3>Live runtime</h3><span>RENDER · AUTO-RESTART</span></div>${items.map(p=>{const r=runtimeMap[p.id]||{status:'stopped',restarts:0,autoStart:p.auto_start!==false};return `<div class="runtime-row"><div class="runtime-main"><div class="runtime-name">${zpEsc(p.name||p.id)} ${runtimeBadge(r)}</div><div class="runtime-sub">${zpEsc(kindLabel(p.kind))} · ${r.uptimeMs?rtUptime(r.uptimeMs)+' uptime':'not running'}${r.memoryMb?' · '+r.memoryMb+' MB':''} · ${r.restarts||0} restart(s) · ${r.autoStart?'auto-start ON':'auto-start OFF'}</div>${r.error?`<div class="runtime-inline-error">${zpEsc(r.error)}</div>`:''}</div><div class="runtime-actions">${btn('Start','rt-live-start:'+p.id,'btn')}${btn('Stop','rt-live-stop:'+p.id,'btn ghost')}${btn('Restart','rt-live-restart:'+p.id,'btn ghost')}${btn('Logs','rt-live-logs:'+p.id,'btn ghost')}</div></div>`}).join('')}<p class="key-note">Stop karne par auto-start OFF hota hai. Start karne par dobara ON. Crash hone par 5 baar tak khud restart hota hai; phir error banner dikhta hai.</p></div>`;
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
  }catch(e){/* keep last known state */}
}
async function runtimeAction(id,action){
  const labels={start:'Starting',stop:'Stopping',restart:'Restarting'};toast((labels[action]||'Working')+'…');
  try{await zexApi('/api/runtime/'+action,'POST',{id});toast(action==='stop'?'Stopped · auto-start OFF':action==='start'?'Started':'Restarted');await loadLiveRuntime();await loadProjects()}catch(e){toast('Runtime: '+e.message);await loadLiveRuntime()}
}
async function showRuntimeLogs(id){
  try{const d=await zexApi('/api/runtime/logs?id='+encodeURIComponent(id));const p=zexProjectsMap[id]||liveProjects.find(x=>x.id===id)||{};const lines=(d.log||[]).slice(-300);openModal('Logs · '+(p.name||id),'Live Render process output',`<div class="logs" style="max-height:380px;overflow:auto">${lines.map(l=>'<div>'+zpEsc(l)+'</div>').join('')||'No logs yet. Start the project.'}</div>`,'Close',()=>{})}catch(e){toast('Logs: '+e.message)}
}

function projectModal(project){
  const p=project||{name:'',id:'',kind:'worker',start_command:'',requirements:'',env:{},files:{}};
  const existing=Object.keys(p.files||{}).length;
  const kindOpts=['website','discord_bot','telegram_bot','api','worker'].map(k=>`<option value="${k}"${(p.kind||'worker')===k?' selected':''}>${KIND_LABELS[k]}</option>`).join('');
  const isBot=(p.kind==='telegram_bot'||p.kind==='discord_bot');
  const tokenHelp=KIND_TOKEN_HELP[p.kind||'']||'';
  const body=`<div class="field"><label>Project name</label><input id="zpName" value="${zpEsc(p.name||'')}" placeholder="My project"></div><div class="field"><label>Project ID</label><input id="zpId" value="${zpEsc(p.id||'')}" placeholder="my-project"${project?' readonly':''}></div><div class="field"><label>What do you want to host?</label><select id="zpKind">${kindOpts}</select></div><p class="key-note" id="zpKindHint" style="margin-top:-6px">${zpEsc(KIND_HINTS[p.kind||'worker'])}</p><div class="field" id="zpTokenWrap" style="${isBot?'':'display:none'}"><label>Bot token</label><input id="zpToken" type="password" autocomplete="off" placeholder="Paste token here (optional if already in env)"><p class="key-note" id="zpTokenHelp">${zpEsc(tokenHelp)}</p></div><div class="field"><label>Upload project files</label><input id="zpUpload" type="file" multiple></div>${existing?`<p class="key-note">${existing} existing file(s) are kept. Uploading a file with the same name replaces it.</p>`:''}<div class="field"><label>Or paste one file</label><input id="zpFileName" placeholder="bot.py / index.html"></div><div class="field"><textarea id="zpCode" style="min-height:100px" placeholder="Paste code here (optional)"></textarea></div><div class="field"><label>Environment variables (optional)</label><textarea id="zpEnv" style="min-height:76px" placeholder="DISCORD_TOKEN=your-token&#10;OWNER_ID=123456789">${zpEsc(Object.entries(p.env||{}).map(([k,v])=>k+'='+v).join('\n'))}</textarea></div><div class="field"><label>Start command (optional)</label><input id="zpCmd" value="${zpEsc(p.start_command||'')}" placeholder="Leave blank — detected automatically"></div><label class="switch" style="margin-top:4px">Auto-start on Render <input id="zpAuto" type="checkbox" ${p.auto_start!==false?'checked':''}></label>`;
  openModal(project?'Edit project':'New project','Choose what to host and upload files. ZEX detects the runtime and start command.',body,'Save project',async()=>{
    const files=Object.assign({},p.files||{});
    const upload=document.getElementById('zpUpload');
    if(upload&&upload.files&&upload.files.length){Object.assign(files,await readFilesToMap(upload.files))}
    const fname=(document.getElementById('zpFileName')||{}).value||'';const code=(document.getElementById('zpCode')||{}).value||'';
    if(fname.trim()&&code){files[fname.trim().replace(/^\/+/,'')]=code}
    const name=(document.getElementById('zpName')||{}).value||'';const id=((document.getElementById('zpId')||{}).value||slugify(name)).trim().toLowerCase();const kind=(document.getElementById('zpKind')||{}).value||'worker';const cmd=(document.getElementById('zpCmd')||{}).value||'';
    const env={};String((document.getElementById('zpEnv')||{}).value||'').split(/\r?\n/).forEach(line=>{const m=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);if(m)env[m[1]]=m[2]});
    const token=((document.getElementById('zpToken')||{}).value||'').trim();
    if(token){if(kind==='telegram_bot'){env.TELEGRAM_BOT_TOKEN=token;env.BOT_TOKEN=token}else if(kind==='discord_bot'){env.DISCORD_TOKEN=token;env.BOT_TOKEN=token}}
    const autoStart=!!(document.getElementById('zpAuto')||{}).checked;
    if(!name.trim()){toast('Enter a project name');return false}
    if(!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)){toast('Project ID must be a lowercase slug (2-64 chars)');return false}
    if(!Object.keys(files).length&&!cmd.trim()){toast(kind==='website'?'Upload at least index.html for a website':'Upload project files or enter a start command');return false}
    const out=Object.assign({},p,{id,name:name.trim(),kind,start_command:cmd.trim(),files,env,enabled:p.enabled!==false,auto_start:autoStart});
    try{const r=await zexApi('/api/projects','POST',{project:out});toast(r.public_url?('Saved · live at '+location.origin+r.public_url):'Saved · Render par start ho raha hai');await loadProjects();await loadLiveRuntime();if(current==='files')await loadFiles();if(current==='overview')await loadOverview()}catch(e){toast('Save failed: '+e.message);return false}
  });
  const kindSel=document.getElementById('zpKind');const hint=document.getElementById('zpKindHint');
  if(kindSel&&hint)kindSel.addEventListener('change',()=>{hint.textContent=KIND_HINTS[kindSel.value]||'';const bot=kindSel.value==='telegram_bot'||kindSel.value==='discord_bot';const wrap=document.getElementById('zpTokenWrap');if(wrap)wrap.style.display=bot?'':'none';const th=document.getElementById('zpTokenHelp');if(th)th.textContent=KIND_TOKEN_HELP[kindSel.value]||''});
  const nameEl=document.getElementById('zpName');const idEl=document.getElementById('zpId');
  if(nameEl&&idEl){let touched=!!p.id;idEl.addEventListener('input',()=>{touched=!!idEl.value});nameEl.addEventListener('input',()=>{if(!touched)idEl.value=slugify(nameEl.value)})}
}
