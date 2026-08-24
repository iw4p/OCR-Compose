const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  models: [],
  document: null,
  selectedPages: new Set(),
  currentPage: null,
  samplePage: null,
  zoom: 1,
  comparison: [],
  selectedModel: null,
  overlayBlocks: [],
  book: null,
  conversionId: null,
  activeBlock: -1,
};

const api = async (path, options = {}) => {
  const response = await fetch(path, options);
  const type = response.headers.get("content-type") || "";
  if (!response.ok) {
    const problem = type.includes("json") ? await response.json() : { error: await response.text() };
    const error = new Error(problem.error || `Request failed (${response.status})`);
    error.issues = problem.issues;
    throw error;
  }
  return type.includes("json") ? response.json() : response.blob();
};

const postJson = (path, value) => api(path, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});

const busy = (title, copy = "") => {
  $("#busy-title").textContent = title;
  $("#busy-copy").textContent = copy;
  $("#busy").hidden = false;
};
const idle = () => { $("#busy").hidden = true; };
let toastTimer;
const toast = (message) => {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => { $("#toast").hidden = true; }, 4200);
};
const fail = (error) => {
  console.error(error);
  toast(error instanceof Error ? error.message : String(error));
};

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

const setStep = (name) => {
  const order = ["source", "compare", "edit", "export"];
  const active = order.indexOf(name);
  $$(".step").forEach((button, index) => {
    button.disabled = index > active;
    button.classList.toggle("active", index === active);
  });
};

async function loadModels() {
  const result = await api("/api/models");
  state.models = result.models;
  renderWelcomeModels();
  renderModelList();
}

function renderWelcomeModels() {
  $("#welcome-models").innerHTML = state.models.map((model) => `
    <article class="mini-model">
      <header><strong>${escapeHtml(model.name)} ${escapeHtml(model.version)}</strong><span class="chip">${model.installed ? "ready" : "available"}</span></header>
      <p>${escapeHtml(model.description)}</p>
    </article>
  `).join("") || '<p class="panel-copy">No model manifests found.</p>';
}

function renderModelList() {
  const target = $("#model-list");
  if (!target) return;
  target.innerHTML = state.models.map((model) => `
    <article class="model-card" data-model="${escapeHtml(model.id)}">
      <header>
        <input type="checkbox" class="model-check" aria-label="Compare ${escapeHtml(model.name)}" ${model.installed ? "checked" : "disabled"} />
        <strong>${escapeHtml(model.name)} ${escapeHtml(model.version)}</strong>
        <small>${model.installed ? "Installed" : "Not installed"}</small>
      </header>
      <p>${escapeHtml(model.description)}</p>
      <div class="chips">${model.capabilities.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")}</div>
      ${model.installed ? `<p>${escapeHtml(model.firstRunNote)}</p>` : `<button class="install-model" data-install="${escapeHtml(model.id)}">${escapeHtml(model.installLabel)}</button>`}
    </article>
  `).join("");
  $$('[data-install]').forEach((button) => button.addEventListener("click", () => install(button.dataset.install)));
}

async function install(modelId) {
  try {
    busy("Installing model runtime", "This can take several minutes. The environment is isolated inside Bookforge.");
    const result = await postJson(`/api/models/${encodeURIComponent(modelId)}/install`, {});
    state.models = result.models;
    renderWelcomeModels();
    renderModelList();
    toast(result.message);
  } catch (error) { fail(error); }
  finally { idle(); }
}

function parsePages(spec, max) {
  const pages = new Set();
  for (const raw of spec.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) throw new Error(`Invalid page range: ${spec}`);
    const first = Number(match[1]);
    const last = Number(match[2] || match[1]);
    if (first < 1 || last < first || last > max) throw new Error(`Pages must be between 1 and ${max}`);
    for (let page = first; page <= last; page += 1) pages.add(page);
  }
  return pages;
}

async function upload(file) {
  if (!file) return;
  try {
    busy("Reading your book", "Inspecting pages and deciding which ones need OCR.");
    const result = await api("/api/documents", {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream", "x-bookforge-filename": encodeURIComponent(file.name) },
      body: file,
    });
    state.document = result.document;
    state.book = result.book || null;
    state.conversionId = null;
    state.activeBlock = -1;
    $("#welcome").hidden = true;
    $("#workspace").hidden = false;
    $("#document-name").textContent = result.document.name;
    $("#book-title").value = result.document.title || file.name.replace(/\.(pdf|epub)$/i, "");
    $("#book-author").value = result.document.author || "";

    if (result.document.kind === "epub") {
      state.selectedPages = new Set();
      $(".page-panel").hidden = true;
      $(".workbench").classList.add("epub-mode");
      $("#compare-panel").hidden = true;
      enterEditor();
    } else {
      $(".page-panel").hidden = false;
      $(".workbench").classList.remove("epub-mode");
      $("#compare-panel").hidden = false;
      state.selectedPages = new Set(result.document.pages.map((page) => page.page));
      state.currentPage = result.document.suggestedPage;
      state.samplePage = result.document.suggestedPage;
      $("#sample-page").value = state.samplePage;
      $("#sample-page").max = result.document.pageCount;
      renderDocumentStats();
      renderPages();
      showPage(state.currentPage);
      setStep("compare");
    }
    if (result.warnings?.length) toast(result.warnings[0]);
  } catch (error) { fail(error); }
  finally { idle(); }
}

function renderDocumentStats() {
  const counts = state.document.counts || {};
  $("#document-stats").innerHTML = `
    <span class="stat">${state.document.pageCount} pages</span>
    <span class="stat native">${counts.native || 0} native</span>
    <span class="stat scan">${counts.scanned || 0} need OCR</span>
    ${counts["no-text"] ? `<span class="stat">${counts["no-text"]} blank</span>` : ""}
  `;
}

function renderPages() {
  if (!state.document || state.document.kind !== "pdf") return;
  $("#page-list").innerHTML = state.document.pages.map((page) => `
    <article class="page-card ${page.page === state.currentPage ? "current" : ""}" data-page="${page.page}">
      <input type="checkbox" aria-label="Include page ${page.page}" ${state.selectedPages.has(page.page) ? "checked" : ""} />
      <img loading="lazy" alt="Page ${page.page}" src="/api/documents/${state.document.id}/pages/${page.page}.png?scale=.22" />
      <footer><span>Page ${page.page}</span><span class="verdict ${page.verdict}" title="${page.verdict}"></span></footer>
    </article>
  `).join("");
  $$(".page-card").forEach((card) => {
    card.addEventListener("click", (event) => {
      const page = Number(card.dataset.page);
      if (event.target.matches('input')) {
        event.target.checked ? state.selectedPages.add(page) : state.selectedPages.delete(page);
        updateSelection();
      } else showPage(page);
    });
  });
  updateSelection();
}

function updateSelection() {
  $("#selection-count").textContent = `${state.selectedPages.size} selected`;
  $("#convert-book").disabled = state.selectedPages.size === 0 || !state.selectedModel;
}

function showPage(page, overlays = state.overlayBlocks) {
  if (!state.document || state.document.kind !== "pdf") return;
  state.currentPage = page;
  state.overlayBlocks = overlays;
  $("#canvas-title").textContent = `Page ${page}`;
  $("#canvas-eyebrow").textContent = page === state.samplePage ? "Sample page" : "Source page";
  const boxes = overlays.map((block, index) => `
    <button class="block-overlay" data-overlay="${index}" aria-label="OCR block ${index + 1}"
      style="left:${block.x * 100}%;top:${block.y * 100}%;width:${block.w * 100}%;height:${block.h * 100}%"></button>
  `).join("");
  $("#page-canvas").innerHTML = `<div class="page-stage" style="transform:scale(${state.zoom})">
    <img alt="Rendered page ${page}" src="/api/documents/${state.document.id}/pages/${page}.png?scale=1.35" />${boxes}
  </div>`;
  $$(".page-card").forEach((card) => card.classList.toggle("current", Number(card.dataset.page) === page));
  $("#zoom-label").textContent = `${Math.round(state.zoom * 100)}%`;
}

async function compareModels() {
  const modelIds = $$(".model-card").filter((card) => card.querySelector(".model-check")?.checked).map((card) => card.dataset.model);
  const page = Number($("#sample-page").value);
  if (!modelIds.length) return toast("Select at least one installed model.");
  if (!Number.isInteger(page) || page < 1 || page > state.document.pageCount) return toast("Choose a valid sample page.");
  try {
    state.samplePage = page;
    showPage(page, []);
    busy("Comparing OCR models", "Models run sequentially and unload between samples to keep memory use reasonable.");
    const result = await postJson(`/api/documents/${state.document.id}/compare`, { page, modelIds });
    state.comparison = result.results;
    renderComparison();
    const firstGood = state.comparison.find((item) => item.ok);
    if (firstGood) selectResult(firstGood.modelId);
  } catch (error) { fail(error); }
  finally { idle(); }
}

function renderComparison() {
  $("#comparison-results").innerHTML = state.comparison.map((result) => {
    const model = state.models.find((item) => item.id === result.modelId);
    return `<article class="result-card ${result.modelId === state.selectedModel ? "selected" : ""}" data-result="${escapeHtml(result.modelId)}">
      <header><strong>${escapeHtml(model?.name || result.modelId)}</strong><span>${(result.elapsedMs / 1000).toFixed(1)}s</span></header>
      ${result.ok
        ? `<p>${result.contractBlocks.length} semantic blocks · ${result.blocks.length} positioned regions</p>`
        : `<p class="result-error">${escapeHtml(result.error)}</p>`}
    </article>`;
  }).join("");
  $$('[data-result]').forEach((card) => card.addEventListener("click", () => selectResult(card.dataset.result)));
}

function selectResult(modelId) {
  const result = state.comparison.find((item) => item.modelId === modelId && item.ok);
  if (!result) return;
  state.selectedModel = modelId;
  renderComparison();
  showPage(state.samplePage, result.blocks);
  $("#convert-book").textContent = `Use ${state.models.find((item) => item.id === modelId)?.name || modelId}`;
  updateSelection();
}

async function convertBook() {
  try {
    busy("Forging the book", "The selected model stays loaded while the chosen pages are converted.");
    const result = await postJson(`/api/documents/${state.document.id}/convert`, {
      pages: [...state.selectedPages],
      modelId: state.selectedModel,
      title: $("#book-title").value.trim(),
      author: $("#book-author").value.trim() || undefined,
      language: $("#book-language").value.trim() || "en",
    });
    state.book = result.book;
    state.conversionId = result.conversionId;
    enterEditor();
    if (result.warnings.length) toast(result.warnings.join(" · "));
  } catch (error) { fail(error); }
  finally { idle(); }
}

function enterEditor() {
  $("#compare-panel").hidden = true;
  $("#editor-panel").hidden = false;
  $("#block-dock").hidden = false;
  state.activeBlock = state.book.content.length ? 0 : -1;
  setStep("edit");
  renderBlocks();
  renderInspector();
}

const blockText = (block) => {
  if ("text" in block) return block.text;
  if (block.type === "image") return block.caption || block.alt || block.file;
  if (block.type === "table") return block.caption || (block.rows ? `${block.rows.length} table rows` : "Scanned table");
  if (block.type === "formula") return block.tex || block.note || "Formula";
  if (block.type === "list") return `${block.items.length} list items`;
  return block.type;
};

function renderBlocks() {
  $("#block-list").innerHTML = state.book.content.map((block, index) => `
    <article class="book-block ${index === state.activeBlock ? "selected" : ""}" draggable="true" data-block="${index}">
      <span class="block-type">${escapeHtml(block.type)}${block.role ? ` · ${escapeHtml(block.role)}` : ""}</span>
      <p>${escapeHtml(blockText(block))}</p>
      <span class="block-page">${block.page ? `p. ${block.page}` : block.pages ? `pp. ${block.pages.map((item) => item.page).join("–")}` : "no page"}</span>
    </article>
  `).join("");
  $$(".book-block").forEach((card) => {
    card.addEventListener("click", () => {
      state.activeBlock = Number(card.dataset.block);
      renderBlocks();
      renderInspector();
      const page = state.book.content[state.activeBlock]?.page || state.book.content[state.activeBlock]?.pages?.[0]?.page;
      if (page && state.document.kind === "pdf") showPage(page, []);
    });
    card.addEventListener("dragstart", () => card.classList.add("dragging"));
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
    card.addEventListener("dragover", (event) => event.preventDefault());
    card.addEventListener("drop", (event) => {
      event.preventDefault();
      const from = Number($(".book-block.dragging")?.dataset.block);
      const to = Number(card.dataset.block);
      moveBlock(from, to);
    });
  });
}

const templateFor = (type, old = {}) => {
  const common = {
    ...(old.page ? { page: old.page } : {}),
    ...(old.id ? { id: old.id } : {}),
    ...(old.role ? { role: old.role } : {}),
  };
  const text = blockText(old) || "";
  if (type === "heading") return { type, level: 2, text, ...common };
  if (type === "quote") return { type, text, ...common };
  if (type === "image") return { type, file: "assets/image.png", alt: text, ...common };
  if (type === "table") return { type, rows: [["Cell"]], ...common };
  if (type === "formula") return { type, display: true, tex: text || null, ...common };
  if (type === "list") return { type, ordered: false, items: [[{ type: "text", text: text || "Item" }]], ...common };
  return { type: "text", text, ...common };
};

function renderInspector() {
  const block = state.book?.content[state.activeBlock];
  if (!block) {
    $("#block-heading").textContent = "No block selected";
    $("#block-inspector").innerHTML = '<p class="panel-copy">Add a block or select one from the ordered strip below.</p>';
    return;
  }
  $("#block-heading").textContent = `Block ${state.activeBlock + 1}`;
  const hasText = "text" in block;
  $("#block-inspector").innerHTML = `
    <label class="field">Type<select id="edit-type">${["text","heading","quote","image","table","formula","list"].map((type) => `<option ${block.type === type ? "selected" : ""}>${type}</option>`).join("")}</select></label>
    ${hasText ? `<label class="field">Content<textarea id="edit-text">${escapeHtml(block.text)}</textarea></label>` : ""}
    ${block.type === "heading" ? `<label class="field">Heading level<input id="edit-level" type="number" min="1" max="6" value="${block.level}" /></label>` : ""}
    <div class="field-row">
      <label class="field">Source page<input id="edit-page" type="number" min="1" value="${block.page || ""}" /></label>
      <label class="field">Role<input id="edit-role" value="${escapeHtml(block.role || "")}" /></label>
    </div>
    <label class="field">Block ID<input id="edit-id" value="${escapeHtml(block.id || "")}" placeholder="optional-anchor" /></label>
    ${!hasText ? `<label class="field">Advanced block JSON<textarea id="edit-json" class="advanced-json">${escapeHtml(JSON.stringify(block, null, 2))}</textarea></label><button id="apply-json" class="wide">Apply JSON</button>` : ""}
    <div class="inspector-actions"><button id="move-prev">← Earlier</button><button id="move-next">Later →</button><button id="remove-block" class="danger">Remove</button></div>
  `;
  $("#edit-type").addEventListener("change", (event) => {
    state.book.content[state.activeBlock] = templateFor(event.target.value, block);
    renderBlocks(); renderInspector();
  });
  $("#edit-text")?.addEventListener("input", (event) => { block.text = event.target.value; renderBlocks(); });
  $("#edit-level")?.addEventListener("input", (event) => { block.level = Number(event.target.value); });
  $("#edit-page").addEventListener("input", (event) => {
    const value = Number(event.target.value);
    if (value > 0) { block.page = value; delete block.pages; } else delete block.page;
    renderBlocks();
  });
  $("#edit-role").addEventListener("input", (event) => { event.target.value ? block.role = event.target.value : delete block.role; renderBlocks(); });
  $("#edit-id").addEventListener("input", (event) => { event.target.value ? block.id = event.target.value : delete block.id; });
  $("#apply-json")?.addEventListener("click", () => {
    try { state.book.content[state.activeBlock] = JSON.parse($("#edit-json").value); renderBlocks(); renderInspector(); }
    catch { toast("That block JSON is not valid."); }
  });
  $("#move-prev").addEventListener("click", () => moveBlock(state.activeBlock, state.activeBlock - 1));
  $("#move-next").addEventListener("click", () => moveBlock(state.activeBlock, state.activeBlock + 1));
  $("#remove-block").addEventListener("click", removeBlock);
}

function moveBlock(from, to) {
  if (!Number.isInteger(from) || to < 0 || to >= state.book.content.length || from === to) return;
  const [block] = state.book.content.splice(from, 1);
  state.book.content.splice(to, 0, block);
  state.activeBlock = to;
  renderBlocks(); renderInspector();
}

function addBlock() {
  const page = state.currentPage || undefined;
  const at = state.activeBlock < 0 ? state.book.content.length : state.activeBlock + 1;
  state.book.content.splice(at, 0, { type: "text", text: "New paragraph", ...(page && { page }) });
  state.activeBlock = at;
  renderBlocks(); renderInspector();
}

function removeBlock() {
  if (state.activeBlock < 0) return;
  state.book.content.splice(state.activeBlock, 1);
  state.activeBlock = Math.min(state.activeBlock, state.book.content.length - 1);
  renderBlocks(); renderInspector();
}

async function validate() {
  try {
    const result = await postJson("/api/validate", { book: state.book });
    const target = $("#validation-status");
    target.className = `validation-status ${result.issues.length ? "bad" : "good"}`;
    target.textContent = result.issues.length
      ? `${result.issues.length} contract issue${result.issues.length === 1 ? "" : "s"}: ${result.issues[0].path.join(".")} — ${result.issues[0].message}`
      : "Contract valid — ready to export.";
    if (!result.issues.length) setStep("export");
    return result.issues;
  } catch (error) { fail(error); return [error]; }
}

function download(name, blob) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function downloadJson() {
  const issues = await validate();
  if (issues.length) return;
  const name = state.document.name.replace(/\.(pdf|epub)$/i, "") + "-book.json";
  download(name, new Blob([JSON.stringify(state.book, null, 2) + "\n"], { type: "application/json" }));
}

async function downloadEpub() {
  try {
    busy("Packing EPUB", "Validating structure and writing the reflowable book.");
    const blob = await postJson("/api/export/epub", {
      documentId: state.document.id,
      conversionId: state.conversionId || undefined,
      book: state.book,
    });
    download(state.document.name.replace(/\.(pdf|epub)$/i, "") + "-bookforge.epub", blob);
    setStep("export");
  } catch (error) {
    if (error.issues?.length) $("#validation-status").textContent = error.issues[0].message;
    fail(error);
  } finally { idle(); }
}

const dropzone = $("#dropzone");
$("#choose-file").addEventListener("click", (event) => { event.preventDefault(); $("#file-input").click(); });
$("#file-input").addEventListener("change", (event) => upload(event.target.files[0]));
dropzone.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") $("#file-input").click(); });
["dragenter", "dragover"].forEach((name) => dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.add("dragging"); }));
["dragleave", "drop"].forEach((name) => dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.remove("dragging"); }));
dropzone.addEventListener("drop", (event) => upload(event.dataTransfer.files[0]));
$("#new-document").addEventListener("click", () => location.reload());
$("#apply-range").addEventListener("click", () => { try { state.selectedPages = parsePages($("#page-range").value, state.document.pageCount); renderPages(); } catch (error) { fail(error); } });
$("#select-all").addEventListener("click", () => { state.selectedPages = new Set(state.document.pages.map((page) => page.page)); renderPages(); });
$("#select-none").addEventListener("click", () => { state.selectedPages.clear(); renderPages(); });
$("#select-scans").addEventListener("click", () => { state.selectedPages = new Set(state.document.pages.filter((page) => page.verdict === "scanned").map((page) => page.page)); renderPages(); });
$("#zoom-in").addEventListener("click", () => { state.zoom = Math.min(1.7, state.zoom + .1); showPage(state.currentPage); });
$("#zoom-out").addEventListener("click", () => { state.zoom = Math.max(.5, state.zoom - .1); showPage(state.currentPage); });
$("#compare-models").addEventListener("click", compareModels);
$("#convert-book").addEventListener("click", convertBook);
$("#add-block").addEventListener("click", addBlock);
$("#validate-book").addEventListener("click", validate);
$("#download-json").addEventListener("click", downloadJson);
$("#download-epub").addEventListener("click", downloadEpub);

loadModels().catch(fail);
