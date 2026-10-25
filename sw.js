/* Desk Buddy service worker: caches the app shell so it opens offline and can be installed.
   API calls (api.anthropic.com) and anything off this origin are never cached here. The Whisper model files
   (from huggingface.co) are cached by transformers.js in its own cache, which this worker leaves alone. */
const CACHE = "desk-buddy-v7";
const SHELL = [
  "./", "./index.html", "./styles.css", "./manifest.webmanifest",
  "./js/store.js", "./js/eye.js", "./js/face-sphere.js", "./js/adapters.js", "./js/whisper.js", "./js/vad.js", "./js/camera.js",
  "./js/brain.js", "./js/kokoro.js", "./js/app.js", "./js/capture-worklet.js", "./js/whisper-worker.js", "./js/kokoro-worker.js",
  // The Whisper runtime's 27 MB .wasm and the natural-voice code (js/vendor/kokoro) aren't precached: they're cached the first time they're used.
  "./js/vendor/transformers/transformers.min.js", "./js/vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs",
  "./icons/icon.svg", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png",
];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("desk-buddy") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  // Network first, so updates show up straight away; the cache is the offline fallback.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html")))
  );
});
