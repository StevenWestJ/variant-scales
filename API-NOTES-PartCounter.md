# API notes — PartCounter

Living document. Add findings as we hit them.

The app moved out of the Claude-artifact sandbox onto a real `src/` + `build.sh`
pipeline, deployed as a standalone PWA (see `CLAUDE.md`). Sections below marked
**(artifact-era, historical)** describe the old sandbox and no longer apply — kept
because the reasoning (why live camera needed a real PWA) is still useful context.

## Stack

| Thing | Version | Notes |
|---|---|---|
| React | 18.3.1 | Function components + hooks only, bundled by esbuild |
| lucide-react | 0.383.0 | Icon set |
| Tailwind CSS | 3.4.19 | Compiled by `build.sh`, so arbitrary values (`text-[11px]`) work fine now |

## Label reading (photo → text)

Barcodes carry the code only. To capture the description printed on the bin label, the
app reads it on-device with a self-hosted **Tesseract.js** — free, works offline after
first use, no key, no CDN dependency at runtime.

- Capture uses `<input type="file" accept="image/*" capture="environment">`. This opens
  the native camera and **works on iOS as well as Android** — unlike `getUserMedia`,
  it needs no iframe camera permission. It is the most portable capture path available.
- The photo is decoded with `createImageBitmap`, then run through a Tesseract.js worker
  (`readLabel` in `src/app.jsx`). The recognized text is split into lines, deduped and
  length-filtered, then shown as tappable chips — the user picks which line is the code
  and which is the name. Nothing is inferred or auto-matched against the parts library.
- Result **prefills an editable form**. Never saved automatically — OCR on a scuffed
  workshop label will get things wrong, and a wrong name silently attached to a count
  is worse than typing it.
- If OCR fails or times out for any reason, the button tells the user to type the name
  instead. No fallback path, paid or otherwise.

**Why not the native `TextDetector` API:** an earlier build used it — free and
built-in, no bundling needed. Turned out `"TextDetector" in window` is `false` on
real, current Chrome for Android: it was never promoted to stable the way
`BarcodeDetector` was, despite this doc previously (wrongly) claiming otherwise. That
claim was never actually verified on hardware before being written down — lesson
learned, see the note in `CLAUDE.md`. Confirmed on device 2026-08-06.

**Removed 2026-08-06 (separately):** an even earlier build sent the photo to
`api.anthropic.com` with a user-entered API key as the fallback when `TextDetector`
was unsupported. Steven doesn't want to pay for this — see the non-negotiable in
`CLAUDE.md`. Don't reintroduce a paid fallback.

### Tesseract.js integration (added 2026-08-06)

`npm install tesseract.js` (pinned `7.0.0`, Apache-2.0). Its `dependencies` already
include `tesseract.js-core@^7.0.0` — that comes along automatically, no separate
install needed.

**Self-hosted, not CDN.** By default Tesseract.js fetches its worker script, WASM
core, and language data from jsDelivr/`tessdata.projectnaptha.com` at runtime — a
live CDN dependency, which fails "offline must work" and adds a soft external
dependency to the critical path even though the library itself is free. Instead, the
required files are vendored into `public/tesseract/` and committed to the repo:

```
public/tesseract/worker.min.js                        — from tesseract.js's dist/
public/tesseract/core/tesseract-core-lstm.{js,wasm}
public/tesseract/core/tesseract-core-simd-lstm.{js,wasm}
public/tesseract/core/tesseract-core-relaxedsimd-lstm.{js,wasm}
                                                        — from tesseract.js-core's dist/,
                                                          LSTM-only variants only (see below)
public/tesseract/lang-data/eng.traineddata.gz          — from tesseract-ocr/tessdata_fast
                                                          on GitHub (Apache-2.0), gzipped
                                                          locally (4.1MB → 2.0MB)
```

`createWorker("eng", 1, { workerPath, corePath, langPath, ... })` points at these with
**root-absolute paths** (`/tesseract/worker.min.js`, not `./tesseract/worker.min.js`).
The docs never clarify whether relative paths resolve against the page or against the
worker's own URL (the worker script itself lives inside `/tesseract/`, so a relative
`./core/` from there could double up to `/tesseract/tesseract/core/`) — rather than
guess, root-absolute sidesteps the question entirely. Safe here because the site is
deployed at the domain root, not a subpath; would need revisiting if that ever changes.

**Only the LSTM-only core variants are shipped**, not the legacy-engine ones. `oem: 1`
(the second `createWorker` argument) means LSTM-only recognition, and
`legacyCore: false` (set explicitly, matches Tesseract's own default) tells it to only
ever pick from the `-lstm` suffixed files. The plain/legacy variants
(`tesseract-core.*`, `tesseract-core-simd.*`, `tesseract-core-relaxedsimd.*`) are never
loaded and were deliberately not copied in — cut the vendored footprint roughly in
half. All three `-lstm` variants (plain/SIMD/relaxed-SIMD) are shipped so Tesseract's
own `wasm-feature-detect` can pick whichever this specific device supports.

**Total footprint: ~11MB**, all lazy — nothing here is in the service worker's install-
time `SHELL` precache, so it doesn't slow down or bloat the initial app install. It's
fetched only the first time "Read the name off the label" is actually used, and the
service worker's fetch handler now caches any successfully-fetched resource (not just
the precached SHELL list — this was a real gap, fixed the same day), so it works
offline from the second use onward. First use requires a connection.

**Verification note (2026-08-06):** unlike the `TextDetector` claim above, this
integration was actually build-tested before shipping — Node isn't installed on the
dev machine normally, so a portable Node was fetched, `npm install` and the real
`bash build.sh` were run for real, and the esbuild output was inspected for leftover
Node-only references. Bundled cleanly, 202.9kb added to the main bundle. Not tested in
an actual mobile browser yet — that's still on Steven to confirm.

**`workerBlobURL: false`, `cacheMethod: "none"`.** The former makes Tesseract load the
worker script directly via `new Worker(workerPath)` rather than fetching it and
wrapping it in a `Blob` URL first (simpler, one fewer moving part, and blob-URL workers
can hit CSP trouble in some setups). The latter disables Tesseract's own IndexedDB
caching of downloaded assets (via `idb-keyval`) — the service worker cache above is
the one and only caching layer; no need for two.

**Every OCR call is timeout-guarded**, same lesson as the `TextDetector` hang below:
`createWorker` gets 45s (first-time asset download can be slow), `recognize()` gets
20s (should be fast once the model's loaded). The `ocrBusy` full-screen loader also
shows live progress from Tesseract's `logger` callback and has a Cancel button as a
second line of defense, so the user is never truly stuck regardless of what the
timeout does or doesn't catch.

**Not run automatically after a barcode scan.** Unlike the old (nonexistent, it turns
out) `TextDetector` plan, Tesseract takes real seconds even when cached — running it
on every single lock, including repeat scans of already-known parts that never use the
name suggestion, would be wasted battery and CPU. It only runs on the explicit "Read
the name off the label" action on the New Part screen.

### TextDetector — why it's gone

Same Shape Detection API family as `BarcodeDetector`. Was assumed to ship on
Chrome/Android the same way `BarcodeDetector` does; confirmed 2026-08-06 that it does
not (`"TextDetector" in window` is `false` on a real current Chrome/Android). It's also
worth remembering **Shape Detection calls in general can hang rather than reject** on
real Android hardware — confirmed separately for `BarcodeDetector`'s frame-capture path
in the scanner, see `CLAUDE.md`. `try/catch` around an `await` does nothing for a call
that never settles; only a real timeout guards against it.

## Artifact storage API (artifact-era, historical)

Superseded by plain `localStorage` under the key `stocktake-v1` once the app left the
artifact sandbox — `localStorage` works fine in a normal page/PWA; it was only the
artifact iframe that blocked it. No public versioned docs exist for this. Behaviour
observed:

```js
await window.storage.set(key, value, shared?)   // value must be a string
await window.storage.get(key, shared?)          // → { key, value, shared }
await window.storage.delete(key, shared?)
await window.storage.list(prefix?, shared?)
```

- **`get` throws on a missing key** — it does not return null. Always wrap in
  try/catch and treat the throw as "first run".
- Values are strings: `JSON.stringify` on the way in, `JSON.parse` on the way out.
- Keys: under 200 chars, no whitespace, slashes or quotes.
- Value limit 5 MB per key. The whole parts library + log lives in one key
  (`stocktake-v1`) to keep writes to a single call.
- `shared: false` (default) = private to this device/user.
- **`localStorage` and `sessionStorage` do not work in artifacts.**

## BarcodeDetector API

MDN-documented, but support is uneven — this is the main technical risk.

```js
const supported = "BarcodeDetector" in window;
const detector = new BarcodeDetector({ formats: ["code_128", "ean_13", "qr_code"] });
const codes = await detector.detect(videoElement); // → [{ rawValue, format, boundingBox }]
```

| Platform | Support |
|---|---|
| Chrome / Edge on Android | Yes |
| Chrome on desktop | Yes (Windows/macOS) |
| Safari / iOS (any browser) | **No** — iOS browsers all use WebKit |
| Firefox | No |

Consequence: on an iPhone the scan button will show a fallback message. Manual entry
and browse must always stay available — they do.

Camera access also needs `getUserMedia` to be permitted inside the artifact iframe.
If the iframe lacks the `camera` permission, the scanner shows a fallback instead of
failing silently.

Detection loop uses `requestAnimationFrame` and stops on first hit, then vibrates via
`navigator.vibrate(60)` (Android only; a no-op elsewhere).

### Confirmed on device (2026-08-05, artifact-era, historical)

Live camera **is blocked** in the artifact frame — `getUserMedia` throws before the
barcode decoder ever runs. This is the iframe's permissions policy, not a device
setting, so granting camera permission on the phone does not fix it.

Consequences:
- The app records `settings.scanBlocked` on first failure and promotes the photo route
  to the primary action from then on.
- The `<input capture>` photo route is unaffected — it hands off to the OS camera app
  rather than streaming into the page.
- Reading the plain digits printed under the barcode is the practical substitute for
  decoding the bars, and it comes free with the label read.

To get live scanning back, the app has to run outside the artifact frame: served as a
normal page over HTTPS, or wrapped as a PWA on the phone.

### If scanning turns out not to work

Options, in order of effort:
1. Run the app as a plain web page on the phone instead of inside the artifact frame.
2. Bundle a JS decoder (ZXing / html5-qrcode) — works in Safari, costs bundle size
   and needs a build step.
3. Use a cheap Bluetooth/USB barcode wedge scanner that types into the code field —
   most robust option on a shop floor, and it works with any phone or tablet.
