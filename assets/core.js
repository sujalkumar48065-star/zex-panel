const ZEX_CONFIG={
  brand:'ZEX PERSONAL PANEL',
  owner:'Zex',
  kapple:{username:'server-side'},
  render:{}
};
const integrations=[
  {name:'Kaggle sessions',value:'server-side only',extra:'checking…'},
  {name:'Render hosting',value:'server-side only',extra:'checking…'},
  {name:'GitHub state',value:'server-side only',extra:'checking…'}
];
let apiVisible=[false,false,false];
let liveProjects=[];
const KIND_LABELS={website:'Website',discord_bot:'Discord bot',telegram_bot:'Telegram bot',api:'API / backend',worker:'Worker'};
const KIND_HINTS={
  website:'Static site files. Public URL is created instantly on this panel.',
  discord_bot:'Bot files. Runs in the Kaggle session at the next handover.',
  telegram_bot:'Bot files. Runs in the Kaggle session at the next handover.',
  api:'Python/Node backend. Runs in Kaggle (inbound URL not exposed by Kaggle).',
  worker:'Background process. Runs and restarts inside the Kaggle session.'
};
const endpoints=[
  ['GET','/api/status','Live session + handover status'],
  ['GET','/api/projects','List registered projects'],
  ['POST','/api/projects','Create or update a project'],
  ['DELETE','/api/projects?id=','Delete a project'],
  ['POST','/api/deploy','Queue a safe deploy'],
  ['POST','/api/backup','Queue Kaggle backup'],
  ['GET','/api/logs','Backend logs'],
  ['GET','/api/backups','Backup + handover history'],
  ['GET','/api/key','Read the master key'],
  ['POST','/api/key','Rotate the master key'],
  ['GET','/api/webhooks','List webhooks'],
  ['POST','/api/webhooks','Create a webhook'],
  ['DELETE','/api/webhooks?id=','Delete a webhook'],
  ['GET','/api/settings','Workspace settings']
];
let current='overview';let masterVisible=false;let masterKeyValue='';let fmTargetId='';let panelStatus=null;
const $=s=>document.querySelector(s);const toast=m=>{let t=$('#toast');t.textContent=m;t.classList.add('show');clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>t.classList.remove('show'),2600)};
const btn=(label,act,cls='btn')=>`<button class="${cls}" data-action="${act}">${label}</button>`;
function head(kicker,title,desc,actions=''){return `<div class="page-head"><div><div class="eyebrow">${kicker}</div><h1>${title}</h1><p>${desc}</p></div><div class="actions">${actions}</div></div>`}
function kindLabel(kind){return KIND_LABELS[kind]||'Worker'}
function slugify(value){return String(value||'').toLowerCase().trim().replace(/[^a-z0-9._-]+/g,'-').replace(/^[-._]+|[-._]+$/g,'').slice(0,56)}
function fmtBytes(n){n=Number(n||0);if(n<1024)return n+' B';if(n<1024*1024)return (n/1024).toFixed(1)+' KB';return (n/1024/1024).toFixed(1)+' MB'}
function fmtWhen(ts){if(!ts)return '—';try{return new Date(ts).toLocaleString()}catch(e){return '—'}}
function contentSize(v){if(v&&typeof v==='object'&&typeof v.__zex_b64==='string')return Math.floor(v.__zex_b64.length*3/4);try{return new TextEncoder().encode(String(v==null?'':v)).length}catch(e){return String(v==null?'':v).length}}
