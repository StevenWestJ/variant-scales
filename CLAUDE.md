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
2. **Manual entry always works.** Camera, text detection and network are all optional
   paths. If any of them fail, the user must still be able to type a code and count.
3. **No paid services in the critical path.** Costs come out of his pocket, not the
   company's. On-device and free, or it doesn't ship.
4. **Offline must work.** There are network dead zones on the factory floor. Counting,
   calibration, the log and CSV export are all local and must stay that way.

## Stack

| | Version | Notes |
|---|---|---|
| React | 18.3.1 | Hooks only |
| lucide-react | 0.383.0 | Icons |
| Tailwind | 3.4.19 | Compiled here, so arbitrary values (`text-[11px]`) work |
| esbuild | 0.28.1 | Bundler |

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

## Browser APIs — where the pain lives

**BarcodeDetector** — Chrome on Android only. Not Safari, not iOS, not Firefox. Fine
here because the device is Android, but never assume it exists; feature-detect.

**TextDetector** — same Shape Detection family, also Chrome/Android. Reads the printed
text off the label for free, on-device, offline. Used to fill in part names. If missing,
the chips just don't appear and the user types the name. Never make it required.

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
4. Then freezes the video, runs TextDetector over that frame, and shows a review panel
   with the code and the detected text. **The user taps Import.** Nothing proceeds on
   its own.

The box is red when nothing is in view, amber when it can see a code but won't take it
(with the reason), green while confirming, solid green on lock. Red as the resting state
is deliberate — it means nothing is being considered.

Don't "simplify" any of this away. Each step is a bug that was reported from the floor.

## Data

Everything is one `localStorage` key, `stocktake-v1`, holding parts, calibrations,
entries, containers, categories and settings. Single key to keep writes atomic and cheap.

Clearing site data wipes the lot. CSV export exists for this reason — remind him to
export after each session, and warn before anything destructive.

## State of play

Working: scan → confirm → import, calibration, weigh-to-count with tare, the log, CSV
export, paste-import of a part list, offline, installed as a PWA.

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
