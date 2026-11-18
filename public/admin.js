"use strict";

/* =========================================================
   math2big — painel administrativo
   ========================================================= */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const PAGE = 50;
const THEME_KEY = "math2big.theme";

const state = { tab: "overview", days: 30, offset: 0, total: 0, settings: null, models: [], detailId: null };

/* ---------------- utilidades ---------------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = new Intl.NumberFormat("pt-BR");
const num = (n) => nf.format(Math.round(Number(n) || 0));
const compact = (n) => new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 }).format(Number(n) || 0);
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "—");
const secs = (ms) => (ms == null || ms === 0 ? "—" : `${(ms / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: 1 })} s`);
const bytes = (b) => (!b ? "—" : b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const when = (iso) => new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
const icon = (name, cls = "i i-sm") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const EVENT_LABELS = {
  copy_all: "Copiou todo o LaTeX", copy_formula: "Copiou uma fórmula", copy_inline: "Copiou um trecho inline",
  copy_word: "Copiou para o Word", copy_word_formula: "Copiou fórmula para o Word", export_md: "Copiou Markdown",
  export_tex: "Baixou .tex (todas)", download_tex: "Baixou .tex", download_md: "Baixou .md", edit_restore: "Restaurou o original",
  rotate: "Girou a imagem", crop: "Recortou a imagem", rerun: "Reconverteu", remove_page: "Removeu página",
  history_open: "Abriu do histórico", model_change: "Trocou de modelo",
};
const SOURCE_LABELS = { upload: "Arquivo", drop: "Arrastar e soltar", paste: "Colar (Ctrl+V)", camera: "Câmera", example: "Exemplo",
  rerun: "Reconversão", crop: "Recorte", rotate: "Giro", desconhecido: "Desconhecida" };
const STATUS = { ok: ["ok", "check", "Sucesso"], error: ["error", "alert", "Erro"], aborted: ["aborted", "x", "Abandonada"] };
const pill = (s) => { const [cls, ic, label] = STATUS[s] || ["aborted", "x", s]; return `<span class="pill ${cls}">${icon(ic)}${label}</span>`; };

let toastTimer;
function toast(msg, ic = "check") {
  const t = $("#toast");
  t.innerHTML = `${icon(ic)}<span>${esc(msg)}</span>`;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

async function api(path, opts = {}) {
  const res = await fetch(`/api/admin${path}`, {
    credentials: "same-origin",
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== "/login") { showLogin(); throw new Error("401"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Erro ${res.status}`);
  return data;
}

/* ---------------- tema ---------------- */
function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
try { applyTheme(JSON.parse(localStorage.getItem(THEME_KEY))); } catch { /* sem armazenamento */ }
$("#btn-theme").onclick = () => {
  const next = getComputedStyle(document.documentElement).colorScheme === "dark" ? "light" : "dark";
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, JSON.stringify(next)); } catch { /* ignora */ }
};

/* ---------------- login ---------------- */
function showLogin(note) {
  $("#dash").hidden = true; $("#login-view").hidden = false;
  ["#btn-logout", "#btn-refresh", "#period-wrap"].forEach((s) => ($(s).hidden = true));
  if (note) $("#login-note").innerHTML = note;
  $("#password").focus();
}
function showDash() {
  $("#login-view").hidden = true; $("#dash").hidden = false;
  ["#btn-logout", "#btn-refresh", "#period-wrap"].forEach((s) => ($(s).hidden = false));
  setTab(location.hash.slice(1) || "overview");
}

$("#login-form").onsubmit = async (e) => {
  e.preventDefault();
  const err = $("#login-error"); err.hidden = true;
  try {
    await api("/login", { method: "POST", body: { password: $("#password").value } });
    $("#password").value = "";
    init();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
};
$("#btn-logout").onclick = async () => { await api("/logout", { method: "POST" }).catch(() => {}); showLogin(); };

async function init() {
  const me = await fetch("/api/admin/me").then((r) => r.json()).catch(() => null);
  if (!me) return showLogin("Servidor indisponível.");
  if (!me.configured) {
    showLogin("O painel está desativado. Defina <code>ADMIN_PASSWORD</code> no servidor e reinicie.");
    $("#login-form").querySelectorAll("input, button").forEach((el) => (el.disabled = true));
    return;
  }
  if (!me.authenticated) return showLogin();
  const banner = $("#db-banner");
  banner.hidden = me.database;
  banner.textContent = me.database ? "" : "Banco não configurado: defina DATABASE_URL no servidor para registrar as conversões.";
  showDash();
}

/* ---------------- abas ---------------- */
function setTab(tab) {
  if (!["overview", "requests", "settings"].includes(tab)) tab = "overview";
  state.tab = tab;
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== tab));
  history.replaceState(null, "", `#${tab}`);
  $("#period-wrap").hidden = tab !== "overview";
  refresh();
}
$$(".tabs button").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
$("#btn-refresh").onclick = () => refresh(true);
$("#period").onchange = () => { state.days = Number($("#period").value); refresh(); };

function refresh(user = false) {
  const job = state.tab === "overview" ? loadStats() : state.tab === "requests" ? loadRequests() : loadSettings();
  job.then(() => user && toast("Atualizado")).catch((e) => e.message !== "401" && toast(e.message, "alert"));
}

/* ---------------- visão geral ---------------- */
async function loadStats() {
  const s = await api(`/stats?days=${state.days}`);
  const t = s.totals;
  const kpis = [
    ["Conversões", num(t.requests), `${num(t.ok)} com sucesso · ${pct(t.ok, t.requests)}`],
    ["Erros", num(t.errors), t.aborted ? `${num(t.aborted)} abandonadas` : pct(t.errors, t.requests) + " do total"],
    ["Tokens", compact(t.total_tokens), `${compact(t.input_tokens)} entrada · ${compact(Number(t.output_tokens) + Number(t.thinking_tokens))} saída`],
    ["Tempo médio", secs(t.avg_latency_ms), `p95 ${secs(t.p95_latency_ms)} · 1º texto ${secs(t.avg_first_token_ms)}`],
    ["Usuários", num(t.clients), "navegadores distintos"],
    ["Fórmulas", compact(t.formulas), `${num(t.with_unsure)} conversões com [?]`],
    ["Editadas", num(t.edited), `${pct(t.edited, t.ok)} das convertidas`],
    ["Imagens", bytes(t.image_bytes), "volume enviado"],
  ];
  $("#kpis").innerHTML = kpis.map(([k, v, sub]) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${esc(sub)}</div></div>`).join("");

  barChart($("#chart-requests"), s.daily, [
    { key: "ok", label: "Sucesso", color: "var(--ok)" },
    { key: "errors", label: "Erro / abandonada", color: "var(--err)" },
  ], num);
  barChart($("#chart-tokens"), s.daily, [
    { key: "input_tokens", label: "Entrada", color: "var(--in)" },
    { key: "output_tokens", label: "Saída + raciocínio", color: "var(--out)" },
  ], compact);

  const m = s.models;
  $("#tbl-models").innerHTML = `<thead><tr><th>Modelo</th><th class="num">Conversões</th><th class="num">Sucesso</th>
    <th class="num">Tokens entrada</th><th class="num">Tokens saída</th><th class="num">Raciocínio</th>
    <th class="num">Tempo médio</th><th class="num">p95</th><th class="num">Editadas</th></tr></thead><tbody>${
    m.length ? m.map((r) => `<tr><td>${esc(r.model)}</td><td class="num">${num(r.requests)}</td><td class="num">${pct(r.ok, r.requests)}</td>
      <td class="num">${num(r.input_tokens)}</td><td class="num">${num(r.output_tokens)}</td><td class="num">${num(r.thinking_tokens)}</td>
      <td class="num">${secs(r.avg_latency_ms)}</td><td class="num">${secs(r.p95_latency_ms)}</td><td class="num">${pct(r.edited, r.ok)}</td></tr>`).join("")
      : `<tr><td colspan="9" class="muted">Nenhuma conversão no período.</td></tr>`}</tbody>`;

  barList($("#list-events"), s.events.map((e) => [EVENT_LABELS[e.kind] || e.kind, e.n]), "Nenhuma ação registrada.");
  barList($("#list-sources"), s.sources.map((e) => [SOURCE_LABELS[e.source] || e.source, e.n]), "Sem dados.");
  $("#list-errors").innerHTML = s.errors.length
    ? s.errors.map((e) => `<li><span>${esc(e.error || "(sem mensagem)")}</span><span class="n">${num(e.n)}</span></li>`).join("")
    : `<li class="empty-li">Nenhum erro no período.</li>`;
}

function barList(el, rows, empty) {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  el.innerHTML = rows.length
    ? rows.map(([label, n]) => `<li><span>${esc(label)}</span><span class="n">${num(n)}</span><div class="track"><div class="fill" style="width:${(100 * n) / max}%"></div></div></li>`).join("")
    : `<li class="empty-li">${empty}</li>`;
}

/* Barras empilhadas por dia, com dica ao passar o mouse. */
function barChart(el, data, series, fmt) {
  const W = Math.max(el.clientWidth, 280), H = el.clientHeight || 220;
  const pad = { l: 44, r: 6, t: 8, b: 24 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const totals = data.map((d) => series.reduce((a, s) => a + Number(d[s.key] || 0), 0));
  const rawMax = Math.max(...totals, 0);
  const max = niceMax(rawMax || 1);
  const step = iw / Math.max(data.length, 1);
  const bw = Math.max(2, Math.min(28, step * 0.7));
  const y = (v) => pad.t + ih - (v / max) * ih;
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(data.length / Math.max(2, Math.floor(iw / 56)));
  const fmtDay = (iso) => { const [, mo, d] = iso.slice(0, 10).split("-"); return `${d}/${mo}`; };

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.label).join(" e "))} por dia">`;
  svg += `<g class="grid">${ticks.map((t) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/>`).join("")}</g>`;
  svg += `<g class="axis">${ticks.map((t) => `<text x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end">${fmt(t)}</text>`).join("")}`;
  data.forEach((d, i) => {
    if (i % labelEvery === 0 || i === data.length - 1) svg += `<text x="${pad.l + step * i + step / 2}" y="${H - 6}" text-anchor="middle">${fmtDay(d.day)}</text>`;
  });
  svg += `</g><g>`;
  data.forEach((d, i) => {
    const cx = pad.l + step * i + step / 2;
    let base = 0;
    const segs = series.map((s) => ({ s, v: Number(d[s.key] || 0) })).filter((x) => x.v > 0);
    segs.forEach((seg, j) => {
      const gap = j > 0 ? 2 : 0;                       // 2px de respiro entre segmentos
      const y0 = y(base) - gap, y1 = y(base + seg.v);
      const h = Math.max(1, y0 - y1);
      svg += j === segs.length - 1
        ? `<path d="${roundTop(cx - bw / 2, y0 - h, bw, h, Math.min(4, bw / 2))}" fill="${seg.s.color}"/>`
        : `<rect x="${cx - bw / 2}" y="${y0 - h}" width="${bw}" height="${h}" fill="${seg.s.color}"/>`;
      base += seg.v;
    });
    svg += `<rect class="hit" data-i="${i}" x="${pad.l + step * i}" y="${pad.t}" width="${step}" height="${ih}"/>`;
  });
  svg += `</g>`;
  if (!rawMax) svg += `<text class="empty" x="${pad.l + iw / 2}" y="${pad.t + ih / 2}" text-anchor="middle">Sem dados no período</text>`;
  svg += `</svg>`;
  el.innerHTML = svg + `<div class="tip" hidden></div>`;

  const tip = $(".tip", el);
  el.onmousemove = (e) => {
    const hit = e.target.closest(".hit");
    if (!hit) { tip.hidden = true; return; }
    const d = data[Number(hit.dataset.i)];
    const date = new Date(`${d.day.slice(0, 10)}T12:00:00`).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short" });
    tip.innerHTML = `<b>${date}</b><br>${series.map((s) => `${s.label}: <b>${num(d[s.key])}</b>`).join("<br>")}`;
    const r = el.getBoundingClientRect();
    tip.style.left = `${Math.min(Math.max(e.clientX - r.left, 70), r.width - 70)}px`;
    tip.style.top = `${e.clientY - r.top}px`;
    tip.hidden = false;
  };
  el.onmouseleave = () => (tip.hidden = true);
}
// Barra com cantos de cima arredondados (a base fica reta, apoiada no eixo).
function roundTop(x, yTop, w, h, r) {
  r = Math.min(r, h);
  return `M${x},${yTop + h} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + w - r} Q${x + w},${yTop} ${x + w},${yTop + r} V${yTop + h} Z`;
}
function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return Math.max(m * p, 2);
  return 10 * p;
}
window.addEventListener("resize", debounce(() => { if (state.tab === "overview" && !$("#dash").hidden) loadStats().catch(() => {}); }, 300));

/* ---------------- conversões ---------------- */
function filterQuery() {
  const p = new URLSearchParams();
  const add = (k, v) => v && p.set(k, v);
  add("q", $("#f-q").value.trim()); add("model", $("#f-model").value); add("status", $("#f-status").value);
  add("edited", $("#f-edited").value); add("days", $("#f-days").value);
  return p;
}

async function loadRequests() {
  const p = filterQuery();
  p.set("limit", PAGE); p.set("offset", state.offset);
  const data = await api(`/requests?${p}`);
  state.total = data.total;
  const sel = $("#f-model"), cur = sel.value;
  sel.innerHTML = `<option value="">Todos os modelos</option>` + data.models.map((m) => `<option ${m === cur ? "selected" : ""}>${esc(m)}</option>`).join("");

  $("#req-count").textContent = `${num(data.total)} ${data.total === 1 ? "conversão" : "conversões"}`;
  $("#tbl-req").innerHTML = `<thead><tr><th>Quando</th><th>Status</th><th>Modelo</th><th>Conteúdo</th>
    <th class="num">Tokens</th><th class="num">Tempo</th><th class="num">Fórmulas</th><th>Cliente</th></tr></thead><tbody>${
    data.items.length ? data.items.map((r) => `<tr data-id="${r.id}" tabindex="0">
      <td>${when(r.created_at)}</td><td>${pill(r.status)}</td><td>${esc(r.model)}</td>
      <td class="snip"><span>${esc(r.snippet) || '<i class="muted">sem texto</i>'}</span></td>
      <td class="num" title="entrada ${num(r.input_tokens)} · saída ${num(r.output_tokens)} · raciocínio ${num(r.thinking_tokens)}">${num(r.total_tokens)}</td>
      <td class="num">${secs(r.latency_ms)}</td>
      <td class="num">${r.formula_count ?? "—"}${r.unsure_count ? `<span class="tag" title="trechos [?]">${r.unsure_count} ?</span>` : ""}${r.edited ? `<span class="tag">editada</span>` : ""}</td>
      <td class="mono muted">${esc((r.client_id || "—").slice(0, 8))}</td></tr>`).join("")
      : `<tr><td colspan="8" class="muted">Nenhuma conversão encontrada.</td></tr>`}</tbody>`;

  const page = Math.floor(state.offset / PAGE) + 1, pages = Math.max(1, Math.ceil(data.total / PAGE));
  $("#pg-info").textContent = `Página ${page} de ${pages}`;
  $("#pg-prev").disabled = state.offset === 0;
  $("#pg-next").disabled = state.offset + PAGE >= data.total;
}
const reloadRequests = () => { state.offset = 0; loadRequests().catch((e) => e.message !== "401" && toast(e.message, "alert")); };
$("#f-q").addEventListener("input", debounce(reloadRequests, 300));
["#f-model", "#f-status", "#f-edited", "#f-days"].forEach((s) => ($(s).onchange = reloadRequests));
$("#filters").onsubmit = (e) => { e.preventDefault(); reloadRequests(); };
$("#pg-prev").onclick = () => { state.offset = Math.max(0, state.offset - PAGE); loadRequests(); };
$("#pg-next").onclick = () => { state.offset += PAGE; loadRequests(); };
$("#btn-export").onclick = () => { location.href = `/api/admin/export.csv?${filterQuery()}`; };

$("#tbl-req").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) openDetail(tr.dataset.id); });
$("#tbl-req").addEventListener("keydown", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr && e.key === "Enter") openDetail(tr.dataset.id); });

/* ---------------- detalhe ---------------- */
function renderMath(root, src) {
  root.innerHTML = "";
  if (!window.katex) { root.textContent = src; return; }
  const re = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g;
  let last = 0, m;
  const prose = (text) => {
    for (const para of text.split(/\n\s*\n/)) {
      if (!para.trim()) continue;
      const p = document.createElement("p");
      p.innerHTML = para.trim().split(/(\$[^$\n]+?\$)/g).map((chunk, i) => (i % 2
        ? katex.renderToString(chunk.slice(1, -1), { throwOnError: false, strict: "ignore" })
        : esc(chunk).replace(/\n/g, "<br>"))).join("");
      root.append(p);
    }
  };
  while ((m = re.exec(src))) {
    prose(src.slice(last, m.index));
    const div = document.createElement("div");
    katex.render((m[1] ?? m[2]).trim(), div, { displayMode: true, throwOnError: false, strict: "ignore" });
    root.append(div);
    last = re.lastIndex;
  }
  prose(src.slice(last));
}

async function openDetail(id) {
  state.detailId = id;
  $("#detail").hidden = false; $("#scrim").hidden = false;
  $("#d-id").textContent = id;
  $("#d-body").innerHTML = `<p class="muted">Carregando…</p>`;
  let data;
  try { data = await api(`/requests/${id}`); } catch (e) { $("#d-body").innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  const r = data.item;
  const meta = [
    ["Quando", when(r.created_at)], ["Status", pill(r.status)], ["Modelo", esc(r.model)], ["Provedor", esc(r.provider)],
    ["Tokens entrada", num(r.input_tokens)], ["Tokens saída", num(r.output_tokens)], ["Raciocínio", num(r.thinking_tokens)],
    ["Total", num(r.total_tokens)], ["Tempo total", secs(r.latency_ms)], ["1º texto em", secs(r.first_token_ms)],
    ["Imagem", `${r.image_width && r.image_height ? `${r.image_width}×${r.image_height} · ` : ""}${bytes(r.image_bytes)}`],
    ["Formato", esc(r.media_type)], ["Origem", esc(SOURCE_LABELS[r.source] || r.source || "—")],
    ["Páginas no lote", r.batch_size ?? "—"], ["Fórmulas", r.formula_count ?? "—"], ["Trechos [?]", r.unsure_count ?? "—"],
    ["Término", esc(r.finish_reason || "—")], ["Raciocínio ativo", r.thinking_used == null ? "—" : r.thinking_used ? "sim" : "não"],
    ["Cliente", `<span class="mono">${esc(r.client_id || "—")}</span>`], ["IP (hash)", `<span class="mono">${esc(r.ip_hash || "—")}</span>`],
  ];
  const c = data.client;
  const blocks = [];
  blocks.push(`<dl class="meta-grid">${meta.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`);
  if (r.error) blocks.push(`<div class="block"><h3>Erro${r.http_status ? ` (${r.http_status})` : ""}</h3><pre class="raw">${esc(r.error)}</pre></div>`);
  if (r.hint) blocks.push(`<div class="block"><h3>Dica do usuário</h3><pre class="raw">${esc(r.hint)}</pre></div>`);

  const versions = [["content", "Resultado do modelo", r.content]];
  if (r.edited_content != null) versions.push(["edited", `Editado pelo usuário · ${when(r.edited_at)}`, r.edited_content]);
  for (const [key, title, text] of versions) {
    if (text == null) continue;
    blocks.push(`<div class="block" data-version="${key}"><h3><span>${esc(title)}</span>
      <span class="seg-tabs"><button class="active" data-view="render">Visualizar</button><button data-view="raw">Texto</button><button data-view="copy">${icon("copy")}</button></span></h3>
      <div class="rendered"></div><pre class="raw" hidden>${esc(text)}</pre></div>`);
  }
  if (r.latex) blocks.push(`<div class="block"><h3><span>Só o LaTeX (${r.formula_count} fórmula${r.formula_count === 1 ? "" : "s"})</span>
    <span class="seg-tabs"><button data-copy-latex>${icon("copy")}Copiar</button></span></h3><pre class="raw">${esc(r.latex)}</pre></div>`);
  if (r.content == null && r.status === "ok") blocks.push(`<p class="muted small">O texto desta conversão não foi guardado (opção desligada ou limpo).</p>`);
  if (data.events.length) blocks.push(`<div class="block"><h3>O que o usuário fez depois</h3><ul class="timeline">${
    data.events.map((ev) => `<li><time>${new Date(ev.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</time><span>${esc(EVENT_LABELS[ev.kind] || ev.kind)}</span></li>`).join("")}</ul></div>`);
  if (c) blocks.push(`<div class="block"><h3>Este cliente</h3><p class="small muted" style="margin:0">${num(c.requests)} conversões · ${compact(c.tokens)} tokens · desde ${when(c.first_seen)} · último uso ${when(c.last_seen)}
    · <a href="#" data-client="${esc(r.client_id)}">ver todas</a></p></div>`);
  if (r.user_agent) blocks.push(`<div class="block"><h3>Navegador</h3><p class="small muted mono" style="margin:0">${esc(r.user_agent)}</p></div>`);
  $("#d-body").innerHTML = blocks.join("");

  for (const [key, , text] of versions) {
    const b = $(`[data-version="${key}"]`, $("#d-body"));
    if (!b) continue;
    renderMath($(".rendered", b), text);
    $(".seg-tabs", b).onclick = (e) => {
      const btn = e.target.closest("button"); if (!btn) return;
      if (btn.dataset.view === "copy") return copy(text);
      $$("button", e.currentTarget).forEach((x) => x.classList.toggle("active", x === btn));
      $(".rendered", b).hidden = btn.dataset.view !== "render";
      $("pre", b).hidden = btn.dataset.view !== "raw";
    };
  }
  $("[data-copy-latex]", $("#d-body"))?.addEventListener("click", () => copy(r.latex));
  $("[data-client]", $("#d-body"))?.addEventListener("click", (e) => {
    e.preventDefault(); closeDetail();
    $("#f-q").value = e.target.dataset.client; $("#f-status").value = ""; $("#f-model").value = ""; $("#f-edited").value = ""; $("#f-days").value = "";
    if (state.tab !== "requests") setTab("requests"); else reloadRequests();
  });
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Copiado"); } catch { toast("O navegador bloqueou a cópia", "alert"); }
}
function closeDetail() { $("#detail").hidden = true; $("#scrim").hidden = true; state.detailId = null; }
$("#d-close").onclick = closeDetail;
$("#scrim").onclick = closeDetail;
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#detail").hidden) closeDetail(); });
$("#d-delete").onclick = async () => {
  if (!state.detailId || !confirm("Apagar este registro de vez? Não dá para desfazer.")) return;
  try { await api(`/requests/${state.detailId}`, { method: "DELETE" }); closeDetail(); toast("Registro apagado", "trash"); refresh(); }
  catch (e) { toast(e.message, "alert"); }
};

/* ---------------- configurações ---------------- */
async function loadSettings() {
  const { settings: s, models } = await api("/settings");
  state.settings = s; state.models = models;
  $("#s-logging").checked = s.logging_enabled;
  $("#s-content").checked = s.store_content;
  $("#s-maint").value = s.maintenance_message || "";
  const disabled = new Set(s.disabled_models || []);
  $("#s-default").innerHTML = `<option value="">Automático (mais novo)</option>` +
    models.map((m) => `<option value="${esc(m.id)}" ${m.id === s.default_model ? "selected" : ""}>${esc(m.label)}</option>`).join("");
  $("#s-models").innerHTML = models.length
    ? models.map((m) => `<label><input type="checkbox" value="${esc(m.id)}" ${disabled.has(m.id) ? "" : "checked"}>${esc(m.label)}</label>`).join("")
    : `<span class="muted small">Nenhum modelo disponível (verifique as chaves de API).</span>`;
  $("#s-status").textContent = "";
}
$("#settings-form").onsubmit = async (e) => {
  e.preventDefault();
  const enabledIds = $$("#s-models input:checked").map((i) => i.value);
  if (state.models.length && !enabledIds.length) return toast("Deixe pelo menos um modelo ativo", "alert");
  const body = {
    logging_enabled: $("#s-logging").checked,
    store_content: $("#s-content").checked,
    default_model: $("#s-default").value || null,
    disabled_models: state.models.map((m) => m.id).filter((id) => !enabledIds.includes(id)),
    maintenance_message: $("#s-maint").value.trim(),
  };
  if (body.default_model && body.disabled_models.includes(body.default_model)) return toast("O modelo padrão precisa estar ativo", "alert");
  try { await api("/settings", { method: "PUT", body }); toast("Configurações salvas"); $("#s-status").textContent = "Vale em até 20 s para os usuários."; }
  catch (ex) { toast(ex.message, "alert"); }
};
$("#purge-form").onsubmit = async (e) => {
  e.preventDefault();
  const days = Number($("#p-days").value), contentOnly = $("#p-content").checked;
  const what = contentOnly ? "o texto dos registros" : "os registros (e eventos)";
  if (!confirm(`Apagar ${what} com mais de ${days} dia(s)? Não dá para desfazer.`)) return;
  try {
    const r = await api("/purge", { method: "POST", body: { older_than_days: days, content_only: contentOnly } });
    $("#p-status").textContent = `${num(r.affected)} registro(s) afetado(s).`;
    toast("Limpeza concluída", "trash");
  } catch (ex) { toast(ex.message, "alert"); }
};

init();
