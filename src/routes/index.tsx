import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { HeroSection } from "@/components/HeroSection";
import { FileUpload } from "@/components/FileUpload";
import { AnalysisResults } from "@/components/AnalysisResults";
import { analyzeAudio, type AnalysisResult } from "@/lib/audioAnalysis";
import MpeghDecoderDialog, { type MpeghDecoderChoice } from "@/components/MpeghDecoderDialog";
import { parseSpatialMetadata, type SpatialMetadata } from "@/lib/useSpatialMetadata";
import { BrowserCodecInfo } from "@/components/BrowserCodecInfo";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [decodeProgress, setDecodeProgress] = useState(0);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spatialMeta, setSpatialMeta] = useState<SpatialMetadata | null>(null);

  // MPEG-H decoder dialog state
  const [decoderDialogOpen, setDecoderDialogOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingFileInfo, setPendingFileInfo] = useState<{ channels: number; sampleRate: number } | null>(null);
  const decoderResolveRef = useRef<((choice: MpeghDecoderChoice | null) => void) | null>(null);

  /** Returns true if the file is a Sony 360 RA / MPEG-H file that needs decoder selection */
  const is360RAFile = (file: File) => {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    // Direct MPEG-H extensions (.mha1, .mhm1, .mhas), OR m4a/mp4 detected as 360RA
    return ["mha1", "mhm1", "mhas"].includes(ext)
      || file.type === "audio/mha1"
      || file.type === "audio/mhm1";
  };

  /** Show decoder dialog and wait for user choice. Returns null if cancelled. */
  const askDecoderChoice = (file: File, channels: number, sampleRate: number): Promise<MpeghDecoderChoice | null> => {
    return new Promise((resolve) => {
      decoderResolveRef.current = resolve;
      setPendingFile(file);
      setPendingFileInfo({ channels, sampleRate });
      setDecoderDialogOpen(true);
    });
  };

  const handleDecoderSelect = (choice: MpeghDecoderChoice) => {
    setDecoderDialogOpen(false);
    decoderResolveRef.current?.(choice);
    decoderResolveRef.current = null;
  };

  const handleDecoderCancel = () => {
    setDecoderDialogOpen(false);
    decoderResolveRef.current?.(null);
    decoderResolveRef.current = null;
    setIsAnalyzing(false);
    setPendingFile(null);
  };

  const handleFileSelect = useCallback(async (file: File) => {
    setIsAnalyzing(true);
    setError(null);
    setResult(null);
    setSpatialMeta(null);
    setProgress(0);
    setDecodeProgress(0);

    try {
      // For 360 RA files, detect channels from file name / sniff header, then show dialog
      let mpeghDecoderChoice: MpeghDecoderChoice = "ittiam";

      // Parse native file info — this properly detects MHA1/MHM1 even when
      // the stsd box is deep in the file (fragmented MP4 layout).
      const { parseNativeFileInfo } = await import("@/lib/audioAnalysis");
      const nativeInfo = await parseNativeFileInfo(file);

      // Check for 360RA: from extension, file type, OR from binary box parser
      // This correctly handles .m4a files containing mha1/mhm1 codec inside
      const looks360RA = is360RAFile(file) || nativeInfo?.is360RA === true;
      console.log(`[Index] File: ${file.name}, looks360RA: ${looks360RA}, nativeInfo?.is360RA: ${nativeInfo?.is360RA}`);

      if (looks360RA) {
        const channels   = nativeInfo?.channels   ?? 24;
        const sampleRate = nativeInfo?.sampleRate ?? 48000;
        const choice = await askDecoderChoice(file, channels, sampleRate);
        if (choice === null) return; // user cancelled
        mpeghDecoderChoice = choice;

        // Parse spatial metadata in parallel (non-blocking)
        file.arrayBuffer().then((buf) => {
          const meta = parseSpatialMetadata(buf);
          setSpatialMeta(meta);
        });
      }

      const analysisResult = await analyzeAudio(
        file,
        (p) => setProgress(p),
        {
          mpeghDecoderChoice,
          onDecodeProgress: (pct) => setDecodeProgress(pct),
        },
      );
      setResult(analysisResult);

      // If spatial meta not yet set, try again from decoded nativeInfo
      if (!spatialMeta && analysisResult.nativeInfo?.is360RA) {
        file.arrayBuffer().then((buf) => {
          const meta = parseSpatialMetadata(buf);
          setSpatialMeta(meta);
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to analyze audio file");
    } finally {
      setIsAnalyzing(false);
      setPendingFile(null);
    }
  }, []);

  return (
    <div className="min-h-screen bg-gradient-navy">
      <BrowserCodecInfo />
      <div className="mx-auto max-w-5xl px-4 pb-16">
        <HeroSection />
        <FileUpload onFileSelect={handleFileSelect} isAnalyzing={isAnalyzing} progress={progress} />

        {/* MPEG-H / 360 RA decode progress bar — shown while Worker is decoding */}
        <AnimatePresence>
          {isAnalyzing && decodeProgress > 0 && decodeProgress < 100 && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-4 rounded-lg border bg-card px-4 py-3 space-y-1.5"
            >
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="text-sm">🎵</span>
                  Decoding MPEG-H 3D Audio / Sony 360 Reality Audio…
                </span>
                <span className="font-mono font-medium text-foreground">{decodeProgress}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <motion.div
                  className="h-full rounded-full bg-gradient-to-r from-orange-500 via-amber-400 to-yellow-300"
                  initial={{ width: "0%" }}
                  animate={{ width: `${decodeProgress}%` }}
                  transition={{ ease: "easeOut", duration: 0.3 }}
                />
              </div>
              <p className="text-xs text-muted-foreground/70">
                All channels preserved — no downsampling or mixing
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Decoder selection dialog for Sony 360 RA / MPEG-H files */}
        <MpeghDecoderDialog
          open={decoderDialogOpen}
          fileName={pendingFile?.name ?? ""}
          channels={pendingFileInfo?.channels ?? 24}
          sampleRate={pendingFileInfo?.sampleRate ?? 48000}
          onSelect={handleDecoderSelect}
          onCancel={handleDecoderCancel}
        />

        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="liquid-card mt-6 border-coral/30 p-4 text-center text-sm text-coral"
            >
              {error}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {result && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
              className="mt-8"
            >
              <AnalysisResults result={result} spatialMeta={spatialMeta} />
            </motion.div>
          )}
        </AnimatePresence>

        <motion.footer
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1 }}
          className="mt-16 border-t border-border/50 pt-6 text-center"
        >
          <p className="mono-text text-xs text-muted-foreground">
            Audio Veritas · WebAssembly analysis · No files uploaded to servers
          </p>
        </motion.footer>
      </div>
    </div>
  );
}
