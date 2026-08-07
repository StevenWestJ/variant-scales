# Part Counter — working notes

Read this before touching anything. It exists so you don't re-learn what has already
been paid for in wasted hours.

## What this is

A weigh-to-count stocktake tool for Variant, a Danish trailer manufacturer in Vejle.
Steven is Production Foreman in Building 1. Counting thousands of bolts, nuts and
washers by hand is slow, so instead: calibrate a part once (count a sample, weigh it,
store grams-per-piece), then weigh a whole box and divide. Target accuracy is **within
10%** — deliberately loose. Speed matters more than precision here.

It runs on **one Android phone**, hosted on Netlify, installed as a PWA.

## How he works — match this

- **Ask before building** when the concept is still forming. He has deep domain
  knowledge you don't have; a question costs a minute, a wrong assumption costs a
  rebuild.
- **Keep `PRD-PartCounter.md` current.** It's the shared memory. Decisions and answered
  questions go in it, with a changelog entry per version.
- **Document libraries with the version in use.** `API-NOTES-PartCounter.md` covers the
  browser APIs, which are the risky part. If you adopt something new and no good docs
  exist, write the file and keep adding to it as you learn.
- He pushes back when something's wrong, and he's usually right. When he said paying for
  an API key to read labels was excessive, he was correct — a free on-device option
  existed and had been overlooked.

## Non-negotiables

1. **Nothing commits itself.** Every scan is confirmed by the user before it becomes
   data. This was learned the hard way: an earlier build accepted the barcode decoder's
   first output and imported codes from frames pointed at nothing. The whole point of
   the tool is eliminating manual errors that reach compliance documents. A silently
   wrong count is worse than no count.

   **Corollary — a scanned barcode outranks anything OCR produces.** The label reader
   used to route its "which line is the part number?" answer through `openCode()`,
   which reassigns `activeCode` — so reading a name off a label silently replaced the
   scanned part number with OCR text (fixed 2026-08-07, pc-v16). When a code is already
   known, the pick screen never offers to change it and says where it came from. If you
   add another source of part numbers, rank it against this: decoded barcode first,
   typed-by-user second, OCR last and never silently.
2. **Manual entry always works.** Camera, text detection and network are all optional
   paths. If any of them fail, the user must still be able to type a code and count.
3. **No paid services in the critical path.** Costs come out of his pocket, not the
   company's. On-device and free, or it doesn't ship. A build briefly called the
   Anthropic API with a user-supplied key for label reading — removed 2026-08-06.
   Label reading now runs on a self-hosted Tesseract.js (see API-NOTES) after the
   native `TextDetector` API it was meant to use turned out not to actually exist on
   real Chrome/Android. Don't reintroduce a paid fallback here.
4. **Offline must work.** There are network dead zones on the factory floor. Counting,
   calibration, the log and CSV export are all local and must stay that way.

## Stack

| | Version | Notes |
|---|---|---|
| React | 18.3.1 | Hooks only |
| lucide-react | 0.383.0 | Icons |
| Tailwind | 3.4.19 | Compiled here, so arbitrary values (`text-[11px]`) work |
| esbuild | 0.28.1 | Bundler |
| tesseract.js | 7.0.0 | On-device OCR for label reading. Self-hosted — see API-NOTES for the `public/tesseract/` asset layout, don't point it at a CDN. Runs `dan+eng`: **the labels are Danish**, and English-only returned confident nonsense |

## Build and deploy

```bash
npm install
bash build.sh        # → dist/
```

`build.sh` bundles with esbuild, compiles Tailwind, then `inline.js` inlines both into a
single `dist/index.html`. `public/` is copied over the top.

Deploy: drag `dist/` (or a zip of it) onto Netlify. Auto-deploys on push if the repo is
connected.

### The one that will catch you

**Bump `VERSION` in `public/sw.js` on every deploy** (`pc-v6` → `pc-v7`). The service
worker serves the cached copy first. Forget this and Steven tests yesterday's build and
reports your fix didn't work. It has happened.

**Also bump `BUILD` in `src/app.jsx`, to the same string.** It's shown at the bottom of
Setup on the phone. This exists specifically so Steven can tell you what he's looking at
without guessing whether the service worker cache caught up — check it before debugging
a report that a fix "didn't work."

## Browser APIs — where the pain lives

**BarcodeDetector** — Chrome on Android only. Not Safari, not iOS, not Firefox. Fine
here because the device is Android, but never assume it exists; feature-detect.

**TextDetector — doesn't actually exist, don't use it.** Same Shape Detection family as
`BarcodeDetector`, and this doc used to claim it shipped on Chrome/Android the same way.
That was never verified on real hardware before being written down. Confirmed
2026-08-06 on Steven's actual phone: `"TextDetector" in window` is `false`. It was
apparently never promoted past experimental. Label reading uses a self-hosted
Tesseract.js instead now (see API-NOTES) — works everywhere, not just Chrome/Android.

**getUserMedia** — needs a secure context. Blocked in the Claude artifact frame and on
`file://`. Only ever test on the real HTTPS URL. Hours were lost to this.

**Camera quality is the scanner's weak point, not the decoder.** The decoder is ML Kit
and is good. If scanning is poor, look at resolution (1920×1080 is requested),
`focusMode: continuous`, and the torch — in that order — before considering a different
library. ZXing is in maintenance mode and can't even set resolution. If a swap is ever
genuinely needed, zbar-wasm is the candidate.

## Scanner design, and why

The detection loop:

1. Decodes at ~11fps, not every frame — faster just feeds it motion blur.
2. Discards any code whose bounding box isn't **entirely inside** the on-screen guide
   box, and any narrower than 18% of that box. Partial and distant reads were producing
   wrong codes.
3. Requires the **same value three times running** before accepting.
4. Then freezes the video and shows a review panel with the code. **The user taps
   Import.** Nothing proceeds on its own. (OCR on the frame was tried here
   automatically at one point — removed; see API-NOTES on why it's a deliberate,
   separate action instead.)

The box is red when nothing is in view, amber when it can see a code but won't take it
(with the reason), green while confirming, solid green on lock. Red as the resting state
is deliberate — it means nothing is being considered.

Don't "simplify" any of this away. Each step is a bug that was reported from the floor.

**The label reader now works the same way, and for the same reason.** OCR over a whole
photo of a workbench returned nonsense, exactly as the barcode decoder did before it
started rejecting anything outside the guide box. The user drags a box round the text
and nothing outside it is read. When something on-device is guessing badly, narrowing
what it's allowed to look at has beaten trying to make it smarter, twice now.

**2026-08-06 bug (fixed):** the capture-on-lock code declared `vid`/`cv` with `const`
inside a `try` block, then referenced them again after the block closed — a
`ReferenceError`, silently swallowed by the surrounding `catch`. Effect: the video
never actually froze on lock, and on-device text detection never ran, both failing
silently. Fixed by declaring both above the `try`. Watch for this pattern generally —
a `try { const x = … }` followed by code outside the block that still expects `x` is
invisible in review and silent at runtime.

**2026-08-06 bug (fixed), suspected but not the real blocker — corrected:** at the
time, the code still `await`ed `TextDetector.detect(cv)` *before* calling
`setPending(...)`, and this was diagnosed as the cause: text detection hanging and
gating the whole flow. That diagnosis turned out to be wrong in a specific way — later
the same day, testing confirmed `TextDetector` doesn't exist on Steven's phone at all
(see the entry above), so that `await` was never actually reached; the `if (cv &&
"TextDetector" in window)` guard skipped it every time. The *actual* remaining blocker
was the CSS bug below, which the (non-existent) hang theory happened to also explain
plausibly enough to seem confirmed. Recorded here as a caution about "confirmed on
device" claims: re-verify what you think you tested, especially when a fix doesn't
actually change the symptom. The code was still restructured to call `setPending`
immediately on lock regardless, since **the underlying principle is still correct even
though this specific hang wasn't real**: nothing that reaches across a real device API
should sit between lock-on and showing Import. Shape Detection calls in general are
reported to hang rather than reject on some Android/Chrome combinations — not
confirmed firsthand here, but cheap to guard against regardless (see `withTimeout` in
`src/app.jsx`).

**2026-08-06 bug (fixed), stacked on top of the one above:** once the previous fix
actually let `setPending` fire, the Import panel *still* never appeared on device — the
camera feed filled the entire screen, edge to edge, and even the always-present "Enter
code by hand" button was invisible. This was a pure CSS bug that the TextDetector hang
had been masking the whole time: the video sits in a `flex-1` container with no
`min-height` override, and on this phone the camera stream reports a portrait-oriented
aspect ratio. Flexbox's default automatic minimum size lets that intrinsic aspect ratio
act as a floor on how far the video container can shrink, and that floor came out
taller than the screen — pushing every sibling below it (the Import panel, the bottom
button row) off the bottom edge with no way to scroll to them. Fixed by adding
`min-h-0` to the video's flex container. **General lesson: any `flex-1` container
holding a `<video>`/`<img>`/other intrinsically-sized element needs `min-h-0` (or
`min-w-0` in a row) or its siblings can get silently pushed off-screen on some devices
— test on the actual phone, a desktop browser resize won't reproduce this.**

## Data

Everything is one `localStorage` key, `stocktake-v1`, holding parts, calibrations,
entries, containers, categories and settings. Single key to keep writes atomic and cheap.

Clearing site data wipes the lot. CSV export exists for this reason — remind him to
export after each session, and warn before anything destructive.

## State of play

Working: scan → confirm → import, label OCR (crop → pick lines), calibration,
weigh-to-count, editing a part, the log, CSV export, paste-import of a part list,
offline, installed as a PWA.

**Tare is gone (v0.14).** Box/tote presets and the empty-box weight field were removed
at Steven's request — he zeroes the scale with the box on it. `tareG` survives as a
constant 0 in entries and in the CSV so old logs and any spreadsheet built on the
export don't change shape. Don't reintroduce a tare UI without asking; if it comes
back, the plumbing is still there.

Open, in the PRD: whether anyone else counts in parallel, whether the export should carry
the NAV system quantity for on-the-spot variance, and whether this parts library seeds
the ERP's parts master (which would raise the stakes on naming conventions).

Not done: multi-user, NAV integration, Danish translation.

## The bigger picture

Steven is separately building a custom ERP to replace Dynamics NAV — ASP.NET Core,
PostgreSQL, React, Docker, Clean Architecture. This app is partly a proving ground. The
PWA-plus-service-worker approach here is a serious candidate for the ERP's floor
tablets: no MDM, no app store, updates by pushing to a server, offline tolerance built
in. Worth keeping in mind when he asks how something would scale.
