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
app reads it on-device with `TextDetector` — free, offline, no key.

- Capture uses `<input type="file" accept="image/*" capture="environment">`. This opens
  the native camera and **works on iOS as well as Android** — unlike `getUserMedia`,
  it needs no iframe camera permission. It is the most portable capture path available.
- The photo is decoded with `createImageBitmap`, then `new TextDetector().detect(bitmap)`
  returns text blocks. Lines are deduped and length-filtered, then shown as tappable
  chips — the user picks which line is the code and which is the name. Nothing is
  inferred or auto-matched against the parts library.
- Result **prefills an editable form**. Never saved automatically — OCR on a scuffed
  workshop label will get things wrong, and a wrong name silently attached to a count
  is worse than typing it.
- `TextDetector` missing (see support table below) → the button tells the user to type
  the name instead. No fallback path, paid or otherwise.

**Removed 2026-08-06:** an earlier build sent the photo to `api.anthropic.com` with a
user-entered API key when `TextDetector` was unsupported. Steven doesn't want to pay for
this, so the paid fallback is gone — see the non-negotiable in `CLAUDE.md`. Don't
reintroduce it.

### TextDetector support

Same Shape Detection API family as `BarcodeDetector` — Chrome/Edge on Android, not
Safari/iOS, not Firefox. Same caveat as `BarcodeDetector` below: feature-detect, never
assume.

**It can hang, not just fail.** `detect()` proxies through Play Services on Android;
confirmed on device (2026-08-06) that it can sit forever without resolving or
rejecting. A `try/catch` around an `await` does nothing for a call that never settles.
Never let it — or any other on-device Shape Detection call — sit between "code locked"
and showing the user the accept/Import screen. Run it after, fire-and-forget, patching
the result in if it ever comes back.

Every direct `await` on a Shape Detection call (the standalone "Photograph the label"
path, not just the scanner) goes through `withTimeout(promise, 8000)` for the same
reason — an 8s cap, then fail soft. The `ocrBusy` full-screen loader also has a Cancel
button as a second line of defense, so the user is never truly stuck regardless of
what the timeout does or doesn't catch.

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
