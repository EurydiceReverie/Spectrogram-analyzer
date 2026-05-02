/**
 * mpegh3daDecoder.ts
 * ------------------
 * TypeScript wrapper around the Ittiam MPEG-H 3D Audio WASM decoder
 * (libmpegh/web_plugin/decode-mpegh3da.js + decode-mpegh3da.wasm).
 *
 * The WASM exposes these C functions via Emscripten:
 *   _MPEGH3DA_Decoder_new()                 → decoder handle (number)
 *   _DS_open()                              → data-source handle (number)
 *   _DS_set_blob(ds, ptr, byteLen)          → void
 *   _DS_close(ds)                           → void
 *   _MPEGH3DA_Decoder_set_source(dec, ds)   → void
 *   _MPEGH3DA_initDecoder(dec)              → status (number)
 *   _MPEGH3DA_Decoder_run(dec, pcmBuf)      → void  (decodes ALL frames)
 *   _MPEGH3DA_Decoder_get_sampFreq(dec)     → number
 *   _MPEGH3DA_Decoder_get_numChans(dec)     → number
 *   _MPEGH3DA_Decoder_get_numDecFrames(dec) → number
 *   _MPEGH3DA_Decoder_get_frameLength(dec)  → number
 *   _MPEGH3DA_Decoder_destroy(dec)          → void
 *   _malloc(size)                           → ptr
 *   _free(ptr)                              → void
 *   HEAPU8                                  → Uint8Array view of WASM memory
 *   HEAPF32                                 → Float32Array view of WASM memory
 */

export interface Mpegh3daResult {
  /** Per-channel Float32Array PCM data (interleaved → de-interleaved) */
  channelData: Float32Array[];
  sampleRate: number;
  channels: number;
  /** Total samples per channel */
  totalSamples: number;
  duration: number;
}

// ─── Module singleton ────────────────────────────────────────────────────────

/** Emscripten Module type — we only type what we use. */
interface EmscriptenModule {
  _MPEGH3DA_Decoder_new(): number;
  _DS_open(): number;
  _DS_set_blob(ds: number, ptr: number, len: number): void;
  _DS_close(ds: number): void;
  _MPEGH3DA_Decoder_set_source(dec: number, ds: number): void;
  _MPEGH3DA_initDecoder(dec: number): number;
  _MPEGH3DA_Decoder_run(dec: number, pcmBuf: number): void;
  _MPEGH3DA_Decoder_get_sampFreq(dec: number): number;
  _MPEGH3DA_Decoder_get_numChans(dec: number): number;
  _MPEGH3DA_Decoder_get_numDecFrames(dec: number): number;
  _MPEGH3DA_Decoder_get_frameLength(dec: number): number;
  _MPEGH3DA_Decoder_destroy(dec: number): void;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
  onRuntimeInitialized?: () => void;
}

let _modulePromise: Promise<EmscriptenModule> | null = null;

/**
 * Lazily load and initialise the WASM module (singleton — loaded once).
 *
 * The Emscripten JS glue lives in `/decode-mpegh3da.js` (served from public/).
 * It attaches itself to `window.Module` and resolves via `onRuntimeInitialized`.
 */
function loadMpegh3daModule(): Promise<EmscriptenModule> {
  if (_modulePromise) return _modulePromise;

  _modulePromise = (async () => {
    // If already loaded (e.g. script tag on page), grab immediately.
    if (typeof (window as any).Module?._MPEGH3DA_Decoder_new === 'function') {
      return (window as any).Module as EmscriptenModule;
    }

    // Pre-fetch the raw WASM binary (no encryption)
    const resp = await fetch('/decode-mpegh3da.wasm');
    const wasmBytes = await resp.arrayBuffer();
    console.log(`[MPEG-H] pre-fetched ${(wasmBytes.byteLength / 1024).toFixed(0)}KB of WASM`);

    // Create blob URL so Emscripten's locateFile can fetch it
    const wasmBlobURL = URL.createObjectURL(new Blob([wasmBytes], { type: "application/wasm" }));

    return await new Promise<EmscriptenModule>((resolve, reject) => {
      // Inject a pre-init hook so we get notified when WASM is ready.
      const prevModule: Partial<EmscriptenModule> =
        (window as any).Module ?? {};

      (window as any).Module = {
        ...prevModule,
        wasmBinary: new Uint8Array(wasmBytes),
        locateFile: (path: string) => path.endsWith('.wasm') ? wasmBlobURL : `/${path}`,
        onRuntimeInitialized() {
          resolve((window as any).Module as EmscriptenModule);
        },
      };

      // Dynamically load the glue script.
      const script = document.createElement('script');
      script.src = '/decode-mpegh3da.js';
      script.async = true;
      script.onerror = () => reject(new Error('Failed to load decode-mpegh3da.js'));
      document.head.appendChild(script);
    });
  })();

  return _modulePromise;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Decode a Sony 360 Reality Audio / MPEG-H 3D Audio file (`.mha1`, `.mhm1`,
 * `.mhas`, `.mp4` with MPEG-H track) using the Ittiam libmpegh WASM decoder.
 *
 * @param arrayBuffer  Raw bytes of the audio file.
 * @returns            De-interleaved Float32 PCM + metadata.
 */
export async function decodeMpegh3da(
  arrayBuffer: ArrayBuffer,
): Promise<Mpegh3daResult> {
  const M = await loadMpegh3daModule();

  const inputBytes = new Uint8Array(arrayBuffer);

  // ── 1. Create decoder & data-source objects ──────────────────────────────
  const decoder = M._MPEGH3DA_Decoder_new();
  const dataSource = M._DS_open();

  // ── 2. Copy compressed audio into WASM heap ──────────────────────────────
  const compPtr = M._malloc(inputBytes.byteLength);
  M.HEAPU8.set(inputBytes, compPtr);
  M._DS_set_blob(dataSource, compPtr, inputBytes.byteLength);
  M._MPEGH3DA_Decoder_set_source(decoder, dataSource);

  // ── 3. Init — reads stream header ────────────────────────────────────────
  // Per Ittiam reference: small non-zero "warning" codes are OK for MP4 input,
  // but FATAL codes (high 16 bits = 0xFFFF, i.e. negative-as-uint32) mean the
  // bitstream cannot be parsed. Continuing past a fatal init produces sr=0/ch=0
  // garbage, so we surface a clear error instead.
  const initStatus = M._MPEGH3DA_initDecoder(decoder) >>> 0;
  console.log(`[Ittiam] _MPEGH3DA_initDecoder status: 0x${initStatus.toString(16)}`);
  // 0xFFFF**** are IA_FATAL_ERROR codes (Ittiam IA error convention).
  if ((initStatus & 0xFFFF0000) === 0xFFFF0000) {
    M._free(compPtr);
    M._DS_close(dataSource);
    M._MPEGH3DA_Decoder_destroy(decoder);
    throw new Error(
      `[Ittiam] _MPEGH3DA_initDecoder returned fatal error 0x${initStatus.toString(16)} ` +
      `— bitstream not recognised as MPEG-H 3D Audio. Try the Fraunhofer decoder.`
    );
  }

  // ── 4. Probe: run once to get stream parameters ──────────────────────────
  // Exact match to Ittiam reference: allocate with DEFAULT values FIRST,
  // then run decoder to fill actual values.
  const SIZE_OF_FLOAT32 = 4;
  const PCM_WORD_SIZE = 2; // matches reference demo
  // Use same defaults as reference: num_frames=12000, frame_length=1024, num_chans=1
  let numFrames    = 12000;
  let frameLength  = 1024;
  let numChans     = 1;

  // Allocate with initial defaults (same as reference)
  let numElements = frameLength * numChans * PCM_WORD_SIZE * numFrames;
  let audioBufPtr = M._malloc(numElements * SIZE_OF_FLOAT32);

  // Run once to fill header metadata (exact reference pattern)
  M._MPEGH3DA_Decoder_run(decoder, audioBufPtr);

  // Read actual stream parameters after first run
  const sampFreq    = M._MPEGH3DA_Decoder_get_sampFreq(decoder);
  const actualChans = M._MPEGH3DA_Decoder_get_numChans(decoder);
  const actualFrames= M._MPEGH3DA_Decoder_get_numDecFrames(decoder);
  const actualFrameLength = M._MPEGH3DA_Decoder_get_frameLength(decoder);

  console.log(`[Ittiam] Stream: ${sampFreq}Hz · ${actualChans}ch · ${actualFrames} frames · frameLen=${actualFrameLength}`);

  // ── 5. If actual parameters differ from defaults, reallocate and re-run ──
  const neededElements = actualFrameLength * actualChans * PCM_WORD_SIZE * actualFrames;
  const neededBytes    = neededElements * SIZE_OF_FLOAT32;
  const allocatedBytes = numElements * SIZE_OF_FLOAT32;

  if (neededBytes > allocatedBytes || actualChans > numChans || actualFrames > numFrames) {
    M._free(audioBufPtr);
    audioBufPtr = M._malloc(neededBytes);

    // Re-create fresh decoder and re-run with correct buffer size
    M._DS_close(dataSource);
    M._MPEGH3DA_Decoder_destroy(decoder);

    const decoder2    = M._MPEGH3DA_Decoder_new();
    const dataSource2 = M._DS_open();
    M._DS_set_blob(dataSource2, compPtr, inputBytes.byteLength);
    M._MPEGH3DA_Decoder_set_source(decoder2, dataSource2);
    M._MPEGH3DA_initDecoder(decoder2);
    M._MPEGH3DA_Decoder_run(decoder2, audioBufPtr);
    M._DS_close(dataSource2);
    M._MPEGH3DA_Decoder_destroy(decoder2);

    numChans    = actualChans;
    numFrames   = actualFrames;
    frameLength = actualFrameLength;
  } else {
    // First run decoded everything correctly — just close/destroy
    M._DS_close(dataSource);
    M._MPEGH3DA_Decoder_destroy(decoder);
    numChans    = actualChans;
    numFrames   = actualFrames;
    frameLength = actualFrameLength;
  }

  // Validate we got real data
  if (sampFreq <= 0 || numChans <= 0 || numFrames <= 0) {
    M._free(audioBufPtr);
    M._free(compPtr);
    throw new Error(`[Ittiam] Decoder returned invalid parameters: sr=${sampFreq} ch=${numChans} frames=${numFrames}`);
  }

  // ── 6. De-interleave PCM from WASM HEAPF32 ──────────────────────────────
  //    WASM layout: interleaved [ch0, ch1, ..., chN, ch0, ch1, ...]
  //    Each sample index: audioBufPtr + (frame * numChans + chan) * 4
  const totalSamples = numFrames * frameLength;

  const channelData: Float32Array[] = Array.from(
    { length: numChans },
    () => new Float32Array(totalSamples),
  );

  const heapF32 = M.HEAPF32;
  const baseIdx = audioBufPtr >> 2; // byte ptr → float32 index

  for (let i = 0; i < totalSamples; i++) {
    for (let ch = 0; ch < numChans; ch++) {
      channelData[ch][i] = heapF32[baseIdx + i * numChans + ch];
    }
  }

  // ── 7. Cleanup WASM heap ─────────────────────────────────────────────────
  M._free(audioBufPtr);
  M._free(compPtr);

  return {
    channelData,
    sampleRate: sampFreq,
    channels: numChans,
    totalSamples,
    duration: totalSamples / sampFreq,
  };
}
