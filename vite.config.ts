import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    tsconfigPaths(),
  ],
  optimizeDeps: {
    exclude: [
      "libflacjs",
      "libflacjs/dist/libflac.min.js",
      "libflacjs/dist/libflac.min.wasm.js",
      "@wasm-audio-decoders/common",
      "@wasm-audio-decoders/ogg-vorbis",
      "@wasm-audio-decoders/flac",
      "mpg123-decoder",
      "opus-decoder",
      "@ffmpeg/ffmpeg",
      "@ffmpeg/util",
    ],
  },
  build: {
    outDir: "dist",
    target: "esnext",
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
