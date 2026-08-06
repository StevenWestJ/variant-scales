# Getting Part Counter onto the phone as an app

Three levels. Most people stop at level 2.

---

## Level 1 — Shortcut (what you have now)

Chrome menu → Add to Home screen. Gives an icon, but it still opens in a browser tab
with the address bar, and it dies without a signal.

## Level 2 — Installed PWA (Netlify)

The repo builds itself now — `netlify.toml` tells Netlify to run `bash build.sh` and
publish `dist/`. Connect the repo in Netlify (New site from Git) once; every push to
`main` deploys automatically. No manual file upload.

What this buys you:

- **Installs properly.** Chrome offers "Install app" instead of a bookmark. It gets its
  own icon in the app drawer, its own entry in the task switcher, and runs full-screen
  with no address bar.
- **Works with no signal.** A service worker caches the whole app on first visit. Once
  installed it opens and counts in a dead zone at the back of the building — the parts
  library, calibrations and log are all local anyway. Only the label-photo reader needs
  a connection, and it fails with a clear message rather than hanging.
- **Updates itself.** Push a new `index.html` to the repo and the app picks it up on the
  next launch, with the old cache cleared automatically.

To confirm it worked: open the site, and Chrome's menu should read **Install app**
rather than Add to Home screen. Then turn on flight mode and open it — it should still
run.

### Version bumping

Every deploy bumps `VERSION` in `public/sw.js` and `BUILD` in `src/app.jsx`, together,
to the same string (`pc-v6` → `pc-v7`). The service worker version is what tells
installed phones to throw away the old cache — forget it and they'll keep serving the
previous build. The app-visible `BUILD` is shown at the bottom of Setup on the phone, so
you can check what you're actually running without guessing whether the cache caught up.

## Level 3 — Real APK

Only worth it if you want to hand this to other people without them visiting a URL, or
you want it in a company app store / MDM push.

**PWABuilder** (`pwabuilder.com`) is the shortcut: paste your Netlify URL, it packages
the PWA into a signed Android APK/AAB you can sideload or publish. No Android Studio,
no Java. It works because the app is already a valid PWA — level 2 is a prerequisite.

The heavier option is Capacitor, which wraps the same web code in a native shell and
gives you real native APIs. Worth it only if you later need something the browser can't
do — Bluetooth scales talking directly to the app, for instance. That's a genuine
possibility for this tool eventually: reading grams off the scale over Bluetooth instead
of typing them would remove the last manual step.

---

## Note for the ERP

Everything here transfers. Installed PWA + service worker is a reasonable answer for
the floor tablets too: no app store, no MDM deployment cycle, updates by pushing to a
server, and offline tolerance built in. Worth remembering when the forklift and picking
interfaces come up.
