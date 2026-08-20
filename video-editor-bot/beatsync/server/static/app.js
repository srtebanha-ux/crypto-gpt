/* ==================================================================
   beatsync Studio — frontend (vanilla JS, sem build)
   ================================================================== */
"use strict";

const API = "/api";
const state = {
  projects: [],
  current: null,      // projeto aberto (deep)
  presets: [],
  selectedPreset: null,
  cutMode: null,
  pollTimer: null,
};

/* ---------- helpers de rede ---------- */
async function api(path, opts = {}) {
  const res = await fetch(API + path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch (_) {}
    throw new Error(msg);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res;
}
const jpost = (p, body) => api(p, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body || {}),
});
const jpatch = (p, body) => api(p, {
  method: "PATCH", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body || {}),
});

/* ---------- DOM helpers ---------- */
const $ = (sel, el = document) => el.querySelector(sel);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtBytes = (b) => {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB"]; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return b.toFixed(b < 10 && i > 0 ? 1 : 0) + " " + u[i];
};
const fmtDur = (s) => {
  if (!s) return "—";
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return m ? `${m}:${String(r).padStart(2, "0")}` : `${r}s`;
};

function toast(msg, kind = "info") {
  const t = el("div", "toast " + kind, esc(msg));
  $("#toast-wrap").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, 3800);
}

/* ================================================================
   Boot
   ================================================================ */
async function boot() {
  bindGlobal();
  await Promise.all([loadHealth(), loadPresets(), loadProjects()]);
}

async function loadHealth() {
  try {
    const h = await api("/health");
    const caps = h.capabilities || {};
    const wrap = $("#caps"); wrap.innerHTML = "";
    const items = [
      ["librosa", "áudio"], ["ffmpeg", "ffmpeg"],
      ["moviepy", "vídeo"], ["whisper", "letra"],
    ];
    for (const [k, label] of items) {
      const on = !!caps[k];
      const c = el("span", "cap " + (on ? "on" : "off"),
        `<i class="dot"></i>${label}`);
      c.title = on ? `${k} disponível` : `${k} indisponível`;
      wrap.appendChild(c);
    }
  } catch (e) { /* silencioso */ }
}

async function loadPresets() {
  state.presets = await api("/presets");
  const sel = $("#np-preset"); sel.innerHTML = "";
  for (const p of state.presets) {
    const o = el("option"); o.value = p.name;
    o.textContent = p.label || p.name;
    sel.appendChild(o);
  }
}

async function loadProjects() {
  state.projects = await api("/projects");
  renderProjectList();
}

/* ================================================================
   Sidebar
   ================================================================ */
function renderProjectList() {
  const ul = $("#project-list"); ul.innerHTML = "";
  if (!state.projects.length) {
    ul.appendChild(el("li", "pi-meta", "Nenhum projeto ainda"));
    return;
  }
  for (const p of state.projects) {
    const li = el("li", "project-item" +
      (state.current && state.current.id === p.id ? " active" : ""));
    li.innerHTML = `
      <span class="pi-name">${esc(p.name)}</span>
      <span class="pi-meta">
        <span class="status-pill status-${p.status}">${p.status}</span>
        · 🎵${p.counts.audio} · 🎞️${p.counts.video}
      </span>`;
    li.onclick = () => openProject(p.id);
    ul.appendChild(li);
  }
}

/* ================================================================
   Modal novo projeto
   ================================================================ */
function bindGlobal() {
  $("#new-project-btn").onclick = openModal;
  $("#empty-new-btn").onclick = openModal;
  $("#np-cancel").onclick = closeModal;
  $("#modal").onclick = (e) => { if (e.target.id === "modal") closeModal(); };
  $("#np-create").onclick = createProject;
}
function openModal() { $("#modal").classList.remove("hidden"); $("#np-name").focus(); }
function closeModal() {
  $("#modal").classList.add("hidden");
  $("#np-name").value = ""; $("#np-desc").value = "";
}
async function createProject() {
  const name = $("#np-name").value.trim();
  if (!name) { toast("Dê um nome ao projeto", "err"); return; }
  try {
    const p = await jpost("/projects", {
      name, description: $("#np-desc").value.trim(),
      preset: $("#np-preset").value,
    });
    closeModal();
    await loadProjects();
    openProject(p.id);
    toast("Projeto criado", "ok");
  } catch (e) { toast(e.message, "err"); }
}

/* ================================================================
   Abrir / renderizar projeto
   ================================================================ */
async function openProject(id) {
  stopPolling();
  state.current = await api("/projects/" + id);
  state.selectedPreset = state.current.preset;
  state.cutMode = (state.current.analysis && state.current.analysis.cut_mode) || null;
  renderProjectList();
  renderWorkspace();
  // se há job em andamento, retoma o polling
  const running = (state.current.jobs || []).find(
    (j) => j.status === "running" || j.status === "queued");
  if (running) pollJob(running.id);
}

async function refreshCurrent() {
  if (!state.current) return;
  const id = state.current.id;
  state.current = await api("/projects/" + id);
  renderWorkspace();
}

function renderWorkspace() {
  $("#empty-state").classList.add("hidden");
  const ws = $("#workspace"); ws.classList.remove("hidden");
  const p = state.current;
  const audio = (p.assets || []).find((a) => a.kind === "audio");
  const clips = (p.assets || []).filter((a) => a.kind === "video");
  const an = p.analysis;
  const lastJob = (p.jobs || [])[0];

  ws.innerHTML = "";

  /* ----- header ----- */
  const header = el("div", "ws-header");
  header.innerHTML = `
    <div class="ws-title">
      <h2>${esc(p.name)}
        <span class="status-pill status-${p.status}">${p.status}</span></h2>
      <span class="desc">${esc(p.description || "Sem descrição")}</span>
    </div>
    <div class="actions">
      <button class="btn btn-danger btn-sm" id="del-proj">Excluir</button>
    </div>`;
  ws.appendChild(header);
  $("#del-proj").onclick = () => deleteProject(p.id);

  /* ----- grid ----- */
  const grid = el("div", "grid");
  grid.appendChild(cardMusic(audio));
  grid.appendChild(cardClips(clips));
  grid.appendChild(cardAnalysis(an, audio));
  grid.appendChild(cardRender(lastJob, audio, clips));
  ws.appendChild(grid);

  if (an) drawTimeline(an);
}

/* ---------- Card: música ---------- */
function cardMusic(audio) {
  const c = el("div", "card");
  c.innerHTML = `<h3>🎵 Música</h3>
    <p class="hint">A faixa que define o ritmo dos cortes.</p>`;
  if (audio) {
    const a = el("div", "asset");
    a.innerHTML = `<span class="ic">🎵</span>
      <div class="meta"><div class="n">${esc(audio.filename)}</div>
      <div class="s">${fmtBytes(audio.size_bytes)}</div></div>
      <button class="btn btn-danger btn-sm">Trocar</button>`;
    a.querySelector("button").onclick = () => makeDrop(c, "audio", "audio/*");
    c.appendChild(a);
  } else {
    c.appendChild(makeDropEl("audio", "audio/*",
      "🎧", "Arraste a música ou clique (mp3, wav, m4a…)"));
  }
  return c;
}

/* ---------- Card: clipes ---------- */
function cardClips(clips) {
  const c = el("div", "card");
  c.innerHTML = `<h3>🎞️ Clipes brutos <span style="color:var(--muted);
    font-weight:400;font-size:12px">(${clips.length})</span></h3>
    <p class="hint">Os vídeos crus de onde saem os cortes.</p>`;
  c.appendChild(makeDropEl("video", "video/*",
    "🎬", "Arraste clipes ou clique (mp4, mov, mkv…) — múltiplos"));
  if (clips.length) {
    const g = el("div", "clip-grid");
    for (const v of clips) {
      const chip = el("div", "clip-chip");
      const dims = v.width ? `${v.width}×${v.height}` : "";
      chip.innerHTML = `<span class="x" title="remover">×</span>
        <div class="cn">${esc(v.filename)}</div>
        <div class="cs">${fmtDur(v.duration)} ${dims}</div>`;
      chip.querySelector(".x").onclick = () => deleteAsset(v.id);
      g.appendChild(chip);
    }
    c.appendChild(g);
  }
  return c;
}

/* ---------- Card: análise ---------- */
function cardAnalysis(an, audio) {
  const c = el("div", "card");
  c.innerHTML = `<h3>🎚️ Análise & cortes</h3>
    <p class="hint">BPM, batidas e o plano de cortes no ritmo.</p>`;

  // presets
  const row = el("div", "preset-row");
  for (const p of state.presets) {
    const chip = el("div", "chip" +
      (p.name === state.selectedPreset ? " active" : ""));
    chip.innerHTML = `${esc(p.label || p.name)}
      <span class="cd">${esc((p.description || "").slice(0, 42))}</span>`;
    chip.onclick = () => selectPreset(p.name);
    row.appendChild(chip);
  }
  c.appendChild(row);

  // modo de corte
  const fr = el("div", "field-row");
  fr.innerHTML = `
    <label class="field">Modo de corte
      <select id="cut-mode">
        ${["beat", "downbeat", "onset", "hybrid"].map((m) =>
          `<option value="${m}">${m}</option>`).join("")}
      </select>
    </label>`;
  c.appendChild(fr);
  const sel = fr.querySelector("#cut-mode");
  sel.value = state.cutMode || "hybrid";
  sel.onchange = () => { state.cutMode = sel.value; };

  const btn = el("button", "btn btn-primary", "🎚️ Analisar áudio");
  btn.style.marginTop = "12px";
  btn.disabled = !audio;
  btn.onclick = () => analyze(btn);
  c.appendChild(btn);
  if (!audio) {
    c.appendChild(el("p", "hint", "Envie uma música para analisar."));
  }

  if (an) {
    const stats = el("div", "analysis-stats");
    stats.innerHTML = `
      <div class="stat"><span class="v grad">${an.tempo.toFixed(0)}</span>
        <span class="k">BPM</span></div>
      <div class="stat"><span class="v">${an.num_beats}</span>
        <span class="k">batidas</span></div>
      <div class="stat"><span class="v">${an.num_cuts}</span>
        <span class="k">cortes</span></div>
      <div class="stat"><span class="v">${fmtDur(an.duration)}</span>
        <span class="k">duração</span></div>`;
    c.appendChild(stats);

    const tw = el("div", "timeline-wrap");
    tw.innerHTML = `<canvas class="timeline" id="tl-canvas"></canvas>
      <div class="legend">
        <span><i style="background:#3a4459"></i>batidas</span>
        <span><i style="background:#22d3ee"></i>downbeats</span>
        <span><i style="background:#fbbf24"></i>picos</span>
        <span><i style="background:#7c5cff"></i>cortes</span>
      </div>`;
    c.appendChild(tw);
  }
  return c;
}

/* ---------- Card: render ---------- */
function cardRender(job, audio, clips) {
  const c = el("div", "card");
  c.innerHTML = `<h3>✨ Render</h3>
    <p class="hint">Monta o videoclipe final com os cortes sincronizados.</p>`;

  const ready = audio && clips.length;
  const btn = el("button", "btn btn-primary", "✨ Renderizar videoclipe");
  btn.disabled = !ready ||
    (job && (job.status === "running" || job.status === "queued"));
  btn.onclick = () => startRender(btn);
  c.appendChild(btn);
  if (!ready) {
    c.appendChild(el("p", "hint",
      "Precisa de 1 música + ao menos 1 clipe."));
  }

  if (job) c.appendChild(jobView(job));
  return c;
}

function jobView(job) {
  const box = el("div");
  box.id = "job-box";
  const pct = job.progress || 0;
  const running = job.status === "running" || job.status === "queued";
  box.innerHTML = `
    <div class="progress"><div class="bar" style="width:${pct}%"></div></div>
    <div class="job-stage">
      <span>${running ? '<span class="spinner"></span> ' : ""}${esc(job.stage)}</span>
      <span>${pct.toFixed(0)}%</span>
    </div>`;
  if (job.status === "done" && job.output) {
    const v = el("video", "output");
    v.controls = true; v.src = `${API}/jobs/${job.id}/download`;
    box.appendChild(v);
    const dl = el("a", "btn btn-sm", "⬇️ Baixar MP4");
    dl.href = `${API}/jobs/${job.id}/download`; dl.download = "";
    dl.style.marginTop = "10px";
    box.appendChild(dl);
  }
  if (job.status === "error" && job.error) {
    box.appendChild(el("div", "job-log", "❌ " + esc(job.error)));
  }
  if (running) {
    const cancel = el("button", "btn btn-danger btn-sm", "Cancelar");
    cancel.style.marginTop = "10px";
    cancel.onclick = () => api(`/jobs/${job.id}/cancel`, { method: "POST" })
      .then(() => toast("Cancelando…", "info"));
    box.appendChild(cancel);
  }
  return box;
}

/* ================================================================
   Ações
   ================================================================ */
function selectPreset(name) {
  state.selectedPreset = name;
  jpatch("/projects/" + state.current.id, { preset: name })
    .then(() => refreshCurrent())
    .catch((e) => toast(e.message, "err"));
}

async function analyze(btn) {
  const orig = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Analisando…';
  try {
    await jpost(`/projects/${state.current.id}/analyze`,
      { cut_mode: state.cutMode });
    await refreshCurrent();
    toast("Análise concluída", "ok");
  } catch (e) {
    toast(e.message, "err");
    btn.disabled = false; btn.innerHTML = orig;
  }
}

async function startRender(btn) {
  btn.disabled = true;
  try {
    const job = await jpost(`/projects/${state.current.id}/render`, {});
    toast("Render iniciado", "info");
    await refreshCurrent();
    pollJob(job.id);
  } catch (e) {
    toast(e.message, "err"); btn.disabled = false;
  }
}

function pollJob(jobId) {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    try {
      const job = await api("/jobs/" + jobId);
      const box = $("#job-box");
      if (box) box.replaceWith(jobView(job));
      if (["done", "error", "canceled"].includes(job.status)) {
        stopPolling();
        await openProject(state.current.id); // recarrega status/projeto
        if (job.status === "done") toast("Videoclipe pronto! 🎉", "ok");
        else if (job.status === "error") toast("Falha no render", "err");
      }
    } catch (e) { stopPolling(); }
  }, 1200);
}
function stopPolling() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

async function deleteAsset(id) {
  try {
    await api(`/projects/${state.current.id}/assets/${id}`, { method: "DELETE" });
    await refreshCurrent();
  } catch (e) { toast(e.message, "err"); }
}

async function deleteProject(id) {
  if (!confirm("Excluir este projeto e todos os arquivos?")) return;
  try {
    await api("/projects/" + id, { method: "DELETE" });
    state.current = null;
    await loadProjects();
    $("#workspace").classList.add("hidden");
    $("#empty-state").classList.remove("hidden");
    toast("Projeto excluído", "ok");
  } catch (e) { toast(e.message, "err"); }
}

/* ================================================================
   Upload (dropzone + input)
   ================================================================ */
function makeDropEl(kind, accept, icon, label) {
  const dz = el("div", "dropzone");
  dz.innerHTML = `<span class="dz-icon">${icon}</span>${esc(label)}`;
  const input = el("input");
  input.type = "file"; input.accept = accept; input.style.display = "none";
  input.multiple = kind === "video";
  dz.appendChild(input);
  dz.onclick = () => input.click();
  input.onchange = () => uploadFiles(kind, [...input.files]);
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add("drag"); };
  dz.ondragleave = () => dz.classList.remove("drag");
  dz.ondrop = (e) => {
    e.preventDefault(); dz.classList.remove("drag");
    uploadFiles(kind, [...e.dataTransfer.files]);
  };
  return dz;
}
function makeDrop(container, kind, accept) {
  container.appendChild(makeDropEl(kind, accept, "⬆️", "Selecione o arquivo"));
}

async function uploadFiles(kind, files) {
  if (!files.length) return;
  toast(`Enviando ${files.length} arquivo(s)…`, "info");
  for (const f of files) {
    const fd = new FormData();
    fd.append("kind", kind); fd.append("file", f);
    try {
      await fetch(`${API}/projects/${state.current.id}/assets`,
        { method: "POST", body: fd })
        .then((r) => { if (!r.ok) throw new Error("falha no upload"); });
    } catch (e) { toast(`${f.name}: ${e.message}`, "err"); }
  }
  await refreshCurrent();
  toast("Upload concluído", "ok");
}

/* ================================================================
   Visualização das batidas (canvas)
   ================================================================ */
function drawTimeline(an) {
  const canvas = $("#tl-canvas");
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const dur = an.duration || 1;
  const x = (t) => (t / dur) * (W - 2) + 1;

  const draw = (arr, color, top, bottom, w) => {
    ctx.strokeStyle = color; ctx.lineWidth = w;
    ctx.beginPath();
    for (const t of arr) {
      const px = x(t);
      ctx.moveTo(px, top); ctx.lineTo(px, bottom);
    }
    ctx.stroke();
  };

  // grade de segundos
  ctx.strokeStyle = "rgba(255,255,255,.04)"; ctx.lineWidth = 1;
  for (let s = 0; s <= dur; s += Math.max(1, Math.round(dur / 20))) {
    ctx.beginPath(); ctx.moveTo(x(s), 0); ctx.lineTo(x(s), H); ctx.stroke();
  }

  draw(an.beats || [], "#3a4459", H * 0.62, H * 0.9, 1);
  draw(an.downbeats || [], "#22d3ee", H * 0.42, H * 0.9, 1.4);
  draw(an.onsets || [], "#fbbf24", H * 0.30, H * 0.5, 1);
  draw(an.cuts || [], "#7c5cff", H * 0.06, H * 0.94, 1.6);
}

window.addEventListener("resize", () => {
  if (state.current && state.current.analysis) drawTimeline(state.current.analysis);
});

boot();
