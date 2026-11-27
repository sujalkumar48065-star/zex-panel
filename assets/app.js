function reloadCurrentPage(){
  const loaders={overview:loadOverview,projects:loadProjects,deployments:loadDeployments,console:loadConsole,files:loadFiles,backups:loadBackups,monitoring:loadMonitoring,api:loadApi,settings:loadSettings,webhooks:loadWebhooks,admin:loadAdmin,runtime:loadRuntime};
  if(loaders[current])loaders[current]();
}
async function copyMasterKey(){
  try{if(!masterKeyValue){const d=await zexApi('/api/key');masterKeyValue=d.key||''}if(!masterKeyValue)throw new Error('No key available');await navigator.clipboard.writeText(masterKeyValue);toast('Master key copied')}catch(e){toast('Copy failed: '+e.message)}
}
document.addEventListener('click',async e=>{
  const nav=e.target.closest('[data-page]');if(nav){current=nav.dataset.page;render();return}
  const el=e.target.closest('[data-action]');if(!el)return;
  const act=el.dataset.action;
  if(act==='new-project'||act==='deploy'||act==='zex-new'){projectModal(null);return}
  if(act.startsWith('new-kind:')){projectModal({kind:act.slice(9)});return}
  if(act.startsWith('template:')){const kind=act.slice(9);projectModal({name:'',id:'',kind,start_command:'',files:{},env:{}});return}
  if(act.startsWith('manage-')){const p=liveProjects[+act.split('-')[1]];if(p)manageProject(p);return}
  if(act.startsWith('zex-edit:')){const p=zexProjectsMap[act.slice(9)];if(p)projectModal(p);return}
  if(act.startsWith('rt-live-')){const m=act.match(/^rt-live-(start|stop|restart|logs):(.+)$/);if(m){if(m[1]==='logs')showRuntimeLogs(m[2]);else runtimeAction(m[2],m[1]);return}}
  if(act.startsWith('zex-del:')){
    const id=act.slice(8);openModal('Delete project','Remove '+id+' from ZEX CLOUD?',`<p class="key-note">The project is removed from the registry and both Kaggle sessions at the next safe handover.</p>`,'Delete',async()=>{await zexApi('/api/projects?id='+encodeURIComponent(id),'DELETE');toast('Deleted · applies at next handover');await loadProjects();if(current==='files')await loadFiles()});return
  }
  if(act==='webhook-new'){webhookModal();return}
  if(act.startsWith('webhook-del:')){const id=act.slice(12);openModal('Delete webhook','Remove this webhook?','<p class="key-note">Future events will not be delivered.</p>','Delete',async()=>{await zexApi('/api/webhooks?id='+encodeURIComponent(id),'DELETE');toast('Webhook deleted');await loadWebhooks()});return}
  if(act==='save-settings'){saveSettings();return}
  if(act==='regenerate-key'){openModal('Regenerate master key?','Existing API-key clients must be updated.','<p class="key-note">A new key is generated instantly and stored server-side.</p>','Regenerate',async()=>{const d=await zexApi('/api/key','POST');masterKeyValue=d.key||'';toast('Master key rotated');render()});return}
  if(act==='copy-key'){copyMasterKey();return}
  if(act==='toggle-key'){masterVisible=!masterVisible;render();return}
  if(act==='upload'){const sel=document.getElementById('fmSelect');if(!sel){toast('Open File manager and select a project first');return}fmTargetId=sel.value;document.getElementById('fileInput')?.click();return}
  if(act==='backup'||act==='zex-backup'){toast('Writing Kaggle backup…');zexApi('/api/backup','POST').then(r=>{toast(r.queued?'Backup queued for next safe handover':(r.ok?'Kaggle backup written':'Backup failed'));if(current==='backups')loadBackups();loadRuntime()}).catch(err=>toast('Backup failed: '+err.message));return}
  if(act==='restore'){toast('Restore is embedded in the next safe handover.');return}
  if(act==='docs'){current='api';render();return}
  if(act==='notifBtn'||act==='notifications'){zexApi('/api/status').then(s=>toast('Session '+(s.active||'—').toUpperCase()+' · '+(s.projects&&s.projects.count||0)+' project(s) · '+(s.failures||0)+' failure(s)')).catch(err=>toast(err.message));return}
  if(act==='help'){current='api';render();toast('Live API reference opened.');return}
  if(act==='dep-refresh'){loadDeployments();return}
  if(act==='console-refresh'){loadConsole();return}
  if(act==='mon-refresh'){loadMonitoring();return}
  if(act==='rt-refresh'||act==='rt-logs'){loadRuntime();return}
  if(act==='rt-start-a'||act==='rt-start-b'){const slot=act.endsWith('a')?'a':'b';zexApi('/api/session/start','POST',{slot}).then(()=>{toast('Session '+slot.toUpperCase()+' queued');loadRuntime()}).catch(err=>toast('Start failed: '+err.message));return}
  if(act==='rt-pause'){zexApi('/api/session/pause','POST').then(()=>{toast('Auto-rotation paused');loadRuntime()}).catch(err=>toast('Pause failed: '+err.message));return}
  if(act==='rt-rotate'){toast('Preparing safe handover…');zexApi('/api/session/rotate','POST').then(r=>{toast(r.scheduled?('Handover scheduled: '+new Date(r.startAt).toLocaleString()):'Handover queued');loadRuntime()}).catch(err=>toast('Rotate failed: '+err.message));return}
  if(act==='rt-failover'){zexApi('/api/render/fallback','POST').then(r=>{toast(r.ok?'Render fallback triggered':'Fallback: '+(r.error||'not configured'));loadRuntime()}).catch(err=>toast('Fallback failed: '+err.message));return}
  if(act==='zex-sync'){toast('Scheduling safe deploy…');zexApi('/api/deploy','POST').then(()=>{toast('Deploy queued for next safe handover');loadProjects();loadRuntime()}).catch(err=>toast('Sync failed: '+err.message));return}
  if(act==='add-domain'){openModal('Custom domains','Domains are not connected to this deployment.',`<p class="key-note">ZEX CLOUD serves websites from this panel at <code>/s/&lt;project-id&gt;/</code>. Attach a custom domain in front of the Render service if needed.</p>`,'Close',()=>{});return}
  if(act==='new-database'||act==='database'){openModal('Databases','ZEX CLOUD does not use an external database.',`<p class="key-note">Project files and settings are stored as JSON and the private GitHub state repo. No database is configured by design.</p>`,'Close',()=>{});return}
  if(act==='admin-users'){openModal('User management','Single-owner workspace.',`<p class="key-note">Only one panel account exists. Login is protected by the panel password; API access uses session tokens or the master key.</p>`,'Close',()=>{});return}
  if(act==='admin-nodes'){try{const s=await zexApi('/api/status');const a=s.sessions&&s.sessions.a||{},b=s.sessions&&s.sessions.b||{};openModal('Infrastructure','Live Kaggle and Render status.',`<div class="switch">Session A <span class="tag">${zpEsc(a.status||'—')} · v${zpEsc(String(a.version||'—'))} · ${rtTime(a.remainingMs)}</span></div><div class="switch">Session B <span class="tag">${zpEsc(b.status||'—')} · v${zpEsc(String(b.version||'—'))} · ${rtTime(b.remainingMs)}</span></div><div class="switch">Render fallback <span class="tag">${s.render&&s.render.configured?'configured':'not configured'}</span></div>`,'Close',()=>{})}catch(err){toast(err.message)}return}
  if(act==='admin-ops'){try{const s=await zexApi('/api/status');openModal('Platform operations','Rotation and safe handover.',`<div class="switch">Auto rotation <span class="tag">${s.enabled?'ON':'PAUSED'}</span></div><div class="switch">Next handover <span class="tag">${s.handover?zpEsc(s.handover.slot)+' · '+new Date(s.handover.startAt).toLocaleString():'not scheduled'}</span></div><div class="switch">Pending deploy <span class="tag">${s.deployPending?'yes':'no'}</span></div><p class="key-note">Use Kaggle runtime to rotate, backup or inspect logs.</p>`,'Close',()=>{})}catch(err){toast(err.message)}return}
  if(act==='logs'){current='console';render();return}
  if(act==='clear-logs'){render();return}
  toast('This action is not available.');
});
$('#menuBtn').addEventListener('click',()=>$('#sidebar').classList.toggle('open'));
$('#notifBtn').addEventListener('click',async()=>{try{const s=await zexApi('/api/status');toast('Session '+(s.active||'—').toUpperCase()+' · '+((s.projects&&s.projects.count)||0)+' project(s) · '+((s.failures||0))+' failure(s)')}catch(e){toast(e.message)}});
$('#helpBtn').addEventListener('click',()=>{current='api';render()});
$('#modalCancel').addEventListener('click',()=>$('#modalBackdrop').classList.remove('show'));
$('#modalBackdrop').addEventListener('click',e=>{if(e.target.id==='modalBackdrop')e.currentTarget.classList.remove('show')});
$('#globalSearch').addEventListener('keydown',e=>{if(e.key==='Enter'){let q=e.target.value.toLowerCase().trim();if(!q){toast('Enter a search term.');return}let p=liveProjects.find(x=>(x.name||x.id||'').toLowerCase().includes(q)||(x.id||'').toLowerCase().includes(q)||(x.start_command||'').toLowerCase().includes(q));if(p){current='projects';render();toast('Showing project '+p.id)}else toast('No matching project.')}});
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('#globalSearch').focus()}if(e.key==='Escape')$('#modalBackdrop').classList.remove('show')});
$('#content').addEventListener('change',async e=>{
  if(e.target.id==='consoleProject'){await loadConsole();return}
  if(e.target.id==='fmSelect'){await loadFiles();return}
  if(e.target.id==='fileInput'){
    if(!fmTargetId){toast('Select a project in File manager first');return}
    try{await uploadFilesToProject(fmTargetId,e.target.files)}catch(err){toast(err.message)}finally{e.target.value=''}
  }
});
(function(){
  var lo=document.getElementById('logoutBtn');
  if(lo)lo.addEventListener('click',function(){try{sessionStorage.removeItem('zex_token');sessionStorage.removeItem('zex_panel_auth_v1')}catch(e){};location.href='login.html'});
})();
function startRuntimePoll(){
  if(runtimePollTimer)clearInterval(runtimePollTimer);
  runtimePollTimer=setInterval(function(){if(document.hidden)return;if(document.getElementById('content'))loadLiveRuntime()},5000);
}
window.addEventListener('unhandledrejection',function(e){try{toast('Unexpected: '+((e.reason&&e.reason.message)||e.reason||'error'))}catch(x){}});
window.addEventListener('error',function(e){if(e&&e.message&&/ResizeObserver|Script error/i.test(e.message))return;try{toast('JS error: '+e.message)}catch(x){}});
(function(){
  if(!sessionStorage.getItem('zex_token')){location.replace('login.html');return}
  render();startRuntimePoll();setTimeout(loadLiveRuntime,800);
})();
