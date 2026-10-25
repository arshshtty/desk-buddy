# Vendored: kokoro-js 1.2.1 and phonemizer 1.2.1

Self-hosted copies, so the app loads no code from a CDN. Both are Apache-2.0 (licences in this folder).

- `kokoro.js`: `dist/kokoro.js` from the npm package [kokoro-js](https://www.npmjs.com/package/kokoro-js) 1.2.1, with only its
  import specifiers rewritten:
  - `@huggingface/transformers` → `../transformers/transformers.min.js` (the copy Whisper already uses);
  - `phonemizer` → `./phonemizer.js`;
  - Node's `path` and `fs/promises` → `./empty.js` (unused in the browser: voices are fetched from Hugging Face instead and
    kept in the browser's `kokoro-voices` cache).
- `phonemizer.js`: `dist/` ES module build of the npm package [phonemizer](https://www.npmjs.com/package/phonemizer) 1.2.1
  (espeak-ng compiled to WebAssembly, embedded; no imports).
- `empty.js`: `export default {};`

The prebuilt `kokoro.web.js` bundle wasn't used: it bundles its own transformers.js and loads ONNX Runtime from a CDN.

The model itself isn't here: [onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)
(`onnx/model_quantized.onnx`, 92.4 MB; `onnx/model.onnx`, 325.5 MB for WebGPU) downloads the first time the natural voice is used.
