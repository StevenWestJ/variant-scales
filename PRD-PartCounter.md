# PRD — Weigh-to-Count Stocktake App

**Owner:** Steven, Production Foreman, Variant (Building 1)
**Status:** v0.14 — built, awaiting shop-floor test
**Last updated:** 2026-08-06

---

## 1. Problem

Annual/periodic stocktake requires counting thousands of small parts (bolts, nuts,
washers, rivets, split pins). Hand-counting is slow and error-prone. Precision scales
are being brought in, but a scale alone gives grams, not pieces.

## 2. Goal

A phone app that turns a box weight into a piece count, using a per-part calibration
that only has to be done once. Accuracy target: **within 10%**. Speed matters more
than precision.

## 3. Users

Single user for v0.1 (Steven). Possible extension: 2–4 people counting in parallel
across Buildings 1–3, results merged.

## 4. Core flow

1. Identify the part — scan barcode, type the code, or filter by group (one level:
   Bolts / Nuts / Washers / …).
2. If the part is unknown → name it and assign a group.
3. If the part has no calibration → count a sample by hand (default 100 pcs), weigh
   it in grams, enter both. App stores **g per piece**.
4. Zero the scale with the empty box on it, tip the parts in, enter the weight in g
   or kg.
5. App shows the estimated count, plus a ± figure.
6. Save to the stocktake log. Export the whole log as CSV.

## 5. Maths

```
gPerPiece = sampleWeightG / sampleCount
count     = round(netG / gPerPiece)

relativeError ≈ (scaleResolution / sampleWeightG)   // calibration error
              + scaleResolution / netG              // weighing error
```

(Tare was removed in v0.14 — the scale is zeroed with the box on it, so the weight
entered *is* the net weight, and there's one weighing rather than two.)

The ± figure is flagged green under 10%, amber over. Over 10% the fix is a bigger
calibration sample.

## 6. Decisions made

| Decision | Choice | Why |
|---|---|---|
| Storage | On-device, single JSON key | No backend needed for a stocktake |
| Calibration sample | Variable, default 100 | Light parts need bigger samples |
| Filter depth | One level (group) | Explicitly requested |
| ~~Tare handling~~ | **Dropped 2026-08-07** | Box presets ("totes") and typed box weights were removed at Steven's request — not relevant to how he actually works. Zero the scale with the empty box on it instead. `tareG` stays in the data model and CSV as 0 so old logs and any spreadsheet built on the export still read |
| Units | g and kg on input, grams internally | Scales differ; avoid unit-conversion errors |
| Unknown codes | Create the part inline | Never block a count |
| Export | CSV | Feeds Dynamics NAV or Excel reconciliation |

## 7. Out of scope for v0.1

- Multi-user sync / shared session
- Part master import from NAV
- Danish/English language toggle
- Location or bin tracking beyond a free-text note
- Variance report against system stock

## 8. Answered

- **Counting device is an Android phone.** Chrome on Android supports both
  `getUserMedia` and `BarcodeDetector`, so live scanning works — but only once the app
  is served over HTTPS. Inside the chat artifact frame, and from `file://`, the camera
  is blocked at the browser level. No JS barcode decoder needed.

- **Barcodes carry Variant part numbers**, not supplier EANs. No alias table needed —
  a scan is a direct lookup against the library.
- **A barcode carries the code only, never the description.** The name has to come
  from the on-device library, which makes the library the thing that guarantees the
  right part is counted.
- **No NAV export available.** The library is built up during the count. Each part is
  named once; every scan after that is a lookup.

- **Bin labels are printed in Danish**, with some English and abbreviations mixed into
  the descriptions (`Blindnitte – AL/ST – 6,4 x 30 mm`). The label reader loads Danish
  and English together for this reason. Worth remembering for anything else that has
  to parse or match on label text.

## 9. Open questions

1. **Multiple counters** — will anyone else count in parallel? If yes, v0.3 needs a
   shared session or per-person CSV merge.
2. **Reconciliation** — should the export carry the NAV system quantity next to the
   counted quantity, so variance is visible on the spot?
3. **Mixed boxes** — any part where the same box holds two sizes? Currently assumed no.
4. **Library reuse** — is this stocktake library the seed for the new ERP's parts
   master, or throwaway? Changes how carefully the naming convention needs policing.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Camera/barcode API unavailable on the phone | Manual entry and browse always available |
| Very light parts (small washers) exceed 10% error | ± warning prompts a larger sample |
| Data loss if browser storage is cleared | Export CSV after each work session |
| Scale not zeroed with the box on it — the box weight lands in the count | Weight is shown on the result screen before saving. Tare handling was removed in v0.14, so this is now a procedure question rather than something the app can catch |

## 11. Changelog

- **v0.14 (2026-08-07)** — OCR reported at ~90% accurate on the floor; good enough for
  now, `tessdata_best` left on the shelf. Removed tare entirely at Steven's request:
  no more box/tote presets in Setup and no empty-box weight on the weigh screen — you
  zero the scale with the empty box on it. `tareG` is kept as 0 in the data model and
  CSV so existing logs and exports don't change shape. **Parts can now be edited** —
  the pencil in the Parts tab opens a proper edit screen for name and group instead of
  jumping straight to recalibration, and if a rename affects entries already in the
  log it offers to correct those too. Deleting a part now asks first. Build bumped to
  `pc-v17`.

- **v0.13 (2026-08-07)** — Two bugs found in real use of the label reader. **Reading a
  label overwrote the scanned part number**: the pick screen routed the chosen line
  through `openCode()`, which reassigns the active code, so an OCR guess silently
  replaced authoritative barcode data. When a code is already known the screen now only
  asks for the name, shows the number, and states it came from the barcode and can't be
  changed. **Descriptions that wrap onto two lines can now be selected as one name** —
  the pick screen is multi-select, joins the chosen lines in label order, and previews
  the result before you commit. Build bumped to `pc-v16`.

- **v0.12 (2026-08-07)** — OCR ran but returned text unrelated to the label. Three
  compounding causes, all fixed: it was reading Danish labels with an English-only
  model (now `dan+eng`); it was analysing the whole photo including the workbench
  around the label (the user now crops to the text, and page segmentation is set to
  single-block instead of full page layout); and the raw photo went in unprocessed
  (now cropped, scaled, greyscaled and contrast-stretched first). Build bumped to
  `pc-v15`. If accuracy is still short, the next lever is the `best` trained models
  instead of `fast` — ~19MB more download and 3–5× slower per read.

- **v0.11 (2026-08-07)** — Second OCR fix, again located precisely by the v0.9 error
  panel: the photo was being converted to an `ImageBitmap` before being handed to
  Tesseract, which doesn't accept that type (`File`/`Blob`, `img`/`canvas`, data URL
  or `Buffer` only) and failed deep inside its image reader with an unhelpful generic
  message. The conversion was a leftover from the `TextDetector` implementation.
  Dropped it; the raw `File` goes straight to `recognize()` now. Build bumped to
  `pc-v14`.

- **v0.10 (2026-08-07)** — Found the actual cause of the OCR failure, thanks to the
  detailed error panel added in v0.9: the wrong core-engine file variant was shipped.
  `tesseract.js-core` publishes each WASM variant two ways — a small `.js`+`.wasm`
  pair, and a monolithic `.wasm.js` with the WASM bytes embedded inline — and the
  worker's own code always loads the `.wasm.js` form via `importScripts()`. The small
  pair was shipped by guessing from file size rather than checking; swapped to the
  correct files. Build bumped to `pc-v13`.

- **v0.9 (2026-08-06)** — Tesseract OCR failed its first real-device test with only a
  generic error. Ruled out the two likely self-hosting gotchas (WASM MIME type, gzip
  double-encoding) by checking the live site's actual response headers — both correct.
  Real cause still open. Replaced the generic failure message with a persistent,
  selectable panel showing which step failed and the underlying error, so the next
  attempt is diagnosable. Build bumped to `pc-v12`.

- **v0.8 (2026-08-06)** — Label reading now actually works: bundled a self-hosted
  Tesseract.js (on-device OCR, ~11MB of assets vendored into `public/tesseract/`,
  loaded on demand and cached offline after first use). Replaces `TextDetector`, which
  turned out never to have existed on Steven's phone at all — confirmed on device, and
  the earlier docs claiming otherwise were never actually verified. No CDN dependency,
  no paid API, works in any browser. Build-tested end-to-end (portable Node + real
  `esbuild`/`bash build.sh`) before shipping, not just assumed to work. Build bumped to
  `pc-v11`.

- **v0.7 (2026-08-06)** — Barcode scan → confirm → import confirmed working end to end
  on device. Pre-emptively guarded the standalone "Photograph the label" text-read path
  with the same fix the scanner needed: an 8s timeout on `TextDetector.detect()` plus a
  Cancel button on the loading screen, since it had the identical hang risk. Build
  bumped to `pc-v10`.

- **v0.6 (2026-08-06)** — Fixed the Import panel being pushed off-screen after lock:
  the video's `flex-1` container had no `min-height` override, and on-device the
  camera stream's portrait aspect ratio was forcing it to claim the full screen height,
  leaving no room for anything below it (Import, even the always-present "Enter code by
  hand" button). Added `min-h-0`. Build bumped to `pc-v9`.

- **v0.5 (2026-08-06)** — Fixed the real cause of "scan locks but there's no way to
  accept": the app awaited on-device text detection before showing Import, and that
  detection can hang on real hardware. Import now appears the instant a code locks;
  text detection fills in the name chips afterward if/when it finishes, never blocking.
  Build bumped to `pc-v8`.

- **v0.4 (2026-08-06)** — Removed the paid Anthropic API label-reading fallback; label
  reading is on-device `TextDetector` only now, or type it in. Fixed a scoping bug in
  the scanner's lock-on capture that silently broke the freeze-frame and the on-device
  text read (the Import button itself was unaffected). Added a build number (`BUILD` in
  `src/app.jsx`, matches `VERSION` in `public/sw.js`) shown at the bottom of Setup, so
  it's visible which build a phone is actually running.

- **v0.3 (2026-08-05)** — Label reading. Photograph a bin label and the printed part
  number and description are read off it and prefilled, editable. Works on iOS too.

- **v0.2 (2026-08-05)** — Large part-confirmation banner before weighing and on the
  result screen. Unknown codes flagged as new. Duplicate-name warning. Bulk paste
  import of a part list. Fixed input focus loss between keystrokes.

- **v0.1 (2026-08-05)** — First build. Scan/type/browse, calibration, weigh-to-count,
  log, CSV export, box presets, editable groups, scale-resolution setting.
