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

// ---------------------------------------------------------------------------
// Engine class
// ---------------------------------------------------------------------------
class AIEngine {
  constructor() {
    this.engine = null;
    this.activeKey = null;
  }

  supportsWebGPU() {
    return typeof navigator !== "undefined" && !!navigator.gpu;
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
      // Free the previous model's GPU memory before loading a new one.
      try {
        await this.engine.unload();
      } catch (e) {
        console.warn("Unload warning:", e);
      }
      this.engine = null;
    }

    this.engine = await webllm.CreateMLCEngine(model.id, {
      initProgressCallback,
    });
    this.activeKey = modelKey;
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
