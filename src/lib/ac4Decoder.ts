/**
 * ac4Decoder.ts
 * -------------
 * Drives the AC-4 / EAC-3 / AC-3 decoder built from FFmpeg n6.1 +
 * the funnymanva AC-4 community patch, compiled to WASM via Emscripten.
 *
 * Artifacts in public/:
 *   /ffmpeg-ac4-cli.wasm  (~870 KB — minimal: only AC-4/EAC-3/AC-3 decoders +
 *                           MOV demux + WAV mux + aresample, no asm/no threading)
 *   /ffmpeg-ac4-cli.js    Emscripten loader with FS + callMain exposed
 *
 * Workflow:
 *   1. Pre-fetch WASM bytes (bypass Vite URL-rewrite quirks)
 *   2. Inject the loader via IIFE (avoid EmscriptenEH global collision)
 *   3. Module.FS.writeFile("/in.m4a", inputBytes)
 *   4. Module.callMain(["/in.m4a", "/out.wav"])
 *   5. Read /out.wav → parse RIFF/WAV → de-interleave per-channel float32
 *
 * NOTE: AC-4 IMS object metadata is not preserved by the FFmpeg AC-4 decoder.
 * We get the bed PCM only (5.1 / 7.1 / 7.1.4 depending on the file).
 */

import { isolateEmscriptenGlobals } from './emscriptenIsolate';

export interface Ac4Result {
  channelData: Float32Array[];
  sampleRate: number;
  channels: number;
  totalSamples: number;
  duration: number;
  bitDepth: number;
}

interface CliModule {
  FS: { writeFile(path: string, data: Uint8Array): void; readFile(path: string): Uint8Array; };
  callMain(args: string[]): number;
  HEAPU8: Uint8Array;
}

let _modulePromise: Promise<CliModule> | null = null;

function loadAc4Cli(): Promise<CliModule> {
  // Re-create the Module instance fresh on every decode (the CLI uses
  // static globals and isn't re-entrant).
  _modulePromise = (async () => {
    const wasmResp = await fetch('/ffmpeg-ac4-cli.wasm');
    if (!wasmResp.ok) throw new Error(`failed to fetch /ffmpeg-ac4-cli.wasm: HTTP ${wasmResp.status}`);
    const wasmBinary = new Uint8Array(await wasmResp.arrayBuffer());
    console.log(`[AC4/CLI] pre-fetched ${wasmBinary.byteLength} bytes of WASM`);

    return await new Promise<CliModule>(async (resolve, reject) => {
      try { (globalThis as any).Module = undefined; } catch { /* ignore */ }
      const seen = new Map<string, number>();
      const filter = (s: string, useLog: boolean): boolean => {
        const key = s.replace(/0x[0-9a-fA-F]+/g, '0x*').replace(/\d+/g, '#').slice(0, 80);
        const n = (seen.get(key) ?? 0) + 1;
        seen.set(key, n);
        if (n <= 3) return true;
        if (n === 4) (useLog ? console.log : console.warn)(`[AC4/CLI] (suppressing further "${key.slice(0, 60)}…" messages)`);
        return false;
      };
      (globalThis as any).Module = {
        noInitialRun: true,
        noExitRuntime: true,
        wasmBinary,
        locateFile: (path: string) => `/${path}`,
        print:    (s: string) => { if (filter(s, true))  console.log(`[AC4/CLI] ${s}`);  },
        printErr: (s: string) => { if (filter(s, false)) console.warn(`[AC4/CLI] ${s}`); },
        onRuntimeInitialized() { resolve((globalThis as any).Module as CliModule); },
        onAbort: (what: any) => reject(new Error(`AC-4 CLI WASM aborted: ${what}`)),
      };

      const jsResp = await fetch('/ffmpeg-ac4-cli.js');
      if (!jsResp.ok) { reject(new Error(`failed to load /ffmpeg-ac4-cli.js: HTTP ${jsResp.status}`)); return; }
      let jsSrc = await jsResp.text();
      jsSrc = isolateEmscriptenGlobals(jsSrc, '_AC4');
      const existing = document.querySelector('script[data-ac4-cli]');
      if (existing) existing.remove();
      const s = document.createElement('script');
      s.text = jsSrc;
      s.dataset.ac4Cli = '1';
      document.head.appendChild(s);
    });
  })();
  return _modulePromise;
}

/**
 * Decode an AC-4 / EAC-3 / AC-3 file via the patched FFmpeg WASM.
 */
export async function decodeAc4(arrayBuffer: ArrayBuffer): Promise<Ac4Result> {
  const M = await loadAc4Cli();

  M.FS.writeFile('/in.m4a', new Uint8Array(arrayBuffer));

  const args = ['/in.m4a', '/out.wav'];
  console.log(`[AC4/CLI] callMain(${JSON.stringify(args)})`);
  let exitCode: number;
  try {
    exitCode = M.callMain(args);
  } catch (err) {
    throw new Error(`AC-4 callMain threw: ${err}`);
  }
  console.log(`[AC4/CLI] callMain returned ${exitCode}`);

  let wavBytes: Uint8Array;
  try {
    wavBytes = M.FS.readFile('/out.wav');
  } catch {
    throw new Error(`AC-4 CLI did not write /out.wav (callMain exit ${exitCode})`);
  }
  console.log(`[AC4/CLI] /out.wav = ${wavBytes.byteLength} bytes`);

  return parseWavToFloat32(wavBytes);
}

/** Same RIFF/WAV parser as the other testbench decoders. */
function parseWavToFloat32(buf: Uint8Array): Ac4Result {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (off: number) => String.fromCharCode(buf[off], buf[off+1], buf[off+2], buf[off+3]);

  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error(`not a RIFF/WAVE file (tag="${tag(0)}/${tag(8)}")`);
  }
  let fmtOff = -1, dataOff = -1, dataSize = 0;
  let off = 12;
  while (off + 8 <= buf.byteLength) {
    const t = tag(off);
    const sz = dv.getUint32(off + 4, true);
    if (t === 'fmt ') fmtOff = off + 8;
    else if (t === 'data') { dataOff = off + 8; dataSize = sz; break; }
    off += 8 + sz + (sz & 1);
  }
  if (fmtOff < 0 || dataOff < 0) throw new Error(`WAV missing fmt or data chunk`);

  const formatCode  = dv.getUint16(fmtOff + 0, true);
  const channels    = dv.getUint16(fmtOff + 2, true);
  const sampleRate  = dv.getUint32(fmtOff + 4, true);
  const bitsPerSamp = dv.getUint16(fmtOff + 14, true);
  const bytesPerSamp= bitsPerSamp >> 3;
  const totalSamples= Math.floor(dataSize / (bytesPerSamp * channels));

  console.log(`[AC4/CLI] WAV: fmt=${formatCode} ch=${channels} sr=${sampleRate} bits=${bitsPerSamp} samples=${totalSamples}`);

  const channelData: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(totalSamples));

  if (formatCode === 1 && bitsPerSamp === 16) {
    const NORM = 1 / 32768;
    for (let i = 0; i < totalSamples; i++) for (let c = 0; c < channels; c++) {
      channelData[c][i] = dv.getInt16(dataOff + (i * channels + c) * 2, true) * NORM;
    }
  } else if (formatCode === 1 && bitsPerSamp === 24) {
    const NORM = 1 / 8388608;
    for (let i = 0; i < totalSamples; i++) for (let c = 0; c < channels; c++) {
      const o = dataOff + (i * channels + c) * 3;
      let v = buf[o] | (buf[o+1] << 8) | (buf[o+2] << 16);
      if (v & 0x800000) v |= ~0xFFFFFF;
      channelData[c][i] = v * NORM;
    }
  } else if (formatCode === 1 && bitsPerSamp === 32) {
    const NORM = 1 / 2147483648;
    for (let i = 0; i < totalSamples; i++) for (let c = 0; c < channels; c++) {
      channelData[c][i] = dv.getInt32(dataOff + (i * channels + c) * 4, true) * NORM;
    }
  } else if (formatCode === 3 && bitsPerSamp === 32) {
    for (let i = 0; i < totalSamples; i++) for (let c = 0; c < channels; c++) {
      channelData[c][i] = dv.getFloat32(dataOff + (i * channels + c) * 4, true);
    }
  } else {
    throw new Error(`unsupported WAV format (formatCode=${formatCode}, bits=${bitsPerSamp})`);
  }

  return { channelData, sampleRate, channels, totalSamples, duration: totalSamples / sampleRate, bitDepth: bitsPerSamp };
}
