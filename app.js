// app.js - ShrimGen UI logic
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
// Vector icons (single color via currentColor, no emoji anywhere)
// ---------------------------------------------------------------------------
const ICON_THUMB_UP =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3zm0 0 4.5-8a2 2 0 0 1 2 .3 2 2 0 0 1 .7 1.9L13.4 9H18a2 2 0 0 1 2 2.4l-1.5 7A2 2 0 0 1 16.5 20H7"/></svg>';
const ICON_THUMB_DOWN =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 13V4h3a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-3zm0 0-4.5 8a2 2 0 0 1-2-.3 2 2 0 0 1-.7-1.9l.8-5.8H6a2 2 0 0 1-2-2.4l1.5-7A2 2 0 0 1 7.5 3H17"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4.8c0-.4.4-.8.9-.8h4.2c.5 0 .9.4.9.8V7m2 0-.8 12.2c-.1.9-.8 1.6-1.7 1.6H8.6c-.9 0-1.6-.7-1.7-1.6L6 7"/></svg>';
const ICON_COPY =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const ICON_CHECK =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>';
const ICON_PENCIL =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 3.5a2 2 0 0 1 2.83 2.83L7 18.66 3 19.5l.84-4L16.5 3.5z"/></svg>';
const ICON_CHEV_LEFT =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
const ICON_CHEV_RIGHT =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';
const ICON_PIN =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4.5h6l-.6 5.5L17 13v2H7v-2l2.6-3L9 4.5z"/><path d="M12 15v5"/></svg>';

// ---------------------------------------------------------------------------
// Tiny markdown renderer (bold, italics, code, lists, headers, links, quotes)
// ---------------------------------------------------------------------------
const CURSOR_MARKER = "\u0000CURSOR\u0000";

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderMarkdown(src, withCursor = false) {
  if (!src && !withCursor) return "";
  const codeBlocks = [];
  let text = (src || "") + (withCursor ? CURSOR_MARKER : "");

  text = text.replace(/```([a-zA-Z0-9]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
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
  text = text.replace(CURSOR_MARKER, '<span class="caret"></span>');

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
    "You are ShrimGen, a friendly, concise, and helpful AI assistant running entirely on the user's device. Format replies with markdown (bold, italics, lists, code) when it helps clarity. This is a brand-new, independent conversation: you have no memory of any other chat thread, and must never refer to or assume content from a previous conversation that hasn't appeared in this message history.",
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
function getMostRecentChatId() {
  if (!chats.length) return null;
  return chats.reduce((latest, c) => (c.createdAt > latest.createdAt ? c : latest), chats[0]).id;
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const layout = $("#layout");
const sidebarOverlay = $("#sidebar-overlay");
const hamburger = $("#hamburger");
const newChatBtn = $("#new-chat-btn");
const archiveList = $("#archive-list");
const messagesEl = $("#messages");
const emptyState = $("#empty-state");
const composer = $("#composer");
const input = $("#input");
const sendBtn = $("#send-btn");
const stopBtn = $("#stop-btn");
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
const progressSubstatus = $("#progress-substatus");
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
// Archives (with pin + delete)
// ---------------------------------------------------------------------------
function renderArchiveList() {
  archiveList.innerHTML = "";
  if (!chats.length) {
    archiveList.innerHTML = `<div class="archive-empty">No chats yet. Start one below.</div>`;
    return;
  }
  const sorted = [...chats].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });

  for (const chat of sorted) {
    const item = document.createElement("div");
    item.className = "archive-item" + (chat.id === currentChatId ? " active" : "");
    item.innerHTML = `
      <span class="archive-title">
        ${chat.pinned ? `<svg class="pin-mark" viewBox="0 0 24 24" fill="currentColor"><path d="M9 4.5h6l-.6 5.5L17 13v2H7v-2l2.6-3L9 4.5z"/><path d="M12 15v5" stroke="currentColor" stroke-width="2"/></svg>` : ""}
        <span class="archive-title-text">${escapeHtml(chat.title || "New chat")}</span>
      </span>
      <span class="archive-actions">
        <button class="archive-pin ${chat.pinned ? "pinned" : ""}" title="${chat.pinned ? "Unpin" : "Pin"} chat" aria-label="${chat.pinned ? "Unpin" : "Pin"} chat">${ICON_PIN}</button>
        <button class="archive-del" title="Delete chat" aria-label="Delete chat">${ICON_TRASH}</button>
      </span>
    `;
    item.querySelector(".archive-title").addEventListener("click", () => {
      currentChatId = chat.id;
      renderChat();
      renderArchiveList();
      closeMobileSidebar();
    });
    item.querySelector(".archive-pin").addEventListener("click", (e) => {
      e.stopPropagation();
      chat.pinned = !chat.pinned;
      saveChats(chats);
      renderArchiveList();
    });
    item.querySelector(".archive-del").addEventListener("click", (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${chat.title || "this chat"}"? This can't be undone.`)) return;
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
  const chat = { id: uid(), title: "", messages: [], pinned: false, createdAt: Date.now(), updatedAt: Date.now() };
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
    <button class="fb-btn copy-btn" data-type="copy" aria-label="Copy response" title="Copy response">${ICON_COPY}</button>
    <button class="fb-btn" data-type="like" aria-label="Good response" title="Good response">${ICON_THUMB_UP}</button>
    <button class="fb-btn" data-type="dislike" aria-label="Bad response" title="Bad response">${ICON_THUMB_DOWN}</button>
  `;
  const copyBtn = wrap.querySelector('[data-type="copy"]');
  const likeBtn = wrap.querySelector('[data-type="like"]');
  const dislikeBtn = wrap.querySelector('[data-type="dislike"]');

  function refresh() {
    likeBtn.classList.toggle("active", msg.feedback === "like");
    dislikeBtn.classList.toggle("active", msg.feedback === "dislike");
  }
  refresh();

  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(msg.content || "");
    } catch {
      // Clipboard API unavailable (e.g. insecure context), fail silently.
    }
    const original = copyBtn.innerHTML;
    copyBtn.innerHTML = ICON_CHECK;
    copyBtn.disabled = true;
    setTimeout(() => {
      copyBtn.innerHTML = original;
      copyBtn.disabled = false;
    }, 1200);
  });

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

/** Attaches an edit pencil + branch nav arrows to the most recent user message of the most recent chat. */
function attachEditControls(row, msg, chat) {
  const isMostRecentChat = chat.id === getMostRecentChatId();
  const lastUserIdx = (() => {
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i].role === "user") return i;
    }
    return -1;
  })();
  const idx = chat.messages.indexOf(msg);
  const isEditable = isMostRecentChat && idx === lastUserIdx && !isGenerating;
  if (idx === -1) return;

  const metaRow = document.createElement("div");
  metaRow.className = "msg-meta-row";

  if (msg.branches && msg.branches.length > 1) {
    const nav = document.createElement("div");
    nav.className = "branch-nav";
    nav.innerHTML = `
      <button class="branch-prev" aria-label="Previous version">${ICON_CHEV_LEFT}</button>
      <span class="branch-count">${msg.activeBranch + 1}/${msg.branches.length}</span>
      <button class="branch-next" aria-label="Next version">${ICON_CHEV_RIGHT}</button>
    `;
    const prevBtn = nav.querySelector(".branch-prev");
    const nextBtn = nav.querySelector(".branch-next");
    prevBtn.disabled = msg.activeBranch === 0;
    nextBtn.disabled = msg.activeBranch === msg.branches.length - 1;
    prevBtn.addEventListener("click", () => switchBranch(chat, msg, msg.activeBranch - 1));
    nextBtn.addEventListener("click", () => switchBranch(chat, msg, msg.activeBranch + 1));
    metaRow.appendChild(nav);
  }

  if (isEditable) {
    const editBtn = document.createElement("button");
    editBtn.className = "fb-btn edit-btn";
    editBtn.innerHTML = ICON_PENCIL;
    editBtn.title = "Edit message";
    editBtn.setAttribute("aria-label", "Edit message");
    editBtn.addEventListener("click", () => enterEditMode(row, msg, chat));
    metaRow.appendChild(editBtn);
  }

  if (metaRow.children.length) row.appendChild(metaRow);
}

function switchBranch(chat, msg, newIndex) {
  if (!msg.branches || newIndex < 0 || newIndex >= msg.branches.length) return;
  const branch = msg.branches[newIndex];
  msg.activeBranch = newIndex;
  msg.content = branch.content;
  const idx = chat.messages.indexOf(msg);
  const nextMsg = chat.messages[idx + 1];
  if (nextMsg && nextMsg.role === "assistant") {
    nextMsg.content = branch.assistantContent || "";
    nextMsg.modelKey = branch.assistantModelKey || nextMsg.modelKey;
  }
  saveChats(chats);
  renderChat();
}

function enterEditMode(row, msg, chat) {
  const bubble = row.querySelector(".bubble");
  if (!bubble) return;
  const originalHTML = row.innerHTML;

  row.innerHTML = "";
  const box = document.createElement("div");
  box.className = "edit-box";
  box.innerHTML = `
    <textarea class="edit-textarea"></textarea>
    <div class="edit-box-actions">
      <button class="edit-cancel" type="button">Cancel</button>
      <button class="edit-save" type="button">Save & submit</button>
    </div>
  `;
  const textarea = box.querySelector(".edit-textarea");
  textarea.value = msg.content;
  row.appendChild(box);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  box.querySelector(".edit-cancel").addEventListener("click", () => {
    row.innerHTML = originalHTML;
    // Re-bind: easiest reliable path is a full re-render.
    renderChat();
  });

  box.querySelector(".edit-save").addEventListener("click", () => {
    const newText = textarea.value.trim();
    if (!newText) return;
    editUserMessage(chat, msg, newText);
  });
}

async function editUserMessage(chat, msg, newText) {
  const idx = chat.messages.indexOf(msg);
  if (idx === -1) return;
  const nextMsg = chat.messages[idx + 1];
  const oldAssistant = nextMsg && nextMsg.role === "assistant" ? nextMsg : null;

  if (!msg.branches) {
    msg.branches = [
      {
        content: msg.content,
        assistantContent: oldAssistant ? oldAssistant.content : "",
        assistantModelKey: oldAssistant ? oldAssistant.modelKey : null,
      },
    ];
    msg.activeBranch = 0;
  }

  // Drop the old reply (and anything after); we're regenerating from here.
  chat.messages = chat.messages.slice(0, idx + 1);
  msg.content = newText;
  if (idx === 0) {
    chat.title = newText.slice(0, 48) + (newText.length > 48 ? "…" : "");
  }
  chat.updatedAt = Date.now();
  saveChats(chats);
  renderChat();
  renderArchiveList();

  const assistantMsg = await generateAssistantReply(chat);

  msg.branches.push({
    content: newText,
    assistantContent: assistantMsg ? assistantMsg.content : "",
    assistantModelKey: assistantMsg ? assistantMsg.modelKey : null,
  });
  msg.activeBranch = msg.branches.length - 1;
  saveChats(chats);
  renderChat();
}

function buildMessageRow(msg, chat) {
  const row = document.createElement("div");
  row.className = "msg-row " + (msg.role === "user" ? "user" : "assistant");

  if (msg.role === "assistant") {
    const tag = document.createElement("div");
    tag.className = "msg-model-tag";
    const model = MODELS[msg.modelKey];
    tag.textContent = model ? model.name : "ShrimGen";
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
  if (msg.role === "user" && chat) {
    attachEditControls(row, msg, chat);
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
    const { row } = buildMessageRow(msg, chat);
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
  modelModalSub.textContent = forced
    ? "Install an AI to get started. Pick whichever Shrim fits your device, you can add more, switch, or uninstall anytime."
    : "Pick a model to install or switch to. Switching keeps your current conversation, and the new Shrim picks up the full chat history. Installed models you're not using can be uninstalled to free up space.";
  renderModelGrid();
  modelModal.classList.remove("hidden");
}
function closeModelModal() {
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
        <span class="shrim-name">${escapeHtml(model.name)}</span>
        <span class="shrim-desc">${escapeHtml(model.description)}</span>
      </div>
      <div class="ticket-body">
        <p class="ticket-tagline">${escapeHtml(model.tagline)}</p>
        <div class="spec-rows">
          <div class="spec-row"><span>Params</span><span>${escapeHtml(model.params)}</span></div>
          <div class="spec-row"><span>Download</span><span>${escapeHtml(model.downloadSize)}</span></div>
          <div class="spec-row"><span>Est. install time</span><span>${escapeHtml(model.estInstall || "Varies")}</span></div>
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
          ? "Still setting up, compiling the model for your device's GPU. This step can take a few minutes, especially on phones the first time. It'll be much faster next time."
          : "Still working, setting up on your device's GPU. This can take a little while, especially on mobile.";
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

function setSendAvailability() {
  sendBtn.disabled = isGenerating || !aiEngine.activeKey;
}

function updateModelPill() {
  const model = MODELS[aiEngine.activeKey];
  modelPillLabel.textContent = model ? model.name : "Choose a model";
  modelPillBtn.disabled = false;
  setSendAvailability();
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
// Composer: auto-resize (no scrollbar until 10 lines), send / stop toggle
// ---------------------------------------------------------------------------
const LINE_HEIGHT = 22;
const MAX_LINES = 10;

function autoResizeInput() {
  input.style.height = "auto";
  const maxHeight = LINE_HEIGHT * MAX_LINES;
  const desired = input.scrollHeight;
  const capped = Math.min(desired, maxHeight);
  input.style.height = capped + "px";
  input.style.overflowY = desired > maxHeight ? "auto" : "hidden";
}
input.addEventListener("input", autoResizeInput);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    composer.requestSubmit();
  }
});

function setGeneratingUI(generating) {
  isGenerating = generating;
  sendBtn.classList.toggle("hidden", generating);
  stopBtn.classList.toggle("hidden", !generating);
  setSendAvailability();
}

stopBtn.addEventListener("click", async () => {
  await aiEngine.interrupt();
});

/**
 * Builds the full message history for `chat`, streams a reply from the
 * currently active model, and appends it to the chat. Used both for normal
 * sends and for regenerating after an edit. Returns the finished assistant
 * message object (or null on hard failure).
 */
async function generateAssistantReply(chat) {
  const assistantMsg = { role: "assistant", content: "", modelKey: aiEngine.activeKey, ts: Date.now() };
  const { row: aRow, bubble: aBubble } = buildMessageRow(assistantMsg, null);
  messagesEl.appendChild(aRow);
  aBubble.innerHTML = '<span class="dot-loading"><span></span><span></span><span></span></span>';
  scrollToBottom();

  setGeneratingUI(true);

  const history = [
    { role: "system", content: SYSTEM_PROMPT.content + getLearningContext() },
    ...chat.messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  try {
    const full = await aiEngine.streamChat(history, (delta, fullText) => {
      aBubble.innerHTML = renderMarkdown(fullText, true);
      scrollToBottom();
    });
    assistantMsg.content = (full || "").trim() || "...";
    aBubble.innerHTML = renderMarkdown(assistantMsg.content);
    attachFeedback(aRow, assistantMsg);
    chat.messages.push(assistantMsg);
    chat.updatedAt = Date.now();
    saveChats(chats);
    return assistantMsg;
  } catch (err) {
    console.error(err);
    aBubble.innerHTML = `<em>ShrimGen hit a snag generating a reply: ${escapeHtml(err?.message || "unknown error")}</em>`;
    return null;
  } finally {
    setGeneratingUI(false);
    renderArchiveList();
  }
}

composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || isGenerating) return;

  if (!aiEngine.activeKey) {
    openModelModal(true);
    return;
  }

  if (!currentChatId) {
    const chat = { id: uid(), title: "", messages: [], pinned: false, createdAt: Date.now(), updatedAt: Date.now() };
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
  const { row: userRow } = buildMessageRow(userMsg, chat);
  messagesEl.appendChild(userRow);
  input.value = "";
  autoResizeInput();
  scrollToBottom();
  renderArchiveList();

  await generateAssistantReply(chat);
  renderChat(); // refresh so edit controls reflect the new "most recent" user message
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
  setSendAvailability();

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

// ---------------------------------------------------------------------------
// Service worker: register + actively check for updates so a new deploy
// takes effect right away instead of waiting for a manual hard-refresh.
// ---------------------------------------------------------------------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("./sw.js");

      // Check for a new version immediately, then periodically.
      registration.update();
      setInterval(() => registration.update(), 5 * 60 * 1000);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") registration.update();
      });

      // If a new worker finishes installing, activate it right away.
      registration.addEventListener("updatefound", () => {
        const newWorker = registration.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", () => {
          if (newWorker.state === "installed" && registration.waiting) {
            registration.waiting.postMessage("SKIP_WAITING");
          }
        });
      });

      // Once the new worker takes control, reload once to pick up fresh files.
      let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
      });
    } catch (e) {
      console.warn("SW registration failed:", e);
    }
  });
}