# PRD — Weigh-to-Count Stocktake App

**Owner:** Steven, Production Foreman, Variant (Building 1)
**Status:** v0.4 — built, awaiting shop-floor test
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
4. Weigh the full box. Enter gross weight in g or kg.
5. Subtract the empty box: scale-tared (0), a saved box preset, or a typed value.
6. App shows the estimated count, plus a ± figure.
7. Save to the stocktake log. Export the whole log as CSV.

## 5. Maths

```
gPerPiece = sampleWeightG / sampleCount
netG      = grossG − tareG
count     = round(netG / gPerPiece)

relativeError ≈ (scaleResolution / sampleWeightG)      // calibration error
              + (scaleResolution × tareReadings) / netG // weighing error
```

The ± figure is flagged green under 10%, amber over. Over 10% the fix is a bigger
calibration sample.

## 6. Decisions made

| Decision | Choice | Why |
|---|---|---|
| Storage | On-device, single JSON key | No backend needed for a stocktake |
| Calibration sample | Variable, default 100 | Light parts need bigger samples |
| Filter depth | One level (group) | Explicitly requested |
| Tare handling | Three ways: tared scale / preset / typed | Boxes vary; scale tare isn't always usable |
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
| Wrong box tare silently skews a count | Tare shown on the result screen before saving |

## 11. Changelog

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
