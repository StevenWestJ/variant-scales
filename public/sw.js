const VERSION = "pc-v12";
const SHELL = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;

  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) {
        // Refresh in the background so the next launch is current
        fetch(e.request).then((res) => {
          if (res && res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone()));
        }).catch(() => {});
        return hit;
      }
      // Not precached (e.g. the Tesseract OCR assets, loaded on demand the
      // first time the label reader is used) - cache it too once fetched,
      // so it's available offline from then on.
      return fetch(e.request).then((res) => {
        if (res && res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone()));
        return res;
      }).catch(() => caches.match("./index.html"));
    })
  );
});
