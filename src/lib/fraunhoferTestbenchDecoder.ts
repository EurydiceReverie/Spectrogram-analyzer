/**
 * fraunhoferTestbenchDecoder.ts
 * -----------------------------
 * Drives the Fraunhofer MPEG-H reference demo CLI (mpeghDecoder) compiled to
 * WASM (`/fraunhofer-mpegh-cli.{js,wasm}`). Same approach as the Ittiam
 * testbench: build the official CLI as WASM, write input bytes to MEMFS,
 * invoke `Module.callMain([...])`, read the output WAV back and parse it.
 *
 * CLI args (per main_mpeghDecoder.cpp):
 *     -if <input>   input MP4/MHA(S) file
 *     -of <output>  output WAV file
 *     -tl <int>     target loudness (default -16 LU)
 *     -tcl <int>    target channel layout (CICP index, default 6 = 5.1)
 *     -dse <int>    DRC effect type (default 0 = None)
 *     -bsof <path>  bitstream output file
 *
 * NOTE: The Fraunhofer reference build supports MPEG-H "Baseline Profile"
 * only. For LC Profile Level 4 / 22.2 channel content, prefer the Ittiam
 * testbench (mpeghTestbenchDecoder.ts).
 */

import { isolateEmscriptenGlobals } from './emscriptenIsolate';

export interface FraunhoferResult {
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

function loadFraunhoferCli(): Promise<CliModule> {
  _modulePromise = (async () => {
    const wasmResp = await fetch('/fraunhofer-mpegh-cli.wasm');
    if (!wasmResp.ok) throw new Error(`failed to fetch /fraunhofer-mpegh-cli.wasm: HTTP ${wasmResp.status}`);
    const wasmBinary = new Uint8Array(await wasmResp.arrayBuffer());
    console.log(`[Fraunhofer/CLI] pre-fetched ${wasmBinary.byteLength} bytes of WASM`);

    return await new Promise<CliModule>(async (resolve, reject) => {
      try { (globalThis as any).Module = undefined; } catch { /* ignore */ }
      (globalThis as any).Module = {
        noInitialRun: true,
        noExitRuntime: true,
        wasmBinary,
        locateFile: (path: string) => `/${path}`,
        print:    (s: string) => console.log(`[Fraunhofer/CLI] ${s}`),
        printErr: (s: string) => console.warn(`[Fraunhofer/CLI] ${s}`),
        onRuntimeInitialized() { resolve((globalThis as any).Module as CliModule); },
        onAbort: (what: any) => reject(new Error(`Fraunhofer CLI WASM aborted: ${what}`)),
      };

      const jsResp = await fetch('/fraunhofer-mpegh-cli.js');
      if (!jsResp.ok) { reject(new Error(`failed to load /fraunhofer-mpegh-cli.js: HTTP ${jsResp.status}`)); return; }
      let jsSrc = await jsResp.text();
      jsSrc = isolateEmscriptenGlobals(jsSrc, '_FH');
      const existing = document.querySelector('script[data-fraunhofer-cli]');
      if (existing) existing.remove();
      const s = document.createElement('script');
      s.text = jsSrc;
      s.dataset.fraunhoferCli = '1';
      document.head.appendChild(s);
    });
  })();
  return _modulePromise;
}

/**
 * Decode an MPEG-H 3D Audio file via the Fraunhofer reference demo WASM.
 *
 * @param arrayBuffer - the entire input file bytes (m4a / mp4 / mhas)
 * @param opts.targetCicp - target channel layout (CICP index). If omitted we
 *                           parse the file's mhaC `referenceChannelLayout` and
 *                           use THAT — so the decoder renders to the file's
 *                           native layout (no downmix, no upmix). The Fraunhofer
 *                           CLI's API requires SOME target layout; CICP 0 is
 *                           rejected, so "as-coded" must be inferred per-file.
 */
export async function decodeFraunhoferCli(
  arrayBuffer: ArrayBuffer,
  opts: { targetCicp?: number } = {},
): Promise<FraunhoferResult> {
  const M = await loadFraunhoferCli();

  // Determine target channel layout. The Fraunhofer API requires a valid CICP
  // (1..7, 9..20, 100..351, 400..422). CICP 0 is rejected. To honour the
  // "no downmix / native layout" intent, we parse the file's mhaC
  // `referenceChannelLayout` and feed THAT as the target — the decoder then
  // renders directly to the bitstream's own coded layout.
  let cicp = opts.targetCicp;
  if (typeof cicp !== 'number') {
    const sniffed = sniffReferenceChannelLayout(new Uint8Array(arrayBuffer));
    if (sniffed && sniffed > 0) {
      console.log(`[Fraunhofer/CLI] sniffed referenceChannelLayout=${sniffed} from mhaC -> using as -tl`);
      cicp = sniffed;
    } else {
      // Fallback: most consumer 360 RA / streaming MPEG-H content uses CICP 13 (22.2).
      // Without knowing the file's layout we can't really do "as-coded" — pick a
      // reasonable common value and let the user override if they want.
      console.warn(`[Fraunhofer/CLI] could not sniff referenceChannelLayout; defaulting to CICP 13 (22.2)`);
      cicp = 13;
    }
  }

  // Write input to MEMFS
  M.FS.writeFile('/input.m4a', new Uint8Array(arrayBuffer));

  // Invoke the CLI
  // -if/-of: required input/output paths.
  // -tl <cicp>: target channel layout (decoder always renders to this layout).
  const args = ['-if', '/input.m4a', '-of', '/output.wav', '-tl', String(cicp)];
  console.log(`[Fraunhofer/CLI] callMain(${JSON.stringify(args)})`);
  let exitCode: number;
  try {
    exitCode = M.callMain(args);
  } catch (err) {
    throw new Error(`Fraunhofer callMain threw: ${err}`);
  }
  console.log(`[Fraunhofer/CLI] callMain returned ${exitCode}`);

  // 3. Read output WAV
  let wavBytes: Uint8Array;
  try {
    wavBytes = M.FS.readFile('/output.wav');
  } catch {
    throw new Error(`Fraunhofer CLI did not write /output.wav (callMain exit ${exitCode})`);
  }
  console.log(`[Fraunhofer/CLI] /output.wav = ${wavBytes.byteLength} bytes`);

  return parseWavToFloat32(wavBytes);
}

/**
 * Find the `mhaC` box anywhere in the input bytes and return its
 * referenceChannelLayout (CICP index). Per ISO/IEC 23008-3 §20.6:
 *   mhaC payload[0]   configurationVersion (=1)
 *   mhaC payload[1]   mpegh3daProfileLevelIndication
 *   mhaC payload[2]   referenceChannelLayout (CICP)
 *   mhaC payload[3-4] mpegh3daConfigLength (uint16 BE)
 *   mhaC payload[5..] mpegh3daConfig[]
 *
 * Returns 0 if no mhaC found (or invalid).
 */
function sniffReferenceChannelLayout(u8: Uint8Array): number {
  // Naive byte search for FourCC "mhaC". The size field is the 4 bytes
  // immediately preceding it.
  const M = 'm'.charCodeAt(0), H = 'h'.charCodeAt(0),
        A = 'a'.charCodeAt(0), C = 'C'.charCodeAt(0);
  const limit = u8.length - 9;
  for (let i = 4; i < limit; i++) {
    if (u8[i] === M && u8[i+1] === H && u8[i+2] === A && u8[i+3] === C) {
      // Validate by reading the box-size field (4 bytes before the FourCC)
      const sz = (u8[i-4] << 24 | u8[i-3] << 16 | u8[i-2] << 8 | u8[i-1]) >>> 0;
      if (sz < 8 || sz > 0x10000) continue; // sanity
      // Payload starts at i+4. byte[2] of payload = referenceChannelLayout
      const cicp = u8[i + 4 + 2];
      if (cicp > 0) return cicp;
    }
  }
  return 0;
}

/** Same RIFF/WAV parser as mpeghTestbenchDecoder. PCM 16/24/32 + IEEE float. */
function parseWavToFloat32(buf: Uint8Array): FraunhoferResult {
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

  console.log(`[Fraunhofer/CLI] WAV: fmt=${formatCode} ch=${channels} sr=${sampleRate} bits=${bitsPerSamp} samples=${totalSamples}`);

  const channelData: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(totalSamples));

  if (formatCode === 1 && bitsPerSamp === 16) {
    const NORM = 1 / 32768;
    for (let i = 0; i < totalSamples; i++) for (let ch = 0; ch < channels; ch++) {
      channelData[ch][i] = dv.getInt16(dataOff + (i * channels + ch) * 2, true) * NORM;
    }
  } else if (formatCode === 1 && bitsPerSamp === 24) {
    const NORM = 1 / 8388608;
    for (let i = 0; i < totalSamples; i++) for (let ch = 0; ch < channels; ch++) {
      const o = dataOff + (i * channels + ch) * 3;
      let v = buf[o] | (buf[o+1] << 8) | (buf[o+2] << 16);
      if (v & 0x800000) v |= ~0xFFFFFF;
      channelData[ch][i] = v * NORM;
    }
  } else if (formatCode === 1 && bitsPerSamp === 32) {
    const NORM = 1 / 2147483648;
    for (let i = 0; i < totalSamples; i++) for (let ch = 0; ch < channels; ch++) {
      channelData[ch][i] = dv.getInt32(dataOff + (i * channels + ch) * 4, true) * NORM;
    }
  } else if (formatCode === 3 && bitsPerSamp === 32) {
    for (let i = 0; i < totalSamples; i++) for (let ch = 0; ch < channels; ch++) {
      channelData[ch][i] = dv.getFloat32(dataOff + (i * channels + ch) * 4, true);
    }
  } else {
    throw new Error(`unsupported WAV format (formatCode=${formatCode}, bits=${bitsPerSamp})`);
  }

  return { channelData, sampleRate, channels, totalSamples, duration: totalSamples / sampleRate, bitDepth: bitsPerSamp };
}
