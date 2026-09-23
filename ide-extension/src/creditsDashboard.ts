import * as vscode from 'vscode';
import { readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import { randomBytes } from 'crypto';

/**
 * Credits dashboard
 *
 * Opens a webview inside the Kiro IDE showing how many credits each local
 * session consumed, aggregated by month and by week, plus a per-session
 * table (searchable, sortable, filterable by clicking a month/week bar).
 *
 * Data source: ~/.kiro/sessions/<workspace-hash>/<session>/
 *   - session.json    -> title, workspacePaths, createdAt, modelId, agentMode
 *   - messages.jsonl  -> lines with payload.type === "usage_summary", each
 *                        carrying promptTurnSummaries[].usage (credits/turn)
 *
 * A session's credit total is the sum of every `usage` across every
 * usage_summary line in its messages.jsonl. Sessions in the older on-disk
 * format never wrote usage_summary and are counted as "skipped" (no credit
 * data to recover), reported in a footnote.
 */

const KIRO_SESSIONS_DIR = join(homedir(), '.kiro', 'sessions');

interface CreditSession {
  id: string;
  title: string;
  credits: number;
  turns: number;
  model: string;
  agent: string;
  workspace: string;
  date: string | null; // YYYY-MM-DD (createdAt)
}

interface ScanResult {
  sessions: CreditSession[];
  skipped: number;
}

/** Sums usage_summary credits from one messages.jsonl. */
function sumCredits(messagesPath: string): { credits: number; turns: number; hasData: boolean } {
  let credits = 0;
  let turns = 0;
  let hasData = false;

  let raw: string;
  try {
    raw = readFileSync(messagesPath, 'utf8');
  } catch {
    return { credits, turns, hasData };
  }

  for (const line of raw.split('\n')) {
    if (!line || line.indexOf('usage_summary') === -1) continue;
    let obj: { payload?: Record<string, unknown> };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = obj.payload;
    if (!payload || payload.type !== 'usage_summary') continue;
    hasData = true;
    const summaries = payload.promptTurnSummaries;
    if (!Array.isArray(summaries)) continue;
    for (const summ of summaries) {
      const usage = (summ as { usage?: unknown }).usage;
      if (typeof usage === 'number' && Number.isFinite(usage)) {
        credits += usage;
        turns += 1;
      }
    }
  }
  return { credits, turns, hasData };
}

function isoToDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // createdAt is an ISO timestamp; the date portion is all we need.
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m ? m[1]! : null;
}

/** Scans every local Kiro session and returns per-session credit totals. */
export function scanSessionCredits(): ScanResult {
  const sessions: CreditSession[] = [];
  let skipped = 0;

  let workspaceDirs: string[];
  try {
    workspaceDirs = readdirSync(KIRO_SESSIONS_DIR);
  } catch {
    return { sessions, skipped };
  }

  for (const workspaceDir of workspaceDirs) {
    const workspacePath = join(KIRO_SESSIONS_DIR, workspaceDir);
    let sessionDirs: string[];
    try {
      if (!statSync(workspacePath).isDirectory()) continue;
      sessionDirs = readdirSync(workspacePath);
    } catch {
      continue;
    }

    for (const sessionDir of sessionDirs) {
      const dir = join(workspacePath, sessionDir);
      const messagesPath = join(dir, 'messages.jsonl');
      let hasMessages = false;
      try {
        hasMessages = statSync(messagesPath).isFile();
      } catch {
        hasMessages = false;
      }
      if (!hasMessages) continue;

      const { credits, turns, hasData } = sumCredits(messagesPath);
      if (!hasData) {
        skipped += 1; // older format, no credit tracking
        continue;
      }

      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')) as Record<string, unknown>;
      } catch {
        meta = {};
      }

      const workspacePaths = Array.isArray(meta.workspacePaths)
        ? (meta.workspacePaths as unknown[]).map(String)
        : [];
      const primaryWs = workspacePaths.length
        ? basename(workspacePaths[0]!.replace(/\/+$/, ''))
        : '(sem workspace)';

      sessions.push({
        id: String(meta.id ?? sessionDir),
        title: (typeof meta.title === 'string' && meta.title.trim()) || '(sem título)',
        credits: Math.round(credits * 100) / 100,
        turns,
        model: typeof meta.modelId === 'string' ? meta.modelId : '?',
        agent: typeof meta.agentMode === 'string' ? meta.agentMode : '?',
        workspace: primaryWs,
        date: isoToDate(meta.createdAt),
      });
    }
  }

  return { sessions, skipped };
}

let panel: vscode.WebviewPanel | undefined;

/** Opens (or reveals) the credits dashboard webview. */
export function openCreditsDashboard(context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    refresh();
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'kiroRemoteBridge.credits',
    'Consumo de Créditos — Kiro',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  panel.onDidDispose(() => {
    panel = undefined;
  }, null, context.subscriptions);

  // Let the webview ask for a refresh (button in the UI).
  panel.webview.onDidReceiveMessage((msg: { type?: string }) => {
    if (msg?.type === 'refresh') refresh();
  }, undefined, context.subscriptions);

  refresh();
}

function refresh(): void {
  if (!panel) return;
  const { sessions, skipped } = scanSessionCredits();
  panel.webview.html = renderHtml(sessions, skipped);
}

function renderHtml(sessions: CreditSession[], skipped: number): string {
  const nonce = randomBytes(16).toString('base64');
  const data = JSON.stringify(sessions).replace(/</g, '\\u003c');
  const generated = new Date().toLocaleString('pt-BR');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kiro — Consumo de Créditos</title>
<style>
  :root {
    --bg: #0f1117; --panel: #181b24; --panel2: #1f2330; --line: #2a2f3d;
    --txt: #e6e9ef; --muted: #9aa3b2; --accent: #7c9cff; --accent2: #58d6a8;
    --bar: linear-gradient(90deg,#7c9cff,#9d7cff);
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--txt);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width:1100px; margin:0 auto; padding:28px 20px 80px; }
  .head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
  h1 { font-size:22px; margin:0 0 4px; font-weight:650; }
  .sub { color:var(--muted); font-size:13px; margin-bottom:24px; }
  button.refresh { background:var(--panel2); color:var(--txt); border:1px solid var(--line);
    border-radius:9px; padding:8px 14px; font-size:13px; cursor:pointer; white-space:nowrap; }
  button.refresh:hover { border-color:var(--accent); }
  .cards { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-bottom:28px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:16px 18px; }
  .card .k { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .card .v { font-size:26px; font-weight:680; margin-top:6px; }
  .card .v small { font-size:13px; color:var(--muted); font-weight:500; }
  section { background:var(--panel); border:1px solid var(--line); border-radius:16px;
    padding:20px 22px; margin-bottom:22px; }
  section h2 { font-size:15px; margin:0 0 16px; font-weight:620; display:flex;
    align-items:center; gap:8px; }
  .hint { color:var(--muted); font-size:12px; font-weight:400; }
  .bars { display:flex; flex-direction:column; gap:9px; }
  .barrow { display:grid; grid-template-columns:130px 1fr 150px; align-items:center;
    gap:12px; cursor:pointer; padding:3px 6px; border-radius:8px; }
  .barrow:hover { background:var(--panel2); }
  .barrow.active { background:#26304a; outline:1px solid var(--accent); }
  .barlabel { font-size:13px; color:var(--txt); white-space:nowrap; overflow:hidden;
    text-overflow:ellipsis; }
  .bartrack { background:#0d0f16; border-radius:7px; height:22px; overflow:hidden; }
  .barfill { height:100%; background:var(--bar); border-radius:7px; min-width:2px;
    transition:width .3s; }
  .barval { font-size:13px; text-align:right; color:var(--muted); font-variant-numeric:tabular-nums; }
  .barval b { color:var(--txt); font-weight:620; }
  .toolbar { display:flex; gap:12px; align-items:center; margin-bottom:14px; flex-wrap:wrap; }
  input[type=search] { flex:1; min-width:200px; background:var(--panel2); border:1px solid var(--line);
    color:var(--txt); border-radius:10px; padding:9px 13px; font-size:13px; }
  input[type=search]::placeholder { color:var(--muted); }
  .filterpill { background:#26304a; border:1px solid var(--accent); color:var(--txt);
    border-radius:999px; padding:5px 12px; font-size:12px; cursor:pointer; display:none; }
  .filterpill.show { display:inline-flex; align-items:center; gap:6px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  thead th { text-align:left; color:var(--muted); font-weight:560; font-size:12px;
    padding:8px 10px; border-bottom:1px solid var(--line); cursor:pointer; user-select:none;
    position:sticky; top:0; background:var(--panel); }
  thead th:hover { color:var(--txt); }
  thead th.num, td.num { text-align:right; font-variant-numeric:tabular-nums; }
  tbody td { padding:9px 10px; border-bottom:1px solid #22262f; }
  tbody tr:hover { background:var(--panel2); }
  .title-cell { max-width:420px; }
  .title-cell .t { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .tag { display:inline-block; background:var(--panel2); border:1px solid var(--line);
    border-radius:6px; padding:1px 7px; font-size:11px; color:var(--muted); }
  .credit { color:var(--accent2); font-weight:640; }
  .minibar { height:4px; background:var(--bar); border-radius:3px; margin-top:5px; }
  .foot { color:var(--muted); font-size:12px; margin-top:18px; }
  @media (max-width:720px){ .cards{grid-template-columns:repeat(2,1fr);}
    .barrow{grid-template-columns:96px 1fr 96px;} }
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <div>
      <h1>Consumo de créditos — Kiro</h1>
      <div class="sub" id="sub"></div>
    </div>
    <button class="refresh" id="refreshBtn">Atualizar</button>
  </div>

  <div class="cards" id="cards"></div>

  <section>
    <h2>Por mês <span class="hint">— clique numa barra para filtrar as sessões abaixo</span></h2>
    <div class="bars" id="months"></div>
  </section>

  <section>
    <h2>Por semana <span class="hint">— clique numa barra para filtrar as sessões abaixo</span></h2>
    <div class="bars" id="weeks"></div>
  </section>

  <section>
    <h2>Sessões <span class="hint">— clique no cabeçalho para ordenar</span></h2>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Buscar por título, workspace ou modelo…">
      <span class="filterpill" id="pill"></span>
    </div>
    <table>
      <thead><tr>
        <th data-k="title">Sessão</th>
        <th data-k="date">Data</th>
        <th data-k="credits" class="num">Créditos</th>
        <th data-k="turns" class="num">Turns</th>
        <th data-k="model">Modelo</th>
        <th data-k="workspace">Workspace</th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="foot" id="foot"></div>
  </section>

  <div class="foot" id="note"></div>
</div>

<script nonce="${nonce}">
const DATA = ${data};
const SKIPPED = ${skipped};
const GENERATED = ${JSON.stringify(generated)};
const vscodeApi = acquireVsCodeApi();

const fmt = n => n.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmt0 = n => n.toLocaleString('pt-BR');
const MONTHS = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];

function monthKey(d){ return d ? d.slice(0,7) : '?'; }
function monthLabel(k){ if(k==='?')return 'sem data'; const p=k.split('-'); return MONTHS[+p[1]-1]+'/'+p[0]; }
function weekKey(d){
  if(!d) return '?';
  const dt = new Date(d+'T00:00:00');
  const day = (dt.getDay()+6)%7;
  dt.setDate(dt.getDate()-day);
  return dt.toISOString().slice(0,10);
}
function weekLabel(k){
  if(k==='?') return 'sem data';
  const a=new Date(k+'T00:00:00'); const b=new Date(a); b.setDate(b.getDate()+6);
  const f=x=>String(x.getDate()).padStart(2,'0')+'/'+String(x.getMonth()+1).padStart(2,'0');
  return f(a)+'–'+f(b);
}

let filter = null;
let sortK = 'date', sortDir = -1;

function totals(){
  const total = DATA.reduce((s,x)=>s+x.credits,0);
  const turns = DATA.reduce((s,x)=>s+x.turns,0);
  return {total, turns, n:DATA.length, avg: DATA.length? total/DATA.length:0};
}

function aggregate(keyFn){
  const g = {};
  for(const s of DATA){ const k=keyFn(s.date);
    (g[k] = g[k] || {credits:0,sessions:0,turns:0}); g[k].credits+=s.credits;
    g[k].sessions++; g[k].turns+=s.turns; }
  return g;
}

function renderCards(){
  const t = totals();
  const dates = DATA.map(x=>x.date).filter(Boolean).sort();
  const range = dates.length? monthLabel(monthKey(dates[0]))+' → '+monthLabel(monthKey(dates[dates.length-1])) : '—';
  document.getElementById('sub').textContent = 'Gerado em '+GENERATED+' · período '+range;
  document.getElementById('cards').innerHTML =
    '<div class="card"><div class="k">Total de créditos</div><div class="v">'+fmt(t.total)+'</div></div>'+
    '<div class="card"><div class="k">Sessões</div><div class="v">'+fmt0(t.n)+'</div></div>'+
    '<div class="card"><div class="k">Turns</div><div class="v">'+fmt0(t.turns)+'</div></div>'+
    '<div class="card"><div class="k">Média / sessão</div><div class="v">'+fmt(t.avg)+' <small>créditos</small></div></div>';
}

function renderBars(elId, keyFn, labelFn, type){
  const g = aggregate(keyFn);
  const entries = Object.entries(g).sort((a,b)=> a[0]<b[0]?1:-1);
  const max = Math.max.apply(null, entries.map(e=>e[1].credits).concat([1]));
  document.getElementById(elId).innerHTML = entries.map(function(e){
    const k=e[0], v=e[1];
    const active = filter && filter.type===type && filter.key===k ? ' active':'';
    const w = (v.credits/max*100).toFixed(1);
    return '<div class="barrow'+active+'" data-type="'+type+'" data-key="'+k+'">'+
      '<div class="barlabel">'+labelFn(k)+'</div>'+
      '<div class="bartrack"><div class="barfill" style="width:'+w+'%"></div></div>'+
      '<div class="barval"><b>'+fmt(v.credits)+'</b> · '+v.sessions+' sess.</div></div>';
  }).join('');
}

function toggleFilter(type,key){
  if(filter && filter.type===type && filter.key===key) filter=null;
  else filter={type:type,key:key};
  renderAll();
}
function clearFilter(){ filter=null; renderAll(); }

function currentRows(){
  let rows = DATA.slice();
  if(filter){
    const kf = filter.type==='month'? monthKey : weekKey;
    rows = rows.filter(s=> kf(s.date)===filter.key);
  }
  const q = document.getElementById('q').value.trim().toLowerCase();
  if(q) rows = rows.filter(s=> (s.title+' '+s.workspace+' '+s.model).toLowerCase().indexOf(q)!==-1);
  rows.sort(function(a,b){
    let x=a[sortK], y=b[sortK];
    if(typeof x==='string'){ x=(x||'').toLowerCase(); y=(y||'').toLowerCase(); }
    if(x<y) return -1*sortDir; if(x>y) return 1*sortDir; return 0;
  });
  return rows;
}

function renderRows(){
  const rows = currentRows();
  const max = Math.max.apply(null, rows.map(r=>r.credits).concat([1]));
  document.getElementById('rows').innerHTML = rows.map(function(s){
    return '<tr>'+
      '<td class="title-cell"><div class="t">'+esc(s.title)+'</div>'+
        '<div class="minibar" style="width:'+(s.credits/max*100).toFixed(1)+'%"></div></td>'+
      '<td>'+(s.date||'—')+'</td>'+
      '<td class="num credit">'+fmt(s.credits)+'</td>'+
      '<td class="num">'+s.turns+'</td>'+
      '<td><span class="tag">'+esc(s.model)+'</span></td>'+
      '<td>'+esc(s.workspace)+'</td></tr>';
  }).join('');
  const sum = rows.reduce((a,b)=>a+b.credits,0);
  document.getElementById('foot').textContent = rows.length+' sessões exibidas · '+fmt(sum)+' créditos';
  const pill = document.getElementById('pill');
  if(filter){
    const lbl = filter.type==='month'? monthLabel(filter.key): weekLabel(filter.key);
    pill.className='filterpill show'; pill.innerHTML='filtro: '+lbl+' &times;';
  } else pill.className='filterpill';
}

function esc(s){ return (s||'').replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }

function renderAll(){
  renderBars('months', monthKey, monthLabel, 'month');
  renderBars('weeks', weekKey, weekLabel, 'week');
  renderRows();
}

document.getElementById('months').addEventListener('click', onBarClick);
document.getElementById('weeks').addEventListener('click', onBarClick);
function onBarClick(e){
  const row = e.target.closest('.barrow');
  if(row) toggleFilter(row.dataset.type, row.dataset.key);
}
document.getElementById('pill').addEventListener('click', clearFilter);
document.getElementById('refreshBtn').addEventListener('click', function(){ vscodeApi.postMessage({type:'refresh'}); });

const ths = document.querySelectorAll('thead th');
for(let i=0;i<ths.length;i++){
  ths[i].addEventListener('click', function(){
    const k=this.dataset.k;
    if(sortK===k) sortDir*=-1;
    else { sortK=k; sortDir=(k==='title'||k==='model'||k==='workspace'||k==='date')?1:-1; }
    renderRows();
  });
}
document.getElementById('q').addEventListener('input', renderRows);

renderCards();
renderAll();
document.getElementById('note').textContent =
  SKIPPED>0 ? ('Obs.: '+fmt0(SKIPPED)+' sessões antigas sem rastreamento de crédito foram ignoradas (formato anterior ao registro de uso).') : '';
</script>
</body>
</html>`;
}
