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
const KIND_META={
  website:{icon:'◇',title:'Website',short:'HTML · CSS · JavaScript',desc:'Files upload karo, turant public link mil jayega.'},
  telegram_bot:{icon:'➤',title:'Telegram Bot',short:'Python / Node.js · BotFather token',desc:'Telegram bot Kaggle session me 24x7 chalao, live logs aur auto-restart ke saath.'},
  discord_bot:{icon:'◉',title:'Discord Bot',short:'discord.js / discord.py',desc:'Discord bot ko Kaggle session me live host karo, token aur auto-start ke saath.'},
  api:{icon:'⌘',title:'API / Backend',short:'Python / Node.js server',desc:'Backend process Kaggle session me chalao, env vars aur live console ke saath.'},
  worker:{icon:'▧',title:'Worker',short:'Background process',desc:'Koi bhi long-running script Kaggle me, logs aur crash recovery ke saath.'}
};
const KIND_ORDER=['website','telegram_bot','discord_bot','api','worker'];
const KIND_HINTS={
  website:'HTML/CSS/JS website. Public link is created instantly on this panel.',
  discord_bot:'Discord bot. Runs live in the active Kaggle session with auto-restart. Token Discord Developer Portal se milta hai.',
  telegram_bot:'Telegram bot. Runs live in the active Kaggle session with auto-restart. Token Telegram ke @BotFather se milta hai.',
  api:'Python/Node backend. Runs live in the active Kaggle session as a process (public inbound port not exposed).',
  worker:'Background process. Runs live in the active Kaggle session with logs and auto-restart.'
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
  ['GET','/api/metrics','CPU, RAM, storage and project metrics'],
  ['POST','/api/runtime/start','Start a project'],
  ['POST','/api/runtime/stop','Stop a project'],
  ['POST','/api/runtime/restart','Restart a project'],
  ['GET','/api/runtime/logs?id=','Read live project logs']
];
let current=(document.body&&document.body.dataset&&document.body.dataset.initialPage)||'overview';let masterVisible=false;let masterKeyValue='';let fmTargetId='';let panelStatus=null;let metricsMap={};let lastMetrics=null;
const $=s=>document.querySelector(s);const toast=m=>{let t=$('#toast');t.textContent=m;t.classList.add('show');clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>t.classList.remove('show'),2600)};
const btn=(label,act,cls='btn')=>`<button class="${cls}" data-action="${act}">${label}</button>`;
function head(kicker,title,desc,actions=''){return `<div class="page-head"><div><div class="eyebrow">${kicker}</div><h1>${title}</h1><p>${desc}</p></div><div class="actions">${actions}</div></div>`}
function kindLabel(kind){return KIND_LABELS[kind]||'Worker'}
function kindMeta(kind){return KIND_META[kind]||KIND_META.worker}
function fmtPct(n){return (n==null||Number.isNaN(Number(n)))?'—':(Math.round(Number(n)*10)/10)+'%'}
function fmtDuration(ms){const s=Math.max(0,Math.floor(Number(ms||0)/1000));const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60);return d?d+'d '+h+'h':h?h+'h '+m+'m':m?m+'m':s+'s'}
function slugify(value){return String(value||'').toLowerCase().trim().replace(/[^a-z0-9._-]+/g,'-').replace(/^[-._]+|[-._]+$/g,'').slice(0,56)}
function fmtBytes(n){n=Number(n||0);if(n<1024)return n+' B';if(n<1024*1024)return (n/1024).toFixed(1)+' KB';return (n/1024/1024).toFixed(1)+' MB'}
function fmtWhen(ts){if(!ts)return '—';try{return new Date(ts).toLocaleString()}catch(e){return '—'}}
function contentSize(v){if(v&&typeof v==='object'&&typeof v.__zex_b64==='string')return Math.floor(v.__zex_b64.length*3/4);try{return new TextEncoder().encode(String(v==null?'':v)).length}catch(e){return String(v==null?'':v).length}}
function detectStartCommandFromFiles(kind,files){
  files=files||{};if(kind==='website')return '';const names=Object.keys(files);const text=n=>{const v=files[n];if(v&&typeof v==='object'&&typeof v.__zex_b64==='string')return '';return String(v==null?'':v)};
  const find=cs=>{for(const c of cs){if(names.includes(c))return c;const h=names.find(n=>n.endsWith('/'+c));if(h)return h}return null};
  if(find(['package.json'])){try{const pkg=JSON.parse(text(find(['package.json'])));if(pkg.scripts&&pkg.scripts.start)return 'npm start'}catch(e){}}
  const pyPref={discord_bot:['bot.py','main.py','app.py','index.py','run.py','server.py'],telegram_bot:['bot.py','main.py','app.py','index.py','run.py','server.py'],api:['app.py','main.py','server.py','index.py','run.py'],worker:['bot.py','main.py','worker.py','app.py','run.py','index.py']}[kind]||['main.py','app.py','bot.py','worker.py','run.py','index.py'];
  const py=find(pyPref);if(py)return 'python3 -u '+py;
  const pys=names.filter(n=>/\.py$/i.test(n)&&!/(^|\/)(setup|conftest)\.py$/i.test(n)&&!/(^|\/)(__pycache__|\.venv|venv|site-packages|node_modules)\//.test(n));
  if(pys.length){const rank=n=>{const b=n.split('/').pop().toLowerCase();const t=text(n).slice(0,200000);let sc=0;if(pyPref.includes(b))sc+=100;if(/(bot|user|main|app|run|server|worker|start)/.test(b))sc+=30;if(b==='__main__.py')sc+=25;if(/if\s+__name__\s*==\s*['"]__main__['"]/.test(t))sc+=90;if(/asyncio\.run\s*\(/.test(t))sc+=45;if(/(TelegramClient|aiogram|pyrogram|discord\.|bot\.run|client\.run|uvicorn\.run|app\.run|FastAPI\s*\()/.test(t))sc+=35;if(/(flask|django|aiohttp|telethon|python-telegram-bot)/i.test(t))sc+=15;sc-=(n.split('/').length-1)*3;return sc};pys.sort((a,b)=>rank(b)-rank(a)||a.length-b.length);return 'python3 -u '+pys[0]}
  const nodePref={discord_bot:['index.js','bot.js','main.js','server.js'],telegram_bot:['index.js','bot.js','main.js','server.js'],api:['server.js','index.js','app.js','main.js'],worker:['index.js','worker.js','main.js','server.js']}[kind]||['index.js','server.js','app.js','main.js'];
  const node=find(nodePref);if(node)return 'node '+node;
  const jss=names.filter(n=>/\.(m?js|cjs)$/i.test(n)&&!/(^|\/)(node_modules|dist|build)\//.test(n));
  if(jss.length){const rank=n=>{const b=n.split('/').pop().toLowerCase();const t=text(n).slice(0,200000);let sc=0;if(nodePref.includes(b))sc+=100;if(/(bot|user|main|app|run|server|worker|start|index)/.test(b))sc+=30;if(/(listen\s*\(|createServer\s*\(|\.login\s*\(|Telegraf|Client\s*\(|express\s*\()/.test(t))sc+=40;sc-=(n.split('/').length-1)*3;return sc};jss.sort((a,b)=>rank(b)-rank(a)||a.length-b.length);return 'node '+jss[0]}
  return '';
}
