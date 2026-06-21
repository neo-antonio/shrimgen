/* ==========================================================================
   AI ENGINE — multiple swappable models, all running entirely in the browser.

   Real models use Transformers.js (Hugging Face) to load small ONNX-quantized
   instruction-tuned models and run them via WebGPU, falling back to WASM/CPU
   on browsers/devices without WebGPU support. Each model downloads once and
   is cached by the browser (Cache Storage API, cache name "transformers-cache")
   — every generation after that runs fully offline, no network calls at all.

   "Shrim" is a separate, built-in model: a pure-JavaScript dictionary +
   Markov-chain remixer (no download, no GPU/WASM needed) that rewrites your
   training examples with fresh wording and correct grammar/punctuation.
   ========================================================================== */
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0";

env.allowLocalModels = false;
env.useBrowserCache  = true;

const CACHE_NAME = "transformers-cache";

/* ------------------------------------------------------------------------
   MODEL REGISTRY
   ------------------------------------------------------------------------ */
const MODELS = [
  {
    id: "shrim-builtin",
    label: "Shrim",
    subtitle: "Built-in Remixer",
    builtin: true,
    hfId: null,
    params: "—",
    sizeLabel: "0 MB (no download)",
    device: "Any device — phone, tablet, or PC",
    specs: "Pure JavaScript, runs instantly, no GPU/WASM required",
    description: "Instantly remixes your own training examples with fresh wording and clean grammar. Doesn't write new ideas — best when you already have good examples to riff on."
  },
  {
    id: "tinyshrim",
    label: "TinyShrim",
    subtitle: "TinyStories 124M",
    builtin: false,
    hfId: "onnx-community/TinyStories-124M",
    params: "124M",
    sizeLabel: "~80 MB",
    device: "Phones & low-power devices",
    specs: "Runs on CPU (WASM) almost anywhere; very limited reasoning",
    description: "The smallest, fastest real model. Good for short, simple lines on low-end hardware."
  },
  {
    id: "smolshrim",
    label: "SmolShrim",
    subtitle: "SmolLM 360M Instruct",
    builtin: false,
    hfId: "onnx-community/SmolLM2-360M-Instruct",
    params: "360M",
    sizeLabel: "~230 MB",
    device: "Phones & tablets",
    specs: "CPU (WASM) friendly, WebGPU optional for extra speed",
    description: "A step up from TinyShrim — still light, with noticeably better instruction-following."
  },
  {
    id: "shrimlite",
    label: "ShrimLite",
    subtitle: "Qwen2.5 0.5B Instruct",
    builtin: false,
    hfId: "onnx-community/Qwen2.5-0.5B-Instruct",
    params: "0.5B",
    sizeLabel: "~350 MB",
    device: "Tablets & laptops",
    specs: "Runs on WebGPU or CPU(WASM); ~2 GB RAM recommended",
    description: "Quick and capable for everyday ad copy — a good default on mid-range devices."
  },
  {
    id: "shrimgen",
    label: "ShrimGen",
    subtitle: "TinyLlama 1.1B Chat",
    builtin: false,
    hfId: "onnx-community/TinyLlama-1.1B-Chat-v1.0",
    params: "1.1B",
    sizeLabel: "~700 MB",
    device: "Laptops & desktops",
    specs: "WebGPU recommended; falls back to CPU(WASM), ~4 GB RAM",
    description: "The original ShrimGen brain — well-rounded quality and speed for most marketing copy."
  },
  {
    id: "shrimpro",
    label: "ShrimPro",
    subtitle: "Phi-3 Mini 3.8B Instruct",
    builtin: false,
    hfId: "onnx-community/Phi-3-mini-4k-instruct",
    params: "3.8B",
    sizeLabel: "~2.3 GB",
    device: "Desktop / laptop with a discrete or modern integrated GPU",
    specs: "Needs WebGPU for usable speed; ~6 GB RAM",
    description: "The largest, highest-quality model — best copy, but the slowest download and the most demanding on hardware."
  }
];

function getModel(modelId) {
  return MODELS.find(m => m.id === modelId) || MODELS[0];
}

/* ------------------------------------------------------------------------
   PIPELINE LOADING / CACHE / DOWNLOAD STATE  (real models only)
   ------------------------------------------------------------------------ */
const pipelinePromises = {};  // modelId -> Promise<pipeline>
const activeDevices    = {};  // modelId -> "webgpu" | "wasm"

function loadPipeline(modelId, onProgress) {
  const model = getModel(modelId);
  if (model.builtin) return Promise.resolve(null);

  if (pipelinePromises[modelId]) return pipelinePromises[modelId];

  const progress_callback = (p) => {
    if (typeof onProgress === "function") {
      try { onProgress(p); } catch (e) { /* never let a UI callback break loading */ }
    }
  };

  pipelinePromises[modelId] = (async () => {
    const hasWebGPU = typeof navigator !== "undefined" && !!navigator.gpu;
    if (hasWebGPU) {
      try {
        const p = await pipeline("text-generation", model.hfId, {
          device: "webgpu", dtype: "q4", progress_callback
        });
        activeDevices[modelId] = "webgpu";
        return p;
      } catch (err) {
        console.warn(`[AIEngine] WebGPU unavailable/failed for ${modelId}, falling back to WASM/CPU:`, err);
      }
    }
    const p = await pipeline("text-generation", model.hfId, {
      device: "wasm", dtype: "q4", progress_callback
    });
    activeDevices[modelId] = "wasm";
    return p;
  })();

  return pipelinePromises[modelId];
}

/** Force a model to fully download + initialize (used by the "Download" button). */
function downloadModel(modelId, onProgress) {
  return loadPipeline(modelId, onProgress);
}

/** Checks the browser's persistent Cache Storage — reliable across page reloads,
 *  unlike the in-memory pipelinePromises map (which is always empty right after refresh). */
async function isModelDownloaded(modelId) {
  const model = getModel(modelId);
  if (model.builtin) return true;
  if (typeof caches === "undefined") return false;
  try {
    const names = await caches.keys();
    if (!names.includes(CACHE_NAME)) return false;
    const cache = await caches.open(CACHE_NAME);
    const reqs = await cache.keys();
    return reqs.some(r => r.url.includes(model.hfId));
  } catch (e) {
    return false;
  }
}

async function getDownloadedModelIds() {
  const out = [];
  for (const m of MODELS) {
    if (await isModelDownloaded(m.id)) out.push(m.id);
  }
  return out;
}

/** Deletes every cached file for a model so it must be re-downloaded. */
async function uninstallModel(modelId) {
  const model = getModel(modelId);
  if (model.builtin) return false;
  if (typeof caches === "undefined") return false;
  try {
    const names = await caches.keys();
    if (!names.includes(CACHE_NAME)) return false;
    const cache = await caches.open(CACHE_NAME);
    const reqs = await cache.keys();
    let removed = 0;
    for (const r of reqs) {
      if (r.url.includes(model.hfId)) { await cache.delete(r); removed++; }
    }
    delete pipelinePromises[modelId];
    delete activeDevices[modelId];
    return removed > 0;
  } catch (e) {
    return false;
  }
}

function getDevice(modelId) { return activeDevices[modelId] || null; }
function isReady(modelId)   { return !!pipelinePromises[modelId] && !!activeDevices[modelId]; }

/* ------------------------------------------------------------------------
   BUILT-IN "SHRIM" REMIXER — no download, pure JS.
   Dictionary-expanded Markov-chain word remixer with grammar cleanup.
   ------------------------------------------------------------------------ */
const BuiltinRemixer = (function () {
  // Expanded synonym dictionary — every entry remixes to a sibling word.
  const SYN = {
    great:["great","amazing","fantastic","incredible","outstanding","wonderful"],
    good:["good","solid","reliable","dependable","trustworthy"],
    best:["best","top","finest","premier","number-one","leading"],
    new:["new","fresh","latest","brand-new","just-launched"],
    perfect:["perfect","ideal","flawless","just right"],
    love:["love","adore","cherish","treasure"],
    buy:["buy","grab","get","pick up","shop"],
    save:["save","cut costs on","keep more of your money on"],
    fast:["fast","quick","speedy","rapid","lightning-fast"],
    easy:["easy","simple","effortless","hassle-free"],
    quality:["quality","craftsmanship","build quality"],
    style:["style","look","aesthetic","flair"],
    comfort:["comfort","comfortableness","ease"],
    happy:["happy","delighted","thrilled","pleased"],
    special:["special","unique","one-of-a-kind","exclusive"],
    today:["today","now","right now","this moment"],
    deal:["deal","offer","bargain","discount"],
    gift:["gift","present","treat"],
    treat:["treat","indulgence","reward"],
    feel:["feel","experience","enjoy"],
    discover:["discover","explore","uncover","find"],
    upgrade:["upgrade","level up","elevate"],
    affordable:["affordable","budget-friendly","reasonably priced"],
    durable:["durable","long-lasting","built to last"],
    elegant:["elegant","refined","sophisticated"],
    bold:["bold","striking","standout"],
    cozy:["cozy","snug","warm"],
    fresh:["fresh","crisp","clean"],
    smart:["smart","clever","intelligent"],
    modern:["modern","contemporary","sleek"],
    classic:["classic","timeless","traditional"]
  };
  const REVERSE = {};
  Object.keys(SYN).forEach(k => SYN[k].forEach(v => { REVERSE[v.toLowerCase()] = k; }));

  const STOP = new Set(["a","an","the","and","or","but","for","with","of","to","in","on","at",
    "is","are","was","were","be","been","being","it","its","this","that","your","you","our",
    "we","i","he","she","they","them","his","her","from","by","as","into","than","then","so"]);

  const FALLBACK_TEMPLATES = [
    "{label} brings {style} and {quality} together for {audience}.",
    "Meet {label} — {style} made simple.",
    "{label} is the {style} pick for {audience}, every single time.",
    "Treat yourself to {label}, built for {style} living.",
    "{label}: {style}, dependable, and ready when you need it."
  ];

  function tokenizeLine(line) {
    return (line.match(/[A-Za-z0-9'’-]+|[.,!?;:]/g) || []);
  }

  function buildBigramModel(lines) {
    const model = {};
    const starts = [];
    lines.forEach(line => {
      const toks = tokenizeLine(line);
      if (!toks.length) return;
      starts.push(toks[0]);
      for (let i = 0; i < toks.length - 1; i++) {
        const a = toks[i].toLowerCase(), b = toks[i+1];
        if (!model[a]) model[a] = [];
        model[a].push(b);
      }
    });
    return { model, starts };
  }

  function remixWord(word) {
    const lower = word.toLowerCase();
    const canon = REVERSE[lower] || (SYN[lower] ? lower : null);
    if (!canon || Math.random() > 0.55) return word;
    const options = SYN[canon].filter(w => w.toLowerCase() !== lower);
    if (!options.length) return word;
    const picked = options[Math.floor(Math.random() * options.length)];
    return /^[A-Z]/.test(word) ? picked[0].toUpperCase() + picked.slice(1) : picked;
  }

  function joinTokens(tokens) {
    let out = "";
    tokens.forEach((t, i) => {
      const isPunct = /^[.,!?;:]$/.test(t);
      if (i === 0) out += t;
      else out += isPunct ? t : " " + t;
    });
    return out;
  }

  function cleanupGrammar(text) {
    text = text.replace(/\s+/g, " ").replace(/\s+([.,!?;:])/g, "$1").trim();
    text = text.replace(/(^\s*|[.!?]\s+)([a-z])/g, (m, l, c) => l + c.toUpperCase());
    text = text.replace(/\bi\b/g, "I");
    if (!/[.!?]$/.test(text)) text += ".";
    return text;
  }

  function fillTemplate(tpl, ctx) {
    return tpl
      .replace("{label}", ctx.productLabel || "This")
      .replace("{audience}", ctx.audience || "you")
      .replace("{style}", (ctx.tone || "generic").toLowerCase())
      .replace("{quality}", "quality");
  }

  const EMOJI_BY_TONE = {
    Generic: "✨", Emotional: "💛", Professional: "📈", Funny: "😄",
    Luxury: "✨", Urgent: "⏰", Friendly: "🙂"
  };

  /**
   * ctx = { fewShotLines, productLabel, audience, event, tone, charLimit, useEmojis }
   */
  function generate(ctx) {
    ctx = ctx || {};
    const lines = (ctx.fewShotLines || []).filter(Boolean);
    let raw;

    if (lines.length) {
      const { model, starts } = buildBigramModel(lines);
      const start = starts.length ? starts[Math.floor(Math.random()*starts.length)] : "Discover";
      const tokens = [start];
      const targetWords = Math.max(6, Math.min(28, Math.round((ctx.charLimit||120) / 6)));
      let guard = 0;
      while (tokens.length < targetWords && guard < 60) {
        guard++;
        const last = tokens[tokens.length-1].toLowerCase();
        const nexts = model[last];
        if (!nexts || !nexts.length) break;
        tokens.push(nexts[Math.floor(Math.random()*nexts.length)]);
      }
      const remixed = tokens.map(remixWord);
      raw = joinTokens(remixed);
    } else {
      const tpl = FALLBACK_TEMPLATES[Math.floor(Math.random()*FALLBACK_TEMPLATES.length)];
      raw = fillTemplate(tpl, ctx);
    }

    let text = cleanupGrammar(raw);

    if (ctx.useEmojis) {
      const emoji = EMOJI_BY_TONE[ctx.tone] || "✨";
      if (!new RegExp(emoji).test(text)) text = text.replace(/[.!?]\s*$/, "") + " " + emoji;
    }
    return text;
  }

  return { generate };
})();

/* ------------------------------------------------------------------------
   PUBLIC GENERATION API
   ------------------------------------------------------------------------ */

/**
 * opts = {
 *   modelId,
 *   systemPrompt, userPrompt,         // used by real LLMs
 *   remix: { fewShotLines, productLabel, audience, event, tone, charLimit, useEmojis }, // used by Shrim builtin
 *   maxNewTokens, temperature, onProgress
 * }
 */
async function generateOne(opts) {
  opts = opts || {};
  const modelId = opts.modelId || "shrim-builtin";
  const model = getModel(modelId);

  if (model.builtin) {
    return BuiltinRemixer.generate(Object.assign({}, opts.remix, { charLimit: (opts.remix && opts.remix.charLimit) }));
  }

  const generator = await loadPipeline(modelId, opts.onProgress);

  const messages = [
    { role: "system", content: opts.systemPrompt },
    { role: "user",   content: opts.userPrompt   }
  ];

  // Speed: cap tokens tightly, use a slightly lower repetition penalty
  // (cheaper to compute) and skip nucleus sampling at low creativity for
  // a faster, more deterministic decode.
  const lowCreativity = typeof opts.temperature === "number" && opts.temperature < 0.5;

  const out = await generator(messages, {
    max_new_tokens:     Math.min(opts.maxNewTokens || 120, 160),
    temperature:         typeof opts.temperature === "number" ? opts.temperature : 0.8,
    do_sample:           !lowCreativity,
    top_p:               0.9,
    repetition_penalty:  1.1
  });

  const generated = out && out[0] && out[0].generated_text;
  const last = Array.isArray(generated) ? generated.at(-1) : null;
  return (last && typeof last.content === "string") ? last.content.trim() : "";
}

window.AIEngine = {
  MODELS,
  getModel,
  generateOne,
  downloadModel,
  uninstallModel,
  isModelDownloaded,
  getDownloadedModelIds,
  getDevice,
  isReady
};
