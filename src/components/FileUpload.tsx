import { useCallback, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface FileUploadProps {
  onFileSelect: (file: File) => void;
  isAnalyzing: boolean;
  progress: number;
}

export function FileUpload({ onFileSelect, isAnalyzing, progress }: FileUploadProps) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) onFileSelect(file);
    },
    [onFileSelect]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) onFileSelect(file);
    },
    [onFileSelect]
  );

  const statusText =
    progress < 8  ? "Reading file header..." :
    progress < 12 ? "Loading WASM decoder..." :
    progress < 28 ? "Decoding audio (WASM)..." :
    progress < 35 ? "Computing True Peak & RMS..." :
    progress < 45 ? "Spectral cutoff analysis..." :
    progress < 58 ? "Noise floor & dithering..." :
    progress < 65 ? "Stereo & phase analysis..." :
    progress < 73 ? "MQA detection & tag parsing..." :
    progress < 82 ? "Generating spectrogram..." :
    progress < 92 ? "Waveform & fake detection..." :
    progress < 99 ? "Building media info..." :
    "Complete!";

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, delay: 0.3, ease: [0.4, 0, 0.2, 1] }}
    >
      <label
        htmlFor="audio-upload"
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`
          liquid-card relative flex cursor-pointer flex-col items-center justify-center
          gap-4 overflow-hidden px-8 py-16 transition-all duration-500
          ${isDragging ? "liquid-card-active" : "hover:liquid-card-hover"}
          ${isAnalyzing ? "pointer-events-none" : ""}
        `}
      >
        {/* Ambient glow */}
        <AnimatePresence>
          {(isDragging || isAnalyzing) && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.5 }}
              className="pointer-events-none absolute inset-0 overflow-hidden"
            >
              <div className="absolute inset-0 bg-gradient-to-b from-peach/5 via-transparent to-transparent" />
            </motion.div>
          )}
        </AnimatePresence>

        {/* VU Meter bars */}
        <motion.div
          className="flex items-end gap-1"
          animate={isAnalyzing ? {} : {}}
        >
          {[...Array(7)].map((_, i) => (
            <motion.div
              key={i}
              animate={
                isAnalyzing
                  ? {
                      height: [10, 24 + i * 3, 14, 20 + i * 2, 10],
                      opacity: [0.5, 1, 0.6, 0.9, 0.5],
                    }
                  : { height: 10 + i * 2 }
              }
              transition={{
                duration: 1.2,
                repeat: isAnalyzing ? Infinity : 0,
                delay: i * 0.1,
                ease: "easeInOut",
              }}
              className="w-1.5 rounded-sm bg-peach"
              style={{ height: 10 + i * 2, opacity: isDragging ? 1 : 0.6 }}
            />
          ))}
        </motion.div>

        <div className="text-center">
          <p className="text-lg font-medium text-foreground">
            {isAnalyzing ? "Analyzing..." : "Drop audio file here"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {isAnalyzing
              ? statusText
              : "WAV, FLAC, MP3, AAC, OGG, Opus, AIFF, ALAC, AC3, EAC3, AC4, MHA1, MHM1"}
          </p>
        </div>

        {/* Progress bar */}
        <AnimatePresence>
          {isAnalyzing && (
            <motion.div
              initial={{ opacity: 0, scaleX: 0.8 }}
              animate={{ opacity: 1, scaleX: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4 }}
              className="w-56"
            >
              <div className="h-1 overflow-hidden rounded-full bg-secondary">
                <motion.div
                  className="h-full rounded-full bg-peach"
                  initial={{ width: "0%" }}
                  animate={{ width: `${progress}%` }}
                  transition={{ duration: 0.4, ease: "easeOut" }}
                />
              </div>
              <p className="mono-text mt-2 text-center text-xs text-muted-foreground">
                {Math.round(progress)}%
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        <input
          id="audio-upload"
          type="file"
          accept="audio/*,.flac,.mqa,.wav,.wave,.aiff,.aif,.mp3,.m4a,.mp4,.aac,.ogg,.opus,.ac3,.ec3,.eac3,.ac4,.ims,.wma,.wmv,.ape,.wv,.dsf,.dff,.dsd,.mlp,.thd,.dts,.dtshd,.mha1,.mhm1,.mhas,.spx,.amr,.3gp"
          onChange={handleChange}
          className="hidden"
          disabled={isAnalyzing}
        />
      </label>
    </motion.div>
  );
}
