const $ = (s) => document.querySelector(s);
const els = {
  drop: $("#drop"), file: $("#file"), preview: $("#preview"), hint: $("#hint"),
  run: $("#run"), clear: $("#clear"), model: $("#model"), theme: $("#theme"),
  render: $("#render"), source: $("#source"), status: $("#status"), meta: $("#meta"),
  copyLatex: $("#copy-latex"), copyMd: $("#copy-md"), history: $("#history"),
  clearHistory: $("#clear-history"), toast: $("#toast"),
};

const MAX_SIDE = 2000;          // lado máximo enviado ao modelo
const MAX_B64 = 3.5 * 1024 * 1024; // a Vercel aceita no máximo 4,5 MB por requisição
const HISTORY_KEY = "math2big.history";
const THEME_KEY = "math2big.theme";
const MODEL_KEY = "math2big.model";

let current = null;   // { b64, mediaType, dataUrl }
let busy = false;

/* ---------- storage seguro ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

/* ---------- tema ---------- */
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}
applyTheme(store.get(THEME_KEY, null));
els.theme.onclick = () => {
  const dark = getComputedStyle(document.documentElement).colorScheme === "dark";
  const next = dark ? "light" : "dark";
  applyTheme(next); store.set(THEME_KEY, next);
};

/* ---------- modelos ---------- */
fetch("/api/models").then((r) => r.json()).then(({ default: def, models }) => {
  const saved = store.get(MODEL_KEY, def);
  for (const m of models) {
    const o = document.createElement("option");
    o.value = m.id; o.textContent = m.label;
    if (m.id === saved) o.selected = true;
    els.model.append(o);
  }
});
els.model.onchange = () => store.set(MODEL_KEY, els.model.value);

/* ---------- toast ---------- */
let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 1600);
}

/* ---------- entrada de imagem ---------- */
function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}

async function prepare(file) {
  if (!file || !file.type.startsWith("image/")) return toast("Isso não parece uma imagem");
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    let dataUrl = c.toDataURL("image/png");
    let mediaType = "image/png";
    // Grande demais? Passa para JPEG e reduz a qualidade até caber.
    for (let q = 0.92; dataUrl.length > MAX_B64 && q >= 0.5; q -= 0.1) {
      dataUrl = c.toDataURL("image/jpeg", q); mediaType = "image/jpeg";
    }
    current = { b64: dataUrl.split(",")[1], mediaType, dataUrl, thumb: thumbnail(img) };
    els.preview.src = dataUrl; els.preview.hidden = false;
    els.drop.classList.add("has-image");
    els.run.disabled = false; els.clear.disabled = false;
    els.run.focus();
  } catch {
    toast("Não consegui abrir essa imagem");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function thumbnail(img) {
  const c = document.createElement("canvas");
  const s = 160 / Math.max(img.width, img.height);
  c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.7);
}

els.file.onchange = () => prepare(els.file.files[0]);
els.drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.file.click(); } });
["dragenter", "dragover"].forEach((t) => els.drop.addEventListener(t, (e) => { e.preventDefault(); els.drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => els.drop.addEventListener(t, (e) => { e.preventDefault(); els.drop.classList.remove("over"); }));
els.drop.addEventListener("drop", (e) => prepare(e.dataTransfer.files[0]));
window.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (item) { e.preventDefault(); prepare(item.getAsFile()); }
});
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !els.run.disabled) run();
});

els.clear.onclick = () => {
  current = null; els.file.value = "";
  els.preview.hidden = true; els.preview.removeAttribute("src");
  els.drop.classList.remove("has-image");
  els.run.disabled = true; els.clear.disabled = true;
};

/* ---------- OCR ---------- */
function setStatus(html, error = false) {
  els.status.hidden = !html;
  els.status.innerHTML = html || "";
  els.status.classList.toggle("error", error);
}

async function run() {
  if (!current || busy) return;
  busy = true; els.run.disabled = true; els.run.textContent = "Lendo…";
  setStatus('<span class="spinner"></span> Reconhecendo fórmulas…');
  const t0 = performance.now();
  try {
    const r = await fetch("/api/ocr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: current.b64, media_type: current.mediaType, model: els.model.value || null, hint: els.hint.value || null }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `Erro ${r.status}`);
    setStatus("");
    showResult(data.content);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    els.meta.textContent = `${data.model} · ${secs}s · ${data.input_tokens} → ${data.output_tokens} tokens`;
    addHistory({ thumb: current.thumb, content: data.content, ts: Date.now() });
  } catch (err) {
    setStatus(escapeHtml(err.message || "Falha ao converter"), true);
  } finally {
    busy = false; els.run.disabled = !current; els.run.textContent = "Converter";
  }
}
els.run.onclick = run;

/* ---------- renderização ---------- */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Divide o conteúdo em blocos de texto e fórmulas em destaque ($$…$$ ou \[…\]).
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

function render(src) {
  const root = els.render;
  root.innerHTML = "";
  if (!src.trim()) { root.innerHTML = '<p class="muted">Nada para mostrar.</p>'; return; }
  for (const seg of segments(src)) {
    if (seg.type === "math") {
      const div = document.createElement("div");
      div.className = "formula"; div.title = "Clique para copiar o LaTeX";
      try { katex.render(seg.value, div, { displayMode: true, throwOnError: false, strict: "ignore" }); }
      catch { div.textContent = seg.value; }
      div.onclick = () => copy(seg.value, "Fórmula copiada");
      root.append(div);
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
    root.querySelectorAll("p").forEach((p) => renderMathInElement(p, {
      delimiters: [{ left: "$", right: "$", display: false }, { left: "\\(", right: "\\)", display: false }],
      throwOnError: false,
    }));
  }
}

function showResult(content) {
  els.source.value = content;
  render(content);
  els.copyLatex.disabled = els.copyMd.disabled = !content;
  switchTab("render");
}

els.source.addEventListener("input", () => {
  render(els.source.value);
  els.copyLatex.disabled = els.copyMd.disabled = !els.source.value;
});

/* ---------- abas ---------- */
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  els.render.hidden = name !== "render";
  els.source.parentElement.hidden = name !== "source";
}
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));

/* ---------- copiar ---------- */
async function copy(text, msg = "Copiado") {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch { toast("Não foi possível copiar"); }
}
els.copyMd.onclick = () => copy(els.source.value, "Markdown copiado");
els.copyLatex.onclick = () => {
  const src = els.source.value;
  const maths = segments(src).filter((s) => s.type === "math").map((s) => s.value);
  copy(maths.length ? maths.join("\n\n") : src, maths.length > 1 ? `${maths.length} fórmulas copiadas` : "LaTeX copiado");
};

/* ---------- histórico ---------- */
function addHistory(entry) {
  const list = store.get(HISTORY_KEY, []);
  list.unshift(entry);
  store.set(HISTORY_KEY, list.slice(0, 30));
  drawHistory();
}
function drawHistory() {
  const list = store.get(HISTORY_KEY, []);
  els.history.innerHTML = "";
  if (!list.length) { els.history.innerHTML = '<li class="empty">Suas conversões aparecem aqui.</li>'; return; }
  for (const h of list) {
    const li = document.createElement("li");
    const img = document.createElement("img"); img.src = h.thumb; img.alt = "";
    const span = document.createElement("span"); span.className = "h-text";
    span.textContent = h.content.replace(/\s+/g, " ").slice(0, 80);
    li.append(img, span);
    li.onclick = () => { showResult(h.content); els.meta.textContent = new Date(h.ts).toLocaleString("pt-BR"); };
    els.history.append(li);
  }
}
els.clearHistory.onclick = () => { store.set(HISTORY_KEY, []); drawHistory(); };
drawHistory();

// Renderiza o placeholder assim que o KaTeX carregar.
window.addEventListener("load", () => {
  const ph = els.render.querySelector(".placeholder");
  if (ph && window.renderMathInElement) renderMathInElement(ph, { throwOnError: false });
});
