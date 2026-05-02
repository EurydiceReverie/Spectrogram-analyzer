import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Cpu, X, CheckCircle, XCircle, AlertCircle } from "lucide-react";

interface CodecSupport {
  label: string;
  mime: string;
  description: string;
  category: "dolby" | "spatial" | "lossless" | "lossy";
}

const CODECS_TO_CHECK: CodecSupport[] = [
  // Dolby — check both bare stream AND MP4 container MIMEs
  { label: "AC-3 bare (.ac3)",           mime: 'audio/ac-3',                    description: "Dolby Digital bare stream",     category: "dolby" },
  { label: "AC-3 in MP4 (.m4a)",         mime: 'audio/mp4; codecs="ac-3"',      description: "AC-3 in M4A container ← used",  category: "dolby" },
  { label: "E-AC-3 bare (.ec3/.eac3)",   mime: 'audio/ec-3',                    description: "Dolby Digital Plus bare stream", category: "dolby" },
  { label: "E-AC-3 in MP4 (.m4a)",       mime: 'audio/mp4; codecs="ec-3"',      description: "E-AC-3 in M4A container ← used",category: "dolby" },
  { label: "AC-4 / IMS in MP4 (.m4a)",   mime: 'audio/mp4; codecs="ac-4"',      description: "Dolby AC-4 / Atmos IMS",        category: "dolby" },
  // Spatial — decoded via WASM (Fraunhofer/Ittiam) regardless of MSE support
  { label: "MPEG-H mha1 (MSE)",          mime: 'audio/mp4; codecs="mha1"',      description: "360RA — WASM decoder used",     category: "spatial" },
  { label: "MPEG-H mhm1 (MSE)",          mime: 'audio/mp4; codecs="mhm1"',      description: "360RA — WASM decoder used",     category: "spatial" },
  // Lossless
  { label: "FLAC (in MP4)",              mime: 'audio/mp4; codecs="flac"',      description: "FLAC in MP4 — WASM decoder",    category: "lossless" },
  { label: "ALAC (in MP4)",              mime: 'audio/mp4; codecs="alac"',      description: "Apple Lossless — WASM decoder", category: "lossless" },
  { label: "FLAC (native)",              mime: 'audio/flac',                    description: "FLAC native — WASM decoder",    category: "lossless" },
  // Lossy / standard
  { label: "AAC-LC (in MP4)",            mime: 'audio/mp4; codecs="mp4a.40.2"', description: "AAC-LC — FFmpeg WASM",          category: "lossy" },
  { label: "MP3",                        mime: 'audio/mpeg',                    description: "MPEG-1 Layer 3 — mpg123 WASM",  category: "lossy" },
  { label: "Opus (in OGG)",              mime: 'audio/ogg; codecs="opus"',      description: "Opus — libopus WASM",           category: "lossy" },
  { label: "Vorbis (in OGG)",            mime: 'audio/ogg; codecs="vorbis"',    description: "Vorbis — libvorbis WASM",       category: "lossy" },
  { label: "Opus (in WebM)",             mime: 'audio/webm; codecs="opus"',     description: "Opus in WebM container",        category: "lossy" },
];

type SupportLevel = "yes" | "probably" | "no" | "unknown";

function checkMSESupport(mime: string): SupportLevel {
  if (!window.MediaSource) return "unknown";
  try {
    if (MediaSource.isTypeSupported(mime)) return "yes";
    return "no";
  } catch { return "unknown"; }
}

function checkAudioSupport(mime: string): SupportLevel {
  try {
    const a = document.createElement("audio");
    const result = a.canPlayType(mime);
    if (result === "probably") return "probably";
    if (result === "maybe") return "yes";
    return "no";
  } catch { return "unknown"; }
}

const categoryColors: Record<string, string> = {
  dolby:    "text-orange-400",
  spatial:  "text-orange-400",
  lossless: "text-blue-400",
  lossy:    "text-green-400",
};

const categoryLabels: Record<string, string> = {
  dolby:    "Dolby Codecs",
  spatial:  "Spatial Audio",
  lossless: "Lossless",
  lossy:    "Lossy / Standard",
};

export function BrowserCodecInfo() {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Record<string, { mse: SupportLevel; audio: SupportLevel }>>({});

  useEffect(() => {
    if (!open) return;
    const map: Record<string, { mse: SupportLevel; audio: SupportLevel }> = {};
    for (const c of CODECS_TO_CHECK) {
      map[c.mime] = {
        mse:   checkMSESupport(c.mime),
        audio: checkAudioSupport(c.mime),
      };
    }
    setResults(map);
  }, [open]);

  const browserName = (() => {
    const ua = navigator.userAgent;
    if (ua.includes("Edg/"))    return "Edge";
    if (ua.includes("Chrome/")) return "Chrome";
    if (ua.includes("Firefox/"))return "Firefox";
    if (ua.includes("Safari/") && !ua.includes("Chrome")) return "Safari";
    return "Browser";
  })();

  const dolbySupported = CODECS_TO_CHECK
    .filter(c => c.category === "dolby")
    .some(c => results[c.mime]?.mse === "yes");

  const categories = ["dolby", "spatial", "lossless", "lossy"] as const;

  return (
    <>
      {/* Floating button — top right */}
      <button
        onClick={() => setOpen(true)}
        className="fixed top-4 right-4 z-50 flex items-center gap-2 rounded-full bg-zinc-800/90 border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 hover:text-white transition-all shadow-lg backdrop-blur-sm"
        title="Browser codec support"
      >
        <Cpu className="h-3.5 w-3.5 text-blue-400" />
        <span>{browserName} Codec Support</span>
        {/* Dot indicator */}
        <span className={`h-2 w-2 rounded-full ${dolbySupported ? "bg-green-400" : "bg-orange-400"}`} />
      </button>

      {/* Overlay */}
      <AnimatePresence>
        {open && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
              onClick={() => setOpen(false)}
            />
            {/* Panel */}
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: -10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -10 }}
              transition={{ duration: 0.18 }}
              className="fixed top-14 right-4 z-50 w-[420px] max-h-[80vh] overflow-y-auto rounded-xl bg-zinc-900 border border-zinc-700 shadow-2xl"
            >
              {/* Header */}
              <div className="flex items-center justify-between p-4 border-b border-zinc-800">
                <div>
                  <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                    <Cpu className="h-4 w-4 text-blue-400" />
                    {browserName} — Codec Support
                  </h2>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    MSE = MediaSource decode (used for Dolby) · Audio = HTML5 canPlayType
                  </p>
                </div>
                <button onClick={() => setOpen(false)} className="text-zinc-500 hover:text-white transition-colors">
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Dolby warning */}
              {!dolbySupported && (
                <div className="mx-4 mt-3 p-3 rounded-lg bg-orange-900/30 border border-orange-700/50 text-xs text-orange-300">
                  <AlertCircle className="h-3.5 w-3.5 inline mr-1.5 -mt-0.5" />
                  <strong>Dolby not supported natively.</strong> AC-3/E-AC-3/AC-4 files will show metadata only — no waveform/spectrogram. Use Chrome or Edge for full Dolby support.
                </div>
              )}

              {/* Codec list by category */}
              <div className="p-4 space-y-5">
                {categories.map(cat => {
                  const codecs = CODECS_TO_CHECK.filter(c => c.category === cat);
                  return (
                    <div key={cat}>
                      <h3 className={`text-xs font-semibold uppercase tracking-wider mb-2 ${categoryColors[cat]}`}>
                        {categoryLabels[cat]}
                      </h3>
                      <div className="space-y-1.5">
                        {codecs.map(c => {
                          const r = results[c.mime] ?? { mse: "unknown" as SupportLevel, audio: "unknown" as SupportLevel };
                          const supported = r.mse === "yes" || r.audio === "probably" || r.audio === "yes";
                          const partial = r.mse === "unknown" && r.audio === "yes";
                          return (
                            <div key={c.mime} className="flex items-center justify-between rounded-lg bg-zinc-800/60 px-3 py-2">
                              <div>
                                <p className="text-xs font-medium text-zinc-200">{c.label}</p>
                                <p className="text-[10px] text-zinc-500">{c.description}</p>
                              </div>
                              <div className="flex items-center gap-2 shrink-0 ml-3">
                                {/* MSE badge */}
                                <div className={`text-[10px] px-1.5 py-0.5 rounded font-mono border
                                  ${r.mse === "yes" ? "border-green-600 bg-green-900/30 text-green-400"
                                    : r.mse === "no" ? "border-red-800 bg-red-900/20 text-red-400"
                                    : "border-zinc-700 bg-zinc-800 text-zinc-500"}`}>
                                  MSE: {r.mse}
                                </div>
                                {/* Icon */}
                                {supported ? (
                                  <CheckCircle className="h-4 w-4 text-green-400 shrink-0" />
                                ) : partial ? (
                                  <AlertCircle className="h-4 w-4 text-yellow-400 shrink-0" />
                                ) : (
                                  <XCircle className="h-4 w-4 text-red-400 shrink-0" />
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* WASM always-works note */}
              <div className="mx-4 mb-3 p-3 rounded-lg bg-blue-900/20 border border-blue-700/30 text-xs text-blue-300">
                <strong>✅ Always works via WASM (browser-independent):</strong><br />
                FLAC · WAV · AIFF · MP3 · OGG · Opus · ALAC · MPEG-H/360RA (Fraunhofer/Ittiam)
              </div>
              {/* Footer note */}
              <div className="px-4 pb-4">
                <p className="text-[10px] text-zinc-600">
                  Dolby AC-3/E-AC-3 in MP4: Chrome ✅ Edge ✅ Firefox ❌ Safari ❌ · AC-4/IMS: Edge (Windows) ✅ Chrome 122+ ✅ · Bare .ac3/.ec3 files: tries MP4 container MIME as fallback for Edge.
                </p>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
