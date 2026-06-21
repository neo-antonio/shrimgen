// app.js — ShrimGen UI logic
import { aiEngine, MODELS, DEFAULT_MODEL_KEY, isModelInstalled } from "./ai-engine.js";

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
    ? "Install an AI to get started. Pick whichever Shrim fits your device — you can add more, or switch, anytime."
    : "Pick a model to install or switch to. Switching keeps your current conversation — the new Shrim picks up the full chat history.";
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
        <button class="model-action ${isCurrent ? "current" : installed ? "installed" : ""}">
          ${isCurrent ? "Currently active" : installed ? "Switch to this Shrim" : "Install"}
        </button>
      </div>
    `;

    const btn = card.querySelector(".model-action");
    if (!isCurrent) {
      btn.addEventListener("click", () => chooseModel(model.key));
    } else {
      btn.disabled = true;
    }

    modelGrid.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// Progress overlay
// ---------------------------------------------------------------------------
function showProgress(modelName) {
  progressModelName.textContent = "Installing " + modelName + "…";
  progressBar.style.width = "0%";
  progressText.textContent = "Preparing download…";
  progressOverlay.classList.remove("hidden");
}
function updateProgress(report) {
  let pct = 0;
  if (typeof report.progress === "number") pct = Math.round(report.progress * 100);
  progressBar.style.width = pct + "%";
  progressText.textContent = report.text || pct + "% complete";
}
function hideProgress() {
  progressOverlay.classList.add("hidden");
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
    hideProgress();
    modalIsForced = false;
    closeModelModal();
    updateModelPill();
    renderModelGrid();
  } catch (err) {
    console.error(err);
    hideProgress();
    alert("Couldn't load " + model.name + ". " + (err?.message || "Please try again."));
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
    SYSTEM_PROMPT,
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
  } catch (err) {
    console.error(err);
  } finally {
    hideProgress();
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
