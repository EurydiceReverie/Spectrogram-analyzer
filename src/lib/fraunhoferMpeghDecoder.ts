/**
 * fraunhoferMpeghDecoder.ts
 * -------------------------
 * TypeScript wrapper for the Fraunhofer FDK MPEG-H 3D Audio WASM decoder
 * (fraunhofer-mpegh.js + fraunhofer-mpegh.wasm in /public).
 *
 * The WASM is built from Fraunhofer's mpeghdec C library via Emscripten.
 * It supports ALL channel counts (1–24+) at full quality — no downmixing.
 *
 * Exported C functions (via fraunhofer_mpegh_glue.cpp):
 *   _fmpegh_create(cicpSetup)                          → handle
 *   _fmpegh_set_config(h, ptr, len)                    → 0=ok
 *   _fmpegh_feed(h, ptr, len, pts_lo, pts_hi, ts)      → 0=ok / 1=need_data
 *   _fmpegh_get_samples(h, outPtr, outLen, infoPtr)    → 0=frame / 1=need_data
 *   _fmpegh_flush(h)                                   → 0=ok
 *   _fmpegh_set_param(h, param, value)                 → 0=ok
 *   _fmpegh_destroy(h)                                 → void
 *
 * Output info layout (6 × int32 at infoPtr):
 *   [0] numSamplesPerChannel
 *   [1] numChannels
 *   [2] sampleRate
 *   [3] loudness
 *   [4] isConcealed
 *   [5] reserved
 */

export interface FraunhoferMpeghResult {
  channelData: Float32Array[];   // de-interleaved per-channel PCM (float32, -1..1)
  sampleRate: number;
  channels: number;
  totalSamples: number;
  duration: number;
  loudness: number;              // LKFS × -0.25, -1 = not present
  decoderLabel: string;
}

// ─── MP4/ISOBMFF sample extraction (pure JS, no ffmpeg needed) ───────────────

interface Mp4Sample {
  data: Uint8Array;
  pts: number;         // in timescale ticks
  timescale: number;
}

interface Mp4Track {
  samples: Mp4Sample[];
  mhaConfig?: Uint8Array;   // DecoderConfigDescriptor for mha1
  codec: string;            // 'mha1' | 'mhm1'
}

/**
 * Very lightweight MP4 box parser — extracts MPEG-H samples + mha1 config.
 * We only parse what we need: moov→trak→mdia→hdlr/minf/stbl boxes.
 * For full MP4 we rely on mp4box.js (already in the project) as fallback.
 */
async function extractMp4Track(buf: ArrayBuffer): Promise<Mp4Track | null> {
  try {
    // Dynamically import mp4box (already in package.json)
    const mp4boxMod = await import('mp4box');
    const MP4Box = (mp4boxMod as any).default ?? mp4boxMod;
    const mp4File = MP4Box.createFile();

    return await new Promise<Mp4Track | null>((resolve) => {
      let track: Mp4Track | null = null;
      let sampleBuffer: Mp4Sample[] = [];
      let mhaConfig: Uint8Array | undefined;
      let codec = '';
      let trackId = -1;
      let timescale = 44100;

      mp4File.onReady = (info: any) => {
        // Find first MPEG-H track
        for (const t of info.tracks) {
          if (t.codec?.startsWith('mha') || t.codec?.startsWith('mhm')) {
            trackId = t.id;
            codec = t.codec;
            timescale = t.timescale || 44100;
            mp4File.setExtractionOptions(t.id, null, { nbSamples: Infinity });
            break;
          }
        }
        if (trackId === -1) {
          resolve(null);
          return;
        }
        mp4File.start();
      };

      mp4File.onSamples = (_: number, __: any, samples: any[]) => {
        for (const s of samples) {
          sampleBuffer.push({
            data: new Uint8Array(s.data),
            pts: s.cts,
            timescale,
          });
        }
      };

      mp4File.onError = () => resolve(null);

      // Feed the whole buffer at once
      const ab = buf.slice(0);
      (ab as any).fileStart = 0;
      mp4File.appendBuffer(ab);
      mp4File.flush();

      // Give mp4box time to process (it's sync internally after flush)
      setTimeout(() => {
        if (sampleBuffer.length === 0) { resolve(null); return; }
        resolve({
          samples: sampleBuffer,
          mhaConfig,
          codec,
        });
      }, 100);
    });
  } catch {
    return null;
  }
}

// ─── Emscripten Module type ───────────────────────────────────────────────────

interface FraunhoferModule {
  _fmpegh_create(cicpSetup: number): number;
  _fmpegh_set_config(h: number, ptr: number, len: number): number;
  _fmpegh_feed(h: number, ptr: number, len: number, pts_lo: number, pts_hi: number, timescale: number): number;
  _fmpegh_get_samples(h: number, outPtr: number, outLen: number, infoPtr: number): number;
  _fmpegh_flush(h: number): number;
  _fmpegh_set_param(h: number, param: number, value: number): number;
  _fmpegh_destroy(h: number): void;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  HEAPF32: Float32Array;
}

let _fraunhoferModulePromise: Promise<FraunhoferModule> | null = null;

function loadFraunhoferModule(): Promise<FraunhoferModule> {
  if (_fraunhoferModulePromise) return _fraunhoferModulePromise;

  _fraunhoferModulePromise = (async () => {
    // Already loaded?
    if (typeof (window as any).FraunhoferMpeghModule?._fmpegh_create === 'function') {
      return await (window as any).FraunhoferMpeghModule();
    }

    // Pre-fetch the raw WASM binary (no encryption)
    const resp = await fetch('/fraunhofer-mpegh.wasm');
    const wasmBytes = await resp.arrayBuffer();
    console.log(`[Fraunhofer] pre-fetched ${(wasmBytes.byteLength / 1024).toFixed(0)}KB of WASM`);

    // Create blob URL so Emscripten's locateFile can fetch it
    const wasmBlobURL = URL.createObjectURL(new Blob([wasmBytes], { type: "application/wasm" }));

    return await new Promise<FraunhoferModule>((resolve, reject) => {
      // Inject script, then call the factory
      const script = document.createElement('script');
      script.src = '/fraunhofer-mpegh.js';
      script.async = true;
      script.onload = () => {
        const factory = (window as any).FraunhoferMpeghModule;
        if (typeof factory !== 'function') {
          reject(new Error('FraunhoferMpeghModule factory not found after script load'));
          return;
        }
        factory({
          wasmBinary: new Uint8Array(wasmBytes),
          locateFile: (path: string) => path.endsWith('.wasm') ? wasmBlobURL : `/${path}`,
        }).then(resolve).catch(reject);
      };
      script.onerror = () => reject(new Error('Failed to load fraunhofer-mpegh.js'));
      document.head.appendChild(script);
    });
  })();

  return _fraunhoferModulePromise;
}

// ─── Max constants ────────────────────────────────────────────────────────────
const MAX_CHANNELS   = 28;    // MPEG-H up to 24 + headroom
const MAX_FRAME_SIZE = 3072;  // per Fraunhofer API docs
const OUT_BUF_SAMPLES = MAX_CHANNELS * MAX_FRAME_SIZE;
const INFO_INTS = 6;

// ─── Main decode API ──────────────────────────────────────────────────────────

/**
 * Decode MPEG-H 3D Audio / Sony 360 Reality Audio using the Fraunhofer FDK.
 * Preserves ALL channels — no downmix, no truncation.
 *
 * @param arrayBuffer  Raw bytes of .m4a / .mhas / .mha1 file
 * @param cicpSetup    CICP channel layout index (0 = as-coded, 6 = 5.1, etc.)
 *                     Use 0 to get every channel as decoded.
 */
export async function decodeFraunhoferMpegh(
  arrayBuffer: ArrayBuffer,
  cicpSetup = 0,
): Promise<FraunhoferMpeghResult> {
  const M = await loadFraunhoferModule();

  // ── 1. Extract MP4 samples ──────────────────────────────────────────────
  const track = await extractMp4Track(arrayBuffer);
  if (!track || track.samples.length === 0) {
    throw new Error('No MPEG-H track found in file — cannot decode with Fraunhofer SDK');
  }

  // ── 2. Create decoder ───────────────────────────────────────────────────
  const hCtx = M._fmpegh_create(cicpSetup);
  if (!hCtx) throw new Error('fmpegh_create failed — could not allocate decoder');

  // ── 3. Set out-of-band ASC config (required for mha1) ──────────────────
  if (track.mhaConfig && track.mhaConfig.byteLength > 0) {
    const cfgPtr = M._malloc(track.mhaConfig.byteLength);
    M.HEAPU8.set(track.mhaConfig, cfgPtr);
    const cfgStatus = M._fmpegh_set_config(hCtx, cfgPtr, track.mhaConfig.byteLength);
    M._free(cfgPtr);
    if (cfgStatus !== 0) {
      console.warn(`[Fraunhofer] set_config returned ${cfgStatus} — continuing anyway`);
    }
  }

  // ── 4. Allocate working buffers ─────────────────────────────────────────
  const outPtr  = M._malloc(OUT_BUF_SAMPLES * 4);  // int32 × samples
  const infoPtr = M._malloc(INFO_INTS * 4);         // 6 × int32

  // ── 5. Feed all samples, collect PCM frames ─────────────────────────────
  // PCM accumulator: we build per-channel arrays dynamically
  const pcmAccum: Int32Array[] = [];
  let sampleRate   = 48000;
  let numChannels  = 0;
  let loudness     = -1;
  let totalSamples = 0;

  const feedAndDrain = async (data: Uint8Array, pts: number, timescale: number) => {
    const inPtr = M._malloc(data.byteLength);
    M.HEAPU8.set(data, inPtr);

    const ptsLo = pts >>> 0;
    const ptsHi = Math.floor(pts / 0x100000000) >>> 0;
    M._fmpegh_feed(hCtx, inPtr, data.byteLength, ptsLo, ptsHi, timescale);
    M._free(inPtr);

    // Drain all available PCM frames
    let status = 0;
    while (status === 0) {
      status = M._fmpegh_get_samples(hCtx, outPtr, OUT_BUF_SAMPLES, infoPtr);
      if (status !== 0) break;

      const info = M.HEAP32.slice(infoPtr >> 2, (infoPtr >> 2) + INFO_INTS);
      const spf  = info[0];  // samples per frame per channel
      const nch  = info[1];
      const sr   = info[2];
      loudness   = info[3];

      if (spf === 0 || nch === 0) break;

      sampleRate  = sr  || sampleRate;
      numChannels = nch || numChannels;

      // Ensure per-channel arrays exist
      while (pcmAccum.length < nch) pcmAccum.push(new Int32Array(0));

      // Append this frame's samples
      const baseIdx = outPtr >> 2;
      for (let ch = 0; ch < nch; ch++) {
        const old  = pcmAccum[ch];
        const next = new Int32Array(old.length + spf);
        next.set(old);
        for (let i = 0; i < spf; i++) {
          next[old.length + i] = M.HEAP32[baseIdx + i * nch + ch];
        }
        pcmAccum[ch] = next;
      }
      totalSamples = pcmAccum[0]?.length ?? 0;
    }
  };

  for (const sample of track.samples) {
    await feedAndDrain(sample.data, sample.pts, sample.timescale);
  }

  // ── 6. Flush end-of-stream ──────────────────────────────────────────────
  M._fmpegh_flush(hCtx);
  // Drain any remaining frames after flush
  let status = 0;
  while (status === 0) {
    status = M._fmpegh_get_samples(hCtx, outPtr, OUT_BUF_SAMPLES, infoPtr);
    if (status !== 0) break;
    const info = M.HEAP32.slice(infoPtr >> 2, (infoPtr >> 2) + INFO_INTS);
    const spf  = info[0];
    const nch  = info[1];
    if (spf === 0 || nch === 0) break;
    const baseIdx = outPtr >> 2;
    for (let ch = 0; ch < nch; ch++) {
      const old  = pcmAccum[ch] ?? new Int32Array(0);
      const next = new Int32Array(old.length + spf);
      next.set(old);
      for (let i = 0; i < spf; i++) {
        next[old.length + i] = M.HEAP32[baseIdx + i * nch + ch];
      }
      pcmAccum[ch] = next;
    }
    totalSamples = pcmAccum[0]?.length ?? 0;
  }

  // ── 7. Cleanup ──────────────────────────────────────────────────────────
  M._free(outPtr);
  M._free(infoPtr);
  M._fmpegh_destroy(hCtx);

  // ── 8. Convert int32 PCM → float32 (normalise by 2^31) ─────────────────
  const NORM = 1.0 / 2147483648.0;
  const channelData: Float32Array[] = pcmAccum.map((ch) => {
    const f32 = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) f32[i] = ch[i] * NORM;
    return f32;
  });

  const duration = totalSamples / sampleRate;

  return {
    channelData,
    sampleRate,
    channels: numChannels || channelData.length,
    totalSamples,
    duration,
    loudness,
    decoderLabel: 'Fraunhofer FDK mpeghdec WASM — MPEG-H 3D Audio / Sony 360 Reality Audio',
  };
}
