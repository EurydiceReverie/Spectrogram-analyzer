import { useEffect, useRef, useCallback } from "react";
import { motion } from "framer-motion";

interface WaveformCanvasProps {
  waveformData: Float32Array;
  duration: number;
  sampleRate: number;
  rmsLevel: number;
  truePeak: number;
}

// Bar color by amplitude intensity:
// 0–60%  → #2FE0DA teal  (safe)
// 60–85% → orange         (hot)
// 85–100%→ red            (clip risk)
function ampToColor(amp: number): string {
  const t = Math.min(1, Math.max(0, amp));
  if (t < 0.6) {
    const s = t / 0.6;
    const r = Math.round(20 + 27 * s);
    const g = Math.round(180 + 44 * s);
    const b = Math.round(180 + 38 * s);
    return `rgba(${r},${g},${b},0.88)`;
  } else if (t < 0.85) {
    const s = (t - 0.6) / 0.25;
    const r = Math.round(47 + 202 * s);
    const g = Math.round(224 - 109 * s);
    const b = Math.round(218 - 196 * s);
    return `rgba(${r},${g},${b},0.88)`;
  } else {
    const s = (t - 0.85) / 0.15;
    const r = Math.round(249 - 10 * s);
    const g = Math.round(115 - 47 * s);
    const b = Math.round(22 + 46 * s);
    return `rgba(${r},${g},${b},0.88)`;
  }
}

export function WaveformCanvas({ waveformData, duration, sampleRate, rmsLevel, truePeak }: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || waveformData.length === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const width = container.clientWidth;
    const height = 96;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const labelW = 40;
    const plotW = width - labelW;
    const midY = height / 2;

    // Background
    ctx.fillStyle = "#050a10";
    ctx.fillRect(0, 0, width, height);

    // Left label background
    ctx.fillStyle = "rgba(5,10,16,0.92)";
    ctx.fillRect(0, 0, labelW, height);

    // Centre line
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(labelW, midY); ctx.lineTo(width, midY); ctx.stroke();

    // RMS dashed reference line
    const rmsLin = Math.pow(10, rmsLevel / 20);
    const rmsY = midY - rmsLin * midY * 0.9;
    ctx.strokeStyle = "rgba(47,224,218,0.35)";
    ctx.lineWidth = 0.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(labelW, rmsY); ctx.lineTo(width, rmsY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(labelW, height - rmsY); ctx.lineTo(width, height - rmsY); ctx.stroke();
    ctx.setLineDash([]);

    // 0 dBFS clip line
    const clipY = midY * 0.05;
    ctx.strokeStyle = "rgba(239,68,68,0.38)";
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(labelW, clipY); ctx.lineTo(width, clipY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(labelW, height - clipY); ctx.lineTo(width, height - clipY); ctx.stroke();

    // Stereo split lanes. waveformData format per bar: [Lmax, Lmin, Rmax, Rmin]
    const dataBars = Math.floor(waveformData.length / 4);
    const numBars = Math.min(dataBars, Math.max(1, Math.floor(plotW)));
    const barW = plotW / numBars;
    const gap = barW > 3 ? 0.2 : 0;
    const laneGap = 4;
    const laneH = (height - laneGap) / 2;
    const leftMid = laneH / 2;
    const rightMid = laneH + laneGap + laneH / 2;

    // lane midlines
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(labelW, leftMid); ctx.lineTo(width, leftMid);
    ctx.moveTo(labelW, rightMid); ctx.lineTo(width, rightMid);
    ctx.stroke();

    for (let i = 0; i < numBars; i++) {
      const dataIdx = Math.min(Math.floor((i / numBars) * dataBars), dataBars - 1) * 4;
      const lMax = waveformData[dataIdx] || 0;
      const lMin = waveformData[dataIdx + 1] || 0;
      const rMax = waveformData[dataIdx + 2] || 0;
      const rMin = waveformData[dataIdx + 3] || 0;
      const x = labelW + i * barW;
      const bw = Math.max(1, barW * (1 - gap));

      const lTop = leftMid - lMax * leftMid * 0.92;
      const lBottom = leftMid - lMin * leftMid * 0.92;
      const lAmp = Math.max(Math.abs(lMax), Math.abs(lMin));
      ctx.fillStyle = ampToColor(lAmp);
      ctx.fillRect(x, lTop, bw, Math.max(1, lBottom - lTop));

      const rTop = rightMid - rMax * leftMid * 0.92;
      const rBottom = rightMid - rMin * leftMid * 0.92;
      const rAmp = Math.max(Math.abs(rMax), Math.abs(rMin));
      ctx.fillStyle = ampToColor(rAmp).replace("0.88", "0.72");
      ctx.fillRect(x, rTop, bw, Math.max(1, rBottom - rTop));
    }

    // dB scale labels — drawn AFTER bars so they sit on top of the label bg
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = "right";

    // Draw top half labels (positive y-axis = negative dBFS)
    const dbMarks = [0, -6, -12, -18, -24];
    let lastLabelY = -999;
    for (const db of dbMarks) {
      const lin = db === 0 ? 1 : Math.pow(10, db / 20);
      const y = midY - lin * midY * 0.92;
      // Skip if too close to previous label
      if (y - lastLabelY < 10) continue;
      ctx.fillStyle = db === 0 ? "rgba(239,68,68,0.75)" : "rgba(200,200,210,0.75)";
      ctx.fillText(db === 0 ? "0" : `${db}`, labelW - 4, y + 3);
      lastLabelY = y;
    }
  }, [waveformData, rmsLevel]);

  useEffect(() => {
    draw();
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [draw]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      const tooltip = tooltipRef.current;
      const container = containerRef.current;
      if (!canvas || !tooltip || !container) return;

      const rect = canvas.getBoundingClientRect();
      const labelW = 40;
      const plotW = rect.width - labelW;
      const x = e.clientX - rect.left;

      if (x < labelW || x > rect.width) { tooltip.style.display = "none"; return; }

      const tFrac = (x - labelW) / plotW;
      const timeS = tFrac * duration;
      const dataBars = Math.floor(waveformData.length / 4);
      const idx = Math.min(Math.floor(tFrac * dataBars), dataBars - 1) * 4;
      const leftPeak = Math.max(Math.abs(waveformData[idx] || 0), Math.abs(waveformData[idx + 1] || 0));
      const rightPeak = Math.max(Math.abs(waveformData[idx + 2] || 0), Math.abs(waveformData[idx + 3] || 0));
      const db = 20 * Math.log10(Math.max(leftPeak, rightPeak) + 1e-10);
      const min = Math.floor(timeS / 60);
      const sec = (timeS % 60).toFixed(2).padStart(5, "0");

      tooltip.style.display = "block";
      tooltip.style.left = `${Math.min(x + 10, rect.width - 150)}px`;
      tooltip.style.top = "4px";
      tooltip.innerHTML = `<div style="font:10px 'JetBrains Mono',monospace;color:#2FE0DA;line-height:1.65;">
        <div>time: ${min}:${sec}</div>
        <div>peak: ${db > -200 ? db.toFixed(1) + " dBFS" : "−∞"}</div>
      </div>`;
    },
    [waveformData, duration]
  );

  const handleMouseLeave = useCallback(() => {
    if (tooltipRef.current) tooltipRef.current.style.display = "none";
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.1 }}
      className="liquid-card overflow-hidden p-4"
    >
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        {/* Title — JetBrains Mono 10px, primary/50, uppercase, tracking 0.2em */}
        <h3 className="text-[11px] font-mono text-primary/70 uppercase tracking-[0.2em]">
          Waveform
        </h3>
        <span className="text-[10px] font-mono text-muted-foreground/75 uppercase tracking-[0.15em]">
          {(sampleRate / 1000).toFixed(1)} kHz · Peak {truePeak <= 0 ? truePeak.toFixed(2) : `+${truePeak.toFixed(2)}`} dBFS
        </span>
      </div>

      {/* Canvas */}
      <div ref={containerRef} className="relative w-full rounded overflow-hidden">
        <canvas
          ref={canvasRef}
          className="w-full cursor-crosshair"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        />
        <div
          ref={tooltipRef}
          className="pointer-events-none absolute hidden rounded border border-white/10 bg-black/85 px-2.5 py-1.5 backdrop-blur-sm"
          style={{ zIndex: 10 }}
        />
      </div>

      {/* Legend */}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-1.5">
        <div className="flex items-center gap-1.5">
          <div className="h-2 w-6 rounded-sm" style={{ background: "linear-gradient(90deg,#14b4b0,#2FE0DA)" }} />
          <span className="text-[10px] font-mono text-muted-foreground/80 uppercase tracking-[0.15em]">Safe</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-2 w-6 rounded-sm" style={{ background: "linear-gradient(90deg,#2FE0DA,#F97316)" }} />
          <span className="text-[10px] font-mono text-muted-foreground/80 uppercase tracking-[0.15em]">Hot</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-2 w-6 rounded-sm" style={{ background: "linear-gradient(90deg,#F97316,#EF4444)" }} />
          <span className="text-[10px] font-mono text-muted-foreground/80 uppercase tracking-[0.15em]">Clip risk</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-0.5 w-6 border-t border-dashed" style={{ borderColor: "rgba(47,224,218,0.7)" }} />
          <span className="text-[10px] font-mono text-muted-foreground/80 uppercase tracking-[0.15em]">RMS</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-0.5 w-6 border-t border-dashed" style={{ borderColor: "rgba(239,68,68,0.7)" }} />
          <span className="text-[10px] font-mono text-muted-foreground/80 uppercase tracking-[0.15em]">0 dBFS</span>
        </div>
      </div>
    </motion.div>
  );
}
