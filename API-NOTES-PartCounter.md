# API notes — PartCounter

Living document. Add findings as we hit them.

## Stack

| Thing | Version | Notes |
|---|---|---|
| React | 18 (artifact runtime) | Function components + hooks only |
| lucide-react | 0.383.0 | Icon set; pinned by the artifact runtime |
| Tailwind CSS | Core utilities only | **No arbitrary values** (`bg-[#123456]` will not work) — no compiler in the artifact sandbox. Stick to the default palette. |

## Label reading (photo → text)

Barcodes carry the code only. To capture the description printed on the bin label, the
app photographs the label and sends it to the Anthropic API for reading.

- Capture uses `<input type="file" accept="image/*" capture="environment">`. This opens
  the native camera and **works on iOS as well as Android** — unlike `getUserMedia`,
  it needs no iframe camera permission. It is the most portable capture path available.
- Image is read with `FileReader.readAsDataURL`, the `data:` prefix stripped, and sent
  as a base64 `image` content block alongside a text instruction.
- Model: `claude-sonnet-4-6`, `max_tokens: 1000`. No API key is passed — the artifact
  runtime handles auth.
- The model is asked for JSON only; the response is stripped of any ``` fences before
  `JSON.parse`. Known part codes are passed in as reference so the code format matches
  what is already in the library.
- Result **prefills an editable form**. It is never saved automatically — OCR on a
  scuffed workshop label will get things wrong, and a wrong name silently attached to a
  count is worse than typing it.
- Requires a network connection. Fails soft to scan/type.

## Artifact storage API

No public versioned docs exist for this. Behaviour observed:

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

### Confirmed on device (2026-08-05)

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
