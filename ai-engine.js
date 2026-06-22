// ai-engine.js
// Thin wrapper around @mlc-ai/web-llm that ShrimGen uses to install models,
// switch between them mid-conversation, and stream replies token by token.
//
// All inference happens on-device via WebGPU. Nothing is ever sent to a server.

import * as webllm from "https://esm.run/@mlc-ai/web-llm";

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------
// `id` is the WebLLM/MLC prebuilt model id actually fetched from Hugging Face
// and run through WebGPU. Everything else is ShrimGen's own presentation.
export const MODELS = {
  shrimgen: {
    key: "shrimgen",
    name: "ShrimGen",
    tagline: "The default Shrim. Balanced and quick to install.",
    description: "StableLM 2 Zephyr · 1.6B parameters",
    params: "1.6B",
    id: "stablelm-2-zephyr-1_6b-q4f16_1-MLC",
    fallbackId: "stablelm-2-zephyr-1_6b-q4f32_1-MLC",
    downloadSize: "~1.0 GB",
    vram: "~1.8 GB VRAM",
    devices: ["Phone (high-end)", "Tablet", "Laptop", "PC"],
    specs: { ram: "4 GB+", gpu: "Any WebGPU GPU, 2 GB+ VRAM", cpu: "Any modern CPU" },
    isDefault: true,
  },
  shrimqwen: {
    key: "shrimqwen",
    name: "ShrimQwen",
    tagline: "Tiny and nimble. Great on phones.",
    description: "Qwen2.5 · 0.5B parameters",
    params: "0.5B",
    id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
    fallbackId: "Qwen2.5-0.5B-Instruct-q4f32_1-MLC",
    downloadSize: "~0.4 GB",
    vram: "~0.9 GB VRAM",
    devices: ["Phone", "Tablet", "Laptop", "PC"],
    specs: { ram: "2 GB+", gpu: "Any WebGPU GPU, 1 GB+ VRAM", cpu: "Any modern CPU" },
  },
  smolshrim: {
    key: "smolshrim",
    name: "SmolShrim",
    tagline: "The lightest Shrim of all. Installs in seconds.",
    description: "SmolLM2 · 360M parameters",
    params: "0.36B",
    id: "SmolLM2-360M-Instruct-q4f16_1-MLC",
    fallbackId: "SmolLM2-360M-Instruct-q4f32_1-MLC",
    downloadSize: "~0.25 GB",
    vram: "~0.5 GB VRAM",
    devices: ["Phone", "Tablet", "Laptop", "PC"],
    specs: { ram: "2 GB+", gpu: "Any WebGPU GPU, 1 GB+ VRAM", cpu: "Any modern CPU" },
  },
  shrimma: {
    key: "shrimma",
    name: "Shrimma",
    tagline: "A pocket-sized chat companion.",
    description: "TinyLlama · 1.1B parameters",
    params: "1.1B",
    id: "TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC",
    fallbackId: "TinyLlama-1.1B-Chat-v1.0-q4f32_1-MLC",
    downloadSize: "~0.7 GB",
    vram: "~1.0 GB VRAM",
    devices: ["Phone", "Tablet", "Laptop", "PC"],
    specs: { ram: "3 GB+", gpu: "Any WebGPU GPU, 1.5 GB+ VRAM", cpu: "Any modern CPU" },
  },
  shrimllama: {
    key: "shrimllama",
    name: "ShrimLlama",
    tagline: "Sharper reasoning for everyday tasks.",
    description: "Llama 3.2 · 3B parameters",
    params: "3B",
    id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    fallbackId: "Llama-3.2-3B-Instruct-q4f32_1-MLC",
    downloadSize: "~1.9 GB",
    vram: "~2.9 GB VRAM",
    devices: ["Tablet (high-end)", "Laptop", "PC"],
    specs: { ram: "8 GB+", gpu: "3 GB+ VRAM, dedicated or unified", cpu: "Modern multi-core CPU" },
  },
  shrimphi: {
    key: "shrimphi",
    name: "ShrimPhi",
    tagline: "Compact but capable, built for reasoning.",
    description: "Phi-3.5 Mini · 3.8B parameters",
    params: "3.8B",
    id: "Phi-3.5-mini-instruct-q4f16_1-MLC",
    fallbackId: "Phi-3.5-mini-instruct-q4f32_1-MLC",
    downloadSize: "~2.2 GB",
    vram: "~3.6 GB VRAM",
    devices: ["Laptop", "PC"],
    specs: { ram: "8 GB+", gpu: "4 GB+ VRAM, dedicated or unified", cpu: "Modern multi-core CPU" },
  },
  shrimistral: {
    key: "shrimistral",
    name: "ShriMistral",
    tagline: "A heavyweight Shrim for serious conversations.",
    description: "Mistral · 7B parameters",
    params: "7B",
    id: "Mistral-7B-Instruct-v0.3-q4f16_1-MLC",
    fallbackId: "Mistral-7B-Instruct-v0.3-q4f32_1-MLC",
    downloadSize: "~4.0 GB",
    vram: "~5.5 GB VRAM",
    devices: ["Laptop (high-end)", "PC"],
    specs: { ram: "16 GB+", gpu: "6 GB+ dedicated VRAM", cpu: "Modern multi-core CPU" },
  },
  shrimgemm: {
    key: "shrimgemm",
    name: "ShrimGemm",
    tagline: "The biggest catch. Needs a powerful rig.",
    description: "Gemma 2 · 9B parameters",
    params: "9B",
    id: "gemma-2-9b-it-q4f16_1-MLC",
    fallbackId: "gemma-2-9b-it-q4f32_1-MLC",
    downloadSize: "~5.5 GB",
    vram: "~6.5 GB VRAM",
    devices: ["PC (high-end only)"],
    specs: { ram: "24 GB+", gpu: "8 GB+ dedicated VRAM", cpu: "High-end multi-core CPU" },
  },
};

export const DEFAULT_MODEL_KEY = "shrimgen";

const INSTALLED_KEY = "shrimgen_installed_models";

function getInstalledSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem(INSTALLED_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function saveInstalledSet(set) {
  localStorage.setItem(INSTALLED_KEY, JSON.stringify([...set]));
}

export function isModelInstalled(key) {
  return getInstalledSet().has(key);
}

export function markModelInstalled(key) {
  const set = getInstalledSet();
  set.add(key);
  saveInstalledSet(set);
}

export function forgetModel(key) {
  const set = getInstalledSet();
  set.delete(key);
  saveInstalledSet(set);
}

/**
 * Uninstalls a model: stops tracking it as installed and, on a best-effort
 * basis, clears its downloaded weights from the browser's Cache Storage so
 * the space is actually freed. If the model being uninstalled is currently
 * loaded in memory, it's unloaded first.
 */
export async function uninstallModel(modelKey) {
  const model = MODELS[modelKey];
  if (!model) return;

  if (aiEngine.activeKey === modelKey && aiEngine.engine) {
    try {
      await aiEngine.engine.unload();
    } catch (e) {
      console.warn("Unload warning during uninstall:", e);
    }
    aiEngine.engine = null;
    aiEngine.activeKey = null;
    aiEngine.activeModelId = null;
  }

  forgetModel(modelKey);

  if (typeof caches !== "undefined") {
    try {
      const ids = [model.id, model.fallbackId].filter(Boolean);
      const cacheNames = await caches.keys();
      for (const name of cacheNames) {
        const cache = await caches.open(name);
        const requests = await cache.keys();
        for (const req of requests) {
          if (ids.some((id) => req.url.includes(id))) {
            await cache.delete(req);
          }
        }
      }
    } catch (e) {
      console.warn("Cache cleanup warning during uninstall:", e);
    }
  }
}

// ---------------------------------------------------------------------------
// Lightweight feedback-driven adaptation
// ---------------------------------------------------------------------------
// True weight retraining can't happen in a browser, so ShrimGen's "learning"
// is an honest, lightweight stand-in: liked exchanges are kept as style
// examples and folded into the system prompt for future replies, so the
// model leans toward what's worked before. Disliked questions are tracked
// so ShrimGen knows to try a different angle next time.
const LIKED_KEY = "shrimgen_liked_examples";
const DISLIKED_KEY = "shrimgen_disliked_prompts";
const MAX_EXAMPLES = 5;

function readList(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
}
function writeList(key, list) {
  localStorage.setItem(key, JSON.stringify(list.slice(-MAX_EXAMPLES)));
}

export function recordFeedback(type, userText, assistantText) {
  if (type === "like") {
    const list = readList(LIKED_KEY);
    list.push({
      user: (userText || "").slice(0, 200),
      assistant: (assistantText || "").slice(0, 300),
    });
    writeList(LIKED_KEY, list);
  } else if (type === "dislike") {
    const list = readList(DISLIKED_KEY);
    list.push({ user: (userText || "").slice(0, 200) });
    writeList(DISLIKED_KEY, list);
  }
}

export function clearFeedbackMemory() {
  localStorage.removeItem(LIKED_KEY);
  localStorage.removeItem(DISLIKED_KEY);
}

/** Builds a short system-prompt addendum from past feedback, or "" if none yet. */
export function getLearningContext() {
  const liked = readList(LIKED_KEY);
  const disliked = readList(DISLIKED_KEY);
  if (!liked.length && !disliked.length) return "";

  let out = "\n\nFeedback the user has given on past replies, to help you adapt:";
  if (liked.length) {
    out += "\nReplies the user liked — match this style, tone, and length when relevant:";
    liked.forEach((ex, i) => {
      out += `\n${i + 1}. Q: "${ex.user}" — A liked: "${ex.assistant}"`;
    });
  }
  if (disliked.length) {
    out += "\nThe user disliked past replies to questions like these — try a noticeably different approach:";
    disliked.forEach((ex, i) => {
      out += `\n${i + 1}. "${ex.user}"`;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Engine class
// ---------------------------------------------------------------------------
class AIEngine {
  constructor() {
    this.engine = null;
    this.activeKey = null;
    this.activeModelId = null;
    this.usedFallback = false;
    this._cachedHasF16 = null;
  }

  supportsWebGPU() {
    return typeof navigator !== "undefined" && !!navigator.gpu;
  }

  /**
   * Right after unload()-ing a previous engine, the old GPUDevice can take a
   * moment to fully tear down. Requesting a new adapter immediately can
   * transiently fail with "No available adapters" even though the GPU is
   * fine. This retries a few times with a short backoff before giving up.
   */
  async _requestAdapterWithRetry(attempts = 4, delayMs = 350) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) return adapter;
        lastErr = new Error("No available adapters.");
      } catch (e) {
        lastErr = e;
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    throw lastErr || new Error("No available adapters.");
  }

  /**
   * Some quantizations (q4f16_1) require the optional WebGPU "shader-f16"
   * extension. Older GPUs/drivers (especially on some Windows/Intel setups)
   * don't expose it, which is exactly what throws the
   * "extension 'f16' is not allowed" / GPUPipelineError seen in the wild.
   * We check for it up front and prefer the f32 build when it's missing.
   * Result is cached for the session so we don't hammer requestAdapter().
   */
  async hasShaderF16() {
    if (!this.supportsWebGPU()) return false;
    if (this._cachedHasF16 !== null) return this._cachedHasF16;
    try {
      const adapter = await this._requestAdapterWithRetry();
      this._cachedHasF16 = adapter.features.has("shader-f16");
    } catch {
      this._cachedHasF16 = false;
    }
    return this._cachedHasF16;
  }

  /**
   * Loads (downloading if necessary) the given model and makes it the
   * active engine. Reports download/compile progress via onProgress(report).
   */
  async load(modelKey, onProgress) {
    const model = MODELS[modelKey];
    if (!model) throw new Error("Unknown model: " + modelKey);

    const initProgressCallback = (report) => {
      if (onProgress) onProgress(report);
    };

    if (this.engine) {
      // Free the previous model's GPU memory before loading a new one,
      // then give the GPU device a moment to actually finish tearing down.
      try {
        await this.engine.unload();
      } catch (e) {
        console.warn("Unload warning:", e);
      }
      this.engine = null;
      await new Promise((r) => setTimeout(r, 300));
    }

    let idToUse = model.id;
    let usedFallback = false;

    // Pick the compatible variant up front when we can, to avoid a wasted
    // download of a build that's guaranteed to fail to compile.
    if (model.fallbackId) {
      const f16ok = await this.hasShaderF16();
      if (!f16ok) {
        idToUse = model.fallbackId;
        usedFallback = true;
      }
    }

    const tryCreate = (id) => webllm.CreateMLCEngine(id, { initProgressCallback });

    try {
      this.engine = await tryCreate(idToUse);
    } catch (err) {
      const msg = String(err?.message || err);
      const looksLikeF16Issue = /shader-f16|f16|ShaderModule|GPUPipelineError/i.test(msg);
      const looksLikeNoAdapter = /no available adapters|unable to find a compatible gpu/i.test(msg);

      if (!usedFallback && model.fallbackId && looksLikeF16Issue) {
        // Retry once with the more broadly compatible quantization.
        idToUse = model.fallbackId;
        usedFallback = true;
        this.engine = await tryCreate(idToUse);
      } else if (looksLikeNoAdapter) {
        // Likely a transient GPU-device-teardown race; wait and retry once.
        await new Promise((r) => setTimeout(r, 800));
        this.engine = await tryCreate(idToUse);
      } else {
        throw err;
      }
    }

    this.activeKey = modelKey;
    this.activeModelId = idToUse;
    this.usedFallback = usedFallback;
    markModelInstalled(modelKey);
    return this.engine;
  }

  /**
   * Streams a chat completion for the full message history.
   * messages: [{role: 'system'|'user'|'assistant', content: string}, ...]
   * onDelta(text): called with each new chunk of text as it streams in.
   * Returns the final full text.
   */
  async streamChat(messages, onDelta, { temperature = 0.8 } = {}) {
    if (!this.engine) throw new Error("No model loaded yet.");

    const trimmed = trimToFit(messages);

    const chunks = await this.engine.chat.completions.create({
      messages: trimmed,
      temperature,
      stream: true,
    });

    let full = "";
    for await (const chunk of chunks) {
      const delta = chunk.choices?.[0]?.delta?.content || "";
      if (delta) {
        full += delta;
        onDelta(delta, full);
      }
    }
    return full;
  }

  async interrupt() {
    if (this.engine) {
      try {
        await this.engine.interruptGenerate();
      } catch (e) {
        /* ignore */
      }
    }
  }
}

// Keep the resent context to a sane number of turns so tiny models with
// small context windows don't error out when a chat has grown very long.
function trimToFit(messages, maxTurns = 16) {
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const tail = rest.slice(-maxTurns);
  return [...system, ...tail];
}

export const aiEngine = new AIEngine();