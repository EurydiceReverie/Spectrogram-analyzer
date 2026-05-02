/**
 * mpeghTestbenchDecoder.ts
 * ------------------------
 * Drives the Ittiam MPEG-H reference test driver compiled to WASM
 * (`/mpegh-testbench.{js,wasm}`, built with -DLC_LEVEL_4=ON).
 *
 * This is the WHOLE `impeghd_main` CLI from libmpegh-main/test/impeghd_main.c
 * compiled by Emscripten. We invoke it like a CLI from JS:
 *     1. Write input.m4a into MEMFS at `/input.m4a`
 *     2. Module.callMain(['-ifile:/input.m4a','-ofile:/output.wav','-pcmsz:24','-cicp:0'])
 *     3. Read /output.wav back from MEMFS
 *     4. Parse WAV header, extract PCM, return DecodedAudio
 *
 * Why this approach instead of a custom glue:
 *   - The test driver does ALL of the dozens of config-struct field
 *     initialisations correctly (a hand-written glue is fragile).
 *   - It supports ALL MPEG-H Low Complexity Profile streams up to Level 4
 *     including 22.2-channel content (the LC4 stuff prebuilt WASMs lack).
 *   - It writes a proper RIFF/WAV file we can parse trivially.
 */

import { isolateEmscriptenGlobals } from './emscriptenIsolate';

export interface MpeghTestbenchResult {
  channelData: Float32Array[];   // de-interleaved per-channel PCM
  sampleRate: number;
  channels: number;
  totalSamples: number;
  duration: number;
  bitDepth: number;
}

interface TestbenchModule {
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
    analyzePath?(path: string): { exists: boolean };
  };
  callMain(args: string[]): number;
  HEAPU8: Uint8Array;
}

let _modulePromise: Promise<TestbenchModule> | null = null;

/**
 * Load the testbench WASM module. Each load is a fresh Module instance
 * because the CLI modifies global state internally.
 */
function loadTestbenchModule(): Promise<TestbenchModule> {
  _modulePromise = (async () => {
    const wasmResp = await fetch('/mpegh-testbench.wasm');
    if (!wasmResp.ok) throw new Error(`failed to fetch /mpegh-testbench.wasm: HTTP ${wasmResp.status}`);
    const wasmBinary = new Uint8Array(await wasmResp.arrayBuffer());
    console.log(`[Ittiam/CLI] pre-fetched ${wasmBinary.byteLength} bytes of WASM`);

    return await new Promise<TestbenchModule>((resolve, reject) => {
      try { (globalThis as any).Module = undefined; } catch { /* ignore */ }
      (globalThis as any).Module = {
        noInitialRun: true,
        noExitRuntime: true,
        wasmBinary,
        locateFile: (path: string) => `/${path}`,
        print:    (s: string) => console.log(`[Ittiam/CLI] ${s}`),
        printErr: (s: string) => console.warn(`[Ittiam/CLI] ${s}`),
        onRuntimeInitialized() {
          resolve((globalThis as any).Module as TestbenchModule);
        },
        onAbort: (what: any) => reject(new Error(`testbench WASM aborted: ${what}`)),
      };

      // Load glue script directly — no IIFE wrapper, no isolateEmscriptenGlobals.
      // Emscripten needs the Module in global scope to set up WASM imports.
      const existing = document.querySelector('script[src="/mpegh-testbench.js"]');
      if (existing) existing.remove();
      const s = document.createElement('script');
      s.src = '/mpegh-testbench.js';
      s.async = true;
      s.onerror = () => reject(new Error('Failed to load mpegh-testbench.js'));
      document.head.appendChild(s);
    });
  })();
  return _modulePromise;
}

/**
 * Decode an MPEG-H 3D Audio file (raw bytes of the .m4a / .mp4 / .mhas)
 * via the Ittiam testbench WASM CLI.
 */
export async function decodeMpeghTestbench(
  arrayBuffer: ArrayBuffer,
  opts: { cicpSetup?: number; pcmWordSize?: 16 | 24 } = {},
): Promise<MpeghTestbenchResult> {
  const cicp = opts.cicpSetup ?? 0;
  const pcmsz = opts.pcmWordSize ?? 24;

  const M = await loadTestbenchModule();

  // 1. Write input bytes to MEMFS
  const inputBytes = new Uint8Array(arrayBuffer);
  M.FS.writeFile('/input.m4a', inputBytes);

  // 2. Invoke the CLI (synchronous; runs the whole decode)
  const args = [`-ifile:/input.m4a`, `-ofile:/output.wav`, `-pcmsz:${pcmsz}`, `-cicp:${cicp}`];
  console.log(`[Ittiam/CLI] callMain(${JSON.stringify(args)})`);
  let exitCode: number;
  try {
    exitCode = M.callMain(args);
  } catch (err) {
    throw new Error(`testbench callMain threw: ${err}`);
  }
  console.log(`[Ittiam/CLI] callMain returned ${exitCode}`);

  // 3. Read output WAV
  let wavBytes: Uint8Array;
  try {
    wavBytes = M.FS.readFile('/output.wav');
  } catch {
    throw new Error(`testbench did not write /output.wav (callMain exit ${exitCode})`);
  }
  console.log(`[Ittiam/CLI] /output.wav = ${wavBytes.byteLength} bytes`);

  // 4. Parse WAV header + extract per-channel float32 PCM
  return parseWavToFloat32(wavBytes);
}

/**
 * Minimal RIFF/WAV parser. Handles the format the Ittiam testbench writes:
 *   - PCM (format = 1) or IEEE_FLOAT (format = 3)
 *   - 16/24/32-bit integer or 32/64-bit float
 *   - Up to 24+ channels
 *   - Single 'fmt ' chunk + single 'data' chunk
 */
function parseWavToFloat32(buf: Uint8Array): MpeghTestbenchResult {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (off: number) => String.fromCharCode(buf[off], buf[off+1], buf[off+2], buf[off+3]);

  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error(`not a RIFF/WAVE file (tag="${tag(0)}/${tag(8)}")`);
  }

  // Walk chunks looking for 'fmt ' and 'data'
  let fmtOff = -1, dataOff = -1, dataSize = 0;
  let off = 12;
  while (off + 8 <= buf.byteLength) {
    const t = tag(off);
    const sz = dv.getUint32(off + 4, true);
    if (t === 'fmt ') fmtOff = off + 8;
    else if (t === 'data') { dataOff = off + 8; dataSize = sz; break; }
    off += 8 + sz + (sz & 1); // chunks are 2-byte aligned
  }
  if (fmtOff < 0 || dataOff < 0) {
    throw new Error(`WAV missing fmt or data chunk (fmt=${fmtOff}, data=${dataOff})`);
  }

  const formatCode  = dv.getUint16(fmtOff + 0, true);
  const channels    = dv.getUint16(fmtOff + 2, true);
  const sampleRate  = dv.getUint32(fmtOff + 4, true);
  const bitsPerSamp = dv.getUint16(fmtOff + 14, true);
  const bytesPerSamp= bitsPerSamp >> 3;
  const totalSamples= Math.floor(dataSize / (bytesPerSamp * channels));

  console.log(`[Ittiam/CLI] WAV: fmt=${formatCode} ch=${channels} sr=${sampleRate} bits=${bitsPerSamp} samples=${totalSamples}`);

  // Allocate per-channel arrays
  const channelData: Float32Array[] = Array.from(
    { length: channels },
    () => new Float32Array(totalSamples),
  );

  // De-interleave + convert to float32 in [-1, 1]
  if (formatCode === 1 && bitsPerSamp === 16) {
    const NORM = 1 / 32768;
    for (let i = 0; i < totalSamples; i++) {
      for (let ch = 0; ch < channels; ch++) {
        const s = dv.getInt16(dataOff + (i * channels + ch) * 2, true);
        channelData[ch][i] = s * NORM;
      }
    }
  } else if (formatCode === 1 && bitsPerSamp === 24) {
    const NORM = 1 / 8388608;
    for (let i = 0; i < totalSamples; i++) {
      for (let ch = 0; ch < channels; ch++) {
        const o = dataOff + (i * channels + ch) * 3;
        let v = buf[o] | (buf[o+1] << 8) | (buf[o+2] << 16);
        if (v & 0x800000) v |= ~0xFFFFFF; // sign-extend 24→32
        channelData[ch][i] = v * NORM;
      }
    }
  } else if (formatCode === 1 && bitsPerSamp === 32) {
    const NORM = 1 / 2147483648;
    for (let i = 0; i < totalSamples; i++) {
      for (let ch = 0; ch < channels; ch++) {
        const s = dv.getInt32(dataOff + (i * channels + ch) * 4, true);
        channelData[ch][i] = s * NORM;
      }
    }
  } else if (formatCode === 3 && bitsPerSamp === 32) {
    for (let i = 0; i < totalSamples; i++) {
      for (let ch = 0; ch < channels; ch++) {
        channelData[ch][i] = dv.getFloat32(dataOff + (i * channels + ch) * 4, true);
      }
    }
  } else {
    throw new Error(`unsupported WAV format (formatCode=${formatCode}, bits=${bitsPerSamp})`);
  }

  return {
    channelData,
    sampleRate,
    channels,
    totalSamples,
    duration: totalSamples / sampleRate,
    bitDepth: bitsPerSamp,
  };
}
