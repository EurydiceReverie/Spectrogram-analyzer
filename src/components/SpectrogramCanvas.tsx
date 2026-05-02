import { useEffect, useRef, useCallback, useState } from "react";
import { motion } from "framer-motion";
import type { SpectrogramData, SpectrogramChannel } from "@/lib/audioAnalysis";
import { formatDuration } from "@/lib/audioAnalysis";

interface SpectrogramCanvasProps {
  data: SpectrogramData;
}

// ─── Color Schemes ────────────────────────────────────────────────────────────

type ColorScheme = "spek" | "jet" | "magma" | "inferno" | "viridis";

const COLOR_SCHEMES: { value: ColorScheme; label: string; preview: string }[] = [
  {
    value: "spek",
    label: "Spek",
    preview: "linear-gradient(90deg,#000,#16105a,#149664,#c8c819,#e66e0f,#fff5e6)",
  },
  {
    value: "jet",
    label: "Jet / Rainbow",
    preview: "linear-gradient(90deg,#000080,#0000ff,#00ffff,#00ff00,#ffff00,#ff0000,#800000)",
  },
  {
    value: "magma",
    label: "Magma",
    preview: "linear-gradient(90deg,#000004,#3b0f70,#8c2981,#de4968,#fea16e,#fcfdbf)",
  },
  {
    value: "inferno",
    label: "Inferno",
    preview: "linear-gradient(90deg,#000004,#420a68,#932667,#dd513a,#fca50a,#fcffa4)",
  },
  {
    value: "viridis",
    label: "Viridis",
    preview: "linear-gradient(90deg,#440154,#31688e,#35b779,#fde725)",
  },
];

// Smooth interpolation through color stops
function interpolateStops(t: number, stops: [number, number, number, number][]): [number, number, number] {
  t = Math.max(0, Math.min(1, t));
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      const local = (t - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
      const s = local * local * (3 - 2 * local); // smoothstep
      return [
        Math.round(stops[i][1] + (stops[i + 1][1] - stops[i][1]) * s),
        Math.round(stops[i][2] + (stops[i + 1][2] - stops[i][2]) * s),
        Math.round(stops[i][3] + (stops[i + 1][3] - stops[i][3]) * s),
      ];
    }
  }
  const last = stops[stops.length - 1];
  return [last[1], last[2], last[3]];
}

function getColor(t: number, scheme: ColorScheme): [number, number, number] {
  // t: 0 (silence) → 1 (loudest), gamma already applied by caller
  switch (scheme) {
    case "spek":
      // Original Spek 0.8.5 palette: black→navy→blue→cyan→green→yellow→orange→white
      // The majority of music content (-80 to -20 dBFS) maps to blue/cyan/green.
      // Only peaks near 0 dBFS reach orange/white.
      return interpolateStops(t, [
        [0.00,   0,   0,   0],   // silence  → black
        [0.10,   0,   0, 100],   // -108 dBFS → dark navy
        [0.20,   0,   0, 200],   // -96 dBFS → blue
        [0.30,   0, 100, 200],   // -84 dBFS → blue-cyan
        [0.40,   0, 200, 200],   // -72 dBFS → cyan
        [0.50,   0, 200,  50],   // -60 dBFS → green
        [0.60, 100, 210,   0],   // -48 dBFS → yellow-green
        [0.70, 210, 210,   0],   // -36 dBFS → yellow
        [0.80, 240, 140,   0],   // -24 dBFS → orange
        [0.90, 250,  50,   0],   // -12 dBFS → red-orange
        [1.00, 255, 255, 255],   // 0 dBFS   → white
      ]);
    case "jet":
      return interpolateStops(t, [
        [0.00,   0,   0, 128],
        [0.10,   0,   0, 255],
        [0.35,   0, 255, 255],
        [0.50,   0, 255,   0],
        [0.65, 255, 255,   0],
        [0.85, 255,   0,   0],
        [1.00, 128,   0,   0],
      ]);
    case "magma":
      return interpolateStops(t, [
        [0.00,   0,   0,   4],
        [0.13,  14,  10,  60],
        [0.25,  59,  15, 112],
        [0.38, 114,  31, 129],
        [0.50, 163,  47, 114],
        [0.63, 211,  73,  84],
        [0.75, 245, 136,  95],
        [0.88, 253, 187, 132],
        [1.00, 252, 253, 191],
      ]);
    case "inferno":
      return interpolateStops(t, [
        [0.00,   0,   0,   4],
        [0.13,  22,  11, 104],
        [0.25,  88,  28, 135],
        [0.38, 158,  42,  99],
        [0.50, 213,  62,  79],
        [0.63, 237, 104,  37],
        [0.75, 249, 163,   7],
        [0.88, 251, 208,  74],
        [1.00, 252, 255, 164],
      ]);
    case "viridis":
      return interpolateStops(t, [
        [0.00,  68,   1,  84],
        [0.13,  71,  44, 122],
        [0.25,  59,  82, 139],
        [0.38,  44, 114, 142],
        [0.50,  33, 145, 140],
        [0.63,  39, 173, 129],
        [0.75,  92, 200, 99],
        [0.88, 170, 220,  50],
        [1.00, 253, 231,  37],
      ]);
  }
}

function buildColorLUT(_minDb: number, _maxDb: number, scheme: ColorScheme, steps = 512): Uint8Array {
  const lut = new Uint8Array(steps * 3);
  for (let i = 0; i < steps; i++) {
    // t: 0 = silence (minDb) → 1 = loudest (maxDb)
    // Perceptual gamma < 1 makes mid-range detail more visible
    // Linear mapping — Spek uses linear LUT without gamma
    const t = i / (steps - 1);
    const [r, g, b] = getColor(t, scheme);
    lut[i * 3]     = r;
    lut[i * 3 + 1] = g;
    lut[i * 3 + 2] = b;
  }
  return lut;
}

// ─── Dynamic freq marks based on nyquist ─────────────────────────────────────
function getFreqMarks(nyquist: number): number[] {
  const all = [
    20, 30, 50, 100, 200, 300, 500,
    1000, 2000, 3000, 5000, 8000, 10000,
    16000, 20000, 24000, 32000, 40000, 48000,
    64000, 88200, 96000, 176400, 192000,
  ];
  return all.filter(f => f <= nyquist);
}

// ─── Component ────────────────────────────────────────────────────────────────

// LFE channel gets special color treatment (bass-only visualization)
const LFE_CHANNEL_NAMES = new Set(["LFE", "LFE1", "LFE2"]);

export function SpectrogramCanvas({ data }: SpectrogramCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [scheme, setScheme] = useState<ColorScheme>("spek");
  const [freqScale, setFreqScale] = useState<"linear" | "log">("linear");
  const [selectedChannelIdx, setSelectedChannelIdx] = useState(0);

  // Active channel data (single channel or mixed)
  const activeChannel: SpectrogramChannel | null =
    data.channels && data.channels.length > 0
      ? data.channels[Math.min(selectedChannelIdx, data.channels.length - 1)]
      : null;

  const activeMagnitudes = activeChannel?.magnitudes ?? data.magnitudes;
  const _activeTimeSlices = activeChannel?.timeSlices ?? data.timeSlices; // kept for future use
  const activeMinDb = activeChannel?.minDb ?? data.minDb;
  const activeMaxDb = activeChannel?.maxDb ?? data.maxDb;
  // Number of freq bins in the active channel's magnitude slices
  const activeFreqBins = activeMagnitudes.length > 0 ? activeMagnitudes[0].length : data.freqBins;

  // Layout constants stored for hover math
  const plotMetaRef = useRef({ labelW: 52, labelH: 28, legendW: 48, plotW: 0, plotH: 0 });

  const drawSpectrogram = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const width = container.clientWidth;
    // Taller canvas = better freq resolution. 380px gives ~1.9px per FFT bin at 4096-pt.
    const height = 380;
    const dpr = window.devicePixelRatio || 1;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    // Layout
    const labelW = 52;  // left freq axis
    const labelH = 28;  // bottom time axis
    const legendW = 48; // right dB legend (bar + labels)
    const plotW = width - labelW - legendW;
    const plotH = height - labelH;

    plotMetaRef.current = { labelW, labelH, legendW, plotW, plotH };

    // Background
    ctx.fillStyle = "#04080f";
    ctx.fillRect(0, 0, width, height);

    const lutSteps = 512;
    // Always use a fixed 0 to -120 dBFS range like Spek, not auto-scaled.
    // Auto-scaling causes the entire canvas to map to a narrow noise-floor band.
    // The fixed dB range: top = 0 dBFS (loudest), bottom = -120 dBFS (silence).
    // The offset accounts for the FFT normalization convention used in audioAnalysis.ts.
    // Local test: full-scale sine with mag*2/(fftSize*0.5) gives -0.63 dBFS — correct.
    // But uniform-noise floor of a 24-bit/192kHz FLAC sits around -60 dBFS per bin,
    // so the dB scale is correct and green = noise floor of a high-res lossless file.
    const FIXED_MAX_DB = 0;
    const FIXED_MIN_DB = -120;
    const lut = buildColorLUT(FIXED_MIN_DB, FIXED_MAX_DB, scheme, lutSteps);
    const dbRange = FIXED_MAX_DB - FIXED_MIN_DB;

    const nyquist = data.sampleRate / 2;
    const minLogFreq = 20;
    const minFreqLog = Math.log10(minLogFreq);
    const maxFreqLog = Math.log10(nyquist);
    const logRange = maxFreqLog - minFreqLog;

    // Map each screen row → FFT bin. Linear is Spek-compatible default.
    const freqBinMap = new Int32Array(plotH);
    for (let py = 0; py < plotH; py++) {
      const yFrac = 1 - py / Math.max(1, plotH - 1);
      const freq = freqScale === "linear"
        ? yFrac * nyquist
        : Math.pow(10, minFreqLog + yFrac * logRange);
      freqBinMap[py] = Math.max(0, Math.min(
        Math.round((freq / nyquist) * (activeFreqBins - 1)),
        activeFreqBins - 1
      ));
    }

    // ── Render spectrogram pixels into an unscaled offscreen buffer ──
    // drawImage is used instead of putImageData on the main HiDPI-scaled canvas.
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = plotW;
    tempCanvas.height = plotH;
    const tempCtx = tempCanvas.getContext("2d");
    if (!tempCtx) return;
    const imgData = tempCtx.createImageData(plotW, plotH);
    const pixels = imgData.data;

    const numActiveSlices = activeMagnitudes.length;
    if (numActiveSlices === 0) {
      tempCtx.putImageData(imgData, 0, 0);
      ctx.drawImage(tempCanvas, labelW, 0, plotW, plotH);
    } else {

    for (let px = 0; px < plotW; px++) {
      // Map pixel column → fractional slice index with bilinear interpolation
      const slicePos = (px / Math.max(plotW - 1, 1)) * (numActiveSlices - 1);
      const sliceIdx = Math.floor(slicePos);
      const sliceFrac = slicePos - sliceIdx;
      const slice0 = activeMagnitudes[Math.min(sliceIdx, numActiveSlices - 1)];
      const slice1 = activeMagnitudes[Math.min(sliceIdx + 1, numActiveSlices - 1)];

      for (let py = 0; py < plotH; py++) {
        const bin = freqBinMap[py];
        const bin2 = Math.min(bin + 1, activeFreqBins - 1);

        // Bilinear interpolation: horizontal (time) + small vertical smooth
        const v00 = slice0[bin];
        const v10 = slice1[bin];
        const v01 = slice0[bin2];
        const v11 = slice1[bin2];
        // Horizontal lerp
        const vt = v00 + (v10 - v00) * sliceFrac;
        const vt2 = v01 + (v11 - v01) * sliceFrac;
        // Slight vertical smooth (weighted toward primary bin)
        const db = vt * 0.75 + vt2 * 0.25;

        // Map dB → LUT index using fixed 0 to -120 dBFS scale
        let lutIdx = Math.round(((db - FIXED_MIN_DB) / dbRange) * (lutSteps - 1));
        lutIdx = Math.max(0, Math.min(lutSteps - 1, lutIdx));

        const pxIdx = (py * plotW + px) * 4;
        pixels[pxIdx]     = lut[lutIdx * 3];
        pixels[pxIdx + 1] = lut[lutIdx * 3 + 1];
        pixels[pxIdx + 2] = lut[lutIdx * 3 + 2];
        pixels[pxIdx + 3] = 255;
      }
    }

    } // end if numActiveSlices > 0

    tempCtx.putImageData(imgData, 0, 0);
    ctx.drawImage(tempCanvas, labelW, 0, plotW, plotH);

    // ── Left freq axis background ──
    ctx.fillStyle = "rgba(4,8,15,0.92)";
    ctx.fillRect(0, 0, labelW, plotH);

    // ── Freq labels + grid lines ──
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = "right";

    const allFreqMarks = getFreqMarks(nyquist);
    const visibleMarks: { freq: number; y: number; label: string }[] = [];

    for (const freq of allFreqMarks) {
      const pos = freqScale === "linear"
        ? freq / nyquist
        : (Math.log10(Math.max(freq, minLogFreq)) - minFreqLog) / logRange;
      const y = plotH * (1 - pos);
      if (y < 0 || y > plotH) continue;
      const label = freq >= 1000
        ? `${freq % 1000 === 0 ? freq / 1000 : (freq / 1000).toFixed(1)}k`
        : `${freq}`;
      const last = visibleMarks[visibleMarks.length - 1];
      if (!last || Math.abs(y - last.y) >= 13) {
        visibleMarks.push({ freq, y, label });
      }
    }

    // Always force nyquist at top if space allows
    const topLabel = nyquist >= 1000
      ? `${(nyquist / 1000).toFixed(nyquist % 1000 === 0 ? 0 : 1)}k`
      : `${nyquist}`;
    if (!visibleMarks.some(m => m.freq === nyquist)) {
      visibleMarks.push({ freq: nyquist, y: 2, label: topLabel });
    }

    for (const { y, label } of visibleMarks) {
      ctx.fillStyle = "#c8ccd8";
      ctx.fillText(label, labelW - 5, y + 3);
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(labelW, y);
      ctx.lineTo(labelW + plotW, y);
      ctx.stroke();
    }

    // ── Bottom time axis ──
    ctx.fillStyle = "rgba(4,8,15,0.92)";
    ctx.fillRect(labelW, plotH, plotW, labelH);
    ctx.fillStyle = "#c8ccd8";
    ctx.textAlign = "center";
    ctx.font = '9px "JetBrains Mono", monospace';

    // Always show 0:00 at left and full duration at right
    const maxLabels = Math.min(8, Math.floor(plotW / 72));
    for (let i = 0; i <= maxLabels; i++) {
      const frac = i / maxLabels;
      const t = frac * data.duration;
      const x = labelW + frac * plotW;
      ctx.fillText(formatDuration(t), x, plotH + 17);
      // Tick
      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(x, plotH);
      ctx.lineTo(x, plotH + 4);
      ctx.stroke();
    }

    // ── Right dB legend ──
    const barW = 10;
    const barX = labelW + plotW + 20;
    const barH = plotH - 20;
    const barY = 10;

    for (let py = 0; py < barH; py++) {
      const t = 1 - py / barH;
      const lutIdx = Math.round(t * (lutSteps - 1));
      ctx.fillStyle = `rgb(${lut[lutIdx * 3]},${lut[lutIdx * 3 + 1]},${lut[lutIdx * 3 + 2]})`;
      ctx.fillRect(barX, barY + py, barW, 1);
    }
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 0.5;
    ctx.strokeRect(barX, barY, barW, barH);

    // dB tick labels beside bar — fixed 0 to -120 scale
    ctx.fillStyle = "#c8ccd8";
    ctx.font = '8px "JetBrains Mono", monospace';
    ctx.textAlign = "left";
    for (let db = 0; db >= FIXED_MIN_DB; db -= 20) {
      const frac = (db - FIXED_MIN_DB) / dbRange;
      const y = barY + barH - frac * barH;
      if (y < barY || y > barY + barH) continue;
      ctx.fillText(`${db}`, barX + barW + 3, y + 3);
    }

  }, [data, scheme, activeMagnitudes, activeMinDb, activeMaxDb, activeFreqBins]);

  useEffect(() => {
    drawSpectrogram();
    const onResize = () => drawSpectrogram();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [drawSpectrogram]);

  // ── Mouse hover ──
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      const tooltip = tooltipRef.current;
      if (!canvas || !tooltip) return;

      const rect = canvas.getBoundingClientRect();
      const { labelW, plotW, plotH } = plotMetaRef.current;
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      if (mx < labelW || mx > labelW + plotW || my < 0 || my > plotH) {
        tooltip.style.display = "none";
        return;
      }

      const nyquist = data.sampleRate / 2;
      const minLogFreq = 20;
      const minFreqLog = Math.log10(minLogFreq);
      const maxFreqLog = Math.log10(nyquist);

      const tFrac = (mx - labelW) / plotW;
      const timeS = tFrac * data.duration;
      const numSlices = activeMagnitudes.length;
      const sliceIdx = Math.min(Math.floor(tFrac * numSlices), numSlices - 1);

      const yFrac = 1 - my / plotH;
      const freq = freqScale === "linear"
        ? yFrac * nyquist
        : Math.pow(10, minFreqLog + yFrac * (maxFreqLog - minFreqLog));
      const freqBin = Math.min(
        Math.round((freq / nyquist) * (activeFreqBins - 1)),
        activeFreqBins - 1
      );
      const db = activeMagnitudes[sliceIdx]?.[freqBin] ?? activeMinDb;

      const freqLabel = freq >= 1000
        ? `${(freq / 1000).toFixed(3)} kHz`
        : `${Math.round(freq)} Hz`;
      const min = Math.floor(timeS / 60);
      const sec = (timeS % 60).toFixed(2).padStart(5, "0");

      tooltip.style.display = "block";
      tooltip.style.left = `${Math.min(mx + 12, rect.width - 165)}px`;
      tooltip.style.top = `${Math.max(my - 60, 4)}px`;
      tooltip.innerHTML = `<div style="font:10px 'JetBrains Mono',monospace;color:#2FE0DA;line-height:1.7;white-space:nowrap;">
        <div>freq:  ${freqLabel}</div>
        <div>time:  ${min}:${sec}</div>
        <div>level: ${db > -200 ? db.toFixed(1) + " dBFS" : "−∞ dBFS"}</div>
      </div>`;
    },
    [data, activeMagnitudes, activeMinDb, activeFreqBins]
  );

  const handleMouseLeave = useCallback(() => {
    if (tooltipRef.current) tooltipRef.current.style.display = "none";
  }, []);

  const nyquist = data.sampleRate / 2;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="liquid-card overflow-hidden p-4"
    >
      {/* Header row */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h3 className="text-[11px] font-mono text-primary/70 uppercase tracking-[0.2em]">
          Spectrogram
        </h3>
        <span className="text-[10px] font-mono text-muted-foreground/75 uppercase tracking-[0.15em]">
          {(data.sampleRate / 1000).toFixed(1)} kHz · {nyquist >= 1000 ? `${(nyquist / 1000).toFixed(1)} kHz` : `${nyquist} Hz`} max · {data.freqBins * 2}-pt FFT · {freqScale === "linear" ? "Linear" : "Log"} scale
        </span>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-[0.15em]">Scale:</span>
          <select
            value={freqScale}
            onChange={e => setFreqScale(e.target.value as "linear" | "log")}
            className="rounded border border-border/40 bg-background/60 px-2 py-0.5 text-[10px] font-mono text-muted-foreground/80 uppercase tracking-[0.1em] focus:outline-none focus:ring-1 focus:ring-primary/30 cursor-pointer"
          >
            <option value="linear">Linear</option>
            <option value="log">Log</option>
          </select>
        </div>

        {/* Color scheme dropdown */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-[0.15em]">Palette:</span>
          <select
            value={scheme}
            onChange={e => setScheme(e.target.value as ColorScheme)}
            className="rounded border border-border/40 bg-background/60 px-2 py-0.5 text-[10px] font-mono text-muted-foreground/80 uppercase tracking-[0.1em] focus:outline-none focus:ring-1 focus:ring-primary/30 cursor-pointer"
          >
            {COLOR_SCHEMES.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <div
            className="h-3 w-20 rounded-sm border border-border/30"
            style={{ background: COLOR_SCHEMES.find(s => s.value === scheme)?.preview }}
          />
        </div>
      </div>

      {/* Per-channel tabs — shown for multichannel (>2) files */}
      {data.channels && data.channels.length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {data.channels.map((ch, idx) => {
            const isLFE = LFE_CHANNEL_NAMES.has(ch.name);
            const isActive = idx === selectedChannelIdx;
            return (
              <button
                key={idx}
                onClick={() => setSelectedChannelIdx(idx)}
                className={`rounded px-2.5 py-1 text-[10px] font-mono uppercase tracking-[0.15em] transition-all border ${
                  isActive
                    ? isLFE
                      ? "border-[#F97316]/50 bg-[#F97316]/10 text-[#F97316]"
                      : "border-[#2FE0DA]/50 bg-[#2FE0DA]/10 text-[#2FE0DA]"
                    : "border-border/30 bg-transparent text-muted-foreground/60 hover:text-muted-foreground/90 hover:border-border/50"
                }`}
              >
                {ch.name}
                {isLFE && <span className="ml-1 opacity-60">(bass)</span>}
              </button>
            );
          })}
          <span className="ml-2 text-[10px] font-mono text-muted-foreground/50">
            {data.numChannels}ch · {activeChannel?.name}
          </span>
        </div>
      )}

      {/* Canvas */}
      <div ref={containerRef} className="relative w-full rounded overflow-hidden">
        <canvas
          ref={canvasRef}
          className="w-full cursor-crosshair block"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        />
        {/* Hover tooltip */}
        <div
          ref={tooltipRef}
          className="pointer-events-none absolute hidden rounded border border-white/10 bg-black/88 px-2.5 py-1.5 backdrop-blur-sm"
          style={{ zIndex: 20 }}
        />
      </div>

      {/* Bottom legend */}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-1.5">
        {COLOR_SCHEMES.find(s => s.value === scheme) && (
          <>
            <div className="flex items-center gap-1.5">
              <div
                className="h-2 w-24 rounded-sm border border-border/20"
                style={{ background: COLOR_SCHEMES.find(s => s.value === scheme)!.preview }}
              />
              <span className="text-[10px] font-mono text-muted-foreground/80 uppercase tracking-[0.15em]">
                {COLOR_SCHEMES.find(s => s.value === scheme)!.label}
              </span>
            </div>
            <span className="text-[10px] font-mono text-muted-foreground/80 uppercase tracking-[0.15em]">
              Low → High energy
            </span>
          </>
        )}
        <span className="ml-auto text-[10px] font-mono text-muted-foreground/60 uppercase tracking-[0.15em]">
          Hover: freq · time · dBFS
        </span>
      </div>
    </motion.div>
  );
}
