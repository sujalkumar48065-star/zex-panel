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
  website:'HTML/CSS/JS website. Public link is created instantly on this panel.',
  discord_bot:'Discord bot. Runs live on Render with auto-restart. Token Discord Developer Portal se milta hai.',
  telegram_bot:'Telegram bot. Runs live on Render with auto-restart. Token Telegram ke @BotFather se milta hai.',
  api:'Python/Node backend. Runs live on Render as a process (public inbound port not exposed).',
  worker:'Background process. Runs live on Render with logs and auto-restart.'
};
const KIND_TOKEN_HELP={
  discord_bot:'Discord Developer Portal → Applications → Bot → Reset Token → copy. Isko niche token box me paste karein. Code ise DISCORD_TOKEN / BOT_TOKEN me paayega.',
  telegram_bot:'Telegram me @BotFather open karein → /newbot → naam aur username dein → jo lamba token mile, use niche paste karein. Code ise TELEGRAM_BOT_TOKEN / BOT_TOKEN me paayega.'
};
const RUNTIME_STATUS_LABEL={running:'Running',starting:'Starting',installing:'Installing',restarting:'Restarting',stopped:'Stopped',static:'Static site',error:'Error'};
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
  ['GET','/api/settings','Workspace settings'],
  ['GET','/api/runtime','Live runtime status'],
  ['POST','/api/runtime/start','Start a project'],
  ['POST','/api/runtime/stop','Stop a project'],
  ['POST','/api/runtime/restart','Restart a project'],
  ['GET','/api/runtime/logs?id=','Read live project logs']
];
let current=(document.body&&document.body.dataset&&document.body.dataset.initialPage)||'overview';let masterVisible=false;let masterKeyValue='';let fmTargetId='';let panelStatus=null;
const $=s=>document.querySelector(s);const toast=m=>{let t=$('#toast');t.textContent=m;t.classList.add('show');clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>t.classList.remove('show'),2600)};
const btn=(label,act,cls='btn')=>`<button class="${cls}" data-action="${act}">${label}</button>`;
function head(kicker,title,desc,actions=''){return `<div class="page-head"><div><div class="eyebrow">${kicker}</div><h1>${title}</h1><p>${desc}</p></div><div class="actions">${actions}</div></div>`}
function kindLabel(kind){return KIND_LABELS[kind]||'Worker'}
function slugify(value){return String(value||'').toLowerCase().trim().replace(/[^a-z0-9._-]+/g,'-').replace(/^[-._]+|[-._]+$/g,'').slice(0,56)}
function fmtBytes(n){n=Number(n||0);if(n<1024)return n+' B';if(n<1024*1024)return (n/1024).toFixed(1)+' KB';return (n/1024/1024).toFixed(1)+' MB'}
function fmtWhen(ts){if(!ts)return '—';try{return new Date(ts).toLocaleString()}catch(e){return '—'}}
function contentSize(v){if(v&&typeof v==='object'&&typeof v.__zex_b64==='string')return Math.floor(v.__zex_b64.length*3/4);try{return new TextEncoder().encode(String(v==null?'':v)).length}catch(e){return String(v==null?'':v).length}}
