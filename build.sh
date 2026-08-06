#!/usr/bin/env bash
# Builds dist/ - a single self-contained index.html plus the PWA files.
set -euo pipefail

rm -rf dist && mkdir -p dist build

npx esbuild src/index.jsx \
  --bundle --minify \
  --loader:.jsx=jsx --jsx=automatic \
  --define:process.env.NODE_ENV='"production"' \
  --outfile=build/bundle.js

npx tailwindcss -c tailwind.config.js -i src/input.css -o build/style.css --minify

node inline.js

cp public/* dist/
echo "Built dist/ ($(du -h dist/index.html | cut -f1) index.html)"
echo "REMEMBER: bump VERSION in public/sw.js or installed phones keep the old cache."
