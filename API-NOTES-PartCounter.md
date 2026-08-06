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
public/tesseract/core/tesseract-core-lstm.wasm.js
public/tesseract/core/tesseract-core-simd-lstm.wasm.js
public/tesseract/core/tesseract-core-relaxedsimd-lstm.wasm.js
                                                        — from tesseract.js-core's dist/,
                                                          LSTM-only variants only (see
                                                          below) — the *.wasm.js form
                                                          specifically, not the smaller
                                                          .js+.wasm pair also published
                                                          alongside it
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
loaded and were deliberately not copied in. All three `-lstm` variants (plain/SIMD/
relaxed-SIMD) are shipped so Tesseract's own `wasm-feature-detect` can pick whichever
this specific device supports.

**Ship the `.wasm.js` files, not the plain `.js` + `.wasm` pair — confirmed the hard
way (2026-08-06, pc-v12 → pc-v13).** Each `tesseract.js-core` variant is published as
*both* a small `tesseract-core-<variant>.js` (~90KB) paired with a separate
`tesseract-core-<variant>.wasm` binary (~2.8MB), *and* a monolithic
`tesseract-core-<variant>.wasm.js` (~3.9MB) that embeds the same WASM bytes inline as
base64 (its size is almost exactly the raw `.wasm` inflated by base64's ~33%
overhead — that's how you can tell, rather than trial and error, which one a mystery
file like this actually is). The first real-device test shipped the small pair,
guessed from file size ("smaller is obviously the right default, the fat one must be
a fallback") without checking what the code actually does — wrong. `worker.min.js`'s
own core-loading logic (grep it for `importScripts` and `.wasm.js` if this ever needs
re-verifying) always constructs a `*.wasm.js` filename and loads it via
`importScripts()` inside the worker; the small `.js`+`.wasm` pair is for a different
consumption path this app doesn't use, and was never going to be found. Symptom was a
clean, specific error once error surfacing existed: `NetworkError: Failed to execute
'importScripts' ... script ... failed to load` (a 404, in effect) — that specific
error is what made this fast to actually confirm instead of guessing again.
`public/tesseract/core/` now holds only the three `*.wasm.js` files (one per
SIMD/relaxed-SIMD/plain variant) — no separate `.wasm` binaries needed alongside them.

**Total footprint: ~14MB**, all lazy — nothing here is in the service worker's install-
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

### Accuracy: what actually mattered (2026-08-07, pc-v15)

First working read (pc-v14) returned text bearing no relation to the label — wrong even
on a word photographed close up. Three compounding causes, none of them the OCR engine
being bad:

1. **Language.** The labels are Danish (`Blindnitte – AL/ST – 6,4 x 30 mm`) and it was
   running `eng` only. Tesseract's LSTM doesn't just match glyph shapes — it scores
   candidates against a language model, so Danish words judged against English
   vocabulary come back as confident, wrong English. Now `"dan+eng"` (the `langs`
   argument accepts `+`-joined codes; `createWorker` splits on it). Both are
   `tessdata_fast`, +1.2MB gz for Danish. This alone probably explains the
   photographed-close-up word still being wrong.
2. **The photo is mostly not label.** A bin label photographed on a workbench is
   surrounded by desk, tools, other boxes. Default PSM (`AUTO`, 3) tries to find
   columns and reading order across that whole scene. Fixed two ways: the user now
   crops to the text (see below), and the mode is `PSM.SINGLE_BLOCK` (6) — one block
   of text, no page layout analysis. Set via `worker.setParameters()` after creation.
3. **No preprocessing.** Full-resolution phone photo of a glossy laminated label:
   low contrast, glare, far more pixels than Tesseract wants. `preprocess()` in
   `src/app.jsx` crops, scales the long edge into 900–1800px (upscaling tight crops,
   downscaling huge ones), converts to greyscale and stretches the contrast to the
   full 0–255 range.

**The crop step is the same discipline as the scanner's guide box.** `LabelCropper`
shows the photo and the user drags a box round the text; nothing outside it is ever
read. This mirrors the barcode rule in `CLAUDE.md` — reject anything outside the box —
and for the same reason: constraining what the machine is allowed to consider beats
asking it to figure out what matters. `recognize()` gets the cropped canvas (canvas is
a documented-supported input type).

If accuracy still isn't good enough, the next lever is `tessdata_best` instead of
`tessdata_fast` — measured 2026-08-07: `best` eng 15.4MB raw / 12MB gz, dan 9.8MB /
7MB gz, versus `fast` at 4.1MB/2MB and 2.6MB/1.2MB. Materially more accurate,
3–5× slower per read on a phone, ~19MB gz of extra one-time download. Deliberately
not taken yet — try the cheap fixes above first.

**`recognize()` takes the raw `File`/`Blob`, not an `ImageBitmap` — confirmed the hard
way (2026-08-07, pc-v13 → pc-v14).** The photo capture path used to call
`createImageBitmap(file)` first (a leftover from the `TextDetector` days, which
specifically wanted a `CanvasImageSource`). Tesseract.js's documented `recognize()`
input types are: a base64 data URL string, `Buffer`, and — browser-only — `File`/
`Blob` or an `img`/`canvas` element. `ImageBitmap` is not among them. Passing one
anyway didn't throw immediately; it got as far as Tesseract's internal image-format
handling (which branches on the byte content to detect BMP vs. other formats) before
failing deep inside with `Error: Error attempting to read image.` — a generic wrapper
around the WASM engine's `SetImageFile` call returning failure, not a message that
points at the actual mismatch. Fixed by dropping `createImageBitmap` entirely and
passing `file` straight to `worker.recognize()`. (As of pc-v15 it's handed a `canvas`
instead — also on the supported list — because the photo is now cropped and
preprocessed first. The point stands: check that list before passing anything else.)

**First real-device test (2026-08-06, pc-v11) failed** with only a generic "couldn't
read that image" message — not diagnosable from that alone. Checked the two most
likely self-hosting gotchas directly against the live site (`curl -I` against each
asset once visitor-access protection was briefly turned off): WASM served as
`Content-Type: application/wasm` (correct), and the gzipped language data served with
matching `Content-Length` and no silent re-encoding (correct). Both ruled out by
evidence, not assumption. The real cause is still open — pc-v12 replaces the generic
message with a dismissible, selectable panel showing exactly which step failed
(decoding the photo / loading the engine / recognizing text) and the underlying JS
error name and message, so the next failure is diagnosable without another
screenshot-and-guess round trip.

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
