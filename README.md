# Audio Veritas

Web-based audio analysis tool running entirely in the browser — no uploads, no servers. Supports lossless formats (FLAC, ALAC, WAV, AIFF), surround/Dolby codecs (AC-3, E-AC-3, AC-4/Atmos), Sony 360 Reality Audio / MPEG-H 3D Audio, and more.

**Live:** https://audioveritas.pages.dev

## Formats Supported

| Format | Decoder | Bit-Perfect |
|--------|---------|:-----------:|
| FLAC / MQA | libFLAC.js (WASM) | ✅ |
| MP3 | mpg123 (WASM) | — |
| OGG Vorbis | libvorbis (WASM) | — |
| WAV / AIFF | Native binary parser | ✅ |
| M4A (ALAC) | FFmpeg WASM | ✅ |
| M4A (AAC) | FFmpeg WASM | — |
| AC-3 / E-AC-3 (Dolby) | Browser native (MSE) + FFmpeg fallback | ✅ |
| AC-4 / Atmos IMS | Patched FFmpeg WASM | — |
| Sony 360RA / MPEG-H 3D | Ittiam libmpegh / Fraunhofer IIS | ✅ |
| Opus | FFmpeg WASM | — |
| WMA / APE / WavPack / DTS | FFmpeg WASM | — |

## Architecture

```
src/
├── lib/
│   ├── wasmDecoders.ts      # FLAC, MP3, OGG, WAV, AIFF, M4A routing
│   ├── mpegh3daDecoder.ts   # Ittiam MPEG-H decoder (WASM)
│   ├── fraunhoferMpeghDecoder.ts  # Fraunhofer IIS decoder (WASM)
│   ├── ac4Decoder.ts        # AC-4 / Atmos IMS decoder (patched FFmpeg)
│   ├── audioAnalysis.ts     # DR14, RMS, spectrogram, bit-depth detection
│   └── ...
├── components/              # UI (React + Tailwind + Radix UI)
└── workers/
    └── mpeghDecodeWorker.ts # Background decoding worker
```

## WASM Decoders

### libflacjs (FLAC / MQA)
- **Source:** `public/libflac.min.js` or `public/libflac.min.wasm.js`
- **Origin:** Pre-built Emscripten build of libFLAC
- **Purpose:** Bit-perfect FLAC decoding, preserves LSBs for MQA detection
- **Loading:** Injected via `<script>` tag, sets `window.Flac`

### mpg123 (MP3)
- **Package:** `mpg123-decoder` (npm)
- **Purpose:** MP3 decoding at native sample rate

### libvorbis / opus-decoder (OGG)
- **Packages:** `@wasm-audio-decoders/ogg-vorbis`, `opus-decoder`
- **Purpose:** OGG Vorbis and raw Opus decoding

### FFmpeg WASM
- **Source:** `@ffmpeg/core` loaded from jsDelivr CDN
- **Purpose:** AAC, ALAC, WMA, APE, WavPack, DTS, AC-3/E-AC-3 fallback
- **Loading:** Fetched from CDN, instantiated via Emscripten factory

### MPEG-H / Sony 360RA Decoders
Two WASM decoders available (user selects via dialog):

1. **Ittiam libmpegh** — `public/decode-mpegh3da.wasm`
2. **Fraunhofer IIS** — `public/fraunhofer-mpegh.wasm`

Both decode Sony 360 Reality Audio and MPEG-H 3D Audio bitstreams.

### AC-4 / Atmos IMS Decoder
- **Source:** `public/ffmpeg-ac4-cli.wasm` — patched FFmpeg build with AC-4 support
- **Purpose:** Decodes AC-4 / Immersive Music Stereo streams

---

## Building Your Own WASM Decoders

If you need to rebuild the WASM decoders or create new ones, here's what you need.

### Toolchain

| Tool | Purpose | Install |
|------|---------|---------|
| **Emscripten** (emcc/em++) | Compile C/C++ to WebAssembly | `git clone https://github.com/emscripten-core/emsdk.git && ./emsdk install latest && ./emsdk activate` |
| **CMake** | Build system for projects with Makefiles | `apt install cmake` or download from cmake.org |
| **Ninja** | Fast build system (optional, faster than Make) | `apt install ninja-build` |
| **GCC / G++** | GNU C/C++ compiler | `apt install build-essential` |
| **MinGW-w64** | Windows cross-compiler (for .wasm on Linux/Mac) | `apt install mingw-w64` |

### Emscripten Essential Commands

```bash
# Activate Emscripten (run once per shell session)
source /path/to/emsdk/emsdk_env.sh

# Basic C → WASM compilation
emcc input.c -o output.js          # outputs JS + Wasm
emcc input.c -o output.wasm        # outputs Wasm only (no glue JS)

# With optimization
emcc input.c -O3 -o output.js

# With WebAssembly output
emcc input.c -s WASM=1 -o output.js

# With Emscripten modules (FS, etc.)
emcc input.c -s WASM=1 -s EXPORTED_RUNTIME_METHODS="[ccall,cwrap,FS]" -o output.js

# Standalone Wasm (no JS glue) — use when loading manually
emcc input.c -s STANDALONE_WASM=1 -o output.wasm

# Specify memory size
emcc input.c -s INITIAL_MEMORY=16777216 -s MAXIMUM_MEMORY=33554432 -o output.js

# With locateFile (for loading .wasm separately)
emcc input.c -s WASM=1 -s EXPORTED_RUNTIME_METHODS="[ccall,cwrap]" -o output.js
```

### Building libflac (Example)

```bash
git clone https://github.com/xiph/flac.git
cd flac

emcmake cmake .. -DBUILD_CXXLIBS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_TESTING=OFF
emmake make -j$(nproc)

# Output: libflac*.bc or libflac*.a → link with emcc
emcc libflac/.libs/libflac.a -o libflac.js \
    -s WASM=1 \
    -s EXPORTED_RUNTIME_METHODS="[ccall,cwrap,FS]" \
    -s ALLOW_MEMORY_GROWTH=1 \
    -O3
```

### Building FFmpeg (WASM)

FFmpeg WASM builds are complex — requires heavy patching for browsers. See:
- https://github.com/ffmpegwasm/ffmpeg.wasm
- https://github.com/nicknisi/dotfiles/blob/main/workstation/bin/ffmpeg-build.sh

### Building libmpegh (Ittiam MPEG-H)

```bash
git clone https://github.com/nicknisi/ittiam-mpegh.git
cd ittiam-mpegh

emcmake cmake ..
emmake make

emcc testbench/mpegh_testbench.c \
    -o mpegh-testbench.js \
    -s WASM=1 \
    -s EXPORTED_RUNTIME_METHODS="[ccall,cwrap,FS]" \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=33554432 \
    -O3
```

### Common Emscripten Flags Reference

| Flag | Purpose |
|------|---------|
| `-s WASM=1` | Output WebAssembly instead of asm.js |
| `-s STANDALONE_WASM=1` | Output standalone .wasm with no JS glue |
| `-s EXPORTED_RUNTIME_METHODS` | Expose runtime methods (ccall, cwrap, FS) |
| `-s EXPORTED_FUNCTIONS` | Export specific C functions |
| `-s ALLOW_MEMORY_GROWTH=1` | Allow heap to grow dynamically |
| `-s INITIAL_MEMORY=X` | Set initial memory (bytes) |
| `-s MAXIMUM_MEMORY=X` | Set max memory |
| `-s MODULARIZE=1` | Wrap output in ES module |
| `-s EXPORT_ES6=1` | ES6 module export |
| `-s ENVIRONMENT='web,worker'` | Target web/worker environments |
| `-s USE_PTHREADS=1` | Enable threads |
| `-s PROXY_TO_PTHREAD=1` | Proxy main thread to worker |
| `-s WASM_BIGINT=1` | Enable BigInt support |
| `--no-entry` | No main() function required |
| `-s LZ4=1` | LZ4 compression support |
| `-s BINARYEN=1` | Use Binaryen for optimization |

### Loading Wasm Manually (fetch + instantiante)

```javascript
// Fetch raw .wasm file
const response = await fetch('/my-decoder.wasm');
const bytes = await response.arrayBuffer();

// Instantiate with WebAssembly.instantiate
const { instance } = await WebAssembly.instantiate(bytes, imports);
const { myFunction } = instance.exports;

// Or with emscripten module:
const Module = {
  locateFile: (path) => path.endsWith('.wasm') ? '/my-decoder.wasm' : '/' + path,
};
```

---

## Development

```bash
npm install
npm run dev       # dev server
npm run build     # production build
npm run lint      # lint
npm run test      # run tests
```

## No Backend

This app runs **100% client-side**. No data is ever sent to a server. Audio files are analyzed entirely in the browser using WebAssembly decoders.

## License

See individual decoder licenses (libFLAC — BSD, mpg123 — LGPL, FFmpeg — LGPL/GPL, Ittiam/Fraunhofer — proprietary).