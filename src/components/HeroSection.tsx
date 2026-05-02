import { motion } from "framer-motion";

export function HeroSection() {
  return (
    <div className="relative overflow-hidden pb-8 pt-20 text-center">
      {/* Subtle background glow */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-1/4 h-64 w-64 -translate-x-1/2 rounded-full bg-peach/5 blur-3xl" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7 }}
        className="relative"
      >
        {/* Retro VU meter bars */}
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5 }}
          className="mb-6 flex items-end justify-center gap-1.5"
        >
          {[0.3, 0.5, 0.8, 1, 0.9, 0.6, 0.4, 0.7, 0.95, 0.5, 0.3].map((h, i) => (
            <motion.div
              key={i}
              initial={{ height: 0 }}
              animate={{ height: h * 32 }}
              transition={{ duration: 0.6, delay: 0.1 + i * 0.04 }}
              className="w-1.5 rounded-sm bg-peach"
              style={{ opacity: 0.4 + h * 0.6 }}
            />
          ))}
        </motion.div>

        <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
          Audio<span className="text-gradient-peach"> Veritas</span>
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground">
          Professional audio integrity analysis. Detect resampling, lossy encoding,
          clipping, compression artifacts, and verify bit-perfect authenticity.
        </p>
        <p className="mx-auto mt-1.5 text-[10px] font-mono text-primary/50 uppercase tracking-[0.2em]">
          Spectral cutoff · Bit-depth · True Peak · Upsampling · Defective header
        </p>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6, duration: 0.5 }}
          className="mono-text mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-muted-foreground"
        >
          {["Spectral Analysis", "Bit-Perfect Check", "True Peak", "Dynamic Range", "Lossy Detection"].map((tag) => (
            <span key={tag} className="flex items-center gap-1.5">
              <span className="h-1 w-1 rounded-full bg-peach/60" />
              {tag}
            </span>
          ))}
        </motion.div>
      </motion.div>
    </div>
  );
}
