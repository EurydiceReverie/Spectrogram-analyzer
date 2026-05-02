import { motion } from "framer-motion";
import type { FakeDetectionResult } from "@/lib/audioAnalysis";
import { formatFrequency } from "@/lib/audioAnalysis";

interface VerdictCardProps {
  detection: FakeDetectionResult;
  format: string;
}

// ── Verdict color system ─────────────────────────────────────────────
// genuine      → #2FE0DA teal   — file is authentic, no issues
// inconclusive → #A78BFA purple — some signals but not enough to flag
// suspicious   → #F97316 orange — something looks off, not conclusive
// fake         → #EF4444 red    — confirmed lossy transcoding / fraud
// defective    → #F97316 orange — header mismatch / truncated audio
// ─────────────────────────────────────────────────────────────────────
const verdictStyles = {
  genuine: {
    bg: "bg-[rgba(47,224,218,0.07)]",
    border: "border-[rgba(47,224,218,0.28)]",
    text: "text-[#2FE0DA]",
    glow: "shadow-[0_0_30px_rgba(47,224,218,0.10)]",
  },
  fake: {
    bg: "bg-[rgba(239,68,68,0.07)]",
    border: "border-[rgba(239,68,68,0.28)]",
    text: "text-[#EF4444]",
    glow: "shadow-[0_0_30px_rgba(239,68,68,0.10)]",
  },
  suspicious: {
    bg: "bg-[rgba(249,115,22,0.07)]",
    border: "border-[rgba(249,115,22,0.28)]",
    text: "text-[#F97316]",
    glow: "shadow-[0_0_30px_rgba(249,115,22,0.10)]",
  },
  inconclusive: {
    bg: "bg-[rgba(167,139,250,0.07)]",
    border: "border-[rgba(167,139,250,0.28)]",
    text: "text-[#A78BFA]",
    glow: "shadow-[0_0_30px_rgba(167,139,250,0.10)]",
  },
  defective: {
    bg: "bg-[rgba(249,115,22,0.07)]",
    border: "border-[rgba(249,115,22,0.28)]",
    text: "text-[#F97316]",
    glow: "shadow-[0_0_30px_rgba(249,115,22,0.10)]",
  },
};

export function VerdictCard({ detection, format }: VerdictCardProps) {
  const style = verdictStyles[detection.verdict];

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
      className={`liquid-card ${style.bg} ${style.glow} border ${style.border} p-6`}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        {/* Verdict */}
        <div className="flex items-center gap-4">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.2, type: "spring", stiffness: 200 }}
            className={`flex h-14 w-14 items-center justify-center rounded-2xl ${style.bg} border ${style.border}`}
          >
            <span className={`text-2xl font-bold ${style.text}`}>
              {detection.verdict === "genuine" ? "✓" : detection.verdict === "fake" ? "✗" : detection.verdict === "inconclusive" ? "?" : "⚠"}
            </span>
          </motion.div>
          <div>
            <h3 className={`mono-text text-xl font-bold ${style.text}`}>
              {detection.verdictLabel}
            </h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {detection.verdict === "genuine"
                ? `${format} — No lossy transcoding detected`
                : detection.verdict === "inconclusive"
                ? `Some signals detected but not conclusive — ${format}`
                : detection.details}
            </p>
          </div>
        </div>

        {/* Stats */}
        <div className="flex gap-6">
          {detection.actualBitrate && (
            <div className="text-right">
              <p className="mono-text text-xs uppercase tracking-wider text-muted-foreground">
                Actual Bitrate
              </p>
              <p className={`mono-text text-lg font-bold ${style.text}`}>
                ~{detection.actualBitrate} kbps
              </p>
            </div>
          )}
          <div className="text-right">
            <p className="mono-text text-xs uppercase tracking-wider text-muted-foreground">
              Claimed Bitrate
            </p>
            <p className="mono-text text-lg font-bold text-foreground">
              {detection.claimedBitrate} kbps
            </p>
          </div>
          <div className="text-right">
            <p className="mono-text text-xs uppercase tracking-wider text-muted-foreground">
              Freq Cutoff
            </p>
            <p className="mono-text text-lg font-bold text-foreground">
              {formatFrequency(detection.frequencyCutoff)}
            </p>
          </div>
          {detection.cutoffSlopeDbPerOct < 0 && detection.frequencyCutoff > 0 && (
            <div className="text-right">
              <p className="mono-text text-xs uppercase tracking-wider text-muted-foreground">
                Edge Slope
              </p>
              <p className={`mono-text text-lg font-bold ${Math.abs(detection.cutoffSlopeDbPerOct) > 60 ? style.text : "text-foreground"}`}>
                {detection.cutoffSlopeDbPerOct.toFixed(0)} dB/oct
              </p>
            </div>
          )}
          {detection.cutoffStabilityHz > 0 && detection.frequencyCutoff > 0 && (
            <div className="text-right">
              <p className="mono-text text-xs uppercase tracking-wider text-muted-foreground">
                Cutoff σ
              </p>
              <p className={`mono-text text-lg font-bold ${detection.cutoffStabilityHz < 200 ? style.text : "text-foreground"}`}>
                {detection.cutoffStabilityHz.toFixed(0)} Hz
              </p>
            </div>
          )}
          {detection.energyAboveCutoffDb > -120 && detection.frequencyCutoff > 0 && (
            <div className="text-right">
              <p className="mono-text text-xs uppercase tracking-wider text-muted-foreground">
                HF Energy
              </p>
              <p className={`mono-text text-lg font-bold ${detection.energyAboveCutoffDb < -85 ? style.text : detection.energyAboveCutoffDb > -55 ? "text-[#2FE0DA]" : "text-foreground"}`}>
                {detection.energyAboveCutoffDb.toFixed(0)} dB
              </p>
            </div>
          )}
          {detection.confidence > 0 && (
            <div className="text-right">
              <p className="mono-text text-xs uppercase tracking-wider text-muted-foreground">
                Confidence
              </p>
              <p className={`mono-text text-lg font-bold ${style.text}`}>
                {detection.confidence}%
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Reasons list */}
      {detection.reasons.length > 0 && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          transition={{ delay: 0.4, duration: 0.4 }}
          className="mt-4 border-t border-border/20 pt-3"
        >
          <ul className="space-y-1">
            {detection.reasons.map((reason, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                <span className={`mt-0.5 ${style.text}`}>•</span>
                {reason}
              </li>
            ))}
          </ul>
        </motion.div>
      )}
    </motion.div>
  );
}
