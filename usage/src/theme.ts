/**
 * The site's design system: Sarvam Tech Labs' brand (websiteSTL/BRAND.md + brand-tokens.json), dark-first.
 *   - tokens: colours, Inter, 4px spacing scale, radii, gradients, glass, transitions — same variable names as the STL site
 *   - components: navbar (glass), cards, badges (pill), inputs, chips, tables, meters, sidebar, diff block
 *   - icons: Lucide, stroke only (2px, round caps), as BRAND.md specifies; logo: the real logo-icon.svg, unmodified
 * Everything is one stylesheet plus one small script (sidebar collapse, table filters); pages work without the script.
 */
import { escapeHtml as esc } from "./page";

/** assets/brand/logos/logo-icon.svg from the STL site, markup unchanged. */
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" shape-rendering="geometricPrecision"><defs><linearGradient id="iconGrad" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="#12121a"/><path d="M40 18C40 18 34 18 28 18C22 18 18 22 18 26C18 30 22 32 28 33C34 34 40 36 40 40C40 44 36 46 28 46C22 46 18 46 18 46" stroke="url(#iconGrad)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;

/** Lucide icons (https://lucide.dev, ISC): 24×24 grid, stroke only. */
const ICONS = {
  gauge: `<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>`,
  users: `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`,
  search: `<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>`,
  clock: `<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`,
  panel: `<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>`,
  chevron: `<path d="m6 9 6 6 6-6"/>`,
  alert: `<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>`,
  check: `<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>`,
  globe: `<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>`,
  history: `<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>`,
  plug: `<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>`,
  layers: `<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>`,
  activity: `<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>`,
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 18): string {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

const CSS = `
:root{
  --bg-color:#0a0a0f;--bg-surface:#12121a;--bg-surface-hover:#1a1a24;
  --text-primary:#ffffff;--text-secondary:#a1a1aa;
  --accent-primary:#6366f1;--accent-secondary:#22d3ee;--indigo-300:#a5b4fc;
  --success:#22c55e;--warning:#eab308;--error:#ef4444;
  --border-color:rgba(255,255,255,.08);--border-hover:rgba(255,255,255,.2);
  --glass-bg:rgba(18,18,26,.6);--glass-border:rgba(255,255,255,.05);
  --gradient-primary:linear-gradient(135deg,#6366f1,#22d3ee);
  --gradient-subtle:linear-gradient(135deg,rgba(99,102,241,.2),rgba(34,211,238,.2));
  --radius-sm:.375rem;--radius-md:.5rem;--radius-lg:.75rem;--radius-full:9999px;
  --font-sans:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --transition-fast:.2s ease;--transition-normal:.3s ease;
  --shadow-md:0 4px 6px rgba(0,0,0,.3);
}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{color-scheme:dark}
body{margin:0;background:var(--bg-color);color:var(--text-primary);font:400 .875rem/1.5 var(--font-sans);-webkit-font-smoothing:antialiased;min-height:100vh}
body::before,body::after{content:"";position:fixed;z-index:-1;width:520px;height:520px;border-radius:50%;filter:blur(120px);opacity:.16;pointer-events:none}
body::before{background:var(--accent-primary);top:-180px;left:-120px}
body::after{background:var(--accent-secondary);bottom:-220px;right:-140px;opacity:.1}
a{color:var(--indigo-300);text-decoration:none}a:hover{color:var(--accent-secondary)}
:focus-visible{outline:2px solid var(--accent-secondary);outline-offset:2px;border-radius:var(--radius-sm)}
.icon{flex:none;vertical-align:middle}
.container{max-width:1200px;margin:0 auto;padding:0 24px}

/* navbar (glass) */
.nav{position:sticky;top:0;z-index:30;background:var(--glass-bg);border-bottom:1px solid var(--glass-border);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
.nav .container{display:flex;align-items:center;gap:24px;height:64px}
.brand{display:flex;align-items:center;gap:12px;color:var(--text-primary)}.brand:hover{color:var(--text-primary)}
.brand svg{width:32px;height:32px;border-radius:8px}
.brand b{font-weight:600;font-size:1rem;letter-spacing:-.01em}.brand span{display:block;font-size:.75rem;color:var(--text-secondary);font-weight:400;line-height:1.1}
.tabs{display:flex;gap:4px;margin-left:8px}
.tab{display:inline-flex;align-items:center;gap:8px;padding:8px 16px;border:1px solid transparent;border-radius:var(--radius-full);color:var(--text-secondary);font-weight:500;white-space:nowrap;transition:var(--transition-fast)}
.tab:hover{color:var(--text-primary);background:rgba(255,255,255,.05)}
.tab[aria-current="page"]{color:var(--indigo-300);background:rgba(99,102,241,.12);border-color:rgba(99,102,241,.35)}
.nav-meta{margin-left:auto;display:flex;align-items:center;gap:8px;color:var(--text-secondary);font-size:.75rem;white-space:nowrap}

main{padding:32px 0 64px}
.page-head{margin-bottom:24px}
h1{font-size:1.875rem;line-height:1.3;font-weight:700;letter-spacing:-.02em;margin:0 0 4px}
h2{font-size:1.25rem;line-height:1.5;font-weight:600;letter-spacing:-.01em;margin:0}
h3{font-size:1rem;font-weight:600;margin:0}
.lead{color:var(--text-secondary);font-size:1rem;margin:0;max-width:70ch}
.muted{color:var(--text-secondary)}.small{font-size:.75rem}.nowrap{white-space:nowrap}.num{font-variant-numeric:tabular-nums}
.stack>*+*{margin-top:24px}

/* cards */
.card{background:var(--bg-surface);border:1px solid var(--border-color);border-radius:var(--radius-lg);padding:24px}
.card-head{display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.card-head .grow{flex:1}
.grid{display:grid;gap:16px}.grid.stats{grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}
.stat{display:flex;gap:16px;align-items:center;padding:20px}
.tile{display:grid;place-items:center;width:44px;height:44px;border-radius:12px;background:var(--gradient-subtle);color:var(--indigo-300)}
.tile.ok{background:rgba(34,197,94,.12);color:#4ade80}.tile.bad{background:rgba(239,68,68,.12);color:#f87171}.tile.warn{background:rgba(234,179,8,.12);color:#facc15}
.stat .v{font-size:1.5rem;font-weight:700;line-height:1.2;letter-spacing:-.01em}
.stat .l{color:var(--text-secondary);font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;font-weight:500}
.stat .s{color:var(--text-secondary);font-size:.75rem;margin-top:2px}

/* badges + chips */
.badge{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:var(--radius-full);font-size:.75rem;font-weight:500;line-height:1.5;background:rgba(99,102,241,.1);color:var(--indigo-300);white-space:nowrap}
.badge.ok{background:rgba(34,197,94,.12);color:#4ade80}.badge.warn{background:rgba(234,179,8,.12);color:#facc15}.badge.bad{background:rgba(239,68,68,.12);color:#f87171}.badge.mute{background:rgba(255,255,255,.06);color:var(--text-secondary)}
.chip{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:var(--radius-full);border:1px solid var(--border-color);background:transparent;color:var(--text-secondary);font:500 .875rem var(--font-sans);cursor:pointer;transition:var(--transition-fast)}
.chip:hover{border-color:var(--border-hover);color:var(--text-primary)}
.chip[aria-pressed="true"]{background:var(--gradient-subtle);border-color:rgba(99,102,241,.5);color:var(--text-primary)}

/* inputs */
.field{display:flex;flex-direction:column;gap:6px}.field>label{font-size:.75rem;font-weight:500;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.04em}
input[type=search],select{background:var(--bg-surface);color:var(--text-primary);border:1px solid var(--border-color);border-radius:var(--radius-md);padding:8px 12px;font:400 .875rem var(--font-sans);min-width:0;transition:var(--transition-fast)}
input[type=search]{padding-left:36px;width:100%}select{padding-right:28px}
input[type=search]:hover,select:hover{border-color:var(--border-hover)}
input[type=search]:focus,select:focus{outline:none;border-color:var(--accent-primary);box-shadow:0 0 0 2px rgba(99,102,241,.2)}
.search{position:relative}.search .icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--text-secondary);pointer-events:none}
.filters{display:grid;grid-template-columns:minmax(220px,1.4fr) repeat(2,minmax(150px,1fr)) auto;gap:16px;align-items:end}
.switch{display:flex;align-items:center;gap:8px;color:var(--text-secondary);cursor:pointer;height:38px;font-weight:500}
.switch input{accent-color:var(--accent-primary);width:16px;height:16px}
.btn{display:inline-flex;align-items:center;gap:8px;padding:8px 16px;border-radius:var(--radius-md);border:1px solid var(--border-color);background:transparent;color:var(--text-primary);font:500 .875rem var(--font-sans);cursor:pointer;transition:var(--transition-fast)}
.btn:hover{border-color:var(--accent-primary);color:var(--indigo-300);background:rgba(99,102,241,.05)}
.btn.icon-only{padding:8px}

/* tables */
.table-wrap{overflow-x:auto;border:1px solid var(--border-color);border-radius:var(--radius-md)}
table{width:100%;border-collapse:collapse}
th{padding:12px 16px;text-align:left;font-size:.75rem;font-weight:500;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.04em;background:rgba(255,255,255,.02);border-bottom:1px solid var(--border-color);white-space:nowrap}
td{padding:12px 16px;border-bottom:1px solid var(--border-color);vertical-align:top}
tr:last-child td{border-bottom:0}
tbody tr:hover td{background:rgba(255,255,255,.02)}
tr.group td{background:rgba(255,255,255,.03);font-size:.75rem;color:var(--text-secondary);font-weight:500;padding:8px 16px}
td.r,th.r{text-align:right}
table.compact th,table.compact td{padding:10px 12px}
.when2 .d{font-weight:500;white-space:nowrap}.when2 .t{color:var(--text-secondary);font-size:.75rem;white-space:nowrap}
.empty{padding:32px;text-align:center;color:var(--text-secondary)}

/* meter */
.meter{display:flex;align-items:center;gap:12px;min-width:170px}
.track{flex:1;min-width:80px;height:6px;border-radius:var(--radius-full);background:rgba(255,255,255,.08);overflow:hidden}
.fill{height:100%;border-radius:inherit;background:var(--gradient-primary)}
.meter.warn .fill{background:var(--warning)}.meter.bad .fill{background:var(--error)}
.meter .pct{min-width:44px;text-align:right;font-weight:600}.meter.warn .pct{color:#facc15}.meter.bad .pct{color:#f87171}
.meter.none .fill{width:0}

/* consumption layout + sidebar */
.layout{display:grid;grid-template-columns:320px minmax(0,1fr);gap:24px;align-items:start}
.sidebar{position:sticky;top:88px;max-height:calc(100vh - 112px);overflow:auto;padding:16px}
.sb-collapsed .layout{grid-template-columns:minmax(0,1fr)}.sb-collapsed .sidebar{display:none}
.sidebar h2{font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-secondary);font-weight:600;padding:4px 8px 12px}
.sidebar-head{display:flex;align-items:center;justify-content:space-between}
.acct{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid transparent;border-radius:var(--radius-md);color:var(--text-primary);transition:var(--transition-fast)}
.acct:hover{background:var(--bg-surface-hover);color:var(--text-primary)}
.acct[aria-current="page"]{background:var(--gradient-subtle);border-color:rgba(99,102,241,.4)}
.avatar{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:var(--gradient-subtle);color:var(--indigo-300);font-weight:600;flex:none;text-transform:uppercase}
.acct .t{min-width:0;flex:1}.acct .e{overflow-wrap:anywhere;font-weight:500;line-height:1.35}.acct .p{font-size:.75rem;color:var(--text-secondary)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--error);flex:none;box-shadow:0 0 0 3px rgba(239,68,68,.15)}
.who h1{font-size:1.5rem;overflow-wrap:anywhere}
.chips{display:flex;gap:8px;flex-wrap:wrap}.chips.pad{margin-top:12px}
.section-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.section-head .grow{flex:1}
.note{display:flex;gap:12px;padding:12px 16px;border-radius:var(--radius-md);background:rgba(255,255,255,.03);border:1px solid var(--border-color);color:var(--text-secondary);margin-bottom:16px}
.note.bad{background:rgba(239,68,68,.08);border-color:rgba(239,68,68,.3);color:#fca5a5}
details{border-top:1px solid var(--border-color);margin-top:16px;padding-top:12px}
summary{cursor:pointer;display:flex;align-items:center;gap:8px;color:var(--text-secondary);font-weight:500;list-style:none}
summary::-webkit-details-marker{display:none}summary:hover{color:var(--text-primary)}
summary .icon{transition:transform var(--transition-fast)}details[open]>summary .icon.chev{transform:rotate(180deg)}

/* change history */
.event{display:grid;grid-template-columns:auto 1fr;gap:16px;padding:16px 0;border-top:1px solid var(--border-color)}
.event:first-child{border-top:0;padding-top:0}
.event .when{color:var(--text-secondary);font-size:.75rem;white-space:nowrap;min-width:150px}
.diff{margin:12px 0 0;background:var(--bg-color);border:1px solid var(--border-color);border-radius:var(--radius-md);padding:12px;overflow:auto;font:400 .75rem/1.6 var(--font-mono);max-height:340px}
.diff span{display:block;white-space:pre-wrap;overflow-wrap:anywhere}
.diff .add{color:#4ade80;background:rgba(34,197,94,.08)}.diff .del{color:#f87171;background:rgba(239,68,68,.08)}.diff .hunk{color:var(--accent-secondary)}
.sources p{margin:4px 0 8px}.sources a{display:inline-block;margin:0 12px 4px 0;font-size:.75rem}

footer{color:var(--text-secondary);font-size:.75rem;padding:24px 0 48px;border-top:1px solid var(--border-color)}

@media (max-width:960px){
  .filters{grid-template-columns:1fr 1fr}.filters .search-f{grid-column:1/-1}
  .layout{grid-template-columns:minmax(0,1fr)}
  .sidebar{position:fixed;z-index:25;top:72px;left:12px;bottom:12px;width:min(320px,86vw);max-height:none;box-shadow:0 10px 15px rgba(0,0,0,.4)}
  .nav .container{gap:12px}.brand span{display:none}.nav-meta{display:none}
}
@media (max-width:560px){.container{padding:0 16px}.brand div{display:none}.tabs{margin-left:0}.tab{padding:8px 12px}.tab .icon{display:none}.event{grid-template-columns:1fr;gap:4px}h1{font-size:1.5rem}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

const SCRIPT = `
(()=>{
  const b=document.body,K='stl-sidebar';
  let v=null;try{v=localStorage.getItem(K)}catch(e){}
  if(v==='1'||(v===null&&matchMedia('(max-width:960px)').matches))b.classList.add('sb-collapsed');
  const sync=()=>document.querySelectorAll('[data-sidebar-toggle]').forEach(t=>t.setAttribute('aria-expanded',String(!b.classList.contains('sb-collapsed'))));
  document.querySelectorAll('[data-sidebar-toggle]').forEach(t=>t.addEventListener('click',()=>{
    const c=b.classList.toggle('sb-collapsed');try{localStorage.setItem(K,c?'1':'0')}catch(e){}sync();
  }));
  sync();
  const t=document.getElementById('limits');if(!t)return;
  const rows=[...t.querySelectorAll('tbody tr')],count=document.getElementById('count'),empty=document.getElementById('none');
  const s={q:'',p:new Set(),c:'',f:'',t:false};
  const apply=()=>{let n=0;rows.forEach(r=>{const d=r.dataset;
    const ok=(!s.p.size||s.p.has(d.platform))&&(!s.c||d.category===s.c)&&(!s.f||d.freq===s.f)&&(!s.t||d.tracked==='1')&&(!s.q||d.text.includes(s.q));
    r.hidden=!ok;if(ok)n++});
    count.textContent='Showing '+n+' of '+rows.length+' limits';empty.hidden=n>0;t.parentElement.hidden=n===0;};
  document.getElementById('q').addEventListener('input',e=>{s.q=e.target.value.trim().toLowerCase();apply()});
  document.getElementById('cat').addEventListener('change',e=>{s.c=e.target.value;apply()});
  document.getElementById('freq').addEventListener('change',e=>{s.f=e.target.value;apply()});
  document.getElementById('trk').addEventListener('change',e=>{s.t=e.target.checked;apply()});
  document.querySelectorAll('[data-chip]').forEach(c=>c.addEventListener('click',()=>{
    const on=c.getAttribute('aria-pressed')!=='true';c.setAttribute('aria-pressed',String(on));
    on?s.p.add(c.dataset.chip):s.p.delete(c.dataset.chip);apply();
  }));
  document.getElementById('reset').addEventListener('click',()=>{
    s.q='';s.p.clear();s.c='';s.f='';s.t=false;
    document.getElementById('q').value='';document.getElementById('cat').value='';document.getElementById('freq').value='';document.getElementById('trk').checked=false;
    document.querySelectorAll('[data-chip]').forEach(c=>c.setAttribute('aria-pressed','false'));apply();
  });
  apply();
})();
`;

export interface ShellOptions {
  title: string;
  active: "limits" | "consumption";
  body: string;
  /** "Updated 12 min ago" for the navbar. */
  updated: string;
  /** Zone label for the navbar, e.g. "IST". */
  zone: string;
}

export function shell(o: ShellOptions): string {
  const tab = (href: string, id: ShellOptions["active"], ico: IconName, label: string) =>
    `<a class="tab" href="${href}"${o.active === id ? ' aria-current="page"' : ""}>${icon(ico, 16)}${label}</a>`;
  const favicon = `data:image/svg+xml,${encodeURIComponent(LOGO_SVG)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="dark"><title>${esc(o.title)} · Free-tier monitor</title><link rel="icon" href="${favicon}"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet"><style>${CSS}</style></head><body>
<header class="nav"><div class="container"><a class="brand" href="/" aria-label="Free-tier monitor home">${LOGO_SVG}<div><b>Free-tier monitor</b><span>Sarvam Tech Labs</span></div></a>
<nav class="tabs" aria-label="Sections">${tab("/", "limits", "gauge", "Free-tier limits")}${tab("/consumption", "consumption", "users", "Consumption")}</nav>
<div class="nav-meta">${icon("clock", 14)}<span>${esc(o.updated)} · times in ${esc(o.zone)}</span></div></div></header>
<main><div class="container">${o.body}</div></main>
<footer><div class="container">Sarvam Tech Labs · read-only monitoring on free tiers · <a href="/classic">Raw 7-day table and spike detection</a></div></footer>
<script>${SCRIPT}</script></body></html>`;
}
