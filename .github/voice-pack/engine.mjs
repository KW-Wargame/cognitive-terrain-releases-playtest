/**
 * Speech engine for the Cognitive Terrain voice pack.
 *
 * The game loads this file in a Web Worker and passes it every file from the
 * pack. Nothing here touches the network: requests for model files are served
 * from the pack, and any other request is refused.
 *
 *   await load(files, manifest)   files: { 'model/config.json': Blob, ... }
 *   await speak(text, { speed })  -> { audio: Float32Array, rate: 24000 }
 */
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';

let tts = null, voice = 'bf_emma';
export const misses = [];

export async function load(files, manifest) {
  voice = manifest.voice || voice;
  const typed = (path, type) => new Blob([files[path]], { type });
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/^(blob|data):/.test(url)) {
      return realFetch(input, init);
    }
    const m = /\/resolve\/[^/]+\/([^?#]+)/.exec(url);
    const path = m ? 'model/' + decodeURIComponent(m[1]) : null;
    if (path && files[path]) {
      return new Response(files[path], { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(files[path].size) } });
    }
    misses.push(url);
    return new Response(null, { status: 404, statusText: 'Not in voice pack' });
  };
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = false;
  const wasm = env.backends.onnx.wasm;
  wasm.numThreads = 1;
  wasm.proxy = false;
  wasm.wasmPaths = {
    wasm: URL.createObjectURL(typed(manifest.ort.wasm, 'application/wasm')),
    ...(manifest.ort.mjs ? { mjs: URL.createObjectURL(typed(manifest.ort.mjs, 'text/javascript')) } : {})
  };
  tts = await KokoroTTS.from_pretrained(manifest.model.id, { dtype: manifest.model.dtype, device: 'wasm' });
  return { misses: misses.slice() };
}

export async function speak(text, { speed = 1 } = {}) {
  if (!tts) {
    throw new Error('Voice pack not loaded');
  }
  const out = await tts.generate(text, { voice, speed });
  return { audio: out.audio, rate: out.sampling_rate };
}
