# Part Counter

Weigh-to-count stocktake tool for small parts. Calibrate a part once by weighing a
counted sample, then weigh a full box to get a piece count.

Android phone, installed as a PWA, works offline.

## Build

```bash
npm install
bash build.sh     # → dist/
```

Deploy `dist/` to any static host. **Bump `VERSION` in `public/sw.js` first** or
installed phones keep serving the old cached build.

## Files

- `src/app.jsx` — the whole application
- `public/` — service worker, manifest, icons
- `build.sh` + `inline.js` — produce a single self-contained `dist/index.html`
- `CLAUDE.md` — read this before making changes
- `PRD-PartCounter.md` — requirements, decisions, open questions
- `API-NOTES-PartCounter.md` — browser API behaviour and gotchas
