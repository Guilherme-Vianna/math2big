"use strict";

/* =========================================================
   math2big — interface
   ========================================================= */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const MAX_SIDE = 2000;                 // lado máximo enviado ao modelo
const MAX_SOURCE_SIDE = 2800;          // lado máximo guardado para recorte/giro
const MAX_B64 = 3.5 * 1024 * 1024;     // a Vercel aceita no máximo 4,5 MB por requisição
const CONCURRENCY = 2;
const HISTORY_KEY = "math2big.history.v2";
const THEME_KEY = "math2big.theme";
const MODEL_KEY = "math2big.model";
const HISTORY_MAX = 40;

const els = {
  app: $("#app"), file: $("#file"), camera: $("#camera"), dropzone: $("#dropzone"),
  btnCamera: $("#btn-camera"), btnExample: $("#btn-example"),
  model: $("#model"), btnTheme: $("#btn-theme"), btnHistory: $("#btn-history"), btnHelp: $("#btn-help"),
  pages: $("#pages"), stage: $("#stage"), imgWrap: $("#img-wrap"), img: $("#source-img"),
  viewerTools: $("#viewer-tools"), cropTools: $("#crop-tools"), cropLayer: $("#crop-layer"), cropBox: $("#crop-box"),
  cropApply: $("#crop-apply"), cropCancel: $("#crop-cancel"),
  tRotate: $("#t-rotate"), tCrop: $("#t-crop"), tRerun: $("#t-rerun"), tZoom: $("#t-zoom"), tRemove: $("#t-remove"),
  hint: $("#hint"),
  segs: $$(".seg"), unsure: $("#unsure-badge"), aCopy: $("#a-copy"), aMore: $("#a-more"), menu: $("#export-menu"),
  render: $("#render"), editor: $("#editor"), source: $("#source"), preview: $("#preview"), restore: $("#e-restore"),
  meta: $("#meta"),
  drawer: $("#drawer"), scrim: $("#scrim"), drawerClose: $("#drawer-close"), hSearch: $("#h-search"), hList: $("#h-list"), hClear: $("#h-clear"),
  help: $("#help"), lightbox: $("#lightbox"), lightboxImg: $("#lightbox-img"), dropOverlay: $("#drop-overlay"), toast: $("#toast"),
};

const state = { pages: [], activeId: null, mode: "view", cropping: false };
let seq = 0;

/* ---------------- utilidades ---------------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (name, cls = "i i-sm") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const activePage = () => state.pages.find((p) => p.id === state.activeId) || null;
const isTyping = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

let toastTimer;
function toast(msg, ic = "check") {
  els.toast.innerHTML = `${icon(ic)}<span>${escapeHtml(msg)}</span>`;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 1800);
}

function cleanFences(text) {
  const t = text.trim();
  const m = t.match(/^```[a-zA-Z]*\n?([\s\S]*?)\n?```$/);
  return m ? m[1].trim() : t;
}

/* ---------------- tema e modelos ---------------- */
function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
applyTheme(store.get(THEME_KEY, null));
els.btnTheme.onclick = () => {
  const dark = getComputedStyle(document.documentElement).colorScheme === "dark";
  const next = dark ? "light" : "dark";
  applyTheme(next); store.set(THEME_KEY, next);
};

fetch("/api/models").then((r) => r.json()).then(({ default: def, models }) => {
  const saved = store.get(MODEL_KEY, def);
  for (const m of models) {
    const o = new Option(m.label, m.id, false, m.id === saved);
    els.model.append(o);
  }
  if (!models.length) els.model.append(new Option("Nenhum modelo configurado", ""));
}).catch(() => els.model.append(new Option("Servidor indisponível", "")));
els.model.onchange = () => { store.set(MODEL_KEY, els.model.value); toast("Modelo alterado — vale para as próximas conversões"); };

/* ---------------- imagens ---------------- */
function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}

function drawToCanvas(source, maxSide) {
  const w0 = source.naturalWidth || source.width, h0 = source.naturalHeight || source.height;
  const s = Math.min(1, maxSide / Math.max(w0, h0));
  const c = document.createElement("canvas");
  c.width = Math.round(w0 * s); c.height = Math.round(h0 * s);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return c;
}

function encodeForModel(canvas) {
  const c = drawToCanvas(canvas, MAX_SIDE);
  let dataUrl = c.toDataURL("image/png"), mediaType = "image/png";
  for (let q = 0.92; dataUrl.length > MAX_B64 && q >= 0.5; q -= 0.1) {
    dataUrl = c.toDataURL("image/jpeg", q); mediaType = "image/jpeg";
  }
  return { b64: dataUrl.split(",")[1], mediaType };
}

function refreshPageImage(page) {
  page.display = page.canvas.toDataURL("image/jpeg", 0.9);
  page.thumb = drawToCanvas(page.canvas, 400).toDataURL("image/jpeg", 0.72);
}

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f && f.type.startsWith("image/"));
  if (!files.length) return toast("Nenhuma imagem encontrada", "alert");
  let first = null;
  for (const file of files) {
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      const page = newPage(drawToCanvas(img, MAX_SOURCE_SIDE));
      state.pages.push(page);
      first ??= page;
      enqueue(page);
    } catch {
      toast(`Não consegui abrir “${file.name || "imagem"}”`, "alert");
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (first) { select(first.id); }
  if (files.length > 1) toast(`${files.length} páginas adicionadas`);
}

function newPage(canvas) {
  const page = {
    id: `p${++seq}`, canvas, display: "", thumb: "", status: "idle",
    content: "", original: "", partial: "", error: null, errorStatus: null, meta: null,
    startedAt: 0, controller: null, historyId: null,
  };
  refreshPageImage(page);
  return page;
}

/* ---------------- fila de conversão ---------------- */
function enqueue(page) {
  if (page.controller) page.controller.abort();
  page.status = "queued"; page.error = null; page.partial = "";
  pump();
  renderAll();
}

function pump() {
  const running = state.pages.filter((p) => p.status === "running").length;
  const next = state.pages.filter((p) => p.status === "queued").slice(0, Math.max(0, CONCURRENCY - running));
  next.forEach(convert);
}

async function convert(page) {
  page.status = "running"; page.partial = ""; page.error = null; page.startedAt = performance.now();
  const controller = new AbortController();
  page.controller = controller;
  renderAll();

  const { b64, mediaType } = encodeForModel(page.canvas);
  const body = JSON.stringify({ image: b64, media_type: mediaType, model: els.model.value || null, hint: els.hint.value.trim() || null });
  let done = null, failure = null;

  try {
    const res = await fetch("/api/ocr/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: controller.signal });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      failure = { message: data.detail || `Erro ${res.status}`, status: res.status };
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (msg.delta) { page.partial += msg.delta; scheduleLive(page); }
          else if (msg.error) failure = { message: msg.error, status: msg.status };
          else if (msg.done) done = msg;
        }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") return;           // página removida ou reconvertida
    failure = { message: "Sem conexão com o servidor. Verifique sua internet e tente de novo." };
  }
  if (page.controller !== controller) return;         // uma conversão mais nova assumiu
  page.controller = null;

  if (!failure && !page.partial.trim()) failure = { message: "A conversão terminou sem texto. Tente de novo." };
  if (failure) {
    page.status = "error"; page.error = failure.message; page.errorStatus = failure.status || null;
  } else {
    page.status = "done";
    page.content = page.original = cleanFences(page.partial);
    const secs = ((performance.now() - page.startedAt) / 1000).toFixed(1);
    page.meta = { model: done?.model || els.model.value, secs };
    saveToHistory(page);
    if (page.id !== state.activeId) toast(`Página ${pageIndex(page) + 1} pronta`);
  }
  page.partial = "";
  renderAll();
  pump();
}

let liveQueued = false;
function scheduleLive(page) {
  if (page.id !== state.activeId || liveQueued) return;
  liveQueued = true;
  setTimeout(() => { liveQueued = false; renderResult(); }, 60);
}

/* ---------------- renderização de matemática ---------------- */
const KATEX_OPTS = {
  throwOnError: false, strict: "ignore",
  trust: (ctx) => ctx.command === "\\htmlClass",
};
const markUnsure = (tex) => tex.replace(/\\text\{\s*\[\?\]\s*\}/g, "\\htmlClass{unsure}{\\text{[?]}}");

function segments(src) {
  const out = []; const re = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g;
  let last = 0, m;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ type: "text", value: src.slice(last, m.index) });
    out.push({ type: "math", value: (m[1] ?? m[2]).trim() });
    last = re.lastIndex;
  }
  if (last < src.length) out.push({ type: "text", value: src.slice(last) });
  return out;
}

function renderMath(root, src, { streaming = false, interactive = true } = {}) {
  root.innerHTML = "";
  let body = src, pending = "";
  if (streaming) {
    // Não renderiza um bloco $$ que ainda não terminou de chegar.
    const count = (src.match(/\$\$/g) || []).length;
    if (count % 2 === 1) { const cut = src.lastIndexOf("$$"); body = src.slice(0, cut); pending = src.slice(cut); }
  }
  if (!window.katex) { root.textContent = src; return; }

  for (const seg of segments(body)) {
    if (seg.type === "math") {
      const block = document.createElement("div");
      block.className = "formula";
      block.tabIndex = interactive ? 0 : -1;
      const inner = document.createElement("div");
      katex.render(markUnsure(seg.value), inner, { ...KATEX_OPTS, displayMode: true });
      block.append(inner);
      if (interactive && !streaming) {
        block.dataset.tex = seg.value;
        block.title = "Clique para copiar o LaTeX";
        const bar = document.createElement("div");
        bar.className = "f-actions";
        bar.innerHTML = `<button data-act="copy">${icon("copy")}LaTeX</button><button data-act="word">${icon("word")}Word</button><button data-act="edit">${icon("edit")}Editar</button>`;
        block.append(bar);
      }
      root.append(block);
    } else {
      for (const para of seg.value.split(/\n\s*\n/)) {
        if (!para.trim()) continue;
        const p = document.createElement("p");
        p.innerHTML = escapeHtml(para.trim()).replace(/\n/g, "<br>");
        root.append(p);
      }
    }
  }
  if (window.renderMathInElement) {
    $$("p", root).forEach((p) => {
      p.innerHTML = p.innerHTML.replace(/\$([^$]+?)\$/g, (m, inner) => `$${markUnsure(inner)}$`);
      renderMathInElement(p, {
        delimiters: [{ left: "$", right: "$", display: false }, { left: "\\(", right: "\\)", display: false }],
        ...KATEX_OPTS,
      });
      highlightProseUnsure(p);
    });
  }
  if (pending || streaming) {
    const tail = document.createElement("div");
    tail.className = "pending-raw";
    tail.textContent = pending;
    const caret = document.createElement("span"); caret.className = "caret";
    tail.append(caret);
    root.append(tail);
  }
}

function highlightProseUnsure(p) {
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest(".katex") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const hits = [];
  while (walker.nextNode()) if (walker.currentNode.nodeValue.includes("[?]")) hits.push(walker.currentNode);
  for (const node of hits) {
    const span = document.createElement("span");
    span.innerHTML = escapeHtml(node.nodeValue).replace(/(?:\\text\{)?\[\?\]\}?/g, '<span class="unsure">[?]</span>');
    node.replaceWith(...span.childNodes);
  }
}

const countUnsure = (src) => (src.match(/\[\?\]/g) || []).length;
const countFormulas = (src) => segments(src).filter((s) => s.type === "math").length;

/* ---------------- interface: páginas ---------------- */
const pageIndex = (page) => state.pages.indexOf(page);

function renderPages() {
  els.pages.innerHTML = "";
  state.pages.forEach((page, i) => {
    const b = document.createElement("button");
    b.className = "page-tab" + (page.id === state.activeId ? " active" : "");
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", page.id === state.activeId);
    const st = {
      queued: '<span class="spinner" style="opacity:.35;animation:none"></span>',
      running: '<span class="spinner"></span>',
      done: icon("check"),
      error: icon("alert"),
      idle: "",
    }[page.status];
    b.innerHTML = `<img src="${page.thumb}" alt=""><span>Pág. ${i + 1}</span><span class="st" aria-label="${page.status}">${st}</span>`;
    b.onclick = () => select(page.id);
    els.pages.append(b);
  });
  const add = document.createElement("button");
  add.className = "page-add"; add.title = "Adicionar páginas"; add.setAttribute("aria-label", "Adicionar páginas");
  add.innerHTML = icon("plus", "i");
  add.onclick = () => els.file.click();
  els.pages.append(add);
  els.pages.querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function renderViewer() {
  const page = activePage();
  if (!page) return;
  if (els.img.getAttribute("src") !== page.display) els.img.src = page.display;
  const busy = page.status === "running";
  els.tRerun.disabled = busy;
  els.tRerun.classList.toggle("attention", page.status === "error");
}

function select(id) {
  if (state.cropping) exitCrop();
  state.activeId = id;
  renderAll();
}

function removePage(page) {
  if (!page) return;
  page.controller?.abort();
  const i = pageIndex(page);
  state.pages.splice(i, 1);
  const next = state.pages[Math.min(i, state.pages.length - 1)];
  state.activeId = next ? next.id : null;
  renderAll();
  pump();
}

/* ---------------- interface: resultado ---------------- */
const PHASES = [[0, "Enviando a imagem…"], [1.5, "Lendo símbolos, índices e expoentes…"], [3.5, "Montando o LaTeX…"], [12, "Página densa — quase lá…"]];

function renderResult() {
  const page = activePage();
  const r = els.render;
  els.unsure.hidden = true;
  const ready = page?.status === "done";
  els.aCopy.disabled = els.aMore.disabled = !ready;
  els.menu.classList.toggle("single", state.pages.filter((p) => p.status === "done").length < 2);
  if (!page) return;

  const showEditor = ready && state.mode === "edit";
  els.editor.hidden = !showEditor;
  r.hidden = showEditor;
  els.segs.forEach((s) => { s.classList.toggle("active", s.dataset.mode === (showEditor ? "edit" : "view")); s.disabled = !ready; });

  if (page.status === "queued" || (page.status === "running" && !page.partial)) {
    const label = page.status === "queued" ? "Na fila…" : phaseFor(page);
    r.innerHTML = `<div class="loading"><div class="loading-head"><span class="spinner"></span><span class="phase">${label}</span><span class="time"></span></div>
      <div class="sk" style="width:72%"></div><div class="sk formula-sk"></div><div class="sk" style="width:48%"></div><div class="sk formula-sk" style="width:44%"></div><div class="sk" style="width:64%"></div></div>`;
    tick();
  } else if (page.status === "running") {
    renderMath(r, page.partial, { streaming: true });
  } else if (page.status === "error") {
    const quota = page.errorStatus === 429;
    r.innerHTML = `<div class="error-card">${icon("alert", "i")}<div><h3>Não deu para converter esta página</h3><p>${escapeHtml(page.error || "")}</p>
      <div class="row"><button class="btn small primary" data-retry>${icon("refresh")} Tentar de novo</button>
      ${quota ? `<button class="btn small ghost" data-switch>Trocar modelo</button>` : ""}
      <button class="btn small ghost" data-crop>${icon("crop")} Recortar e tentar</button></div></div></div>`;
    $("[data-retry]", r).onclick = () => enqueue(page);
    $("[data-crop]", r).onclick = () => enterCrop();
    const sw = $("[data-switch]", r); if (sw) sw.onclick = () => { els.model.focus(); els.model.showPicker?.(); };
  } else if (ready) {
    if (showEditor) {
      if (els.source.value !== page.content) els.source.value = page.content;
      renderMath(els.preview, page.content, { interactive: false });
    } else {
      renderMath(r, page.content);
      if (!page.content.trim()) r.innerHTML = '<p class="h-empty">Nada reconhecido nesta imagem.</p>';
    }
    const n = countUnsure(page.content);
    if (n) { els.unsure.hidden = false; $("span", els.unsure).textContent = n === 1 ? "1 trecho para conferir" : `${n} trechos para conferir`; }
  }
  renderMeta(page);
}

function phaseFor(page) {
  const t = (performance.now() - page.startedAt) / 1000;
  return PHASES.filter(([s]) => t >= s).pop()[1];
}

function renderMeta(page) {
  const parts = [];
  if (page.status === "done") {
    const f = countFormulas(page.content);
    parts.push(`${f} ${f === 1 ? "fórmula" : "fórmulas"}`);
    if (page.meta?.model) parts.push(page.meta.model);
    if (page.meta?.secs) parts.push(`${page.meta.secs}s`);
    if (page.content !== page.original) parts.push("editado");
  } else if (page.status === "running") {
    parts.push(page.partial ? "recebendo…" : "processando…");
  }
  els.meta.innerHTML = parts.map((p) => `<span>${escapeHtml(p)}</span>`).join("<span>·</span>");
}

setInterval(tick, 250);
function tick() {
  const page = activePage();
  if (!page || page.status !== "running") return;
  const t = ((performance.now() - page.startedAt) / 1000).toFixed(1);
  const time = $(".loading .time", els.render); if (time) time.textContent = `${t}s`;
  const phase = $(".loading .phase", els.render); if (phase) phase.textContent = phaseFor(page);
}

function renderAll() {
  els.app.dataset.view = state.pages.length ? "work" : "empty";
  if (!state.pages.length) return;
  renderPages();
  renderViewer();
  renderResult();
}

/* clique nas fórmulas */
els.render.addEventListener("click", (e) => {
  const page = activePage();
  const btn = e.target.closest(".f-actions button");
  const block = e.target.closest(".formula");
  if (btn && block) {
    e.stopPropagation();
    const tex = block.dataset.tex;
    if (btn.dataset.act === "copy") copyText(tex, "Fórmula copiada");
    if (btn.dataset.act === "word") copyWord([{ type: "math", value: tex }], "Fórmula copiada para o Word");
    if (btn.dataset.act === "edit") { setMode("edit"); focusInEditor(page, tex); }
    return;
  }
  if (block?.dataset.tex) { copyText(block.dataset.tex, "Fórmula copiada"); block.classList.remove("flash"); void block.offsetWidth; block.classList.add("flash"); return; }
  const inline = e.target.closest("p .katex");
  if (inline) {
    const tex = inline.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (tex) copyText(tex.replace(/\\htmlClass\{unsure\}\{(\\text\{\[\?\]\})\}/g, "$1"), "Trecho copiado");
  }
});

function focusInEditor(page, tex) {
  requestAnimationFrame(() => {
    const i = page.content.indexOf(tex);
    els.source.focus();
    if (i >= 0) {
      els.source.setSelectionRange(i, i + tex.length);
      const before = page.content.slice(0, i).split("\n").length;
      els.source.scrollTop = Math.max(0, (before - 3) * 23);
    }
  });
}

/* modos */
function setMode(mode) {
  const page = activePage();
  if (page?.status !== "done") return;
  state.mode = mode;
  renderResult();
}
els.segs.forEach((s) => (s.onclick = () => setMode(s.dataset.mode)));

const syncEdit = debounce(() => {
  const page = activePage(); if (!page) return;
  renderMath(els.preview, page.content, { interactive: false });
  renderMeta(page);
  const n = countUnsure(page.content);
  els.unsure.hidden = !n;
  if (n) $("span", els.unsure).textContent = n === 1 ? "1 trecho para conferir" : `${n} trechos para conferir`;
  saveToHistory(page);
}, 140);
els.source.addEventListener("input", () => { const page = activePage(); if (page) { page.content = els.source.value; syncEdit(); } });
els.restore.onclick = () => {
  const page = activePage(); if (!page) return;
  page.content = page.original; els.source.value = page.content; syncEdit(); toast("Texto original restaurado", "undo");
};

els.unsure.onclick = () => {
  setMode("view");
  const hit = $(".unsure", els.render);
  if (!hit) return;
  hit.scrollIntoView({ block: "center", behavior: "smooth" });
  const block = hit.closest(".formula, p");
  block?.classList.remove("flash"); void block?.offsetWidth; block?.classList.add("flash");
};

/* ---------------- copiar e exportar ---------------- */
async function copyText(text, msg = "Copiado") {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch { toast("O navegador bloqueou a cópia", "alert"); }
}

function mathml(tex, display = true) {
  const html = katex.renderToString(tex, { throwOnError: false, strict: "ignore", output: "mathml", displayMode: display });
  return (html.match(/<math[\s\S]*<\/math>/) || [""])[0]
    .replace(/<annotation[\s\S]*?<\/annotation>/g, "").replace(/<\/?semantics>/g, "");
}

async function copyWord(segs, msg) {
  const htmlParts = [], plainParts = [];
  for (const s of segs) {
    if (s.type === "math") { const m = mathml(s.value); htmlParts.push(`<p>${m}</p>`); plainParts.push(m); }
    else for (const para of s.value.split(/\n\s*\n/)) {
      if (!para.trim()) continue;
      const html = escapeHtml(para.trim()).replace(/\$([^$]+?)\$/g, (_, t) => mathml(t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"), false));
      htmlParts.push(`<p>${html}</p>`); plainParts.push(para.trim());
    }
  }
  const html = `<html><body>${htmlParts.join("")}</body></html>`;
  const plain = plainParts.join("\n\n");
  try {
    await navigator.clipboard.write([new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([plain], { type: "text/plain" }),
    })]);
    toast(msg, "word");
  } catch {
    copyText(plain, msg);
  }
}

function formulasOf(src) {
  const maths = segments(src).filter((s) => s.type === "math").map((s) => s.value);
  return maths.length ? maths.join("\n\n") : src;
}

function texEscapeProse(text) {
  return text.split(/(\$[^$]+?\$)/g).map((chunk, i) => (i % 2 ? chunk : chunk
    .replace(/\\text\{\[\?\]\}/g, "[?]").replace(/([&%#_])/g, "\\$1"))).join("");
}

function toTexDocument(contents) {
  const body = contents.map((src) => segments(src).map((s) => s.type === "math"
    ? `\\[\n${s.value}\n\\]`
    : s.value.split(/\n\s*\n/).map((p) => texEscapeProse(p.trim()).replace(/\n/g, " \\\\\n")).filter(Boolean).join("\n\n")
  ).filter(Boolean).join("\n\n")).join("\n\n\\newpage\n\n");
  return `\\documentclass[12pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[brazil]{babel}
\\usepackage{amsmath,amssymb,amsfonts,mathtools}
\\usepackage[margin=2.5cm]{geometry}

\\begin{document}

${body}

\\end{document}
`;
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`${name} baixado`, "download");
}

function copyLatex() {
  const page = activePage();
  if (page?.status !== "done") return;
  const n = countFormulas(page.content);
  copyText(formulasOf(page.content), n > 1 ? `${n} fórmulas copiadas` : "LaTeX copiado");
}
els.aCopy.onclick = copyLatex;

function toggleMenu(open = els.menu.hidden) {
  els.menu.hidden = !open;
  els.aMore.setAttribute("aria-expanded", open);
  if (open) els.menu.querySelector("button:not([hidden])")?.focus();
}
els.aMore.onclick = (e) => { e.stopPropagation(); toggleMenu(); };
document.addEventListener("click", (e) => { if (!els.menu.hidden && !e.target.closest(".menu-wrap")) toggleMenu(false); });

els.menu.addEventListener("click", (e) => {
  const item = e.target.closest("[data-export]");
  if (!item) return;
  toggleMenu(false);
  const page = activePage();
  const n = pageIndex(page) + 1;
  const done = state.pages.filter((p) => p.status === "done");
  switch (item.dataset.export) {
    case "copy-md": return copyText(page.content, "Markdown copiado");
    case "copy-word": return copyWord(segments(page.content), "Copiado — cole no Word");
    case "dl-tex": return download(`math2big-pagina-${n}.tex`, toTexDocument([page.content]), "application/x-tex");
    case "dl-md": return download(`math2big-pagina-${n}.md`, page.content + "\n", "text/markdown");
    case "all-copy": return copyText(done.map((p) => p.content).join("\n\n---\n\n"), `${done.length} páginas copiadas`);
    case "all-tex": return download("math2big.tex", toTexDocument(done.map((p) => p.content)), "application/x-tex");
  }
});

/* ---------------- girar, recortar, ampliar ---------------- */
const rerunSoon = debounce((page) => { if (state.pages.includes(page)) enqueue(page); }, 900);

els.tRotate.onclick = () => {
  const page = activePage(); if (!page || state.cropping) return;
  const src = page.canvas, c = document.createElement("canvas");
  c.width = src.height; c.height = src.width;
  const ctx = c.getContext("2d");
  ctx.translate(c.width, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(src, 0, 0);
  page.canvas = c; refreshPageImage(page);
  renderPages(); renderViewer();
  toast("Imagem girada — reconvertendo…", "rotate");
  rerunSoon(page);
};

els.tRerun.onclick = () => { const page = activePage(); if (page && page.status !== "running") enqueue(page); };
els.tRemove.onclick = () => removePage(activePage());
els.tCrop.onclick = () => (state.cropping ? exitCrop() : enterCrop());

let cropStart = null, cropRect = null;
function enterCrop() {
  if (!activePage()) return;
  state.cropping = true; cropRect = null;
  els.viewerTools.hidden = true; els.cropTools.hidden = false;
  els.cropLayer.hidden = false; els.cropLayer.classList.add("active"); els.cropLayer.classList.remove("has-box");
  els.cropBox.hidden = true; els.cropApply.disabled = true;
}
function exitCrop() {
  state.cropping = false;
  els.viewerTools.hidden = false; els.cropTools.hidden = true;
  els.cropLayer.hidden = true; els.cropLayer.classList.remove("active", "has-box");
}
function layerPoint(e) {
  const r = els.cropLayer.getBoundingClientRect();
  return { x: Math.min(Math.max(e.clientX - r.left, 0), r.width), y: Math.min(Math.max(e.clientY - r.top, 0), r.height) };
}
els.cropLayer.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  els.cropLayer.setPointerCapture(e.pointerId);
  cropStart = layerPoint(e);
  cropRect = { x: cropStart.x, y: cropStart.y, w: 0, h: 0 };
  els.cropLayer.classList.add("has-box");
  drawCropBox();
});
els.cropLayer.addEventListener("pointermove", (e) => {
  if (!cropStart) return;
  const p = layerPoint(e);
  cropRect = { x: Math.min(p.x, cropStart.x), y: Math.min(p.y, cropStart.y), w: Math.abs(p.x - cropStart.x), h: Math.abs(p.y - cropStart.y) };
  drawCropBox();
});
els.cropLayer.addEventListener("pointerup", () => { cropStart = null; els.cropApply.disabled = !(cropRect && cropRect.w > 12 && cropRect.h > 12); });
function drawCropBox() {
  Object.assign(els.cropBox.style, { left: `${cropRect.x}px`, top: `${cropRect.y}px`, width: `${cropRect.w}px`, height: `${cropRect.h}px` });
  els.cropBox.hidden = false;
}
els.cropCancel.onclick = exitCrop;
els.cropApply.onclick = () => {
  const page = activePage();
  if (!page || !cropRect) return;
  const scale = page.canvas.width / els.cropLayer.clientWidth;
  const sx = Math.round(cropRect.x * scale), sy = Math.round(cropRect.y * scale);
  const sw = Math.round(cropRect.w * scale), sh = Math.round(cropRect.h * scale);
  const c = document.createElement("canvas"); c.width = sw; c.height = sh;
  c.getContext("2d").drawImage(page.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  page.canvas = c; refreshPageImage(page);
  exitCrop();
  enqueue(page);
  toast("Recortado — convertendo só essa área", "crop");
};

els.img.addEventListener("click", () => openLightbox());
els.tZoom.onclick = () => openLightbox();
function openLightbox() {
  const page = activePage(); if (!page || state.cropping) return;
  els.lightboxImg.src = page.display; els.lightbox.hidden = false;
}
els.lightbox.onclick = () => (els.lightbox.hidden = true);

/* ---------------- histórico ---------------- */
function saveToHistory(page) {
  if (page.status !== "done") return;
  const list = store.get(HISTORY_KEY, []);
  page.historyId ??= `h${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const entry = { id: page.historyId, ts: Date.now(), thumb: page.thumb, content: page.content, model: page.meta?.model };
  const i = list.findIndex((h) => h.id === entry.id);
  if (i >= 0) list.splice(i, 1);
  list.unshift(entry);
  while (list.length && !store.set(HISTORY_KEY, list.slice(0, HISTORY_MAX))) list.pop(); // se estourar o espaço, descarta os mais antigos
  if (!els.drawer.hidden) renderHistory();
}

function renderHistory() {
  const q = els.hSearch.value.trim().toLowerCase();
  const list = store.get(HISTORY_KEY, []).filter((h) => !q || h.content.toLowerCase().includes(q));
  els.hList.innerHTML = "";
  if (!list.length) { els.hList.innerHTML = `<li class="h-empty">${q ? "Nada encontrado." : "Suas conversões aparecem aqui."}</li>`; return; }
  for (const h of list) {
    const li = document.createElement("li");
    li.className = "h-item"; li.tabIndex = 0;
    li.innerHTML = `<img src="${h.thumb}" alt=""><div class="h-body"><div class="h-text"></div><div class="h-date">${new Date(h.ts).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</div></div>
      <button class="icon-btn" aria-label="Apagar do histórico">${icon("trash")}</button>`;
    $(".h-text", li).textContent = h.content.replace(/\s+/g, " ").slice(0, 140);
    li.onclick = () => openFromHistory(h);
    li.onkeydown = (e) => { if (e.key === "Enter") openFromHistory(h); };
    $("button", li).onclick = (e) => {
      e.stopPropagation();
      store.set(HISTORY_KEY, store.get(HISTORY_KEY, []).filter((x) => x.id !== h.id));
      renderHistory();
    };
    els.hList.append(li);
  }
}

async function openFromHistory(h) {
  const existing = state.pages.find((p) => p.historyId === h.id);
  if (existing) { select(existing.id); closeDrawer(); return; }
  const img = await loadImage(h.thumb);
  const page = newPage(drawToCanvas(img, MAX_SOURCE_SIDE));
  Object.assign(page, { status: "done", content: h.content, original: h.content, historyId: h.id, meta: { model: h.model } });
  state.pages.push(page);
  select(page.id);
  closeDrawer();
}

function openDrawer() { els.drawer.hidden = false; els.scrim.hidden = false; renderHistory(); els.hSearch.focus(); }
function closeDrawer() { els.drawer.hidden = true; els.scrim.hidden = true; }
els.btnHistory.onclick = () => (els.drawer.hidden ? openDrawer() : closeDrawer());
els.drawerClose.onclick = closeDrawer;
els.scrim.onclick = closeDrawer;
els.hSearch.oninput = renderHistory;
els.hClear.onclick = () => { if (confirm("Apagar todo o histórico deste navegador?")) { store.set(HISTORY_KEY, []); renderHistory(); } };

/* ---------------- ajuda ---------------- */
els.btnHelp.onclick = () => els.help.showModal();
els.help.addEventListener("click", (e) => { if (e.target === els.help || e.target.closest("[data-close]")) els.help.close(); });

/* ---------------- entrada de arquivos ---------------- */
els.dropzone.onclick = () => els.file.click();
els.btnCamera.onclick = () => els.camera.click();
els.file.onchange = () => { addFiles(els.file.files); els.file.value = ""; };
els.camera.onchange = () => { addFiles(els.camera.files); els.camera.value = ""; };
els.btnExample.onclick = async () => {
  const blob = await (await fetch("/exemplo.png")).blob();
  addFiles([new File([blob], "exemplo.png", { type: "image/png" })]);
};

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; els.dropOverlay.hidden = false; });
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; els.dropOverlay.hidden = true; } });
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; els.dropOverlay.hidden = true;
  addFiles(e.dataTransfer.files);
});
window.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith("image/")).map((i) => i.getAsFile());
  if (files.length) { e.preventDefault(); addFiles(files); }
});

/* ---------------- teclado ---------------- */
window.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === "Escape") {
    if (!els.lightbox.hidden) return (els.lightbox.hidden = true);
    if (!els.menu.hidden) return toggleMenu(false);
    if (state.cropping) return exitCrop();
    if (!els.drawer.hidden) return closeDrawer();
  }
  if (mod && e.key === "Enter") { e.preventDefault(); return els.tRerun.click(); }
  if (mod && e.shiftKey && e.key.toLowerCase() === "c") { e.preventDefault(); return copyLatex(); }
  if (mod || e.altKey || isTyping(e) || els.help.open) return;
  const page = activePage();
  switch (e.key) {
    case "?": els.help.showModal(); break;
    case "h": case "H": els.btnHistory.click(); break;
    case "e": case "E": if (page) setMode(state.mode === "edit" ? "view" : "edit"); break;
    case "r": case "R": if (page) els.tRotate.click(); break;
    case "c": case "C": if (page) els.tCrop.click(); break;
    case "Delete": if (page) removePage(page); break;
    case "ArrowLeft": case "ArrowRight": {
      if (!page) break;
      const i = pageIndex(page) + (e.key === "ArrowLeft" ? -1 : 1);
      if (state.pages[i]) select(state.pages[i].id);
      break;
    }
  }
});

window.addEventListener("load", renderAll);
renderAll();
