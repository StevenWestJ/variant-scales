import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Camera, Keyboard, Filter, Scale, Check, X, ChevronLeft, Plus, Trash2,
  Download, Settings, AlertTriangle, Package, Search, RotateCcw,
  ClipboardList, Pencil, Boxes, Image as ImageIcon, Loader, Zap
} from "lucide-react";
import { createWorker, PSM } from "tesseract.js";

/* ------------------------------------------------------------------ */
/*  Storage                                                            */
/* ------------------------------------------------------------------ */
const KEY = "stocktake-v1";

// Bump on every change, together with VERSION in public/sw.js.
// Shown in Setup so it's obvious which build a phone is running.
const BUILD = "pc-v15";

const DEFAULT_DATA = {
  parts: {},          // code -> { code, name, category, gPerPiece, sampleCount, sampleWeightG, calibratedAt }
  entries: [],        // { id, code, name, category, grossG, tareG, netG, gPerPiece, count, note, ts }
  containers: [       // tare presets
    { id: "c1", name: "Blue tote", g: 0 },
  ],
  categories: ["Bolts", "Nuts", "Washers", "Screws", "Rivets", "Split pins", "Clips", "Springs", "Other"],
  settings: { resolutionG: 0.1, location: "Building 1" },
};

async function loadData() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_DATA, ...JSON.parse(raw) };
  } catch (e) { /* first run */ }
  return DEFAULT_DATA;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
const toGrams = (val, unit) => {
  const n = parseFloat(String(val).replace(",", "."));
  if (isNaN(n)) return NaN;
  return unit === "kg" ? n * 1000 : n;
};

const fmt = (n, d = 1) =>
  isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : "—";

const uid = () => Math.random().toString(36).slice(2, 10);

// Shape Detection calls (TextDetector, BarcodeDetector) can hang on real
// Android hardware instead of resolving or rejecting - confirmed on device.
// Never await one without a timeout, or the caller stalls forever.
const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);

function accuracy(count, netG, gPerPiece, sampleWeightG, res, usedTare) {
  if (!isFinite(netG) || netG <= 0 || !gPerPiece) return null;
  const calErr = res / Math.max(sampleWeightG || res, res);       // error in g/pc
  const weighErr = (res * (usedTare ? 2 : 1)) / netG;             // error in net weight
  const rel = calErr + weighErr;
  return { rel, plusMinus: Math.max(1, Math.ceil(count * rel)) };
}

/* ------------------------------------------------------------------ */
/*  Small UI atoms                                                     */
/* ------------------------------------------------------------------ */
const Label = ({ children }) => (
  <div className="text-[11px] uppercase tracking-[0.2em] text-slate-400 mb-2 font-medium">{children}</div>
);

const Panel = ({ children, className = "" }) => (
  <div className={`bg-slate-800 border border-slate-700 rounded-lg ${className}`}>{children}</div>
);

const Btn = ({ children, onClick, variant = "default", className = "", disabled }) => {
  const styles = {
    default: "bg-slate-700 text-slate-100 active:bg-slate-600 border-slate-600",
    primary: "bg-amber-400 text-slate-950 active:bg-amber-300 border-amber-300 font-semibold",
    ghost: "bg-transparent text-slate-300 active:bg-slate-800 border-slate-700",
    danger: "bg-transparent text-rose-400 active:bg-slate-800 border-slate-700",
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`min-h-[56px] px-4 rounded-lg border text-base flex items-center justify-center gap-2 transition-colors disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-amber-400 ${styles[variant]} ${className}`}
    >
      {children}
    </button>
  );
};

const NumInput = ({ value, onChange, placeholder, suffix, autoFocus }) => (
  <div className="flex items-stretch">
    <input
      type="text"
      inputMode="decimal"
      autoFocus={autoFocus}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded-l-lg px-4 py-4 text-2xl font-mono text-amber-300 placeholder-slate-600 focus:outline-none focus:border-amber-400"
    />
    {suffix && (
      <div className="px-4 flex items-center bg-slate-800 border border-l-0 border-slate-700 rounded-r-lg text-slate-400 font-mono text-sm">
        {suffix}
      </div>
    )}
  </div>
);

const TextInput = ({ value, onChange, placeholder, autoFocus }) => (
  <input
    value={value}
    autoFocus={autoFocus}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-4 py-4 text-base text-slate-100 placeholder-slate-600 focus:outline-none focus:border-amber-400"
  />
);

/* ------------------------------------------------------------------ */
/*  Barcode scanner                                                    */
/* ------------------------------------------------------------------ */
function Scanner({ onCode, onClose, onPhoto, onBlocked }) {
  const videoRef = useRef(null);
  const [error, setError] = useState(null);
  const [candidate, setCandidate] = useState(null);
  const [hint, setHint] = useState(null);
  const [status, setStatus] = useState("none");
  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [resolution, setResolution] = useState(null);
  const trackRef = useRef(null);
  const [pending, setPending] = useState(null);
  const restartRef = useRef(null);

  const rescan = () => {
    setPending(null);
    setStatus("none");
    setCandidate(null);
    agreeRef.current = { value: null, count: 0 };
    try { videoRef.current && videoRef.current.play(); } catch (e) {}
    if (restartRef.current) restartRef.current();
  };

  const toggleTorch = async () => {
    const track = trackRef.current;
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn }] });
      setTorchOn(!torchOn);
    } catch (e) { /* torch unsupported on this camera */ }
  };
  const boxRef = useRef(null);
  const stopRef = useRef(false);
  const agreeRef = useRef({ value: null, count: 0 });

  useEffect(() => {
    let stream;
    let detector;
    stopRef.current = false;

    (async () => {
      if (!("BarcodeDetector" in window)) {
        setError("This browser can't decode barcodes. Photograph the label instead — the number under the bars reads fine.");
        onBlocked && onBlocked();
        return;
      }
      try {
        detector = new window.BarcodeDetector({
          formats: ["code_128", "code_39", "ean_13", "ean_8", "qr_code", "upc_a", "upc_e", "itf", "codabar"],
        });
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30 },
            advanced: [{ focusMode: "continuous" }],
          },
        });
        const track = stream.getVideoTracks()[0];
        trackRef.current = track;
        try {
          const caps = track.getCapabilities ? track.getCapabilities() : {};
          if (caps.focusMode && caps.focusMode.includes("continuous")) {
            await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
          }
          setHasTorch(!!caps.torch);
          const st = track.getSettings ? track.getSettings() : {};
          setResolution(st.width && st.height ? `${st.width}×${st.height}` : null);
        } catch (e) { /* capability probing is best-effort */ }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        const CONFIRMATIONS = 3;
        const MIN_INTERVAL = 90;   // ms between decode attempts
        let lastRun = 0;
        const tick = async (ts) => {
          if (stopRef.current || !videoRef.current) return;
          if (ts && ts - lastRun < MIN_INTERVAL) { requestAnimationFrame(tick); return; }
          lastRun = ts || 0;
          try {
            const all = await detector.detect(videoRef.current);

            // Map the on-screen guide box into video coordinates (video uses object-cover)
            let inBox = [];
            const vid = videoRef.current, box = boxRef.current;
            if (vid && box && vid.videoWidth) {
              const vr = vid.getBoundingClientRect(), br = box.getBoundingClientRect();
              const scale = Math.max(vr.width / vid.videoWidth, vr.height / vid.videoHeight);
              const offX = (vr.width - vid.videoWidth * scale) / 2;
              const offY = (vr.height - vid.videoHeight * scale) / 2;
              const gx = (br.left - vr.left - offX) / scale;
              const gy = (br.top - vr.top - offY) / scale;
              const gw = br.width / scale, gh = br.height / scale;

              inBox = all.filter((c) => {
                const b = c.boundingBox;
                if (!b) return false;
                const fullyInside =
                  b.x >= gx && b.y >= gy &&
                  b.x + b.width <= gx + gw &&
                  b.y + b.height <= gy + gh;
                const bigEnough = b.width >= gw * 0.18;   // reject distant/partial reads
                return fullyInside && bigEnough;
              });
            }

            if (!all.length) { setStatus("none"); setHint(null); }
            else if (inBox.length > 1) { setStatus("blocked"); setHint("More than one barcode in view"); }
            else if (!inBox.length) { setStatus("blocked"); setHint("Move the barcode fully inside the box"); }
            else { setStatus("locking"); setHint(null); }

            const codes = inBox.length === 1 ? inBox : [];
            const v = codes.length ? String(codes[0].rawValue || "").trim() : "";
            if (v.length >= 3) {
              if (agreeRef.current.value === v) agreeRef.current.count += 1;
              else agreeRef.current = { value: v, count: 1 };
              setCandidate({ value: v, count: agreeRef.current.count });

              if (agreeRef.current.count >= CONFIRMATIONS) {
                const vid = videoRef.current;
                let frame = null;
                let cv = null;
                try {
                  cv = document.createElement("canvas");
                  cv.width = vid.videoWidth || 1280;
                  cv.height = vid.videoHeight || 720;
                  cv.getContext("2d").drawImage(vid, 0, 0, cv.width, cv.height);
                  frame = cv.toDataURL("image/jpeg", 0.8);
                } catch (e) { /* frame grab optional */ }
                if (navigator.vibrate) navigator.vibrate(60);
                setStatus("locked");
                stopRef.current = true;
                setCandidate(null);
                try { vid.pause(); } catch (e) { /* freeze the frame if we can */ }

                // Show Import immediately - never gate reaching the accept
                // screen on anything else. OCR (Tesseract, see runOcr) is
                // deliberately not run automatically here: it takes real
                // seconds, and most scans are repeat-scans of already-known
                // parts where a name is never needed. It's a separate,
                // explicit action ("Read the name off the label") on the
                // New Part screen instead.
                setPending({ value: v, frame, lines: [], name: "" });
                return;
              }
            } else {
              agreeRef.current = { value: null, count: 0 };
              setCandidate(null);
            }
          } catch (e) { /* frame not ready */ }
          requestAnimationFrame(tick);
        };
        restartRef.current = () => { stopRef.current = false; requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      } catch (e) {
        const msg =
          e && (e.name === "NotAllowedError" || e.name === "SecurityError")
            ? "Live camera is blocked in this window. Photograph the label instead — that uses your phone's camera app and works."
            : e && e.name === "NotFoundError"
            ? "No camera found on this device."
            : "Camera wouldn't start here. Photograph the label instead.";
        setError(msg);
        onBlocked && onBlocked();
      }
    })();

    return () => {
      stopRef.current = true;
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, [onCode, onBlocked]);

  return (
    <div className="fixed inset-0 bg-slate-950 z-50 flex flex-col">
      <div className="flex items-center justify-between p-4 border-b border-slate-800">
        <span className="text-[11px] uppercase tracking-[0.2em] text-slate-400">Scan part barcode</span>
        <button onClick={onClose} className="text-slate-300 p-2"><X size={24} /></button>
      </div>
      <div className="flex-1 min-h-0 relative bg-black">
        <video ref={videoRef} playsInline muted className="w-full h-full object-cover" />
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div
            ref={boxRef}
            className={`w-4/5 h-40 rounded transition-colors duration-100 ${
              status === "locked"  ? "border-4 border-lime-400 bg-lime-400/25" :
              status === "locking" ? "border-4 border-lime-400 bg-lime-400/10" :
              status === "blocked" ? "border-4 border-amber-400" :
                                     "border-2 border-rose-500"
            }`}
          />
        </div>
        <div className="absolute top-4 left-0 right-0 flex justify-center pointer-events-none">
          <div className={`px-3 py-1.5 rounded-full text-[11px] uppercase tracking-[0.2em] ${
            status === "locked"  ? "bg-lime-400 text-slate-950" :
            status === "locking" ? "bg-lime-400/20 text-lime-300" :
            status === "blocked" ? "bg-amber-400/20 text-amber-300" :
                                   "bg-rose-500/20 text-rose-300"
          }`}>
            {status === "locked" ? "Got it" :
             status === "locking" ? "Reading — hold steady" :
             status === "blocked" ? "Not in the box" :
                                    "Searching"}
          </div>
        </div>
        {hint && !candidate && (
          <div className="absolute bottom-4 left-4 right-4 bg-slate-950/90 border border-amber-400/40 rounded-lg p-3 text-center text-sm text-amber-300">
            {hint}
          </div>
        )}
        {candidate && (
          <div className="absolute bottom-4 left-4 right-4 bg-slate-950/90 border border-slate-700 rounded-lg p-3 text-center">
            <div className="font-mono text-lg text-amber-300 break-all">{candidate.value}</div>
            <div className="flex justify-center gap-1 mt-2">
              {[0, 1, 2].map((i) => (
                <span key={i} className={`h-1.5 w-8 rounded-full ${i < candidate.count ? "bg-lime-400" : "bg-slate-700"}`} />
              ))}
            </div>
            <div className="text-[10px] uppercase tracking-widest text-slate-500 mt-2">Hold steady</div>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 bg-slate-950/95 flex items-center justify-center p-8">
            <div className="text-center">
              <AlertTriangle className="mx-auto mb-4 text-amber-400" size={40} />
              <p className="text-slate-300 text-sm leading-relaxed">{error}</p>
            </div>
          </div>
        )}
      </div>
      {pending && (
        <div className="bg-slate-900 border-t-2 border-lime-400 p-4 space-y-3 max-h-[52vh] overflow-y-auto">
          <div>
            <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500 mb-1">Scanned code</div>
            <div className="font-mono text-2xl text-amber-300 break-all">{pending.value}</div>
          </div>

          {pending.lines.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500 mb-2">
                Text on the label — tap the name
              </div>
              <div className="flex flex-wrap gap-2">
                {pending.lines.map((t) => (
                  <button
                    key={t}
                    onClick={() => setPending({ ...pending, name: pending.name === t ? "" : t })}
                    className={`px-3 py-2 rounded-lg text-sm border text-left ${
                      pending.name === t
                        ? "bg-amber-400 text-slate-950 border-amber-400"
                        : "border-slate-700 text-slate-300"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Btn onClick={rescan}>Rescan</Btn>
            <Btn variant="primary" onClick={() => onCode(pending.value, pending.frame, pending.name)}>
              <Check size={18} /> Import
            </Btn>
          </div>
        </div>
      )}

      <div className="p-4 space-y-2">
        {!error && !pending && hasTorch && (
          <Btn onClick={toggleTorch} variant={torchOn ? "primary" : "default"} className="w-full">
            <Zap size={18} /> {torchOn ? "Light on" : "Light"}
          </Btn>
        )}
        {!error && !pending && resolution && (
          <div className="text-center text-[10px] uppercase tracking-widest text-slate-600 font-mono">{resolution}</div>
        )}
        {error && (
          <Btn variant="primary" onClick={onPhoto} className="w-full">Photograph the label</Btn>
        )}
        <Btn onClick={onClose} className="w-full">Enter code by hand</Btn>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Label cropper                                                      */
/*                                                                     */
/*  A photo of a bin label taken on a workbench is mostly not label -  */
/*  desk, other boxes, tools. OCR over the whole frame returns junk,   */
/*  the same way the barcode scanner returned junk before it started   */
/*  rejecting anything outside its guide box. Same discipline here:    */
/*  the user says which part of the photo is the text, and nothing     */
/*  outside it is ever considered.                                     */
/* ------------------------------------------------------------------ */
function LabelCropper({ file, onCancel, onConfirm }) {
  const [url, setUrl] = useState(null);
  const [dims, setDims] = useState(null);      // { w, h } natural pixels
  const [rect, setRect] = useState(null);      // natural pixels
  const frameRef = useRef(null);
  const imgRef = useRef(null);
  const dragRef = useRef(null);

  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  const onLoad = (e) => {
    const im = e.currentTarget;
    const w = im.naturalWidth, h = im.naturalHeight;
    setDims({ w, h });
    // Start with a wide band across the middle - about where a label sits
    // when someone photographs one lying flat.
    setRect({ x: w * 0.08, y: h * 0.34, w: w * 0.84, h: h * 0.32 });
  };

  // Pointer position -> natural image pixels. The frame element is sized to
  // the image's exact aspect ratio, so it *is* the drawn image area - no
  // letterboxing maths needed.
  const toNatural = (clientX, clientY) => {
    const fr = frameRef.current, d = dims;
    if (!fr || !d) return null;
    const r = fr.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      x: Math.max(0, Math.min(d.w, ((clientX - r.left) / r.width) * d.w)),
      y: Math.max(0, Math.min(d.h, ((clientY - r.top) / r.height) * d.h)),
    };
  };

  const down = (e) => {
    const p = toNatural(e.clientX, e.clientY);
    if (!p) return;
    dragRef.current = p;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
  };
  const move = (e) => {
    const a = dragRef.current;
    if (!a) return;
    const p = toNatural(e.clientX, e.clientY);
    if (!p) return;
    setRect({
      x: Math.min(a.x, p.x), y: Math.min(a.y, p.y),
      w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y),
    });
  };
  const up = () => {
    const d = dims, r = rect;
    dragRef.current = null;
    // Ignore a stray tap - keep whatever box was there rather than leaving
    // a sliver that would OCR to nothing.
    if (d && r && (r.w < d.w * 0.04 || r.h < d.h * 0.02)) {
      setRect({ x: d.w * 0.08, y: d.h * 0.34, w: d.w * 0.84, h: d.h * 0.32 });
    }
  };

  const confirm = () => {
    const im = imgRef.current, r = rect;
    if (!im || !r || !dims) return;
    onConfirm(preprocess(im, r));
  };

  const pct = (v, total) => `${(v / total) * 100}%`;

  return (
    <div className="fixed inset-0 bg-slate-950 z-50 flex flex-col">
      <div className="flex items-center justify-between p-4 border-b border-slate-800 shrink-0">
        <span className="text-[11px] uppercase tracking-[0.2em] text-slate-400">Drag a box round the text</span>
        <button onClick={onCancel} className="text-slate-300 p-2"><X size={24} /></button>
      </div>

      <div className="flex-1 min-h-0 flex items-center justify-center p-2 overflow-hidden">
        <div
          ref={frameRef}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          className="relative touch-none select-none max-w-full max-h-full"
          style={dims ? { aspectRatio: `${dims.w} / ${dims.h}`, width: "100%" } : undefined}
        >
          {url && (
            <img
              ref={imgRef}
              src={url}
              alt=""
              onLoad={onLoad}
              draggable={false}
              className="w-full h-full object-fill pointer-events-none"
            />
          )}
          {rect && dims && (
            <>
              <div className="absolute inset-0 bg-slate-950/55 pointer-events-none" />
              <div
                className="absolute border-2 border-lime-400 pointer-events-none"
                style={{
                  left: pct(rect.x, dims.w), top: pct(rect.y, dims.h),
                  width: pct(rect.w, dims.w), height: pct(rect.h, dims.h),
                  boxShadow: "0 0 0 9999px rgba(2,6,23,0.55)",
                }}
              />
            </>
          )}
        </div>
      </div>

      <div className="p-4 space-y-2 shrink-0">
        <p className="text-xs text-slate-500 text-center leading-relaxed">
          Drag across the part name and number. Leave out the barcode and anything else in shot.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Btn onClick={onCancel}>Retake</Btn>
          <Btn variant="primary" onClick={confirm} disabled={!rect}>
            <Check size={18} /> Read this
          </Btn>
        </div>
      </div>
    </div>
  );
}

/* Crop to the chosen box, then greyscale and stretch the contrast. Phone
 * photos of laminated labels are low-contrast and glary; Tesseract does
 * markedly better on a clean, adequately sized greyscale image than on a
 * 12-megapixel colour one. Returns a canvas, which recognize() accepts. */
function preprocess(img, rect, maxDim = 1800, minDim = 900) {
  const sx = Math.round(rect.x), sy = Math.round(rect.y);
  const sw = Math.max(1, Math.round(rect.w)), sh = Math.max(1, Math.round(rect.h));
  const longest = Math.max(sw, sh);
  let scale = 1;
  if (longest > maxDim) scale = maxDim / longest;
  else if (longest < minDim) scale = Math.min(3, minDim / longest);  // upscale tight crops

  const cw = Math.max(1, Math.round(sw * scale));
  const ch = Math.max(1, Math.round(sh * scale));
  const cv = document.createElement("canvas");
  cv.width = cw; cv.height = ch;
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);

  try {
    const image = ctx.getImageData(0, 0, cw, ch);
    const px = image.data;
    const lum = new Uint8ClampedArray(cw * ch);
    let min = 255, max = 0;
    for (let i = 0, j = 0; i < px.length; i += 4, j += 1) {
      const v = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
      lum[j] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = Math.max(1, max - min);
    for (let i = 0, j = 0; i < px.length; i += 4, j += 1) {
      const v = ((lum[j] - min) * 255) / range;
      px[i] = px[i + 1] = px[i + 2] = v;
    }
    ctx.putImageData(image, 0, 0);
  } catch (e) { /* tainted canvas shouldn't happen on a local blob; plain crop is fine */ }

  return cv;
}

/* ------------------------------------------------------------------ */
/*  Main app                                                           */
/* ------------------------------------------------------------------ */
export default function PartCounter() {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("count");
  const [view, setView] = useState("home");     // home | manual | browse | newpart | calibrate | weigh | result
  const [scanning, setScanning] = useState(false);
  const [activeCode, setActiveCode] = useState(null);
  const [toast, setToast] = useState(null);

  // form state
  const [codeInput, setCodeInput] = useState("");
  const [catFilter, setCatFilter] = useState(null);
  const [search, setSearch] = useState("");
  const [newPart, setNewPart] = useState({ name: "", category: "Bolts" });
  const [cal, setCal] = useState({ pieces: "100", weight: "", unit: "g" });
  const [weigh, setWeigh] = useState({ gross: "", unit: "kg", tareId: "", tareManual: "", note: "" });
  const [result, setResult] = useState(null);
  const [importText, setImportText] = useState("");
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(null);
  const [ocrError, setOcrError] = useState(null);
  const [cropFile, setCropFile] = useState(null);
  const [labelLines, setLabelLines] = useState([]);
  const [nameOptions, setNameOptions] = useState([]);
  const fileRef = useRef(null);
  const ocrCancelledRef = useRef(false);

  useEffect(() => { loadData().then(setData); }, []);

  const save = useCallback(async (next) => {
    setData(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); }
    catch (e) { setToast("Couldn't save. Your last entry is on screen only."); }
  }, []);

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2600); };

  if (!data) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-slate-500 text-sm font-mono tracking-widest">LOADING…</div>
      </div>
    );
  }

  const part = activeCode ? data.parts[activeCode] : null;

  /* ---- flow actions ---- */
  const openCode = (code, frameDataUrl, scannedName, suggestions) => {
    const c = String(code || "").trim();
    if (!c) return;
    setActiveCode(c);
    setScanning(false);
    setCodeInput("");
    if (data.parts[c]) {
      if (data.parts[c].gPerPiece) { setWeigh({ gross: "", unit: "kg", tareId: "", tareManual: "", note: "" }); setView("weigh"); }
      else { setCal({ pieces: "100", weight: "", unit: "g" }); setView("calibrate"); }
    } else {
      setNewPart({ name: scannedName || "", category: data.categories[0] });
      setNameOptions(Array.isArray(suggestions) ? suggestions : []);
      setView("newpart");
    }
  };

  const createPart = () => {
    const next = {
      ...data,
      parts: {
        ...data.parts,
        [activeCode]: { code: activeCode, name: newPart.name.trim() || activeCode, category: newPart.category },
      },
    };
    save(next);
    setCal({ pieces: "100", weight: "", unit: "g" });
    setView("calibrate");
  };

  const saveCalibration = () => {
    const pieces = parseInt(cal.pieces, 10);
    const wG = toGrams(cal.weight, cal.unit);
    if (!pieces || pieces < 1 || !isFinite(wG) || wG <= 0) { flash("Enter how many pieces you counted and what they weigh."); return; }
    const next = {
      ...data,
      parts: {
        ...data.parts,
        [activeCode]: {
          ...data.parts[activeCode],
          gPerPiece: wG / pieces,
          sampleCount: pieces,
          sampleWeightG: wG,
          calibratedAt: Date.now(),
        },
      },
    };
    save(next);
    setWeigh({ gross: "", unit: "kg", tareId: "", tareManual: "", note: "" });
    setView("weigh");
    flash(`Calibrated: ${(wG / pieces).toFixed(3)} g per piece`);
  };

  const computeCount = () => {
    const grossG = toGrams(weigh.gross, weigh.unit);
    const container = data.containers.find((c) => c.id === weigh.tareId);
    const tareG = weigh.tareManual !== "" ? toGrams(weigh.tareManual, "g") : (container ? container.g : 0);
    if (!isFinite(grossG) || grossG <= 0) { flash("Enter the weight of the full box."); return; }
    const netG = grossG - (isFinite(tareG) ? tareG : 0);
    if (netG <= 0) { flash("Net weight is zero or less. Check the box weight."); return; }
    const gpp = part.gPerPiece;
    const count = Math.round(netG / gpp);
    const acc = accuracy(count, netG, gpp, part.sampleWeightG, data.settings.resolutionG, tareG > 0);
    setResult({ grossG, tareG: isFinite(tareG) ? tareG : 0, netG, gPerPiece: gpp, count, acc });
    setView("result");
  };

  const saveEntry = () => {
    const entry = {
      id: uid(),
      code: part.code, name: part.name, category: part.category,
      grossG: result.grossG, tareG: result.tareG, netG: result.netG,
      gPerPiece: result.gPerPiece, count: result.count,
      note: weigh.note.trim(), ts: Date.now(),
    };
    save({ ...data, entries: [entry, ...data.entries] });
    setActiveCode(null); setResult(null); setView("home");
    flash(`Logged ${entry.count} × ${entry.name}`);
  };

  // On-device OCR via a self-hosted Tesseract.js (worker/core/lang data all
  // served from ./tesseract/, no CDN). Free, offline after first use, works
  // in any browser - unlike the native TextDetector API this replaced, which
  // turned out not to ship in stable Chrome at all. Never auto-saves; only
  // ever prefills an editable field.
  const cancelOcr = () => {
    ocrCancelledRef.current = true;
    setOcrBusy(false);
    setOcrProgress(null);
  };

  // Takes the cropped, preprocessed canvas from LabelCropper - not the raw
  // photo. recognize() accepts a canvas directly.
  const runOcr = async (canvas) => {
    if (!canvas) return;
    ocrCancelledRef.current = false;
    setOcrBusy(true);
    setOcrProgress({ status: "starting up", pct: 0 });
    setOcrError(null);
    let worker = null;
    let step = "loading the OCR engine";
    try {
      // "dan+eng": the labels are Danish ("Blindnitte", "skive"), but part
      // descriptions mix in English and abbreviations. English alone scored
      // Danish words against English vocabulary and returned confident
      // nonsense - the language model matters as much as the glyphs.
      worker = await withTimeout(
        createWorker("dan+eng", 1, {
          // Root-absolute, not relative: the doc doesn't say whether these
          // resolve against the page or against the worker's own URL, and
          // getting it wrong would silently break OCR. A leading slash
          // sidesteps the question - it always resolves to the origin
          // regardless. Safe because this site is deployed at the domain
          // root, not a subpath.
          workerPath: "/tesseract/worker.min.js",
          corePath: "/tesseract/core/",
          langPath: "/tesseract/lang-data/",
          legacyCore: false,
          workerBlobURL: false,
          gzip: true,
          cacheMethod: "none",
          logger: (m) => {
            if (m && m.status && typeof m.progress === "number") {
              setOcrProgress({ status: m.status, pct: Math.round(m.progress * 100) });
            }
          },
        }),
        45000
      );
      if (ocrCancelledRef.current) return;

      // The crop is one block of label text, not a document page. The default
      // (AUTO) tries to find columns and reading order in it and does badly.
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });

      step = "recognizing text";
      const { data } = await withTimeout(worker.recognize(canvas), 40000);
      if (ocrCancelledRef.current) return;
      const lines = (data.text || "")
        .split("\n")
        .map((t) => t.trim())
        .filter((t) => t.length > 1 && t.length < 60)
        .filter((t, i, a) => a.indexOf(t) === i)
        .slice(0, 12);
      if (lines.length) {
        setLabelLines(lines);
        setView("picklabel");
        return;
      }
      flash("No text found in that box. Try again, closer or better lit.");
    } catch (e) {
      if (!ocrCancelledRef.current) {
        const detail = e && e.message === "timeout"
          ? `Timed out while ${step}.`
          : `Failed while ${step}: ${(e && (e.name ? `${e.name}: ` : "") + (e.message || String(e))) || "unknown error"}`;
        setOcrError(detail);
      }
    } finally {
      if (worker) worker.terminate().catch(() => {});
      if (!ocrCancelledRef.current) { setOcrBusy(false); setOcrProgress(null); }
    }
  };

  const csv = () => {
    const head = "code,name,category,gross_g,tare_g,net_g,g_per_piece,count,note,counted_at";
    const rows = data.entries.map((e) =>
      [e.code, e.name, e.category, e.grossG.toFixed(1), e.tareG.toFixed(1), e.netG.toFixed(1),
       e.gPerPiece.toFixed(4), e.count, `"${(e.note || "").replace(/"/g, "'")}"`,
       new Date(e.ts).toISOString()].join(",")
    );
    return [head, ...rows].join("\n");
  };

  const download = () => {
    try {
      const blob = new Blob([csv()], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `stocktake-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      flash("CSV downloaded");
    } catch (e) {
      navigator.clipboard?.writeText(csv());
      flash("CSV copied to clipboard");
    }
  };

  /* ---- headers ---- */
  const Header = ({ title, back, right }) => (
    <div className="sticky top-0 z-20 bg-slate-900/95 backdrop-blur border-b border-slate-800">
      <div className="flex items-center gap-3 px-4 h-16">
        {back && <button onClick={back} className="text-slate-300 -ml-2 p-2"><ChevronLeft size={26} /></button>}
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-[0.25em] text-amber-400/80">Stocktake</div>
          <div className="text-base text-slate-100 truncate">{title}</div>
        </div>
        {right}
      </div>
    </div>
  );

  /* ================== COUNT TAB VIEWS ================== */
  const parts = Object.values(data.parts);
  const filtered = parts.filter((p) =>
    (!catFilter || p.category === catFilter) &&
    (!search || (p.name + p.code).toLowerCase().includes(search.toLowerCase()))
  );

  const CountTab = () => {
    if (view === "home") {
      const todays = data.entries.filter((e) => new Date(e.ts).toDateString() === new Date().toDateString());
      return (
        <>
          <Header title="Pick a part to count" />
          <div className="p-4 space-y-3">
            {data.settings.scanBlocked ? (
              <button
                onClick={() => fileRef.current?.click()}
                className="w-full bg-amber-400 text-slate-950 rounded-lg py-8 flex flex-col items-center gap-2 active:bg-amber-300"
              >
                <ImageIcon size={40} strokeWidth={1.5} />
                <span className="font-semibold text-lg">Photograph the label</span>
                <span className="text-xs opacity-70">Reads the code and the name</span>
              </button>
            ) : (
              <button
                onClick={() => setScanning(true)}
                className="w-full bg-amber-400 text-slate-950 rounded-lg py-8 flex flex-col items-center gap-2 active:bg-amber-300"
              >
                <Camera size={40} strokeWidth={1.5} />
                <span className="font-semibold text-lg">Scan barcode</span>
              </button>
            )}
            <div className="grid grid-cols-3 gap-2">
              <Btn
                onClick={() => data.settings.scanBlocked ? setScanning(true) : fileRef.current?.click()}
                className="flex-col py-6 h-auto px-2"
              >
                {data.settings.scanBlocked
                  ? <><Camera size={24} strokeWidth={1.5} /><span className="text-xs">Try scan</span></>
                  : <><ImageIcon size={24} strokeWidth={1.5} /><span className="text-xs">Read label</span></>}
              </Btn>
              <Btn onClick={() => setView("manual")} className="flex-col py-6 h-auto px-2">
                <Keyboard size={24} strokeWidth={1.5} /><span className="text-xs">Type code</span>
              </Btn>
              <Btn onClick={() => { setCatFilter(null); setSearch(""); setView("browse"); }} className="flex-col py-6 h-auto px-2">
                <Filter size={24} strokeWidth={1.5} /><span className="text-xs">Browse</span>
              </Btn>
            </div>

            <div className="pt-4">
              <Label>Today</Label>
              <Panel className="p-4 flex items-center justify-between">
                <div>
                  <div className="text-3xl font-mono text-amber-300">{todays.length}</div>
                  <div className="text-xs text-slate-400 mt-1">boxes counted</div>
                </div>
                <div className="text-right">
                  <div className="text-3xl font-mono text-slate-200">
                    {todays.reduce((s, e) => s + e.count, 0).toLocaleString()}
                  </div>
                  <div className="text-xs text-slate-400 mt-1">pieces</div>
                </div>
              </Panel>
            </div>
          </div>
        </>
      );
    }

    if (view === "manual") {
      return (
        <>
          <Header title="Type part code" back={() => setView("home")} />
          <div className="p-4 space-y-4">
            <Label>Part code</Label>
            <TextInput value={codeInput} onChange={setCodeInput} placeholder="e.g. 40012-M8" autoFocus />
            <Btn variant="primary" onClick={() => openCode(codeInput)} className="w-full" disabled={!codeInput.trim()}>
              Continue <ChevronLeft size={18} className="rotate-180" />
            </Btn>
          </div>
        </>
      );
    }

    if (view === "browse") {
      return (
        <>
          <Header title="Browse parts" back={() => setView("home")} />
          <div className="p-4 space-y-4">
            <div className="relative">
              <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name or code"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-11 pr-4 py-4 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-amber-400"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setCatFilter(null)}
                className={`px-4 py-2 rounded-full text-sm border ${!catFilter ? "bg-amber-400 text-slate-950 border-amber-400" : "border-slate-700 text-slate-300"}`}
              >All</button>
              {data.categories.map((c) => (
                <button
                  key={c}
                  onClick={() => setCatFilter(c === catFilter ? null : c)}
                  className={`px-4 py-2 rounded-full text-sm border ${catFilter === c ? "bg-amber-400 text-slate-950 border-amber-400" : "border-slate-700 text-slate-300"}`}
                >{c}</button>
              ))}
            </div>
            {filtered.length === 0 ? (
              <Panel className="p-8 text-center">
                <Package className="mx-auto mb-3 text-slate-600" size={32} />
                <p className="text-slate-400 text-sm">No parts here yet. Scan or type a code to add one.</p>
              </Panel>
            ) : (
              <div className="space-y-2">
                {filtered.map((p) => (
                  <button
                    key={p.code}
                    onClick={() => openCode(p.code)}
                    className="w-full text-left bg-slate-800 border border-slate-700 rounded-lg p-4 active:bg-slate-700"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-slate-100 truncate">{p.name}</div>
                        <div className="text-xs font-mono text-slate-500 mt-1">{p.code} · {p.category}</div>
                      </div>
                      {p.gPerPiece ? (
                        <div className="text-right shrink-0">
                          <div className="font-mono text-amber-300">{p.gPerPiece.toFixed(3)}</div>
                          <div className="text-[10px] uppercase tracking-wider text-slate-500">g/pc</div>
                        </div>
                      ) : (
                        <span className="shrink-0 text-[10px] uppercase tracking-wider text-rose-400 border border-rose-400/40 rounded px-2 py-1">
                          Not set
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      );
    }

    if (view === "picklabel") {
      return (
        <>
          <Header title="What did it read?" back={() => { setLabelLines([]); setView("home"); }} />
          <div className="p-4 space-y-4">
            <p className="text-sm text-slate-400 leading-relaxed">
              Tap the line that is the part code. Anything else on the label is offered as the name next.
            </p>
            <div className="space-y-2">
              {labelLines.map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    const rest = labelLines.filter((x) => x !== t);
                    setLabelLines([]);
                    openCode(t, null, rest[0] || "", rest);
                  }}
                  className="w-full text-left bg-slate-800 border border-slate-700 rounded-lg p-4 active:bg-slate-700 font-mono text-slate-100 break-all"
                >
                  {t}
                </button>
              ))}
            </div>
            <Btn onClick={() => { setLabelLines([]); setView("manual"); }} className="w-full">
              None of these — type it
            </Btn>
          </div>
        </>
      );
    }

    if (view === "newpart") {
      const n = newPart.name.trim().toLowerCase();
      const dupName = n ? parts.find((p) => p.name.toLowerCase() === n && p.code !== activeCode) : null;
      return (
        <>
          <Header title="New part" back={() => { setActiveCode(null); setView("home"); }} />
          <div className="p-4 space-y-5">
            <div className="bg-slate-950 border-2 border-amber-400/60 rounded-lg p-4">
              <div className="inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-slate-950 bg-amber-400 rounded px-2 py-1 mb-3">
                <Plus size={12} /> New code
              </div>
              <div className="font-mono text-2xl text-amber-300 break-all">{activeCode}</div>
              <p className="text-xs text-slate-400 mt-2">Not in your library. Name it once and every future scan finds it.</p>
            </div>
            <div>
              <Label>Name</Label>
              <TextInput value={newPart.name} onChange={(v) => setNewPart({ ...newPart, name: v })} placeholder="e.g. M8×30 flange bolt" autoFocus />
              {nameOptions.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {nameOptions.map((t) => (
                    <button
                      key={t}
                      onClick={() => setNewPart({ ...newPart, name: t })}
                      className="px-3 py-2 rounded-lg text-xs border border-slate-700 text-slate-300 active:bg-slate-800"
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}
              {dupName && (
                <div className="flex gap-2 mt-2 text-amber-400 text-xs leading-relaxed">
                  <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                  <span>You already have that name under code {dupName.code}. Same part with two codes counts twice.</span>
                </div>
              )}
            </div>
            <Btn onClick={() => fileRef.current?.click()} className="w-full">
              <ImageIcon size={18} /> Read the name off the label
            </Btn>
            <div>
              <Label>Group</Label>
              <div className="flex flex-wrap gap-2">
                {data.categories.map((c) => (
                  <button
                    key={c}
                    onClick={() => setNewPart({ ...newPart, category: c })}
                    className={`px-4 py-2 rounded-full text-sm border ${newPart.category === c ? "bg-amber-400 text-slate-950 border-amber-400" : "border-slate-700 text-slate-300"}`}
                  >{c}</button>
                ))}
              </div>
            </div>
            <Btn variant="primary" onClick={createPart} className="w-full">Save and calibrate</Btn>
          </div>
        </>
      );
    }

    if (view === "calibrate" && part) {
      const pieces = parseInt(cal.pieces, 10);
      const wG = toGrams(cal.weight, cal.unit);
      const gpp = pieces > 0 && isFinite(wG) ? wG / pieces : null;
      const tooLight = gpp && data.settings.resolutionG / wG > 0.02;
      return (
        <>
          <Header title="Calibrate" back={() => { setActiveCode(null); setView("home"); }} />
          <div className="p-4 space-y-5">
            <Panel className="p-4">
              <div className="text-slate-100">{part.name}</div>
              <div className="text-xs font-mono text-slate-500 mt-1">{part.code} · {part.category}</div>
            </Panel>
            <p className="text-sm text-slate-400 leading-relaxed">
              Count out a sample by hand, put it on the scale, and enter both numbers. You only do this once per part.
            </p>
            <div>
              <Label>Pieces you counted</Label>
              <NumInput value={cal.pieces} onChange={(v) => setCal({ ...cal, pieces: v })} suffix="pcs" />
              <div className="flex gap-2 mt-2">
                {[25, 50, 100, 200].map((n) => (
                  <button key={n} onClick={() => setCal({ ...cal, pieces: String(n) })}
                    className="flex-1 py-2 rounded border border-slate-700 text-sm text-slate-300 active:bg-slate-800">{n}</button>
                ))}
              </div>
            </div>
            <div>
              <Label>Weight of that sample</Label>
              <div className="flex gap-2">
                <div className="flex-1"><NumInput value={cal.weight} onChange={(v) => setCal({ ...cal, weight: v })} placeholder="0.00" suffix="g" /></div>
              </div>
            </div>
            {gpp && (
              <Panel className="p-4">
                <Label>Piece weight</Label>
                <div className="font-mono text-3xl text-amber-300">{gpp.toFixed(4)} <span className="text-base text-slate-400">g</span></div>
                {tooLight && (
                  <div className="flex gap-2 mt-3 text-amber-400 text-xs leading-relaxed">
                    <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                    <span>Sample is light for this scale. Weigh more pieces for a tighter count.</span>
                  </div>
                )}
              </Panel>
            )}
            <Btn variant="primary" onClick={saveCalibration} className="w-full">Save calibration</Btn>
          </div>
        </>
      );
    }

    if (view === "weigh" && part) {
      return (
        <>
          <Header
            title="Weigh the box"
            back={() => { setActiveCode(null); setView("home"); }}
            right={
              <button onClick={() => { setCal({ pieces: String(part.sampleCount || 100), weight: "", unit: "g" }); setView("calibrate"); }}
                className="text-slate-400 p-2"><RotateCcw size={20} /></button>
            }
          />
          <div className="p-4 space-y-5">
            <div className="bg-slate-950 border-2 border-amber-400/60 rounded-lg p-5">
              <div className="text-[10px] uppercase tracking-[0.25em] text-slate-500 mb-2">Counting</div>
              <div className="text-2xl text-slate-50 leading-snug">{part.name}</div>
              <div className="font-mono text-sm text-amber-300 mt-2 break-all">{part.code}</div>
              <div className="flex items-center justify-between mt-4 pt-3 border-t border-slate-800">
                <span className="text-xs text-slate-500">{part.category}</span>
                <span className="font-mono text-xs text-slate-400">{part.gPerPiece.toFixed(4)} g/pc</span>
              </div>
              <button
                onClick={() => { setActiveCode(null); setView("home"); }}
                className="mt-3 text-xs uppercase tracking-wider text-slate-500 underline underline-offset-4"
              >
                Wrong part — go back
              </button>
            </div>

            <div>
              <Label>Total weight on the scale</Label>
              <NumInput value={weigh.gross} onChange={(v) => setWeigh({ ...weigh, gross: v })} placeholder="0.00" suffix={weigh.unit} autoFocus />
              <div className="flex gap-2 mt-2">
                {["g", "kg"].map((u) => (
                  <button key={u} onClick={() => setWeigh({ ...weigh, unit: u })}
                    className={`flex-1 py-3 rounded border text-sm ${weigh.unit === u ? "bg-slate-700 border-amber-400 text-amber-300" : "border-slate-700 text-slate-400"}`}>{u}</button>
                ))}
              </div>
            </div>

            <div>
              <Label>Empty box weight</Label>
              <div className="flex flex-wrap gap-2 mb-2">
                <button onClick={() => setWeigh({ ...weigh, tareId: "", tareManual: "" })}
                  className={`px-4 py-2 rounded-full text-sm border ${!weigh.tareId && !weigh.tareManual ? "bg-amber-400 text-slate-950 border-amber-400" : "border-slate-700 text-slate-300"}`}>
                  Scale was tared
                </button>
                {data.containers.filter((c) => c.g > 0).map((c) => (
                  <button key={c.id} onClick={() => setWeigh({ ...weigh, tareId: c.id, tareManual: "" })}
                    className={`px-4 py-2 rounded-full text-sm border ${weigh.tareId === c.id ? "bg-amber-400 text-slate-950 border-amber-400" : "border-slate-700 text-slate-300"}`}>
                    {c.name} · {c.g}g
                  </button>
                ))}
              </div>
              <NumInput value={weigh.tareManual} onChange={(v) => setWeigh({ ...weigh, tareManual: v, tareId: "" })} placeholder="or type box weight" suffix="g" />
            </div>

            <div>
              <Label>Note (optional)</Label>
              <TextInput value={weigh.note} onChange={(v) => setWeigh({ ...weigh, note: v })} placeholder="Rack A3, part box 2…" />
            </div>

            <Btn variant="primary" onClick={computeCount} className="w-full text-lg">
              <Scale size={20} /> Count it
            </Btn>
          </div>
        </>
      );
    }

    if (view === "result" && part && result) {
      const good = result.acc && result.acc.rel <= 0.1;
      return (
        <>
          <Header title="Result" back={() => setView("weigh")} />
          <div className="p-4 space-y-4">
            <div className="bg-slate-950 border-2 border-amber-400/60 rounded-lg p-6 text-center">
              <div className="text-lg text-slate-100 leading-snug">{part.name}</div>
              <div className="font-mono text-xs text-slate-500 mt-1 break-all">{part.code}</div>
              <div className="text-[11px] uppercase tracking-[0.25em] text-slate-500 mt-5 mb-3">Estimated count</div>
              <div className="font-mono text-6xl text-amber-300 tracking-tight">{result.count.toLocaleString()}</div>
              {result.acc && (
                <div className="font-mono text-sm text-slate-400 mt-3">
                  ± {result.acc.plusMinus} pcs · ± {(result.acc.rel * 100).toFixed(1)}%
                </div>
              )}
              <div className={`inline-flex items-center gap-2 mt-4 text-xs px-3 py-1.5 rounded-full border ${good ? "text-lime-400 border-lime-400/40" : "text-amber-400 border-amber-400/40"}`}>
                {good ? <Check size={14} /> : <AlertTriangle size={14} />}
                {good ? "Inside your 10% tolerance" : "Wider than 10% — recalibrate with more pieces"}
              </div>
            </div>

            <Panel className="p-4 space-y-3 font-mono text-sm">
              {[
                ["On the scale", `${fmt(result.grossG)} g`],
                ["Empty box", `− ${fmt(result.tareG)} g`],
                ["Parts only", `${fmt(result.netG)} g`],
                ["Piece weight", `${result.gPerPiece.toFixed(4)} g`],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="text-slate-500">{k}</span>
                  <span className="text-slate-200">{v}</span>
                </div>
              ))}
            </Panel>

            <Btn variant="primary" onClick={saveEntry} className="w-full text-lg"><Check size={20} /> Save to stocktake</Btn>
            <Btn onClick={() => setView("weigh")} className="w-full">Weigh again</Btn>
          </div>
        </>
      );
    }
    return null;
  };

  /* ================== PARTS TAB ================== */
  const PartsTab = () => (
    <>
      <Header title={`Parts library · ${parts.length}`} />
      <div className="p-4 space-y-2">
        {parts.length === 0 && (
          <Panel className="p-8 text-center">
            <Boxes className="mx-auto mb-3 text-slate-600" size={32} />
            <p className="text-slate-400 text-sm">Nothing here yet. Every part you scan gets saved automatically.</p>
          </Panel>
        )}
        {parts.map((p) => (
          <Panel key={p.code} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-slate-100">{p.name}</div>
                <div className="text-xs font-mono text-slate-500 mt-1">{p.code} · {p.category}</div>
                <div className="text-xs text-slate-400 mt-2 font-mono">
                  {p.gPerPiece
                    ? `${p.gPerPiece.toFixed(4)} g/pc · from ${p.sampleCount} pcs`
                    : "Not calibrated"}
                </div>
              </div>
              <div className="flex gap-1 shrink-0">
                <button onClick={() => { setActiveCode(p.code); setCal({ pieces: String(p.sampleCount || 100), weight: "", unit: "g" }); setTab("count"); setView("calibrate"); }}
                  className="p-3 text-slate-400 active:text-amber-300"><Pencil size={18} /></button>
                <button onClick={() => {
                  const parts2 = { ...data.parts }; delete parts2[p.code];
                  save({ ...data, parts: parts2 });
                }} className="p-3 text-slate-500 active:text-rose-400"><Trash2 size={18} /></button>
              </div>
            </div>
          </Panel>
        ))}
      </div>
    </>
  );

  /* ================== LOG TAB ================== */
  const LogTab = () => (
    <>
      <Header
        title={`Stocktake log · ${data.entries.length}`}
        right={<button onClick={download} className="p-2 text-amber-400"><Download size={22} /></button>}
      />
      <div className="p-4 space-y-2">
        {data.entries.length === 0 && (
          <Panel className="p-8 text-center">
            <ClipboardList className="mx-auto mb-3 text-slate-600" size={32} />
            <p className="text-slate-400 text-sm">Counted boxes land here. Export to CSV when the count is done.</p>
          </Panel>
        )}
        {data.entries.map((e) => (
          <Panel key={e.id} className="p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-slate-100 truncate">{e.name}</div>
                <div className="text-xs font-mono text-slate-500 mt-1">
                  {e.code} · {fmt(e.netG)} g net
                </div>
                {e.note && <div className="text-xs text-slate-400 mt-1">{e.note}</div>}
                <div className="text-[10px] text-slate-600 mt-1">{new Date(e.ts).toLocaleString()}</div>
              </div>
              <div className="text-right shrink-0">
                <div className="font-mono text-2xl text-amber-300">{e.count.toLocaleString()}</div>
                <button onClick={() => save({ ...data, entries: data.entries.filter((x) => x.id !== e.id) })}
                  className="text-[10px] uppercase tracking-wider text-slate-500 mt-1">Remove</button>
              </div>
            </div>
          </Panel>
        ))}
      </div>
    </>
  );

  /* ================== SETTINGS ================== */
  const SettingsTab = () => (
    <>
      <Header title="Setup" />
      <div className="p-4 space-y-6">
        <div>
          <Label>Scale readability</Label>
          <div className="flex gap-2">
            {[0.01, 0.1, 1, 5].map((r) => (
              <button key={r} onClick={() => save({ ...data, settings: { ...data.settings, resolutionG: r } })}
                className={`flex-1 py-3 rounded border font-mono text-sm ${data.settings.resolutionG === r ? "bg-slate-700 border-amber-400 text-amber-300" : "border-slate-700 text-slate-400"}`}>
                {r} g
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500 mt-2">The smallest step your scale shows. Used for the ± figure.</p>
        </div>

        <div>
          <Label>Boxes and totes</Label>
          <div className="space-y-2">
            {data.containers.map((c) => (
              <div key={c.id} className="flex gap-2">
                <input value={c.name}
                  onChange={(e) => save({ ...data, containers: data.containers.map((x) => x.id === c.id ? { ...x, name: e.target.value } : x) })}
                  className="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded-lg px-3 py-3 text-slate-100 focus:outline-none focus:border-amber-400" />
                <input value={c.g} inputMode="decimal"
                  onChange={(e) => save({ ...data, containers: data.containers.map((x) => x.id === c.id ? { ...x, g: parseFloat(e.target.value) || 0 } : x) })}
                  className="w-24 bg-slate-950 border border-slate-700 rounded-lg px-3 py-3 font-mono text-amber-300 focus:outline-none focus:border-amber-400" />
                <button onClick={() => save({ ...data, containers: data.containers.filter((x) => x.id !== c.id) })}
                  className="px-3 text-slate-500"><Trash2 size={18} /></button>
              </div>
            ))}
          </div>
          <Btn onClick={() => save({ ...data, containers: [...data.containers, { id: uid(), name: "New box", g: 0 }] })}
            className="w-full mt-2"><Plus size={18} /> Add a box</Btn>
        </div>

        <div>
          <Label>Groups</Label>
          <div className="flex flex-wrap gap-2">
            {data.categories.map((c) => (
              <span key={c} className="px-3 py-2 rounded-full text-sm border border-slate-700 text-slate-300 flex items-center gap-2">
                {c}
                <button onClick={() => save({ ...data, categories: data.categories.filter((x) => x !== c) })}
                  className="text-slate-600"><X size={14} /></button>
              </span>
            ))}
          </div>
          <div className="flex gap-2 mt-3">
            <input id="newcat" placeholder="Add a group"
              className="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded-lg px-3 py-3 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-amber-400"
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.target.value.trim()) {
                  save({ ...data, categories: [...data.categories, e.target.value.trim()] });
                  e.target.value = "";
                }
              }} />
          </div>
        </div>

        <div>
          <Label>Paste a part list</Label>
          <p className="text-xs text-slate-500 mb-2">
            One part per line: <span className="font-mono text-slate-400">code, name, group</span>. Group is optional.
            Existing parts and their calibrations are left alone.
          </p>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={5}
            placeholder={"40012-M8, M8x30 flange bolt, Bolts\n40088, M8 nyloc nut, Nuts"}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-3 font-mono text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-amber-400"
          />
          <Btn
            onClick={() => {
              const rows = importText.split("\n").map((l) => l.split(/[,;\t]/).map((s) => s.trim()));
              const nextParts = { ...data.parts };
              const nextCats = [...data.categories];
              let added = 0, skipped = 0;
              rows.forEach(([code, name, cat]) => {
                if (!code) return;
                if (nextParts[code]) { skipped++; return; }
                const group = cat && cat.length ? cat : "Other";
                if (!nextCats.includes(group)) nextCats.push(group);
                nextParts[code] = { code, name: name || code, category: group };
                added++;
              });
              save({ ...data, parts: nextParts, categories: nextCats });
              setImportText("");
              flash(`${added} added, ${skipped} already there`);
            }}
            disabled={!importText.trim()}
            className="w-full mt-2"
          >
            <Plus size={18} /> Add these parts
          </Btn>
        </div>

        <div>
          <Label>Data</Label>
          <Btn onClick={download} className="w-full mb-2"><Download size={18} /> Export stocktake CSV</Btn>
          <Btn variant="danger" onClick={() => {
            if (confirm("Clear the log? Parts and calibrations stay.")) save({ ...data, entries: [] });
          }} className="w-full">Clear the log</Btn>
        </div>

        <div className="pt-2 text-center text-[10px] uppercase tracking-[0.2em] text-slate-600 font-mono">
          Build {BUILD}
        </div>
      </div>
    </>
  );

  /* ================== SHELL ================== */
  const tabs = [
    { id: "count", icon: Scale, label: "Count" },
    { id: "parts", icon: Package, label: "Parts" },
    { id: "log", icon: ClipboardList, label: "Log" },
    { id: "setup", icon: Settings, label: "Setup" },
  ];

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 pb-24" style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      {scanning && (
        <Scanner
          onCode={openCode}
          onClose={() => { setScanning(false); setView("manual"); }}
          onPhoto={() => { setScanning(false); fileRef.current?.click(); }}
          onBlocked={() => {
            if (!data.settings.scanBlocked) save({ ...data, settings: { ...data.settings, scanBlocked: true } });
          }}
        />
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files && e.target.files[0];
          // Clear immediately so retaking the same photo still fires onChange
          if (fileRef.current) fileRef.current.value = "";
          if (f) setCropFile(f);
        }}
      />

      {cropFile && (
        <LabelCropper
          file={cropFile}
          onCancel={() => setCropFile(null)}
          onConfirm={(canvas) => { setCropFile(null); runOcr(canvas); }}
        />
      )}

      {ocrBusy && (
        <div className="fixed inset-0 bg-slate-950/90 z-50 flex flex-col items-center justify-center gap-4 px-8">
          <Loader size={36} className="text-amber-400 animate-spin" />
          <div className="text-sm text-slate-400 tracking-wide text-center">
            {ocrProgress ? `${ocrProgress.status}…` : "Reading the label…"}
          </div>
          {ocrProgress && ocrProgress.pct > 0 && (
            <div className="w-48 h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div className="h-full bg-amber-400" style={{ width: `${ocrProgress.pct}%` }} />
            </div>
          )}
          <div className="text-[10px] uppercase tracking-widest text-slate-600 text-center">
            First time takes longer — downloading the reader
          </div>
          <Btn onClick={cancelOcr} className="mt-2">Cancel</Btn>
        </div>
      )}

      {ocrError && (
        <div className="fixed inset-0 bg-slate-950/95 z-50 flex flex-col items-center justify-center gap-4 px-6">
          <AlertTriangle className="text-amber-400" size={32} />
          <div className="text-sm text-slate-300 text-center">Couldn't read that label.</div>
          <div className="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-lg p-3 font-mono text-xs text-amber-300 break-words select-all max-h-40 overflow-y-auto">
            {ocrError}
          </div>
          <div className="text-[10px] uppercase tracking-widest text-slate-600 text-center">
            Tap the box above to select it, then read it out or send it over
          </div>
          <Btn variant="primary" onClick={() => setOcrError(null)} className="mt-2">OK, type the name instead</Btn>
        </div>
      )}

      {tab === "count" && CountTab()}
      {tab === "parts" && PartsTab()}
      {tab === "log" && LogTab()}
      {tab === "setup" && SettingsTab()}

      {toast && (
        <div className="fixed bottom-24 left-4 right-4 z-40 bg-slate-800 border border-amber-400/40 rounded-lg px-4 py-3 text-sm text-slate-100 shadow-xl">
          {toast}
        </div>
      )}

      <nav className="fixed bottom-0 left-0 right-0 bg-slate-950 border-t border-slate-800 flex z-30">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => { setTab(t.id); if (t.id === "count") setView("home"); }}
            className={`flex-1 py-3 flex flex-col items-center gap-1 ${tab === t.id ? "text-amber-400" : "text-slate-500"}`}
          >
            <t.icon size={22} strokeWidth={1.6} />
            <span className="text-[10px] uppercase tracking-wider">{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
