// Inlines the compiled CSS and JS into a single index.html.
// Everything must be inline: the app has to work as one file if needed.
const fs = require("fs");

const css = fs.readFileSync("build/style.css", "utf8");
const js = fs.readFileSync("build/bundle.js", "utf8");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1">
<meta name="theme-color" content="#0f172a">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Count">
<link rel="manifest" href="manifest.json">
<link rel="icon" href="icon-192.png">
<link rel="apple-touch-icon" href="icon-192.png">
<title>Part Counter</title>
<style>${css}
html,body,#root{height:100%;background:#0f172a}
body{margin:0;-webkit-text-size-adjust:100%;overscroll-behavior-y:contain}
input,textarea{font-size:16px}
@media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
<script>
if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js").catch(function (e) {
      console.warn("Service worker not registered:", e);
    });
  });
}
</script>
</body>
</html>`;

fs.writeFileSync("dist/index.html", html);
