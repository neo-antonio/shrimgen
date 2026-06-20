/* ==========================================================================
   AI ENGINE — real local language model, runs entirely in the browser.
   Uses Transformers.js (Hugging Face) to load a small ONNX-quantized
   instruction-tuned model and run it via WebGPU, falling back to WASM/CPU
   on browsers/devices without WebGPU support.

   The model downloads once and is cached by the browser (Cache API /
   IndexedDB) — every generation after that runs fully offline, no network
   calls of any kind.
   ========================================================================== */
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0";

// Run purely off the Hugging Face hub + browser cache — never probe for local files.
env.allowLocalModels = false;
env.useBrowserCache  = true;

// Small (1.5B param), instruction-tuned, ONNX-converted for Transformers.js.
// Quantized to 4-bit (dtype "q4") to keep the download + memory footprint small
// while still writing coherent, on-brief marketing copy.
const MODEL_ID = "onnx-community/Qwen2.5-1.5B-Instruct";

let pipelinePromise = null;
let activeDevice     = null;

function loadPipeline(onProgress) {
  if (pipelinePromise) return pipelinePromise;

  const progress_callback = (p) => {
    if (typeof onProgress === "function") {
      try { onProgress(p); } catch (e) { /* never let a UI callback break loading */ }
    }
  };

  pipelinePromise = (async () => {
    const hasWebGPU = typeof navigator !== "undefined" && !!navigator.gpu;
    if (hasWebGPU) {
      try {
        const p = await pipeline("text-generation", MODEL_ID, {
          device: "webgpu", dtype: "q4", progress_callback
        });
        activeDevice = "webgpu";
        return p;
      } catch (err) {
        console.warn("[AIEngine] WebGPU unavailable or failed, falling back to WASM/CPU:", err);
      }
    }
    // q4 (4-bit) quantization is WebGPU-only — the WASM/CPU ONNX runtime backend
    // doesn't support it, so the CPU fallback must use a different dtype (q8 = 8-bit).
    const p = await pipeline("text-generation", MODEL_ID, {
      device: "wasm", dtype: "q8", progress_callback
    });
    activeDevice = "wasm";
    return p;
  })();

  return pipelinePromise;
}

/**
 * Generate one piece of text from a system + user prompt.
 * Resolves with the model's reply (trimmed). Throws on hard failure.
 */
async function generateOne({ systemPrompt, userPrompt, maxNewTokens, temperature, onProgress }) {
  const generator = await loadPipeline(onProgress);

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user",   content: userPrompt   }
  ];

  const out = await generator(messages, {
    max_new_tokens:     maxNewTokens || 120,
    temperature:         typeof temperature === "number" ? temperature : 0.8,
    top_p:               0.92,
    do_sample:           true,
    repetition_penalty:  1.15
  });

  const generated = out && out[0] && out[0].generated_text;
  const last = Array.isArray(generated) ? generated.at(-1) : null;
  return (last && typeof last.content === "string") ? last.content.trim() : "";
}

function getDevice() { return activeDevice; }
function isReady()   { return pipelinePromise !== null && activeDevice !== null; }

/**
 * Explicitly trigger the model download/load (without running generation).
 * Safe to call multiple times — reuses the same in-flight/loaded pipeline.
 */
function preload(onProgress) {
  return loadPipeline(onProgress);
}

window.AIEngine = { generateOne, getDevice, isReady, preload, MODEL_ID };
