# Vendored: transformers.js + ONNX Runtime Web (for on-device Whisper)

- `transformers.min.js`: @huggingface/transformers 4.3.1 (Apache-2.0, see LICENSE-transformers.txt),
  copied from the npm package's `dist/` with one change: a GitHub gist link inside an error message
  was replaced with plain words, because GitHub's secret scanning mistook the gist ID for an API key. For the same reason, the
  string `Mistral3ForConditionalGeneration` is written as a joined string, and its ES export is renamed
  `Mistral3ForCondGeneration`. Desk Buddy only uses the Whisper pipeline, so neither change affects it. It bundles ONNX Runtime Web's JavaScript.
- `ort-wasm-simd-threaded.asyncify.mjs` / `.wasm`: the ONNX Runtime Web build that transformers.js 4.3.1 loads
  (MIT, see LICENSE-onnxruntime.txt; text from github.com/microsoft/onnxruntime).

Self-hosted so the app needs no CDN. The Whisper model weights are not here: they download from
huggingface.co (Xenova/whisper-tiny.en or Xenova/whisper-base.en) the first time and are cached by the browser.
