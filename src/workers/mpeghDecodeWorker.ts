/**
 * mpeghDecodeWorker.ts
 * --------------------
 * Web Worker that runs MPEG-H decoding off the main thread.
 * Supports both Ittiam (libmpegh) and Fraunhofer (mpeghdec) decoders.
 *
 * Messages IN  (from main thread):
 *   { type: 'decode', decoder: 'ittiam'|'fraunhofer', buffer: ArrayBuffer, cicpSetup?: number }
 *
 * Messages OUT (to main thread):
 *   { type: 'progress', percent: number }
 *   { type: 'result',   result: DecodedAudio }
 *   { type: 'error',    message: string }
 */

// We re-use the same result shape as wasmDecoders.ts
export interface WorkerDecodedAudio {
  channelData: Float32Array[];
  sampleRate: number;
  bitDepth: number;
  channels: number;
  duration: number;
  decoderUsed: string;
}

// ─── Ittiam path (already works — uses existing decode-mpegh3da.wasm) ─────────

async function runIttiam(buffer: ArrayBuffer): Promise<WorkerDecodedAudio> {
  // In a Worker we cannot use document, so we load the WASM module differently.
  // Emscripten glue supports importScripts() in Worker context.
  (self as any).Module = {
    locateFile: (path: string) => `/${path}`,
  };
  (self as any).importScripts('/decode-mpegh3da.js');

  await new Promise<void>((resolve) => {
    if ((self as any).Module?.runtimeInitialized) { resolve(); return; }
    const prev = (self as any).Module.onRuntimeInitialized;
    (self as any).Module.onRuntimeInitialized = () => { if (prev) prev(); resolve(); };
  });

  const M = (self as any).Module;

  const inputBytes = new Uint8Array(buffer);
  const SIZE_OF_FLOAT32 = 4;
  const PCM_WORD_SIZE   = 2;
  const PROBE_FRAMES    = 12000;
  const PROBE_LEN       = 1024;
  const MAX_CH          = 32;

  const decoder    = M._MPEGH3DA_Decoder_new();
  const dataSource = M._DS_open();
  const compPtr    = M._malloc(inputBytes.byteLength);
  M.HEAPU8.set(inputBytes, compPtr);
  M._DS_set_blob(dataSource, compPtr, inputBytes.byteLength);
  M._MPEGH3DA_Decoder_set_source(decoder, dataSource);
  const initStatus = M._MPEGH3DA_initDecoder(decoder);
  if (initStatus !== 0) throw new Error(`MPEGH3DA_initDecoder failed: ${initStatus}`);

  const probeBufSize = PROBE_LEN * MAX_CH * PCM_WORD_SIZE * PROBE_FRAMES * SIZE_OF_FLOAT32;
  let audioBufPtr = M._malloc(probeBufSize);
  M._MPEGH3DA_Decoder_run(decoder, audioBufPtr);

  const sampFreq   = M._MPEGH3DA_Decoder_get_sampFreq(decoder);
  const numChans   = M._MPEGH3DA_Decoder_get_numChans(decoder);
  const numFrames  = M._MPEGH3DA_Decoder_get_numDecFrames(decoder);
  const frameLen   = M._MPEGH3DA_Decoder_get_frameLength(decoder);

  (self as any).postMessage({ type: 'progress', percent: 50 });

  const neededBytes = frameLen * numChans * PCM_WORD_SIZE * numFrames * SIZE_OF_FLOAT32;
  if (neededBytes > probeBufSize) {
    M._free(audioBufPtr);
    audioBufPtr = M._malloc(neededBytes);
    M._DS_close(dataSource);
    M._MPEGH3DA_Decoder_destroy(decoder);
    const dec2 = M._MPEGH3DA_Decoder_new();
    const ds2  = M._DS_open();
    M._DS_set_blob(ds2, compPtr, inputBytes.byteLength);
    M._MPEGH3DA_Decoder_set_source(dec2, ds2);
    M._MPEGH3DA_initDecoder(dec2);
    M._MPEGH3DA_Decoder_run(dec2, audioBufPtr);
    M._DS_close(ds2);
    M._MPEGH3DA_Decoder_destroy(dec2);
  } else {
    M._DS_close(dataSource);
    M._MPEGH3DA_Decoder_destroy(decoder);
  }

  // Validate stream parameters BEFORE allocating per-channel arrays.
  // sr=0/ch=0/frames=0 = decoder failed silently; produce a clear error
  // instead of returning an empty channelData array (which crashes analyzeAudio).
  if (sampFreq <= 0 || numChans <= 0 || numFrames <= 0 || frameLen <= 0) {
    M._free(audioBufPtr);
    M._free(compPtr);
    throw new Error(
      `[Ittiam] decoder produced no PCM (sr=${sampFreq}, ch=${numChans}, frames=${numFrames}, frameLen=${frameLen}). ` +
      `Bitstream not recognised — try the Fraunhofer decoder.`
    );
  }

  const totalSamples = numFrames * frameLen;
  const channelData: Float32Array[] = Array.from({ length: numChans }, () => new Float32Array(totalSamples));
  const baseIdx = audioBufPtr >> 2;
  for (let i = 0; i < totalSamples; i++) {
    for (let ch = 0; ch < numChans; ch++) {
      channelData[ch][i] = M.HEAPF32[baseIdx + i * numChans + ch];
    }
  }

  M._free(audioBufPtr);
  M._free(compPtr);

  (self as any).postMessage({ type: 'progress', percent: 100 });

  return {
    channelData,
    sampleRate: sampFreq,
    bitDepth: 24,
    channels: numChans,
    duration: totalSamples / sampFreq,
    decoderUsed: 'Ittiam libmpegh WASM — MPEG-H 3D Audio / Sony 360 Reality Audio',
  };
}

// ─── Fraunhofer path ──────────────────────────────────────────────────────────

async function runFraunhofer(buffer: ArrayBuffer, cicpSetup: number): Promise<WorkerDecodedAudio> {
  // Load glue script (Emscripten MODULARIZE=1 exports FraunhoferMpeghModule factory)
  (self as any).importScripts('/fraunhofer-mpegh.js');

  const factory = (self as any).FraunhoferMpeghModule;
  if (typeof factory !== 'function') throw new Error('FraunhoferMpeghModule not found');

  const M = await factory({ locateFile: (p: string) => `/${p}` });

  (self as any).postMessage({ type: 'progress', percent: 10 });

  // --- Extract MP4 samples using lightweight box parser in Worker context ---
  const track = extractMpeghTrack(buffer);
  if (!track || track.samples.length === 0) {
    throw new Error('No MPEG-H samples found in MP4 container — file may be raw MHAS (try Ittiam) or have an unsupported container layout');
  }
  console.log(`[Worker/Fraunhofer] codec=${track.codec}, samples=${track.samples.length}, mhaConfig=${track.mhaConfig ? track.mhaConfig.byteLength + ' bytes' : 'NONE (mha1 may fail without config)'}`);

  (self as any).postMessage({ type: 'progress', percent: 20 });

  const MAX_CH   = 28;
  const MAX_SPF  = 3072;
  const OUT_SAMP = MAX_CH * MAX_SPF;
  const INFO_N   = 6;

  const hCtx   = M._fmpegh_create(cicpSetup);
  const outPtr  = M._malloc(OUT_SAMP * 4);
  const infoPtr = M._malloc(INFO_N * 4);

  // ── For mha1 streams: wrap config + every audio frame in MHAS packets ───
  // The Fraunhofer FDK's _fmpegh_feed always understands MHAS framing
  // (ISO/IEC 23008-3 §14.4). Raw mha1 samples are NOT MHAS-framed — they're
  // bare mpegh3daFrame() bitstreams. So when set_config fails (we observed
  // status=-1 on this build of the decoder), wrap manually:
  //   PACTYP_MPEGH3DACFG (=1)   contains mpegh3daConfig
  //   PACTYP_MPEGH3DAFRAME (=2) contains mpegh3daFrame (one per audio sample)
  let prependedConfig: Uint8Array | null = null;
  let useMhasWrapping = false;

  // ── Set out-of-band ASC config (REQUIRED for mha1 — config sits in mhaC,
  // not in the sample stream). For mhm1 the config is inline so this is a no-op.
  //
  // mhaC payload layout (ISO/IEC 23008-3 §20.6 MHADecoderConfigurationRecord):
  //   [0]    configurationVersion         (uint8, =1)
  //   [1]    mpegh3daProfileLevelIndication (uint8)
  //   [2]    referenceChannelLayout       (uint8, CICP)
  //   [3-4]  mpegh3daConfigLength         (uint16 BE)
  //   [5..]  mpegh3daConfig[mpegh3daConfigLength]  ← the actual ASC bytes
  //
  // The Fraunhofer FDK API may want either the full record or just the inner
  // mpegh3daConfig. Try both: the full payload first, then the inner config.
  if (track.mhaConfig && track.mhaConfig.byteLength >= 5) {
    const cfg = track.mhaConfig;
    const innerLen   = (cfg[3] << 8) | cfg[4];
    const innerStart = 5;
    const innerEnd   = innerStart + innerLen;
    const haveInner  = innerEnd <= cfg.byteLength && innerLen > 0;

    // Attempt #1 — full mhaC record (configurationVersion + … + mpegh3daConfig)
    const trySetConfig = (bytes: Uint8Array, label: string): number => {
      const ptr = M._malloc(bytes.byteLength);
      M.HEAPU8.set(bytes, ptr);
      const status = M._fmpegh_set_config(hCtx, ptr, bytes.byteLength);
      M._free(ptr);
      console.log(`[Worker/Fraunhofer] _fmpegh_set_config(${label}, ${bytes.byteLength} bytes) → ${status}`);
      return status;
    };

    let cfgStatus = trySetConfig(cfg, 'full mhaC record');
    if (cfgStatus !== 0 && haveInner) {
      // Attempt #2 — only the inner mpegh3daConfig bitstream
      cfgStatus = trySetConfig(cfg.slice(innerStart, innerEnd), 'inner mpegh3daConfig');
    }
    if (cfgStatus !== 0 && track.codec === 'mha1' && haveInner) {
      // Attempt #3 — fall back to MHAS wrapping. Build a PACTYP_MPEGH3DACFG
      // packet from the inner mpegh3daConfig and prepend it to the first audio
      // sample, and wrap every audio frame in PACTYP_MPEGH3DAFRAME (=2). This
      // is the ONLY format Fraunhofer's _fmpegh_feed is guaranteed to understand
      // when set_config is rejected.
      const innerCfg = cfg.slice(innerStart, innerEnd);
      // MHAS streams MUST begin with a PACTYP_SYNC (=6) packet whose payload is
      // a single byte = MHAS_SYNC_BYTE (0xA5). This is what every MPEG-H decoder
      // (Ittiam IA_MPEGH and Fraunhofer FDK aacDecoder TT_MHAS_PACKETIZED) latches
      // onto to recognise the framing — without it, parsers report
      // 3DACONFIG_DATA_NOT_FOUND (0xFFFF9005) or just produce 0 channels.
      const syncPacket = buildMhasPacket(/* PACTYP_SYNC */ 6, new Uint8Array([0xA5]));
      const cfgPacket  = buildMhasPacket(/* PACTYP_MPEGH3DACFG */ 1, innerCfg);
      const head = new Uint8Array(syncPacket.byteLength + cfgPacket.byteLength);
      head.set(syncPacket, 0);
      head.set(cfgPacket, syncPacket.byteLength);
      prependedConfig = head;
      useMhasWrapping = true;
      console.log(`[Worker/Fraunhofer] [v3] set_config rejected — switching to MHAS frame wrapping (sync ${syncPacket.byteLength}B + cfg ${cfgPacket.byteLength}B = ${head.byteLength}B prefix)`);
    } else if (cfgStatus !== 0) {
      console.warn(`[Worker/Fraunhofer] All set_config attempts failed (last status=${cfgStatus}). Decoder may still try to parse the config from inline samples.`);
    }
  } else if (track.codec === 'mha1') {
    console.warn('[Worker/Fraunhofer] mha1 file but no mhaC config found — decode is likely to fail with 0 channels');
  }

  const samples = track.samples;

  const pcmAccum: Int32Array[] = [];
  let sampleRate  = 48000;
  let numChannels = 0;
  let loudness    = -1;
  let totalSamples = 0;
  const total = samples.length;

  for (let si = 0; si < samples.length; si++) {
    const s = samples[si];

    // Build the bytes to feed. When MHAS wrapping is active (mha1 + set_config
    // rejected), wrap the raw mpegh3daFrame in a PACTYP_MPEGH3DAFRAME packet
    // and, on the first sample, prepend the PACTYP_MPEGH3DACFG packet.
    let feedBytes: Uint8Array;
    if (useMhasWrapping) {
      const framePacket = buildMhasPacket(/* PACTYP_MPEGH3DAFRAME */ 2, s.data);
      if (si === 0 && prependedConfig) {
        feedBytes = new Uint8Array(prependedConfig.byteLength + framePacket.byteLength);
        feedBytes.set(prependedConfig, 0);
        feedBytes.set(framePacket, prependedConfig.byteLength);
      } else {
        feedBytes = framePacket;
      }
    } else {
      feedBytes = s.data;
    }

    const inPtr = M._malloc(feedBytes.byteLength);
    M.HEAPU8.set(feedBytes, inPtr);
    const ptsLo = s.pts >>> 0;
    const ptsHi = Math.floor(s.pts / 0x100000000) >>> 0;
    M._fmpegh_feed(hCtx, inPtr, feedBytes.byteLength, ptsLo, ptsHi, s.timescale);
    M._free(inPtr);

    let st = 0;
    while (st === 0) {
      st = M._fmpegh_get_samples(hCtx, outPtr, OUT_SAMP, infoPtr);
      if (st !== 0) break;
      const info = M.HEAP32.slice(infoPtr >> 2, (infoPtr >> 2) + INFO_N);
      const spf = info[0], nch = info[1], sr = info[2];
      loudness = info[3];
      if (spf === 0 || nch === 0) break;
      sampleRate  = sr || sampleRate;
      numChannels = nch;
      while (pcmAccum.length < nch) pcmAccum.push(new Int32Array(0));
      const base = outPtr >> 2;
      for (let ch = 0; ch < nch; ch++) {
        const old = pcmAccum[ch];
        const next = new Int32Array(old.length + spf);
        next.set(old);
        for (let i = 0; i < spf; i++) next[old.length + i] = M.HEAP32[base + i * nch + ch];
        pcmAccum[ch] = next;
      }
      totalSamples = pcmAccum[0]?.length ?? 0;
    }

    const pct = 20 + Math.round((si / total) * 70);
    (self as any).postMessage({ type: 'progress', percent: pct });
  }

  M._fmpegh_flush(hCtx);
  let st = 0;
  while (st === 0) {
    st = M._fmpegh_get_samples(hCtx, outPtr, OUT_SAMP, infoPtr);
    if (st !== 0) break;
    const info = M.HEAP32.slice(infoPtr >> 2, (infoPtr >> 2) + INFO_N);
    const spf = info[0], nch = info[1];
    if (spf === 0 || nch === 0) break;
    const base = outPtr >> 2;
    for (let ch = 0; ch < nch; ch++) {
      const old = pcmAccum[ch] ?? new Int32Array(0);
      const next = new Int32Array(old.length + spf);
      next.set(old);
      for (let i = 0; i < spf; i++) next[old.length + i] = M.HEAP32[base + i * nch + ch];
      pcmAccum[ch] = next;
    }
    totalSamples = pcmAccum[0]?.length ?? 0;
  }

  M._free(outPtr);
  M._free(infoPtr);
  M._fmpegh_destroy(hCtx);

  // Validate output BEFORE we hand it back — never return an empty channelData
  // array (that would crash analyzeAudio with "Cannot read properties of undefined").
  if (pcmAccum.length === 0 || totalSamples === 0 || !pcmAccum[0] || pcmAccum[0].length === 0) {
    throw new Error(
      `[Fraunhofer] decoder produced no PCM samples ` +
      `(channels=${pcmAccum.length}, samples=${totalSamples}, sr=${sampleRate}). ` +
      `The MPEG-H bitstream may be encrypted, malformed, or use an unsupported profile.`
    );
  }

  const NORM = 1.0 / 2147483648.0;
  const channelData: Float32Array[] = pcmAccum.map((ch) => {
    const f32 = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) f32[i] = ch[i] * NORM;
    return f32;
  });

  (self as any).postMessage({ type: 'progress', percent: 100 });

  return {
    channelData,
    sampleRate,
    bitDepth: 24,
    channels: numChannels || channelData.length,
    duration: totalSamples / sampleRate,
    decoderUsed: `Fraunhofer FDK mpeghdec WASM — MPEG-H 3D Audio / Sony 360 Reality Audio (${numChannels}ch, loudness: ${loudness === -1 ? 'N/A' : (loudness * -0.25).toFixed(2) + ' LKFS'})`,
  };
}

// ─── MHAS packet builder (ISO/IEC 23008-3 §14.4) ─────────────────────────────
// MHAS packets carry MPEG-H config / audio frames as escape-coded byte streams.
// Used to wrap raw mha1 samples for decoders that only consume MHAS framing.
//
// Packet layout:
//   mhasPacketType    : escapedValue(3, 8, 8)    // 1=CFG, 2=FRAME, etc.
//   mhasPacketLabel   : escapedValue(2, 8, 32)   // 0 (default)
//   mhasPacketLength  : escapedValue(11, 24, 24) // payload length in bytes
//   mhasPacketPayload : byte[mhasPacketLength]
//   byte align (zero pad to next byte boundary)
function buildMhasPacket(packetType: number, payload: Uint8Array): Uint8Array {
  // Worst-case bit count: 3+8+8 + 2+8+32 + 11+24+24 = 120 bits (15 bytes header)
  const bits: number[] = [];
  const writeBits = (value: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  // escapedValue(nBits, mBits, kBits)
  const writeEscaped = (value: number, nBits: number, mBits: number, kBits: number) => {
    const nMax = (1 << nBits) - 1;
    if (value < nMax) { writeBits(value, nBits); return; }
    writeBits(nMax, nBits);
    let rem = value - nMax;
    const mMax = (1 << mBits) - 1;
    if (rem < mMax) { writeBits(rem, mBits); return; }
    writeBits(mMax, mBits);
    rem -= mMax;
    writeBits(rem, kBits);
  };
  writeEscaped(packetType, 3, 8, 8);
  writeEscaped(/* packetLabel */ 0, 2, 8, 32);
  writeEscaped(payload.byteLength, 11, 24, 24);

  // Header bytes
  const headerBytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] ?? 0);
    headerBytes.push(b);
  }
  const out = new Uint8Array(headerBytes.length + payload.byteLength);
  out.set(headerBytes, 0);
  out.set(payload, headerBytes.length);
  return out;
}

// ─── Minimal MP4 sample extractor (no DOM, works in Worker) ──────────────────

interface RawSample { data: Uint8Array; pts: number; timescale: number; }

interface ExtractedTrack {
  samples: RawSample[];
  /** mhaC / DecoderConfigDescriptor (out-of-band ASC) — required for mha1 decoding */
  mhaConfig: Uint8Array | null;
  codec: string;
}

// Backwards-compatible wrapper used by Fraunhofer path.
function extractSamplesFromBuffer(buf: ArrayBuffer): RawSample[] {
  const t = extractMpeghTrack(buf);
  return t ? t.samples : [];
}

function extractMpeghTrack(buf: ArrayBuffer): ExtractedTrack | null {
  // We use a very small hand-rolled MP4 parser that understands:
  // ftyp → moov → trak → mdia → minf → stbl → stts/stsc/stsz/stco/co64/ctts
  // This is enough for Sony 360 RA .m4a files (single MPEG-H track).
  const view = new DataView(buf);
  const u8   = new Uint8Array(buf);
  const len  = buf.byteLength;

  function readBox(offset: number): { type: string; start: number; end: number } | null {
    if (offset + 8 > len) return null;
    let size = view.getUint32(offset);
    const type = String.fromCharCode(u8[offset+4], u8[offset+5], u8[offset+6], u8[offset+7]);
    if (size === 1) {
      // 64-bit size
      size = view.getUint32(offset + 8) * 0x100000000 + view.getUint32(offset + 12);
    }
    if (size === 0) size = len - offset;
    return { type, start: offset, end: offset + size };
  }

  function findBox(data: Uint8Array, startOff: number, endOff: number, target: string): { start: number; end: number } | null {
    let off = startOff;
    while (off < endOff) {
      if (off + 8 > endOff) break;
      let size = (data[off] << 24 | data[off+1] << 16 | data[off+2] << 8 | data[off+3]) >>> 0;
      const t = String.fromCharCode(data[off+4], data[off+5], data[off+6], data[off+7]);
      if (size === 0) size = endOff - off;
      if (size < 8) break;
      if (t === target) return { start: off, end: off + size };
      off += size;
    }
    return null;
  }

  // Find moov (skip stub moovs that contain no trak — common in progressive MP4)
  let off = 0;
  let moov: { start: number; end: number } | null = null;
  while (off < len) {
    const box = readBox(off);
    if (!box) break;
    if (box.type === 'moov') {
      const hasTrak = findBox(u8, box.start + 8, box.end, 'trak');
      if (hasTrak) { moov = box; break; }
    }
    off = box.end;
  }
  if (!moov) { console.warn('[Worker/MP4] No moov found'); return null; }

  // Walk ALL trak boxes — pick the one whose stsd FourCC is mha1/mhm1.
  // The first trak may be video/text/hint and skipping straight to it would
  // make the decoder feed on non-MPEG-H samples → 0 channels output.
  const moovData = u8;
  let mdiaBox: { start: number; end: number } | null = null;
  let trakBoxOuter: { start: number; end: number } | null = null;
  let codecFourCC = '';
  let mhaConfig: Uint8Array | null = null;
  let trackId = -1;

  let trakScan = moov.start + 8;
  while (trakScan + 8 <= moov.end) {
    const trakBox = findBox(moovData, trakScan, moov.end, 'trak');
    if (!trakBox) break;
    const candMdia = findBox(moovData, trakBox.start + 8, trakBox.end, 'mdia');
    if (candMdia) {
      // Look up stsd inside this trak and check the codec FourCC.
      const candMinf = findBox(moovData, candMdia.start + 8, candMdia.end, 'minf');
      const candStbl = candMinf && findBox(moovData, candMinf.start + 8, candMinf.end, 'stbl');
      const candStsd = candStbl && findBox(moovData, candStbl.start + 8, candStbl.end, 'stsd');
      if (candStsd) {
        // Scan ALL stsd entries (not just the first), since some files put
        // mha1/mhm1 after a placeholder.
        const entryCount = view.getUint32(candStsd.start + 12);
        let eOff = candStsd.start + 16;
        for (let ei = 0; ei < entryCount && eOff + 8 < len; ei++) {
          const eSize = view.getUint32(eOff);
          if (eSize < 8) break;
          const codec = String.fromCharCode(u8[eOff+4], u8[eOff+5], u8[eOff+6], u8[eOff+7]);
          if (codec === 'mha1' || codec === 'mhm1') {
            mdiaBox = candMdia;
            trakBoxOuter = trakBox;
            codecFourCC = codec;

            // tkhd → trackId  (so we can match traf.tfhd entries in fragmented MP4)
            const tkhdBox = findBox(moovData, trakBox.start + 8, trakBox.end, 'tkhd');
            if (tkhdBox) {
              const v = view.getUint8(tkhdBox.start + 8);
              trackId = v === 1
                ? view.getUint32(tkhdBox.start + 28)   // version 1: id at +28
                : view.getUint32(tkhdBox.start + 20);  // version 0: id at +20
            }

            // mha1 sample entry layout (ISO 14496-12 + ISO 23008-3):
            //   8 byte box header (size+type)
            //   8 bytes reserved + 2 bytes data_reference_index   (= 10)
            //   8 bytes (reserved/pre_defined for SampleEntry)
            //   2 bytes channelcount
            //   2 bytes samplesize
            //   4 bytes (pre_defined + reserved)
            //   4 bytes samplerate (16.16 fixed)
            //   THEN: child boxes (mhaC, mhaP, etc.)
            const childStart = eOff + 8 + 8 + 8 + 2 + 2 + 4 + 4; // = eOff + 36
            const eEnd = eOff + eSize;
            const mhaC = findBox(moovData, childStart, eEnd, 'mhaC');
            if (mhaC && mhaC.end - mhaC.start > 8) {
              // mhaC layout: 8 byte header, then config payload.
              // First byte is configurationVersion (=1), then mpegh3daProfileLevelIndication,
              // then referenceChannelLayout, then mpegh3daConfigLength + mpegh3daConfig[].
              mhaConfig = u8.slice(mhaC.start + 8, mhaC.end);
            }
            break;
          }
          eOff += eSize;
        }
      }
    }
    if (mdiaBox) break;
    trakScan = trakBox.end;
  }
  // Fallback: no MPEG-H trak found — use first trak's mdia (preserves prior behaviour for unusual files)
  if (!mdiaBox) {
    const firstTrak = findBox(moovData, moov.start + 8, moov.end, 'trak');
    if (!firstTrak) {
      console.warn('[Worker/MP4] No trak found in moov');
      return null;
    }
    mdiaBox = findBox(moovData, firstTrak.start + 8, firstTrak.end, 'mdia');
    if (!mdiaBox) {
      console.warn('[Worker/MP4] First trak has no mdia');
      return null;
    }
    trakBoxOuter = firstTrak;
  }

  // Read timescale from mdhd
  const mdhdBox = findBox(moovData, mdiaBox.start + 8, mdiaBox.end, 'mdhd');
  let timescale = 44100;
  if (mdhdBox) {
    const v = view.getUint8(mdhdBox.start + 8);
    timescale = v === 1
      ? view.getUint32(mdhdBox.start + 20)  // version 1: 64-bit times
      : view.getUint32(mdhdBox.start + 16); // version 0: 32-bit times
  }

  const minfBox = findBox(moovData, mdiaBox.start + 8, mdiaBox.end, 'minf');
  if (!minfBox) { console.warn('[Worker/MP4] No minf'); return null; }
  const stblBox = findBox(moovData, minfBox.start + 8, minfBox.end, 'stbl');
  if (!stblBox) { console.warn('[Worker/MP4] No stbl'); return null; }

  // stts: sample→duration table
  const sttsBox = findBox(moovData, stblBox.start + 8, stblBox.end, 'stts');
  const stszBox = findBox(moovData, stblBox.start + 8, stblBox.end, 'stsz');
  const stscBox = findBox(moovData, stblBox.start + 8, stblBox.end, 'stsc');
  const stcoBox = findBox(moovData, stblBox.start + 8, stblBox.end, 'stco');
  const co64Box = findBox(moovData, stblBox.start + 8, stblBox.end, 'co64');

  // ── Fragmented MP4 path (no stbl tables / sampleCount=0) ────────────────
  // moov is a stub → real samples live in moof/traf/trun referencing mdat data.
  const isFragmented = !stszBox || (!stcoBox && !co64Box) || (() => {
    if (!stszBox) return true;
    const sc = view.getUint32(stszBox.start + 16);
    return sc === 0;
  })();

  if (isFragmented) {
    console.log(`[Worker/MP4] Fragmented MP4 detected — parsing moof/traf/trun for trackId=${trackId}, codec=${codecFourCC}`);
    const fragSamples = extractFragmentedSamples(view, u8, len, trackId, timescale, readBox);
    console.log(`[Worker/MP4] Fragmented extraction: ${fragSamples.length} samples`);
    return { samples: fragSamples, mhaConfig, codec: codecFourCC };
  }

  if (!stszBox || (!stcoBox && !co64Box)) {
    console.warn('[Worker/MP4] Missing stsz/stco/co64 — cannot extract samples');
    return null;
  }

  // Parse stsz — sample sizes
  const stszOff = stszBox.start + 12; // skip version+flags
  const defaultSize = view.getUint32(stszOff);
  const sampleCount = view.getUint32(stszOff + 4);
  const sizes: number[] = [];
  if (defaultSize === 0) {
    for (let i = 0; i < sampleCount; i++) sizes.push(view.getUint32(stszOff + 8 + i * 4));
  } else {
    for (let i = 0; i < sampleCount; i++) sizes.push(defaultSize);
  }

  // Parse stco / co64 — chunk offsets
  const chunkOffsets: number[] = [];
  if (stcoBox) {
    const cnt = view.getUint32(stcoBox.start + 12);
    for (let i = 0; i < cnt; i++) chunkOffsets.push(view.getUint32(stcoBox.start + 16 + i * 4));
  } else if (co64Box) {
    const cnt = view.getUint32(co64Box.start + 12);
    for (let i = 0; i < cnt; i++) {
      const hi = view.getUint32(co64Box.start + 16 + i * 8);
      const lo = view.getUint32(co64Box.start + 20 + i * 8);
      chunkOffsets.push(hi * 0x100000000 + lo);
    }
  }

  // Parse stsc — sample-to-chunk mapping
  const stscOff = stscBox ? stscBox.start + 12 : -1;
  const stscEntries: { firstChunk: number; samplesPerChunk: number }[] = [];
  if (stscBox) {
    const cnt = view.getUint32(stscOff);
    for (let i = 0; i < cnt; i++) {
      stscEntries.push({
        firstChunk: view.getUint32(stscOff + 4 + i * 12),
        samplesPerChunk: view.getUint32(stscOff + 8 + i * 12),
      });
    }
  }

  // Parse stts — decode timestamps
  const dts: number[] = [];
  let curDts = 0;
  if (sttsBox) {
    const cnt = view.getUint32(sttsBox.start + 12);
    for (let i = 0; i < cnt; i++) {
      const count    = view.getUint32(sttsBox.start + 16 + i * 8);
      const duration = view.getUint32(sttsBox.start + 20 + i * 8);
      for (let j = 0; j < count; j++) { dts.push(curDts); curDts += duration; }
    }
  } else {
    for (let i = 0; i < sampleCount; i++) { dts.push(i * 1024); }
  }

  // Resolve sample file offsets from chunk map
  const sampleOffsets: number[] = new Array(sampleCount).fill(0);
  let si = 0;
  for (let ci = 0; ci < chunkOffsets.length && si < sampleCount; ci++) {
    const chunkIdx = ci + 1; // 1-based
    let spc = 1;
    for (let ei = stscEntries.length - 1; ei >= 0; ei--) {
      if (stscEntries[ei].firstChunk <= chunkIdx) { spc = stscEntries[ei].samplesPerChunk; break; }
    }
    let byteOff = chunkOffsets[ci];
    for (let j = 0; j < spc && si < sampleCount; j++, si++) {
      sampleOffsets[si] = byteOff;
      byteOff += sizes[si];
    }
  }

  // Build result
  const result: RawSample[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const off2  = sampleOffsets[i];
    const sz   = sizes[i];
    if (off2 + sz > len) break;
    result.push({
      data: u8.slice(off2, off2 + sz),
      pts: dts[i] ?? i * 1024,
      timescale,
    });
  }
  console.log(`[Worker/MP4] Classic extraction: ${result.length} samples (codec=${codecFourCC}, mhaC=${mhaConfig ? mhaConfig.byteLength + ' bytes' : 'none'})`);
  return { samples: result, mhaConfig, codec: codecFourCC };
}

// ── Fragmented MP4 sample extraction (moof / traf / tfhd / trun + mdat) ────
// ISO/IEC 14496-12 §8.8. Each `moof` box describes one fragment. For each track
// fragment (`traf`):
//   tfhd: track id + default sample size/duration
//   tfdt: base media decode time (optional)
//   trun: per-sample size, duration, flags relative to data_offset
// Sample data lives at moof.start + data_offset (or in mdat, but offset is from moof).
function extractFragmentedSamples(
  view: DataView,
  u8: Uint8Array,
  len: number,
  wantTrackId: number,
  timescale: number,
  readBox: (offset: number) => { type: string; start: number; end: number } | null,
): RawSample[] {
  const out: RawSample[] = [];
  let off = 0;
  while (off + 8 <= len) {
    const box = readBox(off);
    if (!box) break;
    if (box.type === 'moof') {
      parseMoof(box.start, Math.min(box.end, len));
    }
    off = box.end;
    if (box.end <= box.start) break;
  }
  return out;

  function findBoxIn(start: number, end: number, target: string): { start: number; end: number } | null {
    let o = start;
    while (o + 8 <= end && o < len) {
      const s = (u8[o] << 24 | u8[o+1] << 16 | u8[o+2] << 8 | u8[o+3]) >>> 0;
      if (s < 8) break;
      const t = String.fromCharCode(u8[o+4], u8[o+5], u8[o+6], u8[o+7]);
      if (t === target) return { start: o, end: o + s };
      o += s;
    }
    return null;
  }

  function parseMoof(moofStart: number, moofEnd: number) {
    // Walk all traf children
    let p = moofStart + 8;
    while (p + 8 <= moofEnd) {
      const traf = findBoxIn(p, moofEnd, 'traf');
      if (!traf) break;
      parseTraf(moofStart, traf.start, Math.min(traf.end, moofEnd));
      p = traf.end;
    }
  }

  function parseTraf(moofStart: number, trafStart: number, trafEnd: number) {
    // tfhd — required, has trackId
    const tfhd = findBoxIn(trafStart + 8, trafEnd, 'tfhd');
    if (!tfhd) return;
    const tfhdFlags = (u8[tfhd.start + 9] << 16 | u8[tfhd.start + 10] << 8 | u8[tfhd.start + 11]) >>> 0;
    let p = tfhd.start + 12;
    const tfhdTrackId = view.getUint32(p); p += 4;
    if (wantTrackId !== -1 && tfhdTrackId !== wantTrackId) return;
    let baseDataOffset = moofStart;        // default-base-is-moof default
    let defaultSampleDuration = 0;
    let defaultSampleSize = 0;
    if (tfhdFlags & 0x000001) { // base-data-offset-present (uint64)
      const hi = view.getUint32(p); const lo = view.getUint32(p + 4); p += 8;
      baseDataOffset = hi * 0x100000000 + lo;
    }
    if (tfhdFlags & 0x000002) { p += 4; }                    // sample-description-index
    if (tfhdFlags & 0x000008) { defaultSampleDuration = view.getUint32(p); p += 4; }
    if (tfhdFlags & 0x000010) { defaultSampleSize     = view.getUint32(p); p += 4; }
    // 0x000020 default-sample-flags — skip

    // tfdt — base media decode time (optional)
    let baseMediaDecodeTime = 0;
    const tfdt = findBoxIn(trafStart + 8, trafEnd, 'tfdt');
    if (tfdt) {
      const v = u8[tfdt.start + 8];
      if (v === 1) {
        const hi = view.getUint32(tfdt.start + 12);
        const lo = view.getUint32(tfdt.start + 16);
        baseMediaDecodeTime = hi * 0x100000000 + lo;
      } else {
        baseMediaDecodeTime = view.getUint32(tfdt.start + 12);
      }
    }

    // Walk all trun boxes (a traf can have multiple)
    let trunOff = trafStart + 8;
    let curDts = baseMediaDecodeTime;
    while (trunOff + 8 <= trafEnd) {
      const trun = findBoxIn(trunOff, trafEnd, 'trun');
      if (!trun) break;
      const trunFlags = (u8[trun.start + 9] << 16 | u8[trun.start + 10] << 8 | u8[trun.start + 11]) >>> 0;
      let q = trun.start + 12;
      const sampleCount = view.getUint32(q); q += 4;
      let dataOffset = 0;
      if (trunFlags & 0x000001) { dataOffset = view.getInt32(q); q += 4; }
      if (trunFlags & 0x000004) { q += 4; } // first-sample-flags
      let runOffset = baseDataOffset + dataOffset;

      for (let i = 0; i < sampleCount; i++) {
        let sampleDuration = defaultSampleDuration;
        let sampleSize     = defaultSampleSize;
        if (trunFlags & 0x000100) { sampleDuration = view.getUint32(q); q += 4; }
        if (trunFlags & 0x000200) { sampleSize     = view.getUint32(q); q += 4; }
        if (trunFlags & 0x000400) { q += 4; } // sample-flags
        if (trunFlags & 0x000800) { q += 4; } // sample-composition-time-offset
        if (sampleSize > 0 && runOffset + sampleSize <= len) {
          out.push({
            data: u8.slice(runOffset, runOffset + sampleSize),
            pts: curDts,
            timescale,
          });
          runOffset += sampleSize;
          curDts += sampleDuration;
        }
      }
      trunOff = trun.end;
    }
  }
}

// ─── Worker message handler ───────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent) => {
  const { type, decoder, buffer, cicpSetup } = e.data;
  if (type !== 'decode') return;

  try {
    let result: WorkerDecodedAudio;
    if (decoder === 'fraunhofer') {
      result = await runFraunhofer(buffer, cicpSetup ?? 0);
    } else {
      result = await runIttiam(buffer);
    }
    // Transfer Float32Array buffers for zero-copy
    const transferables = result.channelData.map((ch) => ch.buffer);
    (self as any).postMessage({ type: 'result', result }, transferables);
  } catch (err: any) {
    (self as any).postMessage({ type: 'error', message: err?.message ?? String(err) });
  }
};
