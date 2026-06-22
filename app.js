// app.js — ShrimGen UI logic
import {
  aiEngine,
  MODELS,
  DEFAULT_MODEL_KEY,
  isModelInstalled,
  uninstallModel,
  recordFeedback,
  getLearningContext,
} from "./ai-engine.js";

// ---------------------------------------------------------------------------
// Vector feedback icons (single color via currentColor — no emoji)
// ---------------------------------------------------------------------------
const ICON_THUMB_UP =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3zm0 0 4.5-8a2 2 0 0 1 2 .3 2 2 0 0 1 .7 1.9L13.4 9H18a2 2 0 0 1 2 2.4l-1.5 7A2 2 0 0 1 16.5 20H7"/></svg>';
const ICON_THUMB_DOWN =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 13V4h3a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-3zm0 0-4.5 8a2 2 0 0 1-2-.3 2 2 0 0 1-.7-1.9l.8-5.8H6a2 2 0 0 1-2-2.4l1.5-7A2 2 0 0 1 7.5 3H17"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4.8c0-.4.4-.8.9-.8h4.2c.5 0 .9.4.9.8V7m2 0-.8 12.2c-.1.9-.8 1.6-1.7 1.6H8.6c-.9 0-1.6-.7-1.7-1.6L6 7"/></svg>';

// ---------------------------------------------------------------------------
// Tiny markdown renderer (bold, italics, code, lists, headers, links, quotes)
// ---------------------------------------------------------------------------
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderMarkdown(src) {
  if (!src) return "";
  const codeBlocks = [];
  let text = src.replace(/```([a-zA-Z0-9]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${escapeHtml(code.trim())}</code></pre>`);
    return `\u0000CODEBLOCK${idx}\u0000`;
  });

  text = escapeHtml(text);

  // inline code
  const inlineCode = [];
  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlineCode.length;
    inlineCode.push(`<code>${code}</code>`);
    return `\u0000ICODE${idx}\u0000`;
  });

  // headers
  text = text.replace(/^### (.*)$/gm, "<h3>$1</h3>");
  text = text.replace(/^## (.*)$/gm, "<h2>$1</h2>");
  text = text.replace(/^# (.*)$/gm, "<h1>$1</h1>");

  // bold + italics (bold first so **/__ don't get eaten by single * / _)
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__(.+?)__/g, "<strong>$1</strong>");
  text = text.replace(/(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, "<em>$1</em>");
  text = text.replace(/(?<![_\w])_(?!\s)(.+?)(?<!\s)_(?!_)/g, "<em>$1</em>");

  // links
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // blockquotes
  text = text.replace(/^&gt; ?(.*)$/gm, "<blockquote>$1</blockquote>");

  // lists: group consecutive list lines
  const lines = text.split("\n");
  const out = [];
  let listBuffer = [];
  let listType = null;

  function flushList() {
    if (listBuffer.length) {
      const tag = listType === "ol" ? "ol" : "ul";
      out.push(`<${tag}>${listBuffer.map((li) => `<li>${li}</li>`).join("")}</${tag}>`);
      listBuffer = [];
      listType = null;
    }
  }

  for (const line of lines) {
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ol) {
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      listBuffer.push(ol[1]);
    } else if (ul) {
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      listBuffer.push(ul[1]);
    } else {
      flushList();
      out.push(line);
    }
  }
  flushList();
  text = out.join("\n");

  // paragraphs: split on blank lines, leave block-level tags alone
  const blocks = text.split(/\n{2,}/).map((block) => {
    const trimmed = block.trim();
    if (!trimmed) return "";
    if (/^<(h1|h2|h3|ul|ol|blockquote|pre)/.test(trimmed)) return trimmed;
    if (trimmed.startsWith("\u0000CODEBLOCK")) return trimmed;
    return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
  });
  text = blocks.join("\n");

  text = text.replace(/\u0000ICODE(\d+)\u0000/g, (_, i) => inlineCode[+i]);
  text = text.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, i) => codeBlocks[+i]);

  return text;
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------
const CHATS_KEY = "shrimgen_chats";
const ACTIVE_MODEL_KEY = "shrimgen_active_model";
const SYSTEM_PROMPT = {
  role: "system",
  content:
    "You are ShrimGen, a friendly, concise, and helpful AI assistant running entirely on the user's device. Format replies with markdown (bold, italics, lists, code) when it helps clarity.",
};

function loadChats() {
  try {
    return JSON.parse(localStorage.getItem(CHATS_KEY) || "[]");
  } catch {
    return [];
  }
}
function saveChats(chats) {
  localStorage.setItem(CHATS_KEY, JSON.stringify(chats));
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

let chats = loadChats();
let currentChatId = chats[0]?.id || null;

function getChat(id) {
  return chats.find((c) => c.id === id) || null;
}
function getCurrentChat() {
  return getChat(currentChatId);
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const layout = $("#layout");
const sidebar = $("#sidebar");
const sidebarOverlay = $("#sidebar-overlay");
const hamburger = $("#hamburger");
const newChatBtn = $("#new-chat-btn");
const archiveList = $("#archive-list");
const messagesEl = $("#messages");
const emptyState = $("#empty-state");
const composer = $("#composer");
const input = $("#input");
const sendBtn = $("#send-btn");
const modelPillBtn = $("#model-switcher-btn");
const modelPillLabel = $("#model-pill-label");
const modelModal = $("#model-modal");
const modelModalSub = $("#model-modal-sub");
const modelGrid = $("#model-grid");
const modalClose = $("#modal-close");
const progressOverlay = $("#progress-overlay");
const progressModelName = $("#progress-model-name");
const progressBar = $("#progress-bar");
const progressText = $("#progress-text");
const noWebgpu = $("#no-webgpu");

let modalIsForced = false;
let isGenerating = false;

// ---------------------------------------------------------------------------
// Sidebar (mobile drawer)
// ---------------------------------------------------------------------------
hamburger.addEventListener("click", () => {
  const open = layout.classList.toggle("sidebar-open");
  hamburger.setAttribute("aria-expanded", String(open));
});
sidebarOverlay.addEventListener("click", () => {
  layout.classList.remove("sidebar-open");
  hamburger.setAttribute("aria-expanded", "false");
});

function closeMobileSidebar() {
  if (window.innerWidth <= 860) layout.classList.remove("sidebar-open");
}

// ---------------------------------------------------------------------------
// Archives
// ---------------------------------------------------------------------------
function renderArchiveList() {
  archiveList.innerHTML = "";
  if (!chats.length) {
    archiveList.innerHTML = `<div class="archive-empty">No chats yet. Start one below.</div>`;
    return;
  }
  const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const chat of sorted) {
    const item = document.createElement("div");
    item.className = "archive-item" + (chat.id === currentChatId ? " active" : "");
    item.innerHTML = `<span class="archive-title">${escapeHtml(chat.title || "New chat")}</span><button class="archive-del" title="Delete chat" aria-label="Delete chat">✕</button>`;
    item.querySelector(".archive-title").addEventListener("click", () => {
      currentChatId = chat.id;
      renderChat();
      renderArchiveList();
      closeMobileSidebar();
    });
    item.querySelector(".archive-del").addEventListener("click", (e) => {
      e.stopPropagation();
      chats = chats.filter((c) => c.id !== chat.id);
      saveChats(chats);
      if (currentChatId === chat.id) currentChatId = chats[0]?.id || null;
      renderArchiveList();
      renderChat();
    });
    archiveList.appendChild(item);
  }
}

function createNewChat() {
  const chat = { id: uid(), title: "", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
  chats.unshift(chat);
  currentChatId = chat.id;
  saveChats(chats);
  renderArchiveList();
  renderChat();
  closeMobileSidebar();
  input.focus();
}
newChatBtn.addEventListener("click", createNewChat);

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function attachFeedback(row, msg) {
  const wrap = document.createElement("div");
  wrap.className = "fb-row";
  wrap.innerHTML = `
    <button class="fb-btn" data-type="like" aria-label="Good response" title="Good response">${ICON_THUMB_UP}</button>
    <button class="fb-btn" data-type="dislike" aria-label="Bad response" title="Bad response">${ICON_THUMB_DOWN}</button>
  `;
  const likeBtn = wrap.querySelector('[data-type="like"]');
  const dislikeBtn = wrap.querySelector('[data-type="dislike"]');

  function refresh() {
    likeBtn.classList.toggle("active", msg.feedback === "like");
    dislikeBtn.classList.toggle("active", msg.feedback === "dislike");
  }
  refresh();

  function setFeedback(type) {
    const newVal = msg.feedback === type ? null : type;
    msg.feedback = newVal;
    if (newVal) {
      const chat = getCurrentChat();
      const idx = chat ? chat.messages.indexOf(msg) : -1;
      const userMsg = idx > 0 ? chat.messages[idx - 1] : null;
      recordFeedback(newVal, userMsg?.content || "", msg.content);
    }
    saveChats(chats);
    refresh();
  }

  likeBtn.addEventListener("click", () => setFeedback("like"));
  dislikeBtn.addEventListener("click", () => setFeedback("dislike"));
  row.appendChild(wrap);
}

function buildMessageRow(msg) {
  const row = document.createElement("div");
  row.className = "msg-row " + (msg.role === "user" ? "user" : "assistant");

  if (msg.role === "assistant") {
    const tag = document.createElement("div");
    tag.className = "msg-model-tag";
    const model = MODELS[msg.modelKey];
    tag.textContent = "🦐 " + (model ? model.name : "ShrimGen");
    row.appendChild(tag);
  }

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = renderMarkdown(msg.content);
  row.appendChild(bubble);

  const time = document.createElement("div");
  time.className = "msg-time";
  time.textContent = formatTime(msg.ts || Date.now());
  row.appendChild(time);

  if (msg.role === "assistant" && msg.content) {
    attachFeedback(row, msg);
  }

  return { row, bubble };
}

function renderChat() {
  messagesEl.innerHTML = "";
  const chat = getCurrentChat();
  if (!chat || chat.messages.length === 0) {
    emptyState.classList.remove("hidden");
    return;
  }
  emptyState.classList.add("hidden");
  for (const msg of chat.messages) {
    const { row } = buildMessageRow(msg);
    messagesEl.appendChild(row);
  }
  scrollToBottom();
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// Model modal + grid
// ---------------------------------------------------------------------------
function openModelModal(forced = false) {
  modalIsForced = forced;
  modalClose.style.display = forced ? "none" : "";
  modelModalSub.textContent = forced
    ? "Install an AI to get started. Pick whichever Shrim fits your device — you can add more, switch, or uninstall anytime."
    : "Pick a model to install or switch to. Switching keeps your current conversation — the new Shrim picks up the full chat history. Installed models you're not using can be uninstalled to free up space.";
  renderModelGrid();
  modelModal.classList.remove("hidden");
}
function closeModelModal() {
  if (modalIsForced) return;
  modelModal.classList.add("hidden");
}
modalClose.addEventListener("click", closeModelModal);
modelModal.addEventListener("click", (e) => {
  if (e.target === modelModal) closeModelModal();
});
modelPillBtn.addEventListener("click", () => openModelModal(false));

function renderModelGrid() {
  modelGrid.innerHTML = "";
  for (const model of Object.values(MODELS)) {
    const installed = isModelInstalled(model.key);
    const isCurrent = aiEngine.activeKey === model.key;

    const card = document.createElement("div");
    card.className = "model-card" + (isCurrent ? " active" : "");

    const devTags = model.devices.map((d) => `<span class="device-tag">${escapeHtml(d)}</span>`).join("");

    card.innerHTML = `
      <div class="ticket-head">
        <span class="shrim-name">🦐 ${escapeHtml(model.name)}</span>
        <span class="shrim-desc">${escapeHtml(model.description)}</span>
        <div class="ticket-notch"></div>
      </div>
      <div class="ticket-body">
        <p class="ticket-tagline">${escapeHtml(model.tagline)}</p>
        <div class="spec-rows">
          <div class="spec-row"><span>Params</span><span>${escapeHtml(model.params)}</span></div>
          <div class="spec-row"><span>Download</span><span>${escapeHtml(model.downloadSize)}</span></div>
          <div class="spec-row"><span>VRAM</span><span>${escapeHtml(model.vram)}</span></div>
          <div class="spec-row"><span>RAM</span><span>${escapeHtml(model.specs.ram)}</span></div>
          <div class="spec-row"><span>GPU</span><span>${escapeHtml(model.specs.gpu)}</span></div>
          <div class="spec-row"><span>CPU</span><span>${escapeHtml(model.specs.cpu)}</span></div>
        </div>
        <div class="device-tags">${devTags}</div>
        <div class="model-action-row">
          <button class="model-action ${isCurrent ? "current" : installed ? "installed" : ""}">
            ${isCurrent ? "Currently active" : installed ? "Switch to this Shrim" : "Install"}
          </button>
          ${installed && !isCurrent ? `<button class="model-uninstall" title="Uninstall ${escapeHtml(model.name)}" aria-label="Uninstall ${escapeHtml(model.name)}">${ICON_TRASH}</button>` : ""}
        </div>
      </div>
    `;

    const btn = card.querySelector(".model-action");
    if (!isCurrent) {
      btn.addEventListener("click", () => chooseModel(model.key));
    } else {
      btn.disabled = true;
    }

    const uninstallBtn = card.querySelector(".model-uninstall");
    if (uninstallBtn) {
      uninstallBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Uninstall ${model.name}? You'll need to download it again to use it later.`)) return;
        await uninstallModel(model.key);
        if (localStorage.getItem(ACTIVE_MODEL_KEY) === model.key) {
          localStorage.removeItem(ACTIVE_MODEL_KEY);
        }
        renderModelGrid();
      });
    }

    modelGrid.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// Progress overlay
// ---------------------------------------------------------------------------
const progressSubstatus = $("#progress-substatus");
let progressState = { startedAt: 0, lastPct: -1, lastChangeAt: 0, stallTimer: null };

function clearStallTimer() {
  if (progressState.stallTimer) {
    clearInterval(progressState.stallTimer);
    progressState.stallTimer = null;
  }
}

function showProgress(modelName) {
  progressModelName.textContent = "Installing " + modelName + "…";
  progressBar.style.width = "0%";
  progressBar.classList.remove("stalled");
  progressText.textContent = "Preparing download…";
  progressSubstatus.classList.add("hidden");
  progressSubstatus.textContent = "";
  progressOverlay.classList.remove("hidden");

  const now = Date.now();
  progressState = { startedAt: now, lastPct: -1, lastChangeAt: now, stallTimer: null };
  clearStallTimer();
  progressState.stallTimer = setInterval(() => {
    const stalledFor = Date.now() - progressState.lastChangeAt;
    if (stalledFor > 12000) {
      progressBar.classList.add("stalled");
      progressSubstatus.classList.remove("hidden");
      const totalSecs = Math.round((Date.now() - progressState.startedAt) / 1000);
      progressSubstatus.textContent =
        totalSecs > 60
          ? "Still setting up — compiling the model for your device's GPU. This step can take a few minutes, especially on phones the first time. It'll be much faster next time."
          : "Still working — setting up on your device's GPU. This can take a little while, especially on mobile.";
    }
  }, 2000);
}

function updateProgress(report) {
  let pct = 0;
  if (typeof report.progress === "number") pct = Math.round(report.progress * 100);

  if (pct !== progressState.lastPct) {
    progressState.lastPct = pct;
    progressState.lastChangeAt = Date.now();
    progressBar.classList.remove("stalled");
    progressSubstatus.classList.add("hidden");
  }

  progressBar.style.width = pct + "%";

  const text = report.text || "";
  const isCompiling = pct >= 100 || /shader|gpu|kv.?cache|compil/i.test(text);
  progressText.textContent = isCompiling
    ? "Setting up on your device's GPU…"
    : text || pct + "% downloaded";
}

function hideProgress(delay = 0) {
  clearStallTimer();
  if (delay) {
    setTimeout(() => progressOverlay.classList.add("hidden"), delay);
  } else {
    progressOverlay.classList.add("hidden");
  }
}

function updateModelPill() {
  const model = MODELS[aiEngine.activeKey];
  modelPillLabel.textContent = model ? "🦐 " + model.name : "Choose a model";
  modelPillBtn.disabled = false;
}

async function chooseModel(modelKey) {
  const model = MODELS[modelKey];
  if (!model) return;
  if (aiEngine.activeKey === modelKey) {
    closeModelModal();
    return;
  }
  showProgress(model.name);
  try {
    await aiEngine.load(modelKey, updateProgress);
    localStorage.setItem(ACTIVE_MODEL_KEY, modelKey);
    if (aiEngine.usedFallback) {
      progressBar.style.width = "100%";
      progressText.textContent = "Loaded in compatibility mode for your GPU.";
      hideProgress(1100);
    } else {
      hideProgress();
    }
    modalIsForced = false;
    closeModelModal();
    updateModelPill();
    renderModelGrid();
  } catch (err) {
    console.error(err);
    hideProgress();
    const msg = String(err?.message || err);
    const isAdapterIssue = /no available adapters|unable to find a compatible gpu/i.test(msg);
    alert(
      isAdapterIssue
        ? `Couldn't load ${model.name}: your browser couldn't reach the GPU right now. This usually clears up after fully closing and reopening your browser (a previous model may have left the GPU in a bad state). If it persists, check chrome://gpu to confirm WebGPU is hardware-accelerated.`
        : `Couldn't load ${model.name}. ${msg || "Please try again."}`
    );
  }
}

// ---------------------------------------------------------------------------
// Sending messages
// ---------------------------------------------------------------------------
function autoResizeInput() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
}
input.addEventListener("input", autoResizeInput);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    composer.requestSubmit();
  }
});

composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || isGenerating) return;

  if (!aiEngine.activeKey) {
    openModelModal(true);
    return;
  }

  if (!currentChatId) {
    const chat = { id: uid(), title: "", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    chats.unshift(chat);
    currentChatId = chat.id;
  }
  const chat = getCurrentChat();

  const userMsg = { role: "user", content: text, ts: Date.now() };
  chat.messages.push(userMsg);
  if (!chat.title) chat.title = text.slice(0, 48) + (text.length > 48 ? "…" : "");
  chat.updatedAt = Date.now();
  saveChats(chats);

  emptyState.classList.add("hidden");
  const { row: userRow } = buildMessageRow(userMsg);
  messagesEl.appendChild(userRow);
  input.value = "";
  autoResizeInput();
  scrollToBottom();
  renderArchiveList();

  // placeholder assistant bubble
  const assistantMsg = { role: "assistant", content: "", modelKey: aiEngine.activeKey, ts: Date.now() };
  const { row: aRow, bubble: aBubble } = buildMessageRow(assistantMsg);
  aBubble.classList.add("typing");
  messagesEl.appendChild(aRow);
  scrollToBottom();

  isGenerating = true;
  sendBtn.disabled = true;

  const history = [
    { role: "system", content: SYSTEM_PROMPT.content + getLearningContext() },
    ...chat.messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  try {
    const full = await aiEngine.streamChat(history, (delta, fullText) => {
      aBubble.innerHTML = renderMarkdown(fullText);
      aBubble.classList.add("typing");
      scrollToBottom();
    });
    aBubble.classList.remove("typing");
    assistantMsg.content = full || "…";
    aBubble.innerHTML = renderMarkdown(assistantMsg.content);
    attachFeedback(aRow, assistantMsg);
    chat.messages.push(assistantMsg);
    chat.updatedAt = Date.now();
    saveChats(chats);
  } catch (err) {
    console.error(err);
    aBubble.classList.remove("typing");
    aBubble.innerHTML = `<em>ShrimGen hit a snag generating a reply: ${escapeHtml(err?.message || "unknown error")}</em>`;
  } finally {
    isGenerating = false;
    sendBtn.disabled = false;
    renderArchiveList();
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  if (!aiEngine.supportsWebGPU()) {
    noWebgpu.classList.remove("hidden");
    return;
  }

  renderArchiveList();
  renderChat();

  const savedModelKey = localStorage.getItem(ACTIVE_MODEL_KEY);
  const anyInstalled = Object.keys(MODELS).some((k) => isModelInstalled(k));

  if (!anyInstalled) {
    openModelModal(true);
    return;
  }

  const startKey = savedModelKey && isModelInstalled(savedModelKey) ? savedModelKey : DEFAULT_MODEL_KEY;
  showProgress(MODELS[startKey].name);
  try {
    await aiEngine.load(startKey, updateProgress);
    localStorage.setItem(ACTIVE_MODEL_KEY, startKey);
    if (aiEngine.usedFallback) {
      progressBar.style.width = "100%";
      progressText.textContent = "Loaded in compatibility mode for your GPU.";
      hideProgress(1100);
    } else {
      hideProgress();
    }
  } catch (err) {
    console.error(err);
    hideProgress();
  } finally {
    updateModelPill();
  }
}

boot();

// Register the service worker for offline app-shell support.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW registration failed:", e));
  });
}