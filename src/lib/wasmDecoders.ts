import { decodeMpegh3da } from './mpegh3daDecoder';
import { decodeMpeghTestbench } from './mpeghTestbenchDecoder';
import { decodeFraunhoferCli } from './fraunhoferTestbenchDecoder';
import { decodeMpeghInWorker } from './mpeghWorkerClient';
import type { MpeghDecoderChoice } from '../components/MpeghDecoderDialog';

/**
 * Format-specific audio decoders — all WASM-based, no Web Audio API
 *
 * Strategy:
 *  FLAC / MQA          → @wasm-audio-decoders/flac   (libFLAC WASM, bit-perfect, LSBs preserved)
 *  MP3                 → mpg123-decoder WASM          (libmpg123 WASM, native SR)
 *  OGG Vorbis          → @wasm-audio-decoders/ogg-vorbis (libvorbis WASM)
 *  WAV                 → manual binary parse           (zero resampling, all bit depths)
 *  AIFF                → manual binary parse           (zero resampling, big-endian PCM)
 *  M4A / MP4 (ALAC)    → mp4box.js + binary PCM        (lossless, native SR)
 *  M4A / MP4 (AAC)     → mp4box.js + @ffmpeg WASM      (AAC decode to PCM)
 *  AC-3 / E-AC-3 / EC-3 / AC-4 / IMS → @ffmpeg WASM  (Dolby/Atmos to multichannel PCM)
 *  Sony 360RA (mha1)   → detection only                (proprietary, cannot decode)
 *  WMA / APE / WV / DSD → @ffmpeg WASM fallback
 */

export interface DecodedAudio {
  channelData: Float32Array[];
  sampleRate: number;
  bitDepth: number;
  channels: number;
  duration: number;
  decoderUsed: string;
  rawIntSamples?: Int32Array[]; // Raw integer PCM for MQA detection (preserves exact LSBs)
}

// ─────────────────────────────────────────────────────────────────────────────
// FLAC — libflacjs (libFLAC compiled to WASM via emscripten)
// Bit-perfect output at native sample rate. LSBs preserved for MQA detection.
// Handles 8/16/20/24-bit, any sample rate (44.1/48/88.2/96/176.4/192/384 kHz)
// ─────────────────────────────────────────────────────────────────────────────
// Singleton Flac instance — initialized once, reused for all FLAC/MQA decodes
let _flacInstance: any = null;
let _flacLoading: Promise<any> | null = null;

export async function getFlac(): Promise<any> {
  if (_flacInstance) return _flacInstance;
  if (_flacLoading) return _flacLoading;

  _flacLoading = (async () => {
    // Load libflacjs by injecting a <script> tag pointing to the public folder.
    // This completely bypasses Vite bundling/transformation — the UMD module
    // sets window.Flac directly, preserving the full API including isReady().
    async function loadFlacScript(scriptUrl: string, globalKey: string): Promise<any> {
      return new Promise((resolve, reject) => {
        // If already loaded from a previous attempt
        if ((window as any)[globalKey]?.create_libflac_decoder) {
          resolve((window as any)[globalKey]); return;
        }
        const script = document.createElement("script");
        script.src = scriptUrl;
        script.onload = () => {
          const Flac = (window as any)[globalKey];
          if (!Flac || typeof Flac.create_libflac_decoder !== "function") {
            reject(new Error(`${scriptUrl}: window.${globalKey}.create_libflac_decoder not found after script load`));
            return;
          }
          // Wait for WASM ready if needed
          if (typeof Flac.isReady === "function" && Flac.isReady()) {
            resolve(Flac); return;
          }
          if (typeof Flac.isReady === "function") {
            const prev = Flac.onready;
            Flac.onready = (event: any) => {
              if (prev) prev(event);
              resolve(Flac);
            };
            setTimeout(() => reject(new Error(`${scriptUrl}: WASM ready timeout`)), 20000);
            return;
          }
          // asm.js — synchronous init, already ready
          resolve(Flac);
        };
        script.onerror = () => reject(new Error(`Failed to load script: ${scriptUrl}`));
        document.head.appendChild(script);
      });
    }

    let Flac: any = null;

    // 1) Try asm.js from public/ — fully self-contained, no .wasm fetch needed
    //    The UMD script sets window.Flac
    try {
      Flac = await loadFlacScript("/libflac.min.js", "Flac");
      console.log("[libflacjs] Loaded asm.js variant from public/libflac.min.js");
    } catch (e1) {
      console.warn("[libflacjs] asm.js script failed:", e1);
      // 2) Try WASM variant from public/ — also sets window.Flac
      try {
        // Clear any partial state
        delete (window as any).Flac;
        Flac = await loadFlacScript("/libflac.min.wasm.js", "Flac");
        console.log("[libflacjs] Loaded WASM variant from public/libflac.min.wasm.js");
      } catch (e2) {
        console.warn("[libflacjs] WASM script also failed:", e2);
        throw new Error("libflacjs: all variants failed to load");
      }
    }

    _flacInstance = Flac;
    return Flac;
  })();

  try {
    return await _flacLoading;
  } catch (e) {
    _flacLoading = null;
    throw e;
  }
}

export async function decodeFLAC(arrayBuffer: ArrayBuffer): Promise<DecodedAudio> {
  const Flac = await getFlac();

  const binData = new Uint8Array(arrayBuffer);
  let sampleRate = 0;
  let bitDepth = 0;
  let numChannels = 0;

  // libflacjs decoder write_callback signature:
  //   write_callback(data: Uint8Array[], frameInfo: BlockMetadata)
  // data is an Array of Uint8Array — ONE per channel (NOT interleaved)
  // Each Uint8Array contains raw signed integer samples for that channel
  // (little-endian, same bit depth as the FLAC file)
  const channelBlocks: Uint8Array[][] = []; // [blockIndex][channelIndex]

  let currentOffset = 0;
  const fileSize = binData.byteLength;

  function read_callback(bufferSize: number) {
    const end = currentOffset >= fileSize ? -1 : Math.min(currentOffset + bufferSize, fileSize);
    if (end === -1) return { buffer: new Uint8Array(0), readDataLength: 0, error: false };
    const chunk = binData.subarray(currentOffset, end);
    currentOffset = end;
    return { buffer: chunk, readDataLength: chunk.length, error: false };
  }

  let writeCallCount = 0;
  function write_callback(data: Uint8Array[], frameInfo: any) {
    // data = Array<Uint8Array>, one per channel, raw little-endian signed PCM at native bit depth
    if (Array.isArray(data) && data.length > 0) {
      const copied = data.map(ch => ch.slice(0));
      channelBlocks.push(copied);

      writeCallCount++;
    }
    if (frameInfo && sampleRate === 0) {
      sampleRate   = frameInfo.sampleRate   || frameInfo.sample_rate  || sampleRate;
      numChannels  = frameInfo.channels                               || numChannels;
      bitDepth     = frameInfo.bitsPerSample || frameInfo.bits_per_sample || bitDepth;
    }
    if (numChannels === 0 && Array.isArray(data)) numChannels = data.length;
  }

  function metadata_callback(meta: any) {
    if (meta) {
      sampleRate  = meta.sampleRate  || meta.sample_rate   || sampleRate;
      numChannels = meta.channels                          || numChannels;
      bitDepth    = meta.bitsPerSample || meta.bits_per_sample || bitDepth;
    }
  }

  function error_callback(err: number, msg: string) {
    console.warn("[libflacjs] decode error:", err, msg);
  }

  const decoder = Flac.create_libflac_decoder(false);
  if (!decoder) throw new Error("libflacjs: failed to create decoder");

  const initStatus = Flac.init_decoder_stream(
    decoder, read_callback, write_callback, error_callback, metadata_callback, false
  );
  if (initStatus !== 0) throw new Error(`libflacjs: init_decoder_stream failed (${initStatus})`);

  Flac.FLAC__stream_decoder_process_until_end_of_stream(decoder);
  Flac.FLAC__stream_decoder_finish(decoder);
  Flac.FLAC__stream_decoder_delete(decoder);

  if (channelBlocks.length === 0) throw new Error("libflacjs: no PCM data decoded");

  // Ensure we have valid metadata
  const bps = bitDepth || 16;
  const nch = numChannels || (channelBlocks[0]?.length ?? 2);
  const sr  = sampleRate || 44100;
  const scale = Math.pow(2, bps - 1);

  // Pick stride that produces a standard FLAC block size (4096, 2048, 1024, 8192).
  // libflacjs uses: 1 byte for 8-bit, 2 bytes for 16-bit, 4 bytes for 24-bit.
  const STANDARD_BLOCKS = new Set([512, 1024, 2048, 4096, 8192]);
  const candidateStrides = bps <= 8 ? [1] : bps <= 16 ? [2, 4, 3] : [4, 3, Math.ceil(bps / 8)];

  let bytesPerSampleActual = candidateStrides[0];
  const firstBlockLen = channelBlocks[0]?.[0]?.byteLength ?? 0;

  for (const stride of candidateStrides) {
    if (firstBlockLen % stride !== 0) continue;
    const framesPerBlock = firstBlockLen / stride;
    if (STANDARD_BLOCKS.has(framesPerBlock)) {
      bytesPerSampleActual = stride;
      break;
    }
  }

  // Calculate total frames
  let totalFrames = 0;
  for (const block of channelBlocks) {
    if (block[0]) totalFrames += Math.floor(block[0].byteLength / bytesPerSampleActual);
  }

  // Decode all blocks
  const channelData: Float32Array[] = Array.from({ length: nch }, () => new Float32Array(totalFrames));
  const rawIntSamples: Int32Array[] = Array.from({ length: nch }, () => new Int32Array(totalFrames));
  let framePos = 0;
  for (const block of channelBlocks) {
    const framesInBlock = block[0] ? Math.floor(block[0].byteLength / bytesPerSampleActual) : 0;
    for (let ch = 0; ch < nch; ch++) {
      const chBuf = block[ch];
      if (!chBuf) continue;
      const view = new DataView(chBuf.buffer, chBuf.byteOffset, chBuf.byteLength);
      for (let f = 0; f < framesInBlock; f++) {
        const bytePos = f * bytesPerSampleActual;
        let raw = 0;
        if (bytesPerSampleActual === 1) raw = view.getInt8(bytePos);
        else if (bytesPerSampleActual === 2) raw = view.getInt16(bytePos, true);
        else if (bytesPerSampleActual === 3) {
          const lo = view.getUint8(bytePos), mi = view.getUint8(bytePos + 1), hi = view.getInt8(bytePos + 2);
          raw = (hi << 16) | (mi << 8) | lo;
        }
        else if (bytesPerSampleActual === 4) raw = view.getInt32(bytePos, true);
        if (framePos + f < totalFrames) {
          channelData[ch][framePos + f] = raw / scale;
          rawIntSamples[ch][framePos + f] = raw;
        }
      }
    }
    framePos += framesInBlock;
  }

  const framesPerBlock = firstBlockLen / bytesPerSampleActual;
  console.log(`[libflacjs] bps=${bps}, stride=${bytesPerSampleActual}, framesPerBlock=${framesPerBlock}, blocks=${channelBlocks.length}, totalFrames=${totalFrames}`);

  if (channelData.length === 0 || channelData[0].length === 0) {
    throw new Error(`libflacjs: no PCM data decoded (${bps}-bit, ${sr} Hz, ${nch}ch, blocks=${channelBlocks.length})`);
  }

  return {
    channelData,
    sampleRate: sr,
    bitDepth: bps,
    channels: nch,
    duration: (channelData[0]?.length ?? 0) / sr,
    decoderUsed: `libFLAC.js WASM (libflacjs v5 · ${bps}-bit · ${sr} Hz · bit-perfect)`,
    rawIntSamples,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MP3 — mpg123-decoder WASM
// ─────────────────────────────────────────────────────────────────────────────
export async function decodeMP3(arrayBuffer: ArrayBuffer): Promise<DecodedAudio> {
  const { MPEGDecoderWebWorker } = await import("mpg123-decoder");
  const decoder = new MPEGDecoderWebWorker();
  await decoder.ready;

  const uint8 = new Uint8Array(arrayBuffer);
  const decoded = await decoder.decode(uint8);
  await decoder.free();

  const { channelData, sampleRate } = decoded;
  const duration = channelData[0].length / sampleRate;

  return {
    channelData: Array.from(channelData),
    sampleRate,
    bitDepth: 16,
    channels: channelData.length,
    duration,
    decoderUsed: "mpg123 (WASM)",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// OGG Vorbis — @wasm-audio-decoders/ogg-vorbis
// ─────────────────────────────────────────────────────────────────────────────
export async function decodeOggVorbis(arrayBuffer: ArrayBuffer): Promise<DecodedAudio> {
  const { OggVorbisDecoder } = await import("@wasm-audio-decoders/ogg-vorbis");
  const decoder = new OggVorbisDecoder();
  await decoder.ready;

  const uint8 = new Uint8Array(arrayBuffer);
  const decoded = await decoder.decode(uint8);
  await decoder.free();

  const { channelData, sampleRate } = decoded;
  const duration = channelData[0].length / sampleRate;

  return {
    channelData: Array.from(channelData),
    sampleRate,
    bitDepth: 16,
    channels: channelData.length,
    duration,
    decoderUsed: "libvorbis (WASM)",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Opus — opus-decoder WASM (raw Opus frames) + FFmpeg WASM for OGG/Opus container
// opus-decoder v0.7 exports: OpusDecoder (raw frames), OpusDecoderWebWorker
// .opus files are OGG-containerized — use FFmpeg WASM to decode those
// ─────────────────────────────────────────────────────────────────────────────
export async function decodeOpus(arrayBuffer: ArrayBuffer): Promise<DecodedAudio> {
  try {
    // .opus files use OGG container — FFmpeg handles this reliably
    // OpusDecoder only handles raw Opus frames (no OGG container stripping)
    return await decodeWithFFmpeg(arrayBuffer, "opus", 48000, 16, 2, 0);
  } catch (err) {
    console.warn("[OpusDecoder] FFmpeg failed, trying raw OpusDecoder:", err);
    try {
      const opusMod = await import("opus-decoder");
      const DecoderCls = (opusMod as any).OpusDecoderWebWorker ?? (opusMod as any).OpusDecoder;
      const decoder = new DecoderCls() as any;
      await decoder.ready;

      const uint8 = new Uint8Array(arrayBuffer);
      // OpusDecoder uses decodeFrame for raw frames; use decode if available
      const decoded = typeof decoder.decode === "function"
        ? await decoder.decode(uint8)
        : await decoder.decodeFrame(uint8);
      await decoder.free();

      const { channelData, sampleRate } = decoded;
      const duration = channelData[0].length / sampleRate;

      return {
        channelData: Array.from(channelData),
        sampleRate,
        bitDepth: 16,
        channels: channelData.length,
        duration,
        decoderUsed: "opus-decoder WASM (raw Opus frames)",
      };
    } catch (err2) {
      console.warn("[OpusDecoder] all decoders failed:", err2);
      return {
        channelData: [new Float32Array(48000), new Float32Array(48000)],
        sampleRate: 48000, bitDepth: 16, channels: 2, duration: 0,
        decoderUsed: "Opus decode failed",
      };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WAV — manual binary parse (no AudioContext, no resampling)
// Supports: PCM 8/16/24/32-bit int, 32/64-bit float, any sample rate
// ─────────────────────────────────────────────────────────────────────────────
export async function decodeWAV(arrayBuffer: ArrayBuffer): Promise<DecodedAudio> {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);

  // Validate RIFF header
  if (bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) {
    throw new Error("Not a valid WAV file");
  }

  // Find fmt chunk
  let fmtOffset = -1;
  let dataOffset = -1;
  let dataSize = 0;
  let pos = 12;

  while (pos < arrayBuffer.byteLength - 8) {
    const tag = String.fromCharCode(bytes[pos], bytes[pos+1], bytes[pos+2], bytes[pos+3]);
    const size = view.getUint32(pos + 4, true);
    if (tag === "fmt ") fmtOffset = pos + 8;
    if (tag === "data") { dataOffset = pos + 8; dataSize = size; break; }
    pos += 8 + size + (size % 2); // word-align
  }

  if (fmtOffset < 0 || dataOffset < 0) throw new Error("WAV fmt/data chunk not found");

  const audioFormat = view.getUint16(fmtOffset, true);     // 1=PCM, 3=IEEE float, 65534=extensible
  const channels    = view.getUint16(fmtOffset + 2, true);
  const sampleRate  = view.getUint32(fmtOffset + 4, true);
  const bitDepth    = view.getUint16(fmtOffset + 14, true);
  const isFloat     = audioFormat === 3 || (audioFormat === 65534 && bitDepth === 32);

  const bytesPerSample = bitDepth / 8;
  const numFrames = Math.floor(dataSize / (channels * bytesPerSample));

  // Build per-channel Float32Arrays — use fast typed array paths where possible
  const channelData: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(numFrames));

  if (isFloat && bitDepth === 32) {
    // IEEE 754 float32 LE — fastest path: use Float32Array view directly
    const interleaved = new Float32Array(arrayBuffer, dataOffset, numFrames * channels);
    for (let ch = 0; ch < channels; ch++) {
      const out = channelData[ch];
      for (let f = 0; f < numFrames; f++) out[f] = interleaved[f * channels + ch];
    }
  } else if (bitDepth === 16) {
    // 16-bit PCM LE — use Int16Array for fast bulk read
    const interleaved = new Int16Array(arrayBuffer, dataOffset, numFrames * channels);
    const scale = 1 / 32768;
    for (let ch = 0; ch < channels; ch++) {
      const out = channelData[ch];
      for (let f = 0; f < numFrames; f++) out[f] = interleaved[f * channels + ch] * scale;
    }
  } else if (bitDepth === 24) {
    // 24-bit PCM LE — no native typed array, but optimized byte access
    const scale = 1 / 8388608;
    const data8 = new Uint8Array(arrayBuffer, dataOffset, numFrames * channels * 3);
    for (let f = 0; f < numFrames; f++) {
      for (let ch = 0; ch < channels; ch++) {
        const pos = (f * channels + ch) * 3;
        const lo = data8[pos], mi = data8[pos + 1], hi = data8[pos + 2];
        // Sign-extend from 24-bit
        const raw = (hi & 0x80) ? ((hi << 16) | (mi << 8) | lo) - 0x1000000 : ((hi << 16) | (mi << 8) | lo);
        channelData[ch][f] = raw * scale;
      }
    }
  } else if (bitDepth === 32 && !isFloat) {
    // 32-bit PCM LE — use Int32Array
    const interleaved = new Int32Array(arrayBuffer, dataOffset, numFrames * channels);
    const scale = 1 / 2147483648;
    for (let ch = 0; ch < channels; ch++) {
      const out = channelData[ch];
      for (let f = 0; f < numFrames; f++) out[f] = interleaved[f * channels + ch] * scale;
    }
  } else if (isFloat && bitDepth === 64) {
    // 64-bit float LE — use Float64Array
    const interleaved = new Float64Array(arrayBuffer, dataOffset, numFrames * channels);
    for (let ch = 0; ch < channels; ch++) {
      const out = channelData[ch];
      for (let f = 0; f < numFrames; f++) out[f] = interleaved[f * channels + ch];
    }
  } else if (bitDepth === 8) {
    // 8-bit unsigned PCM
    const data8 = new Uint8Array(arrayBuffer, dataOffset, numFrames * channels);
    const scale = 1 / 128;
    for (let ch = 0; ch < channels; ch++) {
      const out = channelData[ch];
      for (let f = 0; f < numFrames; f++) out[f] = (data8[f * channels + ch] - 128) * scale;
    }
  } else {
    // Fallback: slow DataView path for exotic bit depths
    for (let frame = 0; frame < numFrames; frame++) {
      for (let ch = 0; ch < channels; ch++) {
        const bytePos = dataOffset + (frame * channels + ch) * bytesPerSample;
        channelData[ch][frame] = view.getInt16(bytePos, true) / 32768;
      }
    }
  }

  return {
    channelData,
    sampleRate,
    bitDepth,
    channels,
    duration: numFrames / sampleRate,
    decoderUsed: `WAV binary parser (${bitDepth}-bit${isFloat ? " float" : " PCM"} · ${channels}ch · ${sampleRate}Hz · zero-copy)`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AIFF — manual binary parse (no AudioContext, no resampling)
// Supports: PCM 8/16/24/32-bit, any sample rate
// ─────────────────────────────────────────────────────────────────────────────
export async function decodeAIFF(arrayBuffer: ArrayBuffer): Promise<DecodedAudio> {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);

  if (bytes[0] !== 0x46 || bytes[1] !== 0x4F || bytes[2] !== 0x52 || bytes[3] !== 0x4D) {
    throw new Error("Not a valid AIFF file");
  }

  let channels = 0, numFrames = 0, bitDepth = 0, sampleRate = 0;
  let ssndOffset = -1;
  let pos = 12;

  while (pos < arrayBuffer.byteLength - 8) {
    const tag = String.fromCharCode(bytes[pos], bytes[pos+1], bytes[pos+2], bytes[pos+3]);
    const size = view.getInt32(pos + 4, false);

    if (tag === "COMM") {
      channels  = view.getInt16(pos + 8, false);
      numFrames = view.getUint32(pos + 10, false);
      bitDepth  = view.getInt16(pos + 14, false);
      // 80-bit IEEE 754 extended precision sample rate (big-endian)
      // exponent: bits 79-64, biased by 16383; mantissa: upper 32 bits of 64-bit int
      const expBiased = view.getUint16(pos + 16, false) & 0x7FFF;
      const mantHigh  = view.getUint32(pos + 18, false);
      const shift = expBiased - 16383 - 31;
      sampleRate = Math.round(shift >= 0
        ? mantHigh * Math.pow(2, shift)
        : mantHigh / Math.pow(2, -shift));
    }

    if (tag === "SSND") {
      const offset = view.getUint32(pos + 8, false);
      ssndOffset = pos + 16 + offset; // skip offset + blockSize fields
    }

    pos += 8 + size + (size % 2);
  }

  if (ssndOffset < 0 || channels === 0) throw new Error("AIFF COMM/SSND chunk not found");

  const bytesPerSample = bitDepth / 8;
  const channelData: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(numFrames));

  // AIFF is always big-endian — optimized paths for each bit depth
  const data8 = new Uint8Array(arrayBuffer, ssndOffset, numFrames * channels * bytesPerSample);

  if (bitDepth === 16) {
    const scale = 1 / 32768;
    for (let f = 0; f < numFrames; f++) {
      for (let ch = 0; ch < channels; ch++) {
        const pos = (f * channels + ch) * 2;
        // Big-endian int16
        const val = ((data8[pos] << 8) | data8[pos + 1]) << 16 >> 16; // sign-extend
        channelData[ch][f] = val * scale;
      }
    }
  } else if (bitDepth === 24) {
    const scale = 1 / 8388608;
    for (let f = 0; f < numFrames; f++) {
      for (let ch = 0; ch < channels; ch++) {
        const pos = (f * channels + ch) * 3;
        const hi = data8[pos], mi = data8[pos + 1], lo = data8[pos + 2];
        // Big-endian sign-extend 24-bit
        const raw = (hi & 0x80) ? ((hi << 16) | (mi << 8) | lo) - 0x1000000 : ((hi << 16) | (mi << 8) | lo);
        channelData[ch][f] = raw * scale;
      }
    }
  } else if (bitDepth === 32) {
    const scale = 1 / 2147483648;
    for (let f = 0; f < numFrames; f++) {
      for (let ch = 0; ch < channels; ch++) {
        const pos = (f * channels + ch) * 4;
        // Big-endian int32
        const val = ((data8[pos] << 24) | (data8[pos+1] << 16) | (data8[pos+2] << 8) | data8[pos+3]) | 0;
        channelData[ch][f] = val * scale;
      }
    }
  } else if (bitDepth === 8) {
    const scale = 1 / 128;
    for (let f = 0; f < numFrames; f++) {
      for (let ch = 0; ch < channels; ch++) {
        const pos = (f * channels + ch);
        channelData[ch][f] = ((data8[pos] << 24) >> 24) * scale; // sign-extend 8-bit
      }
    }
  } else {
    // Fallback
    for (let f = 0; f < numFrames; f++) {
      for (let ch = 0; ch < channels; ch++) {
        const pos = (f * channels + ch) * 2;
        const val = ((data8[pos] << 8) | data8[pos + 1]) << 16 >> 16;
        channelData[ch][f] = val / 32768;
      }
    }
  }

  return {
    channelData,
    sampleRate,
    bitDepth,
    channels,
    duration: numFrames / sampleRate,
    decoderUsed: `AIFF binary parser (${bitDepth}-bit PCM · big-endian · ${channels}ch · ${sampleRate}Hz)`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sniff the codec inside an M4A/MP4 container by properly walking MP4 boxes
// to find the stsd (sample description) box and reading the codec FourCC.
// This avoids false positives from text in ID tags matching codec names.
// ─────────────────────────────────────────────────────────────────────────────
function sniffM4ACodec(arrayBuffer: ArrayBuffer): string | null {
  // Read up to 4MB — moov box can be at the END of large M4A/MP4 files (Qt/streaming layout)
  const READ = Math.min(arrayBuffer.byteLength, 4 * 1024 * 1024);
  const u8 = new Uint8Array(arrayBuffer, 0, READ);
  // DataView must reference the SAME region — create a sliced buffer to avoid offset issues
  const slicedBuf = arrayBuffer.byteLength > READ ? arrayBuffer.slice(0, READ) : arrayBuffer;
  const dv = new DataView(slicedBuf);

  function boxType(off: number): string {
    if (off + 8 > READ) return "";
    return String.fromCharCode(u8[off+4], u8[off+5], u8[off+6], u8[off+7]);
  }
  function boxSize(off: number): number {
    if (off + 4 > READ) return 0;
    const s = dv.getUint32(off);
    if (s === 0) return READ - off;
    if (s === 1 && off + 16 <= READ) return Number(dv.getBigUint64(off + 8));
    return s;
  }
  function findBox(start: number, end: number, type: string): number {
    let o = start;
    while (o + 8 <= end && o < READ) {
      const s = boxSize(o);
      if (s < 8) break;
      if (boxType(o) === type) return o;
      o += s;
    }
    return -1;
  }

  // Walk: moov → trak → mdia → minf → stbl → stsd → codec entry
  // Some files have a small stub/fake 'moov' at the start (progressive download hint)
  // followed by the real moov later. Find the moov that actually contains trak children.
  let moov = -1;
  let moovEnd = 0;
  let searchOff = 0;
  while (searchOff < READ) {
    const candidate = findBox(searchOff, READ, "moov");
    if (candidate < 0) break;
    const candidateEnd = Math.min(candidate + boxSize(candidate), READ);
    // Verify this moov has at least one 'trak' child
    const hasTrak = findBox(candidate + 8, candidateEnd, "trak") >= 0;
    if (hasTrak) {
      moov = candidate;
      moovEnd = candidateEnd;
      break;
    }
    // Stub moov — skip and continue
    searchOff = candidateEnd > searchOff + 8 ? candidateEnd : searchOff + 8;
  }

  if (moov < 0) {
    // Fragmented MP4 / non-standard layout: no trak in moov.
    // Raw scan for 'stsd' anywhere in the read buffer (handles fragmented MP4).
    // Also scan directly for known audio codec FourCCs as final fallback.
    // Optimized byte scan — search for 's' (0x73) of 'stsd', then verify full FourCC
    for (let i = 4; i < READ - 8; i++) {
      // Fast path: check for 'stsd' type
      if (u8[i] === 0x73 && u8[i+1] === 0x74 && u8[i+2] === 0x73 && u8[i+3] === 0x64) {
        const eStart = (i - 4) + 16; // stsdBoxStart + 16
        if (eStart + 8 < READ) {
          const codec2 = String.fromCharCode(u8[eStart+4], u8[eStart+5], u8[eStart+6], u8[eStart+7]).toLowerCase().trim();
          if (codec2.length === 4) {
            console.log(`[sniffM4ACodec] Raw stsd scan — found codec: "${codec2}"`);
            return codec2;
          }
        }
        break; // only check first stsd
      }
      // Also check directly for known audio codec FourCCs (e.g. mha1 outside stsd)
      const knownFirst: Record<number, string[]> = {
        0x6D: ["mha1","mhm1","mp4a"], // 'm'
        0x61: ["alac","ac-3","ac-4"], // 'a'
        0x65: ["ec-3","enca"],        // 'e'
      };
      const candidates = knownFirst[u8[i]];
      if (candidates) {
        const t = String.fromCharCode(u8[i], u8[i+1], u8[i+2], u8[i+3]);
        if (candidates.includes(t)) {
          const sz = dv.getUint32(i - 4);
          if (sz >= 28 && sz < 1024 * 1024) {
            console.log(`[sniffM4ACodec] Direct codec scan found: "${t}"`);
            return t;
          }
        }
      }
    }
    return null;
  }

  let trakOff = moov + 8;
  while (trakOff + 8 < moovEnd) {
    const trakSize = boxSize(trakOff);
    if (trakSize < 8) break;
    if (boxType(trakOff) === "trak") {
      const trakEnd = Math.min(trakOff + trakSize, moovEnd);
      const mdia = findBox(trakOff + 8, trakEnd, "mdia");
      if (mdia >= 0) {
        const mdiaEnd = Math.min(mdia + boxSize(mdia), trakEnd);
        const minf = findBox(mdia + 8, mdiaEnd, "minf");
        if (minf >= 0) {
          const minfEnd = Math.min(minf + boxSize(minf), mdiaEnd);
          const stbl = findBox(minf + 8, minfEnd, "stbl");
          if (stbl >= 0) {
            const stblEnd = Math.min(stbl + boxSize(stbl), minfEnd);
            const stsd = findBox(stbl + 8, stblEnd, "stsd");
            if (stsd >= 0) {
              // stsd: 4 bytes version/flags + 4 bytes entry count, then codec entry
              const entryOff = stsd + 8 + 8; // skip stsd header + version/flags + count
              if (entryOff + 4 <= READ) {
                // The codec FourCC is the box type of the first entry
                const codec = boxType(entryOff).toLowerCase().trim();
                console.log(`[sniffM4ACodec] Found codec: "${codec}" at stsd entry`);
                return codec || null;
              }
            }
          }
        }
      }
    }
    trakOff += trakSize;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// M4A / MP4 — smart codec detection + appropriate decoder
// Routes:
//   ALAC          → mp4box.js + binary PCM extraction (bit-perfect)
//   AAC           → FFmpeg WASM (decode to f32le PCM)
//   Dolby ac-3/ec-3/ac-4 → FFmpeg WASM (multichannel decode)
//   mha1/mhm1     → MPEG-H WASM decoder (Sony 360RA)
// ─────────────────────────────────────────────────────────────────────────────
export async function decodeM4A(
  arrayBuffer: ArrayBuffer,
  nativeSampleRate: number,
  nativeBitDepth: number,
  nativeChannels: number,
  nativeDuration: number,
): Promise<DecodedAudio> {

  // Step 1: sniff codec from binary BEFORE mp4box (mp4box fails on Dolby boxes)
  const sniffed = sniffM4ACodec(arrayBuffer);
  console.log(`[decodeM4A] sniffed codec: ${sniffed}`);

  // Route Dolby-in-M4A — use Web Native Audio API (MSE) for all Dolby codecs in M4A
  // ac-3/ec-3: use MSE with mp4 container MIME type
  // ac-4: proprietary — MSE if browser supports it, otherwise metadata-only
  if (sniffed === "ac-3" || sniffed === "ec-3") {
    // Route through decodeDolbyFFmpeg so the bitstream parser runs first
    // (corrects channel count, sample rate, and bitrate from EC-3 syncframe header).
    const dolbyExt = sniffed === "ec-3" ? "m4a_ec3" : "m4a_ac3";
    console.log(`[decodeM4A] Dolby ${sniffed}-in-M4A, routing through bitstream-aware Dolby decoder`);
    return await decodeDolbyFFmpeg(arrayBuffer, dolbyExt, nativeSampleRate, nativeChannels, nativeDuration);
  }

  if (sniffed === "ac-4") {
    // AC-4 (Dolby AC-4 / Dolby Atmos IMS) — try Web Native MSE first
    const mimeCodec = 'audio/mp4; codecs="ac-4"';
    console.log(`[decodeM4A] AC-4-in-M4A — trying Web Native Audio API (MSE: ${mimeCodec})`);
    return await decodeDolbyFFmpeg(arrayBuffer, "ac4", nativeSampleRate, nativeChannels, nativeDuration);
  }

  // Route MPEG-H/360RA — caller (decodeAudioFile) handles decoder choice dialog
  // We throw so decodeAudioFile's is360RA path handles it with the right decoder choice
  if (sniffed === "mha1" || sniffed === "mhm1") {
    console.log(`[decodeM4A] MPEG-H/360RA detected (${sniffed}) — re-routing to 360RA decoder`);
    throw new Error(`__360RA__:${sniffed}`); // signal to decodeAudioFile to use decode360RA
  }

  // AAC/mp4a — use mp4box for container parsing + metadata, then FFmpeg for decode
  if (sniffed === "mp4a" || sniffed === "aac " || sniffed === "enca" || sniffed === null) {
    console.log(`[decodeM4A] AAC/mp4a detected (${sniffed}), using mp4box + FFmpeg`);
    return await decodeAACWithMp4box(arrayBuffer, nativeSampleRate, nativeBitDepth, nativeChannels, nativeDuration);
  }

  // ALAC — always use FFmpeg WASM (real ALAC decoder).
  // Note: the legacy `decodeALACWithMp4box` ROUTE was broken — it treated raw
  // compressed ALAC packets as if they were PCM, producing silent output.
  // ALAC is a real lossless codec (rice coding + linear prediction + matrix
  // de-correlation per Apple ALAC spec) — needs an actual decoder. FFmpeg has it.
  //
  // FFmpeg's ISO BMFF demuxer reads sample rate from the AudioSampleEntry's
  // 16.16 fixed-point field, which is capped at 65535 — so 88.2k / 96k /
  // 192k files get reported as 44.1k / 48k. The TRUE sample rate is in the
  // inner `alac` cookie atom — parse it ourselves and override.
  if (sniffed === "alac") {
    const alacCookie = parseAlacCookie(new Uint8Array(arrayBuffer));
    if (alacCookie) {
      console.log(`[decodeM4A] ALAC detected, parsed cookie: sr=${alacCookie.sampleRate} ch=${alacCookie.channels} bits=${alacCookie.bitDepth} — routing to FFmpeg WASM`);
    } else {
      console.log("[decodeM4A] ALAC detected (no cookie found), routing to FFmpeg WASM");
    }
    // Force FFmpeg's audio filter to resample TO the true cookie sample rate.
    // FFmpeg's m4a demuxer reads sample_rate from the AudioSampleEntry's
    // 16.16 fixed-point field (capped at 65535) → for 88.2/96/192k files,
    // FFmpeg decodes ALAC at the cap rate (44.1/48k) producing audio at
    // half/quarter speed. To fix: pass `-af aresample=SR` to upsample to
    // the true rate the cookie reports. Note this is NOT lossless audio
    // resampling, but the playback / analysis sample rate is correct.
    const result = await decodeWithFFmpegALAC(
      arrayBuffer,
      alacCookie?.sampleRate || nativeSampleRate,
      alacCookie?.channels   || nativeChannels,
      alacCookie?.bitDepth   || nativeBitDepth,
      nativeDuration,
    );
    if (alacCookie) {
      result.sampleRate = alacCookie.sampleRate;
      result.bitDepth   = alacCookie.bitDepth;
      result.decoderUsed = `FFmpeg WASM + ALAC cookie (${alacCookie.sampleRate}Hz · ${alacCookie.bitDepth}-bit · ${result.channels}ch · no downmix)`;
    }
    return result;
  }

  // Unknown codec — try FFmpeg which handles everything
  console.log(`[decodeM4A] Unknown codec (${sniffed}), routing to FFmpeg WASM`);
  return await decodeWithFFmpeg(arrayBuffer, "m4a", nativeSampleRate, nativeBitDepth, nativeChannels, nativeDuration);
}

// ─────────────────────────────────────────────────────────────────────────────
// ALAC via mp4box.js — bit-perfect binary PCM extraction
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Decode ALAC via FFmpeg WASM, forcing the output sample rate to the value
 * we parsed from the alac cookie. FFmpeg's m4a demuxer mis-reports >65kHz
 * sample rates due to the 16.16 fixed-point cap in the AudioSampleEntry,
 * so it decodes at half/quarter speed. We use `-af aresample=SR` to upsample
 * the decoded PCM to the TRUE sample rate; the actual ALAC samples are still
 * decoded losslessly, just relabeled with the proper rate.
 */
async function decodeWithFFmpegALAC(
  arrayBuffer: ArrayBuffer,
  trueSampleRate: number,
  trueChannels: number,
  _trueBitDepth: number,
  nativeDuration: number,
): Promise<DecodedAudio> {
  const ffmpeg = await getFFmpeg();
  const inputName = `alac_${Date.now()}.m4a`;
  const outputName = `alac_${Date.now()}.pcm`;
  await ffmpeg.writeFile(inputName, new Uint8Array(arrayBuffer));

  console.log(`[FFmpeg/ALAC] Decoding (${(arrayBuffer.byteLength/1024/1024).toFixed(1)}MB) → forcing sr=${trueSampleRate}Hz ch=${trueChannels}`);

  const args = [
    "-i", inputName,
    "-vn",
    "-af", `aresample=${trueSampleRate}:async=1`,  // upsample to TRUE rate
    "-ar", String(trueSampleRate),                  // label output at TRUE rate
    "-ac", String(trueChannels),                    // preserve channel count
    "-f", "f32le",
    "-acodec", "pcm_f32le",
    outputName,
  ];
  const ret = await ffmpeg.exec(args);
  console.log(`[FFmpeg/ALAC] exec returned: ${ret}`);

  const pcmData = await ffmpeg.readFile(outputName);
  const pcmBytes = pcmData instanceof Uint8Array ? pcmData : new Uint8Array((pcmData as any).buffer ?? pcmData);
  try { await ffmpeg.deleteFile(inputName); } catch {}
  try { await ffmpeg.deleteFile(outputName); } catch {}

  if (pcmBytes.byteLength < 4) throw new Error(`FFmpeg produced empty output for ALAC`);

  const pcmFloat = new Float32Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength / 4);
  const numFrames = Math.floor(pcmFloat.length / trueChannels);
  console.log(`[FFmpeg/ALAC] Decoded ${numFrames} frames × ${trueChannels}ch @ ${trueSampleRate}Hz`);

  const channelData: Float32Array[] = Array.from({ length: trueChannels }, () => new Float32Array(numFrames));
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < trueChannels; c++) {
      channelData[c][i] = pcmFloat[i * trueChannels + c];
    }
  }

  return {
    channelData,
    sampleRate: trueSampleRate,
    bitDepth: 32,
    channels: trueChannels,
    duration: numFrames / trueSampleRate || nativeDuration,
    decoderUsed: `FFmpeg WASM + ALAC (${trueChannels}ch · ${trueSampleRate}Hz)`,
  };
}

/**
 * Parse the ALAC magic cookie atom inside an MP4/M4A buffer to extract the
 * TRUE sample rate, channels, and bit depth.
 *
 * The cookie layout per Apple ALAC spec:
 *   uint32  frameLength             (typically 4096)
 *   uint8   compatibleVersion       (typically 0)
 *   uint8   bitDepth                (16, 20, 24, 32)
 *   uint8   pb (rice tuning)
 *   uint8   mb
 *   uint8   kb
 *   uint8   numChannels             (true channel count)
 *   uint16  maxRun
 *   uint32  maxFrameBytes
 *   uint32  avgBitRate
 *   uint32  sampleRate              (TRUE sample rate, 32-bit big-endian)
 *
 * The cookie is the payload of the inner 'alac' box (24 bytes total).
 * In a typical M4A: the OUTER 'alac' is the AudioSampleEntry (size ~0x48),
 * and the INNER 'alac' is the cookie (size ~0x24). We parse the LATTER.
 */
/**
 * Parse the dec3 (E-AC-3) or dac3 (AC-3) atom inside an MP4/M4A buffer to
 * extract the TRUE channel layout. The AudioSampleEntry's channel_count
 * field is ALWAYS 2 for EAC3-in-M4A (per Dolby spec) — only the dec3 atom
 * has the real channel mapping derived from acmod + lfeon + num_dep_sub.
 *
 * dec3 layout per ETSI TS 102 366 Annex F:
 *   13 bits: data_rate (kbps × 1)
 *    3 bits: num_ind_sub - 1
 *   per independent substream:
 *      2 bits: fscod         (0=48k, 1=44.1k, 2=32k, 3=reserved)
 *      5 bits: bsid
 *      5 bits: bsmod
 *      3 bits: acmod         (0=1+1, 1=1/0, 2=2/0, 3=3/0, 4=2/1, 5=3/1, 6=2/2, 7=3/2)
 *      1 bit:  lfeon
 *      3 bits: reserved
 *      4 bits: num_dep_sub
 *      if num_dep_sub > 0:
 *        9 bits: chan_loc    (each set bit adds one extra channel)
 *
 * dac3 layout per ETSI TS 102 366 Annex F:
 *    2 bits: fscod
 *    5 bits: bsid
 *    3 bits: bsmod
 *    3 bits: acmod
 *    1 bit:  lfeon
 *    5 bits: bit_rate_code
 */
function parseDec3Atom(u8: Uint8Array, isDac3: boolean): { sampleRate: number; channels: number; acmod: number; lfeon: boolean } | null {
  const targetTag = isDac3 ? [0x64, 0x61, 0x63, 0x33] : [0x64, 0x65, 0x63, 0x33]; // "dac3" / "dec3"
  for (let i = 4; i < u8.length - 8; i++) {
    if (u8[i] === targetTag[0] && u8[i+1] === targetTag[1] && u8[i+2] === targetTag[2] && u8[i+3] === targetTag[3]) {
      const sz = (u8[i-4] << 24 | u8[i-3] << 16 | u8[i-2] << 8 | u8[i-1]) >>> 0;
      // Sanity: dec3 is 5-50 bytes, dac3 is exactly 11 bytes
      if (sz < 8 || sz > 100) continue;
      const payloadStart = i + 4;
      const payloadEnd = i - 4 + sz;
      if (payloadEnd > u8.length) continue;

      // Bit reader
      let bitPos = payloadStart * 8;
      const readBits = (n: number): number => {
        let v = 0;
        for (let b = 0; b < n; b++) {
          const byte = u8[bitPos >> 3];
          const bit = (byte >> (7 - (bitPos & 7))) & 1;
          v = (v << 1) | bit;
          bitPos++;
        }
        return v;
      };

      // acmod -> base channel count (front+rear+side, NO LFE)
      const acmodToBaseCh = [2, 1, 2, 3, 3, 4, 4, 5];
      // chan_loc bits add extra channels (each bit set = 1 extra)
      const popcount9 = (v: number): number => { let c = 0; for (let k = 0; k < 9; k++) if (v & (1 << k)) c++; return c; };

      try {
        let totalCh = 0;
        let firstFscod = 0;
        let firstAcmod = 0;
        let firstLfe = false;
        if (isDac3) {
          firstFscod  = readBits(2);
          /* bsid */    readBits(5);
          /* bsmod */   readBits(3);
          firstAcmod  = readBits(3);
          firstLfe    = readBits(1) === 1;
          totalCh     = acmodToBaseCh[firstAcmod] + (firstLfe ? 1 : 0);
        } else {
          /* data_rate */ readBits(13);
          const numIndSub = readBits(3) + 1;
          for (let s = 0; s < numIndSub; s++) {
            const fscod  = readBits(2);
            /* bsid */    readBits(5);
            /* bsmod */   readBits(5);
            const acmod  = readBits(3);
            const lfeon  = readBits(1) === 1;
            /* reserved*/ readBits(3);
            const numDep = readBits(4);
            let extraCh = 0;
            if (numDep > 0) {
              const chanLoc = readBits(9);
              extraCh = popcount9(chanLoc);
            }
            const subCh = acmodToBaseCh[acmod] + (lfeon ? 1 : 0) + extraCh;
            if (s === 0) { firstFscod = fscod; firstAcmod = acmod; firstLfe = lfeon; }
            totalCh += subCh;
          }
        }

        const fscodToSr = [48000, 44100, 32000, 0]; // 3 = reserved
        const sampleRate = fscodToSr[firstFscod] || 48000;
        if (totalCh < 1 || totalCh > 16) return null;
        return { sampleRate, channels: totalCh, acmod: firstAcmod, lfeon: firstLfe };
      } catch { return null; }
    }
  }
  return null;
}

function parseAlacCookie(u8: Uint8Array): { sampleRate: number; channels: number; bitDepth: number } | null {
  // Scan for any 'alac' FourCC (0x61 0x6C 0x61 0x63), then look at the box
  // immediately after it for the cookie. The cookie box starts with 4-byte
  // size header (typically 0x24 = 36 bytes) preceded by another 'alac' tag.
  const limit = u8.length - 36;
  for (let i = 4; i < limit; i++) {
    if (u8[i] === 0x61 && u8[i+1] === 0x6C && u8[i+2] === 0x61 && u8[i+3] === 0x63) {
      // Box size is the 4 bytes BEFORE the FourCC.
      const sz = (u8[i-4] << 24 | u8[i-3] << 16 | u8[i-2] << 8 | u8[i-1]) >>> 0;
      // The cookie box is exactly 36 bytes (0x24): 8 byte header + 28 byte cookie payload.
      if (sz === 0x24 || sz === 36) {
        // Cookie payload starts at i+4 (after the FourCC) + 4 bytes (version+flags) = i+8
        const p = i + 8;
        if (p + 24 > u8.length) continue;
        // Layout (big-endian):
        //   p+0..3  frameLength (4096)
        //   p+4     compatibleVersion
        //   p+5     bitDepth
        //   p+6..8  pb/mb/kb
        //   p+9     numChannels
        //   p+10..11 maxRun
        //   p+12..15 maxFrameBytes
        //   p+16..19 avgBitRate
        //   p+20..23 sampleRate
        const bitDepth   = u8[p + 5];
        const channels   = u8[p + 9];
        const sampleRate = (u8[p + 20] << 24 | u8[p + 21] << 16 | u8[p + 22] << 8 | u8[p + 23]) >>> 0;
        // Sanity check: known-good values
        if ((bitDepth === 16 || bitDepth === 20 || bitDepth === 24 || bitDepth === 32)
            && channels >= 1 && channels <= 32
            && sampleRate >= 8000 && sampleRate <= 768000) {
          return { sampleRate, channels, bitDepth };
        }
      }
    }
  }
  return null;
}

async function decodeALACWithMp4box(
  arrayBuffer: ArrayBuffer,
  nativeSampleRate: number,
  nativeBitDepth: number,
  nativeChannels: number,
  nativeDuration: number,
): Promise<DecodedAudio> {
  const mp4boxModule = await import("mp4box");
  const MP4Box = (mp4boxModule as any).default ?? mp4boxModule;

  // Suppress mp4box BoxParser warnings
  const origError = console.error;
  console.error = (...args: any[]) => {
    const msg = String(args[0] ?? "");
    if (msg.includes("[BoxParser]") || msg.includes("BoxParser")) return;
    origError.apply(console, args);
  };

  const mp4 = MP4Box.createFile();

  const result = await new Promise<{
    sampleRate: number; channels: number; bitDepth: number; samples: Uint8Array[];
  }>((resolve, reject) => {
    let sampleRate = nativeSampleRate;
    let channels = nativeChannels;
    let bitDepth = nativeBitDepth;
    const rawSamples: Uint8Array[] = [];

    mp4.onReady = (info: any) => {
      // Log every track mp4box found so we can diagnose wrong-track-pick bugs.
      const allTracks = (info.tracks ?? []).map((t: any, i: number) =>
        `#${i} id=${t.id} type=${t.type ?? '?'} codec=${t.codec ?? '?'} sr=${t.audio?.sample_rate ?? '?'} ch=${t.audio?.channel_count ?? '?'} bits=${t.audio?.sample_size ?? '?'} samples=${t.nb_samples ?? '?'}`
      );
      console.log(`[ALAC/mp4box] Tracks found:\n  ${allTracks.join('\n  ')}`);

      // Pick the audio track. mp4box's `type` field is unreliable on some MP4
      // brands (e.g. cmfc/hlsf): an ALAC audio track may report `type=metadata`
      // because mp4box doesn't recognise the brand. Override by treating ANY
      // track with codec=alac as audio, regardless of type.
      let audioTrack: any = null;
      const audioCandidates: any[] = [];
      const pool = Array.isArray(info.tracks) ? info.tracks : [];
      for (const t of pool) {
        const isAlacByCodec = /alac/i.test(t.codec ?? '');
        const isAudioByType = t.type === 'audio';
        const isOtherKnownAudio = /mp4a|ac-3|ec-3|ac-4/i.test(t.codec ?? '');
        if (isAlacByCodec || isAudioByType || isOtherKnownAudio) {
          audioCandidates.push(t);
        }
      }

      // Prefer ALAC tracks (lossless), then by sample count (longer = real audio).
      audioCandidates.sort((a, b) => {
        const aIsAlac = /alac/i.test(a.codec ?? '') ? 1 : 0;
        const bIsAlac = /alac/i.test(b.codec ?? '') ? 1 : 0;
        if (aIsAlac !== bIsAlac) return bIsAlac - aIsAlac;
        return (b.nb_samples ?? 0) - (a.nb_samples ?? 0);
      });
      audioTrack = audioCandidates[0];

      if (!audioTrack) {
        const summary = allTracks.join(', ') || '(none)';
        console.warn(`[ALAC/mp4box] No audio track found. ${summary}`);
        reject(new Error(`No audio track`));
        return;
      }

      // mp4box's `type` field is unreliable on certain MP4 brands (cmfc/hlsf).
      // We do NOT refuse based on type — instead we ALWAYS try to extract
      // samples, and parse the alac cookie ourselves for the TRUE sr/ch/bits.
      // mp4box CAN extract samples from "metadata" tracks just fine; the only
      // issue is its claimed sample-entry metadata. We override it.
      const cookie = parseAlacCookie(new Uint8Array(arrayBuffer));
      sampleRate = cookie?.sampleRate || audioTrack.audio?.sample_rate || nativeSampleRate;
      channels   = cookie?.channels   || audioTrack.audio?.channel_count || nativeChannels;
      bitDepth   = cookie?.bitDepth   || audioTrack.audio?.sample_size || nativeBitDepth;
      const cookieNote = cookie ? ` (alac cookie override: sr=${cookie.sampleRate} ch=${cookie.channels} bits=${cookie.bitDepth})` : '';
      console.log(`[ALAC/mp4box] Selected audio track: id=${audioTrack.id} codec=${audioTrack.codec} type=${audioTrack.type} sr=${sampleRate} ch=${channels} bits=${bitDepth} samples=${audioTrack.nb_samples}${cookieNote}`);

      // Sanity check — refuse to extract if the track looks suspiciously short.
      // For ALAC, samples are typically 4096 frames per packet. Use a generous
      // estimate to avoid false positives; the goal is to catch obvious cases.
      const expectedFrames = sampleRate * (nativeDuration || 0);
      const samplesPerPacket = audioTrack.audio?.samples_per_packet || 4096;
      const actualFrames = (audioTrack.nb_samples ?? 0) * samplesPerPacket;
      if (expectedFrames > 0 && actualFrames > 0 && actualFrames < expectedFrames * 0.5) {
        console.warn(`[ALAC/mp4box] Selected track has only ~${actualFrames} frames (${audioTrack.nb_samples} packets × ${samplesPerPacket}) but file should have ~${Math.round(expectedFrames)} — refusing to use, falling back to FFmpeg`);
        reject(new Error(`Suspicious sample count (${actualFrames} vs expected ${Math.round(expectedFrames)})`));
        return;
      }

      mp4.setExtractionOptions(audioTrack.id, null, { nbSamples: Infinity });
      mp4.start();
    };
    mp4.onSamples = (_id: number, _user: any, samples: any[]) => {
      // Collect ALL sample batches — mp4box may fire this multiple times
      for (const s of samples) rawSamples.push(new Uint8Array(s.data));
    };
    mp4.onError = (e: any) => {
      console.error = origError;
      reject(new Error(String(e)));
    };
    // Feed the FULL buffer — moov box may be at the end of file
    const buf = arrayBuffer.slice(0) as any;
    buf.fileStart = 0;
    mp4.appendBuffer(buf);
    // mp4box processes onReady + onSamples SYNCHRONOUSLY during appendBuffer/flush
    // for in-memory buffers. After flush() returns, ALL samples have been delivered.
    mp4.flush();
    // Resolve immediately after flush — all samples are in rawSamples now
    console.error = origError;
    resolve({ sampleRate, channels, bitDepth, samples: rawSamples });
  });

  const { sampleRate, channels, bitDepth, samples } = result;
  if (samples.length === 0) throw new Error("ALAC: no samples extracted");

  const bytesPerSample = Math.max(1, Math.floor(bitDepth / 8));
  let totalFrames = 0;
  for (const s of samples) totalFrames += Math.floor(s.byteLength / (channels * bytesPerSample));

  const chData: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(totalFrames));
  let frame = 0;
  const scale = Math.pow(2, bitDepth - 1);

  for (const s of samples) {
    const view = new DataView(s.buffer, s.byteOffset, s.byteLength);
    const framesInChunk = Math.floor(s.byteLength / (channels * bytesPerSample));
    for (let f = 0; f < framesInChunk; f++) {
      for (let ch = 0; ch < channels; ch++) {
        const pos = (f * channels + ch) * bytesPerSample;
        let val = 0;
        if (bitDepth === 16)      val = view.getInt16(pos, false) / scale;
        else if (bitDepth === 24) { const hi = view.getInt8(pos), mi = view.getUint8(pos+1), lo = view.getUint8(pos+2); val = ((hi<<16)|(mi<<8)|lo) / scale; }
        else if (bitDepth === 32) val = view.getInt32(pos, false) / scale;
        chData[ch][frame] = val;
      }
      frame++;
    }
  }

  return {
    channelData: chData, sampleRate, bitDepth, channels,
    duration: totalFrames / sampleRate,
    decoderUsed: `mp4box.js + ALAC binary PCM (${bitDepth}-bit · bit-perfect)`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AAC via mp4box.js — parses container metadata, then FFmpeg WASM decodes audio
// mp4box gives us real sampleRate, channels, bitDepth from the container header
// ─────────────────────────────────────────────────────────────────────────────
async function decodeAACWithMp4box(
  arrayBuffer: ArrayBuffer,
  nativeSampleRate: number,
  nativeBitDepth: number,
  nativeChannels: number,
  nativeDuration: number,
): Promise<DecodedAudio> {
  // Use mp4box to extract real metadata from the container
  let sampleRate = nativeSampleRate;
  let channels = nativeChannels;
  let bitDepth = nativeBitDepth;

  try {
    const mp4boxModule = await import("mp4box");
    const MP4Box = (mp4boxModule as any).default ?? mp4boxModule;
    const origError = console.error;
    console.error = (...args: any[]) => {
      const msg = String(args[0] ?? "");
      if (msg.includes("[BoxParser]") || msg.includes("BoxParser")) return;
      origError.apply(console, args);
    };
    const mp4 = MP4Box.createFile();
    await new Promise<void>((resolve) => {
      mp4.onReady = (info: any) => {
        const audioTrack = info.tracks?.find((t: any) => t.type === "audio");
        if (audioTrack) {
          const sr = audioTrack.audio?.sample_rate;
          const ch = audioTrack.audio?.channel_count;
          const bd = audioTrack.audio?.sample_size;
          if (sr && sr > 1) sampleRate = sr;
          if (ch && ch > 0) channels = ch;
          if (bd && bd > 0) bitDepth = bd;
        }
        resolve();
      };
      mp4.onError = () => { console.error = origError; resolve(); }; // ignore errors, use native fallbacks
      // Feed FULL buffer — moov may be at end of file
      const buf = arrayBuffer.slice(0) as any;
      buf.fileStart = 0;
      mp4.appendBuffer(buf);
      mp4.flush();
      // 8s should be enough for any file size; mp4box processes synchronously after flush
      setTimeout(() => { console.error = origError; resolve(); }, 8000);
    });
  } catch { /* use native fallbacks */ }

  // Now decode with FFmpeg using the real metadata from mp4box
  return await decodeWithFFmpeg(arrayBuffer, "m4a", sampleRate, bitDepth, channels, nativeDuration);
}

// ─────────────────────────────────────────────────────────────────────────────
// Chrome MSE (MediaSource Extensions) decoder for EC-3 / EAC-3 / AC-3
// Chrome supports Dolby natively — no FFmpeg needed, no downsampling.
// Returns raw multichannel Float32 PCM at native sample rate.
// ─────────────────────────────────────────────────────────────────────────────
async function decodeDolbyMSE(
  arrayBuffer: ArrayBuffer,
  mimeType: string,
  nativeSampleRate: number,
  nativeChannels: number,
  nativeDuration: number,
  /** internal flag — set true after we've already tried fragmentation, to avoid infinite retry */
  alreadyFragmented = false,
): Promise<DecodedAudio> {
  // Browser identification (just for logging — useful when triaging failures)
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "unknown";
  const isEdge   = /Edg\//.test(ua);
  const isChrome = /Chrome\//.test(ua) && !isEdge;
  const browserTag = isEdge ? "Edge" : isChrome ? "Chrome" : "browser";

  // Map MediaError codes to human-readable strings (HTML spec)
  const mediaErrorCodeToString = (code: number): string => {
    switch (code) {
      case 1: return "MEDIA_ERR_ABORTED (fetching aborted)";
      case 2: return "MEDIA_ERR_NETWORK (network error)";
      case 3: return "MEDIA_ERR_DECODE (decode failed — codec/profile likely unsupported by this browser)";
      case 4: return "MEDIA_ERR_SRC_NOT_SUPPORTED (source format not supported by this browser)";
      default: return `unknown MediaError code=${code}`;
    }
  };

  // Check browser MSE support for this MIME type
  const mseSupported = !!window.MediaSource && MediaSource.isTypeSupported(mimeType);
  console.log(`[Dolby/MSE] ${browserTag}: MediaSource.isTypeSupported("${mimeType}") = ${mseSupported}`);
  if (!mseSupported) {
    throw new Error(`MSE: ${mimeType} not supported in ${browserTag} (MediaSource.isTypeSupported returned false)`);
  }

  const sr  = nativeSampleRate || 48000;
  const ch  = nativeChannels  || 2;
  const dur = nativeDuration  || 0;

  // ── Attempt 1: AudioContext.decodeAudioData(arrayBuffer) ─────────────────
  // Most browsers' decodeAudioData ONLY supports AAC for MP4 input. Edge's
  // and Chrome's native EC-3 decoder is NOT exposed via decodeAudioData —
  // only via MediaSource + HTMLMediaElement. So this typically fails for
  // EAC3-JOC with EncodingError on every desktop browser.
  try {
    const audioCtx = new AudioContext({ sampleRate: sr });
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    await audioCtx.close();

    const actualCh = audioBuffer.numberOfChannels;
    const actualSr = audioBuffer.sampleRate;
    const channelData: Float32Array[] = Array.from(
      { length: actualCh },
      (_, c) => audioBuffer.getChannelData(c).slice() // copy to avoid detach
    );

    console.log(`[Dolby/decodeAudioData] ✅ ${mimeType} decoded: ${actualCh}ch @ ${actualSr}Hz · ${audioBuffer.duration.toFixed(2)}s`);
    return {
      channelData,
      sampleRate: actualSr,
      bitDepth: 32,
      channels: actualCh,
      duration: audioBuffer.duration,
      decoderUsed: `Web Native Audio API / decodeAudioData (${mimeType} · ${actualCh}ch · ${actualSr}Hz · no downmix)`,
    };
  } catch (decodeErr) {
    const errName = decodeErr instanceof Error ? decodeErr.name : "Error";
    const errMsg  = decodeErr instanceof Error ? decodeErr.message : String(decodeErr);
    console.warn(`[Dolby/decodeAudioData] ${browserTag} rejected ${mimeType}: ${errName}: ${errMsg}`);
    console.log(`[Dolby/decodeAudioData] (Note: ${browserTag}'s decodeAudioData typically only handles AAC inside MP4. Falling through to MSE+HTMLMediaElement which uses the OS-level Dolby decoder directly.)`);
  }

  // ── Attempt 2: MSE + HTMLMediaElement + ScriptProcessor ──────────────────
  // This is the "correct" path on Edge/Chrome for native EAC3 decode. The
  // HTMLMediaElement uses the OS-level Dolby decoder (Edge has it on Win10+).
  return new Promise<DecodedAudio>((resolve, reject) => {
    const mediaSource = new MediaSource();
    const audio = document.createElement("audio");
    audio.style.display = "none";
    audio.preload = "auto";          // critical: tell Edge to actually try parsing
    audio.muted = true;              // allow autoplay without user gesture
    document.body.appendChild(audio);

    let settled = false;
    const cleanup = () => {
      try { audio.pause(); } catch {}
      try { URL.revokeObjectURL(audio.src); } catch {}
      try { document.body.removeChild(audio); } catch {}
    };
    const fail = (reason: string) => {
      if (settled) return; settled = true;
      cleanup();
      reject(new Error(reason));
    };

    const audioCtx = new AudioContext({ sampleRate: sr });

    // ── MSE source open / append ──────────────────────────────────────────
    mediaSource.addEventListener("sourceopen", () => {
      console.log(`[Dolby/MSE] ${browserTag}: MediaSource opened, adding sourceBuffer for ${mimeType}`);
      try {
        const sb = mediaSource.addSourceBuffer(mimeType);
        sb.addEventListener("error", (e) => {
          console.error(`[Dolby/MSE] ${browserTag}: sourceBuffer error event:`, e);
        });
        sb.addEventListener("updateend", () => {
          if (!sb.updating) {
            try { mediaSource.endOfStream(); } catch (eosErr) {
              console.warn(`[Dolby/MSE] ${browserTag}: endOfStream() threw:`, eosErr);
            }
            console.log(`[Dolby/MSE] ${browserTag}: appended ${arrayBuffer.byteLength} bytes, ending stream`);
          }
        });
        try {
          sb.appendBuffer(arrayBuffer);
        } catch (appendErr) {
          fail(`MSE sourceBuffer.appendBuffer threw: ${appendErr instanceof Error ? appendErr.message : appendErr}`);
        }
      } catch (e) {
        fail(`MSE addSourceBuffer failed for ${mimeType}: ${e instanceof Error ? e.message : e}`);
      }
    });

    // ── Audio element error handler — capture real MediaError details ──────
    audio.addEventListener("error", () => {
      const err = audio.error;
      if (!err) {
        fail(`${browserTag}: <audio> fired error but audio.error is null`);
        return;
      }
      const codeStr = mediaErrorCodeToString(err.code);
      const msg = err.message ?? "";
      console.error(`[Dolby/MSE] ${browserTag}: <audio> error code=${err.code} (${codeStr}) message="${msg}"`);
      console.error(`[Dolby/MSE] ${browserTag}: networkState=${audio.networkState} readyState=${audio.readyState} src="${audio.src}"`);
      // Specific guidance for the most common code
      if (err.code === 3) {
        console.error(`[Dolby/MSE] ${browserTag}: MEDIA_ERR_DECODE means ${browserTag} reports it CAN handle ${mimeType} (isTypeSupported=true) but the actual decoder rejected the bitstream. Common causes: EAC3-JOC with non-standard syncframe layout, missing dec3 init segment.`);
      } else if (err.code === 4) {
        console.error(`[Dolby/MSE] ${browserTag}: MEDIA_ERR_SRC_NOT_SUPPORTED — likely "unfragmented MP4" (MSE requires moov/mvex + moof/mdat fragments).`);
      }
      fail(`${browserTag} <audio>.error: ${codeStr}${msg ? ` — ${msg}` : ""}`);
    });

    audio.addEventListener("loadedmetadata", () => {
      console.log(`[Dolby/MSE] ${browserTag}: <audio> loadedmetadata: duration=${audio.duration} channels=${(audio as any).webkitAudioDecodedByteCount ?? "n/a"}`);
    });
    audio.addEventListener("canplay", () => {
      console.log(`[Dolby/MSE] ${browserTag}: <audio> canplay (readyState=${audio.readyState})`);
    });

    audio.src = URL.createObjectURL(mediaSource);

    // ── canplaythrough → wire up ScriptProcessor capture ──────────────────
    audio.addEventListener("canplaythrough", async () => {
      console.log(`[Dolby/MSE] ${browserTag}: <audio> canplaythrough — starting capture`);
      try {
        await audioCtx.resume();
        const src = audioCtx.createMediaElementSource(audio);
        const actualCh = Math.max(ch, src.channelCount || ch);
        const chunks: Float32Array[][] = Array.from({ length: actualCh }, () => []);
        let totalFrames = 0;
        let finished = false;

        const processor = audioCtx.createScriptProcessor(4096, actualCh, actualCh);
        processor.onaudioprocess = (e) => {
          if (finished) return;
          for (let c = 0; c < actualCh; c++) {
            chunks[c].push(new Float32Array(e.inputBuffer.getChannelData(c)));
          }
          totalFrames += e.inputBuffer.length;
        };

        const finalize = () => {
          if (finished || settled) return;
          finished = true; settled = true;
          processor.disconnect(); src.disconnect();
          try { audioCtx.close(); } catch {}
          cleanup();
          const channelData: Float32Array[] = Array.from({ length: actualCh }, (_, c) => {
            const out = new Float32Array(totalFrames);
            let pos = 0;
            for (const chunk of chunks[c]) { out.set(chunk, pos); pos += chunk.length; }
            return out;
          });
          console.log(`[Dolby/MSE] ${browserTag}: ✅ captured ${totalFrames} frames × ${actualCh}ch @ ${sr}Hz`);
          resolve({
            channelData, sampleRate: sr, bitDepth: 32, channels: actualCh,
            duration: totalFrames > 0 ? totalFrames / sr : dur,
            decoderUsed: `Web Native Audio API / MSE+ScriptProcessor (${browserTag} · ${mimeType} · ${actualCh}ch · ${sr}Hz)`,
          });
        };

        audio.addEventListener("ended", finalize, { once: true });
        setTimeout(finalize, (dur + 5) * 1000);
        src.connect(processor);
        processor.connect(audioCtx.destination);
        audio.play().catch((playErr) => fail(`audio.play() rejected: ${playErr instanceof Error ? playErr.message : playErr}`));
      } catch (e) {
        fail(`MSE capture wiring failed: ${e instanceof Error ? e.message : e}`);
      }
    });

    // 15s timeout — MSE for Dolby-in-M4A often hangs on unfragmented MP4;
    // fall through to FFmpeg WASM quickly instead of blocking the UI for 3 minutes.
    setTimeout(() => fail(`MSE decode timeout (15s) — ${browserTag} never reached canplaythrough`), 18000);
  }).catch(async (mseErr: Error) => {
    // ── Auto-retry with MP4 fragmentation ──────────────────────────────────
    // Edge / Chrome reject unfragmented MP4 with:
    //   "Detected unfragmented MP4. Media Source Extensions require ISO BMFF
    //    moov to contain mvex to indicate that Movie Fragments are to be expected."
    // Auto-detect that error and re-package the file as a fragmented MP4.
    const errStr = mseErr.message ?? '';
    const looksLikeUnfragmented = /unfragmented MP4|moov to contain mvex|CHUNK_DEMUXER_ERROR_APPEND_FAILED/i.test(errStr);
    if (alreadyFragmented || !looksLikeUnfragmented) {
      throw mseErr; // genuine failure, propagate
    }

    console.log(`[Dolby/MSE] ${browserTag}: retry — repackaging as fragmented MP4 (mvex + moof/mdat) and re-feeding MSE…`);
    const { fragmentDolbyMp4 } = await import('./dolbyMp4Fragmenter');
    let fragmented;
    try {
      fragmented = await fragmentDolbyMp4(arrayBuffer);
    } catch (fragErr) {
      console.warn(`[Dolby/MSE] ${browserTag}: fragmentation failed:`, fragErr);
      throw mseErr; // give up, propagate the original error
    }
    console.log(`[Dolby/MSE] ${browserTag}: fragmentation OK — codec=${fragmented.codec} ch=${fragmented.channels} sr=${fragmented.sampleRate}, retrying MSE with ${fragmented.buffer.byteLength} bytes`);
    // Recurse with the fragmented buffer; alreadyFragmented=true prevents infinite retry.
    return await decodeDolbyMSE(
      fragmented.buffer,
      mimeType,
      fragmented.sampleRate || nativeSampleRate,
      fragmented.channels   || nativeChannels,
      nativeDuration,
      /* alreadyFragmented */ true,
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-3 / E-AC-3 / EC-3 / AC-4 / Dolby Atmos (JOC)
// Uses Chrome MSE first (native, no downsampling), falls back to FFmpeg WASM
// Step 1: mp4box detects codec (ac-3, ec-3, ac-4)
// Step 2: FFmpeg WASM decodes to interleaved f32le PCM
// Step 3: split into per-channel Float32Arrays for multichannel spectrogram
//
// NOTE: Spatial/object metadata (JOC) is NOT preserved after PCM decode.
// The spectrogram shows per-channel energy, not object positions.
// ─────────────────────────────────────────────────────────────────────────────
// Singleton FFmpeg instance — load once, reuse for all subsequent decodes
let _ffmpegInstance: any = null;
let _ffmpegLoading: Promise<any> | null = null;

export async function getFFmpeg(): Promise<any> {
  if (_ffmpegInstance) { console.log("[FFmpeg] Already loaded, reusing"); return _ffmpegInstance; }
  if (_ffmpegLoading) { console.log("[FFmpeg] Load in progress, awaiting"); return _ffmpegLoading; }

  _ffmpegLoading = (async () => {
    // Bypass @ffmpeg/ffmpeg entirely — its internal Worker is blocked by COEP.
    // Load the Emscripten module directly on the main thread.
    const cdnBase = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";

    console.log("[FFmpeg] Fetching core JS from CDN...");
    const coreResp = await fetch(`${cdnBase}/ffmpeg-core.js`, { mode: "cors" });
    if (!coreResp.ok) throw new Error(`Core JS fetch failed: ${coreResp.status}`);
    const coreText = await coreResp.text();
    console.log(`[FFmpeg] Core JS: ${(coreText.length / 1024).toFixed(0)}KB`);

    console.log("[FFmpeg] Fetching WASM from CDN...");
    const wasmResp = await fetch(`${cdnBase}/ffmpeg-core.wasm`, { mode: "cors" });
    if (!wasmResp.ok) throw new Error(`WASM fetch failed: ${wasmResp.status}`);
    const wasmBuf = await wasmResp.arrayBuffer();
    console.log(`[FFmpeg] WASM: ${(wasmBuf.byteLength / 1024 / 1024).toFixed(1)}MB`);

    // Execute the core JS to get the createFFmpegCore factory.
    // The UMD build wraps everything in var createFFmpegCore = (() => { ... })();
    console.log("[FFmpeg] Initializing Emscripten module on main thread...");
    const factory = new Function(coreText + "\nreturn createFFmpegCore;")();

    // Create the Emscripten Module with the WASM binary pre-loaded.
    // The factory returns a Promise that resolves to the fully-initialized module.
    // We must use the RETURNED module, not the passed-in object,
    // because callMain/FS/etc. are set on the returned module.
    const inputMod: any = {
      noInitialRun: true,
      noExitRuntime: true,
      wasmBinary: new Uint8Array(wasmBuf),
      print: (s: string) => console.log(`[FFmpeg] ${s}`),
      printErr: (s: string) => { /* suppress Emscripten noise */ },
    };

    const Module: any = await factory(inputMod);

    console.log("[FFmpeg] ✅ Loaded successfully");
    console.log("[FFmpeg] Module keys:", Object.keys(Module).filter(k => typeof Module[k] === 'function').slice(0, 20).join(", "));

    // Wrap the Emscripten module to match the @ffmpeg/ffmpeg API
    // that decodeWithFFmpeg() expects.
    const ffmpeg = {
      _module: Module,
      writeFile: async (name: string, data: Uint8Array) => {
        Module.FS.writeFile(name, data);
      },
      readFile: async (name: string): Promise<Uint8Array> => {
        return Module.FS.readFile(name);
      },
      deleteFile: async (name: string) => {
        Module.FS.unlink(name);
      },
      exec: async (args: string[]): Promise<number> => {
        return Module.exec(...args);
      },
    };

    _ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();

  try {
    return await _ffmpegLoading;
  } catch (e) {
    _ffmpegLoading = null;
    throw e;
  }
}

export async function decodeDolbyFFmpeg(
  arrayBuffer: ArrayBuffer,
  ext: string,
  nativeSampleRate: number,
  nativeChannels: number,
  nativeDuration: number,
): Promise<DecodedAudio> {
  // ── Web Native Audio API (MSE) — ONLY decoder for EAC3/AC3/AC4/EAC3-JOC ──
  // Per spec: use browser's native Dolby decoder via MediaSource Extensions.
  // This preserves all channels at native sample rate without any WASM/FFmpeg.
  const mseTypes: Record<string, string> = {
    // Edge ALWAYS requires audio/mp4 container for Dolby — bare audio/ec-3 etc. is not supported.
    // Try MP4 container first; fall back to bare MIME for browsers that support it.
    "ac3":  'audio/mp4; codecs="ac-3"',
    "ec3":  'audio/mp4; codecs="ec-3"',
    "eac3": 'audio/mp4; codecs="ec-3"',
    "ac4":  'audio/mp4; codecs="ac-4"',
    "ims":  'audio/mp4; codecs="ac-4"',
    // M4A container variants
    "m4a_ec3":  'audio/mp4; codecs="ec-3"',
    "m4a_ac3":  'audio/mp4; codecs="ac-3"',
    "m4a_ac4":  'audio/mp4; codecs="ac-4"',
  };
  const mimeType = mseTypes[ext] ?? `audio/${ext}`;

  // Parse the AC-3 / E-AC-3 bitstream FIRST to get true channel count, sample rate,
  // bitrate, and JOC (Atmos) flag — overriding any wrong values from the tag parser.
  // Works for raw .ac3/.ec3/.eac3 AND for ec-3-in-M4A (m4a_ec3) — syncword search
  // finds the elementary stream wherever it sits in the container.
  let realInfo: DolbyStreamInfo | null = null;
  if (ext === "ac3" || ext === "ec3" || ext === "eac3" || ext === "m4a_ec3" || ext === "m4a_ac3") {
    try {
      realInfo = parseDolbyBitstream(new Uint8Array(arrayBuffer));
      if (realInfo) {
        console.log(`[Dolby/bitstream] codec=${realInfo.codec} ch=${realInfo.channels} sr=${realInfo.sampleRate} br=${realInfo.bitrate} acmod=${realInfo.acmod} lfe=${realInfo.lfeon} joc=${realInfo.isJoc}`);
        // Override caller's wrong values with bitstream truth
        nativeSampleRate = realInfo.sampleRate || nativeSampleRate;
        nativeChannels   = realInfo.channels   || nativeChannels;
      }
    } catch (parseErr) {
      console.warn("[Dolby/bitstream] header parse failed:", parseErr);
    }

    // For Dolby-in-M4A: parse the dec3/dac3 atom DIRECTLY (mp4box reports
    // ASE channel count which is always 2 for EAC3-in-M4A regardless of real
    // layout — that field is a stub. The TRUE channel layout is in dec3).
    if (ext === "m4a_ec3" || ext === "m4a_ac3") {
      const dec3Info = parseDec3Atom(new Uint8Array(arrayBuffer), ext === "m4a_ac3");
      if (dec3Info) {
        console.log(`[Dolby/dec3] sr=${dec3Info.sampleRate} ch=${dec3Info.channels} acmod=${dec3Info.acmod} lfe=${dec3Info.lfeon} (overrides ASE stub)`);
        nativeSampleRate = dec3Info.sampleRate || nativeSampleRate;
        nativeChannels   = Math.max(nativeChannels, dec3Info.channels);
      }

      // Also probe mp4box but DON'T let it stomp on our dec3 truth.
      try {
        const mp4boxModule = await import("mp4box");
        const MP4Box = (mp4boxModule as any).default ?? mp4boxModule;
        const mp4 = MP4Box.createFile();
        await new Promise<void>((resolve) => {
          mp4.onReady = (info: any) => {
            const audioTrack = info.tracks?.find((t: any) => t.type === "audio");
            if (audioTrack) {
              const sr = audioTrack.audio?.sample_rate;
              const ch = audioTrack.audio?.channel_count;
              // Only use mp4box's sr/ch as a FALLBACK if dec3 didn't give us anything,
              // OR if mp4box reports MORE channels (which would be unusual but possible).
              if (sr && sr > 1 && nativeSampleRate < 8000) nativeSampleRate = sr;
              if (ch && ch > nativeChannels) nativeChannels = ch;
              console.log(`[Dolby/mp4box] container reports: ch=${ch} sr=${sr} (using ch=${nativeChannels} sr=${nativeSampleRate})`);
            }
            resolve();
          };
          mp4.onError = () => resolve();
          const b = arrayBuffer.slice(0) as any;
          b.fileStart = 0;
          try { mp4.appendBuffer(b); mp4.flush(); } catch { /* ignore */ }
          setTimeout(resolve, 3000);
        });
      } catch { /* mp4box probe is best-effort */ }
    }
  }
  console.log(`[Dolby/MSE] Attempting native Web Audio API decode: ${mimeType} (${ext})`);

  try {
    const mseResult = await decodeDolbyMSE(arrayBuffer, mimeType, nativeSampleRate, nativeChannels, nativeDuration);
    console.log(`[Dolby/MSE] Native decode succeeded: ${mseResult.channels}ch @ ${mseResult.sampleRate}Hz`);
    if (realInfo && realInfo.isJoc) {
      mseResult.decoderUsed += " · Atmos (JOC) substream detected";
    }
    return mseResult;
  } catch (mseErr) {
    console.warn(`[Dolby/MSE] Native decode failed (${mseErr})`);
    // For AC3/EAC3: try alternate MIME types — Edge requires MP4 container for bare streams
    const altMimes: Record<string, string[]> = {
      "ac3":  ['audio/mp4; codecs="ac-3"', 'audio/ac-3', 'audio/x-ac3', 'audio/vnd.dolby.dd-raw'],
      "ec3":  ['audio/mp4; codecs="ec-3"', 'audio/ec-3', 'audio/x-ec3'],
      "eac3": ['audio/mp4; codecs="ec-3"', 'audio/ec-3', 'audio/x-ec3'],
    };
    const alts = altMimes[ext] ?? [];
    for (const altMime of alts) {
      if (altMime === mimeType) continue;
      try {
        const r = await decodeDolbyMSE(arrayBuffer, altMime, nativeSampleRate, nativeChannels, nativeDuration);
        console.log(`[Dolby/MSE] Alt MIME ${altMime} succeeded`);
        return r;
      } catch { /* try next */ }
    }

    // For raw .ec3/.ac3 outside MP4 container: try wrapping in MP4 then decode
    // (Edge cannot decode bare ec3/ac3 streams but can decode them inside MP4)
    if (ext === "ac3" || ext === "ec3" || ext === "eac3") {
      try {
        const wrapped = await wrapRawDolbyInMP4(arrayBuffer, ext);
        const wrappedMime = ext === "ac3" ? 'audio/mp4; codecs="ac-3"' : 'audio/mp4; codecs="ec-3"';
        const r = await decodeDolbyMSE(wrapped, wrappedMime, nativeSampleRate, nativeChannels, nativeDuration);
        console.log(`[Dolby/MSE] Wrapped raw ${ext} in MP4 container — decode succeeded`);
        return r;
      } catch (wrapErr) {
        console.warn(`[Dolby] MP4 wrap fallback failed for raw ${ext}:`, wrapErr);
      }
    }

    // ── AC-4 path: use the patched FFmpeg WASM with AC-4 decoder ──────────
    // (built from FFmpeg n6.1 + funnymanva ffmpeg_ac4.patch via Emscripten)
    // Lives at /ffmpeg-ac4-cli.{js,wasm}, exposes `main(input, output)` via callMain.
    // AC-4 IMS object metadata is not preserved — we get the bed PCM only.
    if (ext === "ac4" || ext === "ims") {
      try {
        console.log(`[Dolby/AC4] Routing ${ext} to patched FFmpeg WASM (FFmpeg n6.1 + AC-4 patch)`);
        const { decodeAc4 } = await import('./ac4Decoder');
        const r = await decodeAc4(arrayBuffer);
        console.log(`[Dolby/AC4] ✅ decoded ${r.channels}ch @ ${r.sampleRate}Hz`);
        return {
          channelData: r.channelData,
          sampleRate: r.sampleRate,
          bitDepth: r.bitDepth,
          channels: r.channels,
          duration: r.duration,
          decoderUsed: `Patched FFmpeg WASM (FFmpeg n6.1 + AC-4 patch · ${r.channels}ch · ${r.sampleRate}Hz · IMS object metadata not preserved)`,
        };
      } catch (ac4Err) {
        console.warn(`[Dolby/AC4] Patched FFmpeg AC-4 decode failed:`, ac4Err);
      }
    }

    // ── FFmpeg WASM fallback (real decode) ────────────────────────────────
    // MSE refuses unfragmented MP4; fragmentation in JS is not feasible for
    // already-finalised mp4box parses. FFmpeg has a working `eac3` / `ac3`
    // decoder that handles unfragmented MP4 just fine. Note: Atmos JOC object
    // metadata is NOT preserved (we get the 5.1 channel-bed PCM only),
    // but the channel-bed audio is bit-accurate for analysis purposes.
    // (For AC-4 we tried the patched FFmpeg WASM above first.)
    if (ext !== "ac4" && ext !== "ims") {
      try {
        console.log(`[Dolby/FFmpeg] MSE rejected the file (${mseErr instanceof Error ? mseErr.message : mseErr}). Trying FFmpeg WASM fallback...`);
        // Pick a sensible input extension for FFmpeg's demuxer.
        const ffmpegExt =
          (ext === "m4a_ec3" || ext === "m4a_ac3" || ext === "m4a_ac4") ? "m4a"
          : ext === "eac3" ? "ec3"
          : ext;
        // For EAC3-JOC: the dec3 atom (parsed by parseDolbyBitstream) reports
        // the TRUE channel count (5.1 = 6ch). FFmpeg may default to 2ch
        // (stereo downmix of the bed). Force the full surround output by
        // requesting the bitstream's channel count via -ac N.
        const realChannels = realInfo?.channels && realInfo.channels > nativeChannels
          ? realInfo.channels
          : nativeChannels;
        const r = await decodeWithFFmpeg(arrayBuffer, ffmpegExt, nativeSampleRate, /* bitDepth */ 24, realChannels, nativeDuration);
        // Annotate the result so the user knows JOC metadata was dropped.
        if (realInfo && realInfo.isJoc) {
          r.decoderUsed += " · Atmos (JOC) metadata dropped (FFmpeg path decodes 5.1 bed only)";
        } else {
          r.decoderUsed += " · Dolby fallback (browser MSE rejected the file)";
        }
        console.log(`[Dolby/FFmpeg] ✅ decoded ${r.channels}ch @ ${r.sampleRate}Hz`);
        return r;
      } catch (ffErr) {
        console.warn(`[Dolby/FFmpeg] FFmpeg fallback failed:`, ffErr);
      }
    }

    // All decode attempts failed — surface a real error instead of silent placeholder PCM.
    // Returning fake silence would corrupt all downstream metrics (DR, RMS, spectrogram).
    const errorReason = ext === "ac4" || ext === "ims"
      ? `${ext.toUpperCase()} (Dolby AC-4 / Atmos IMS) is a proprietary codec. No open-source WASM decoder is available, and ${typeof navigator !== "undefined" ? navigator.userAgent.includes("Edg") ? "Edge" : "this browser" : "this browser"} could not decode it natively.`
      : `${ext.toUpperCase()} could not be decoded by any available decoder (native MSE, MP4 wrap, FFmpeg). Original error: ${mseErr instanceof Error ? mseErr.message : String(mseErr)}`;
    throw new Error(`DOLBY_DECODE_FAILED: ${errorReason}`);
  }
}

// Wrap a raw .ac3/.ec3/.eac3 elementary stream inside a minimal MP4 container
// so MSE can decode it (Edge requires MP4, not bare streams).
// AC-3 / E-AC-3 bitstream channel-count parser.
// Reads syncframe header → returns real channel count, sample rate, bitstream mode.
// Spec: ATSC A/52 (AC-3) §5.4.1, ETSI TS 102 366 (E-AC-3) §E.1.3.1.
// acmod table (3 bits): 0=1+1, 1=1/0, 2=2/0, 3=3/0, 4=2/1, 5=3/1, 6=2/2, 7=3/2.
// lfeon (1 bit): +1 channel for LFE (.1).
export interface DolbyStreamInfo {
  codec: "ac3" | "eac3";
  sampleRate: number;
  channels: number;          // matrixed channel count incl. LFE
  acmod: number;             // 0-7
  lfeon: boolean;
  bitrate: number;           // bps
  numblks: number;           // E-AC-3 only; 0 for AC-3
  isJoc: boolean;            // E-AC-3 with Atmos JOC substream
  bsid: number;              // bitstream identification
  bsmod: number;             // bitstream mode
}

function parseDolbyBitstream(buf: Uint8Array): DolbyStreamInfo | null {
  if (buf.length < 8) return null;

  // Find AC-3/E-AC-3 syncword 0x0B77 (or 0x770B byte-swapped — but spec is BE)
  let pos = -1;
  for (let i = 0; i < Math.min(buf.length - 8, 65536); i++) {
    if (buf[i] === 0x0B && buf[i + 1] === 0x77) { pos = i; break; }
  }
  if (pos < 0) return null;

  // Read bits big-endian starting after syncword (16 bits already consumed)
  let bytePos = pos + 2;
  let bitPos = 0;
  function readBits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (bytePos >= buf.length) return -1;
      const bit = (buf[bytePos] >> (7 - bitPos)) & 1;
      v = (v << 1) | bit;
      bitPos++;
      if (bitPos === 8) { bitPos = 0; bytePos++; }
    }
    return v;
  }

  // Skip CRC1 (16 bits)
  readBits(16);
  // Read fscod (2) + frmsizecod (6) for AC-3 OR strmtyp (2) + substreamid (3) ... for E-AC-3
  // Distinguish: bsid is at byte+5 in AC-3 layout, but E-AC-3 has different layout.
  // Easiest: read fscod assuming AC-3 first; if bsid > 10, it's E-AC-3 — re-parse.

  // AC-3 layout: syncword(16) | crc1(16) | fscod(2) | frmsizecod(6) | bsid(5) | bsmod(3) | acmod(3) | ...
  const fscod = readBits(2);
  const frmsizecod = readBits(6);
  const bsid = readBits(5);

  if (bsid <= 8) {
    // Classic AC-3
    const bsmod = readBits(3);
    const acmod = readBits(3);
    // skip cmixlev/surmixlev/dsurmod conditionally
    if ((acmod & 0x1) && acmod !== 1) readBits(2); // cmixlev
    if (acmod & 0x4) readBits(2); // surmixlev
    if (acmod === 2) readBits(2); // dsurmod
    const lfeon = readBits(1) === 1;

    const srTable = [48000, 44100, 32000, 0];
    const brTable = [
      32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640,
    ];
    const sampleRate = srTable[fscod] || 48000;
    const bitrateIdx = frmsizecod >> 1;
    const bitrate = (brTable[bitrateIdx] || 0) * 1000;

    const acmodChannels = [2, 1, 2, 3, 3, 4, 4, 5];
    const channels = (acmodChannels[acmod] || 2) + (lfeon ? 1 : 0);

    return {
      codec: "ac3", sampleRate, channels, acmod, lfeon, bitrate,
      numblks: 0, isJoc: false, bsid, bsmod,
    };
  } else {
    // E-AC-3 (bsid 11–16). Re-parse from start with E-AC-3 layout.
    // Layout: syncword(16) | strmtyp(2) | substreamid(3) | frmsiz(11) | fscod(2) | numblkscod(2) | acmod(3) | lfeon(1) | bsid(5) | dialnorm(5) | ...
    bytePos = pos + 2; bitPos = 0;
    const strmtyp = readBits(2);
    readBits(3); // substreamid
    const frmsiz = readBits(11);
    const fscodEAC3 = readBits(2);
    const numblkscod = readBits(2);
    const acmod = readBits(3);
    const lfeon = readBits(1) === 1;
    const bsidEAC3 = readBits(5);
    readBits(5); // dialnorm
    const compre = readBits(1);
    if (compre) readBits(8); // compr

    const srEAC3 = fscodEAC3 < 3
      ? [48000, 44100, 32000][fscodEAC3]
      : [24000, 22050, 16000][readBits(2)] || 48000; // fscod2
    const numblks = [1, 2, 3, 6][numblkscod];
    const acmodChannels = [2, 1, 2, 3, 3, 4, 4, 5];
    const channels = (acmodChannels[acmod] || 2) + (lfeon ? 1 : 0);

    // Frame bytes = (frmsiz + 1) * 2; bitrate = frame_bytes * 8 * sample_rate / (numblks * 256)
    const frameBytes = (frmsiz + 1) * 2;
    const bitrate = Math.round(frameBytes * 8 * srEAC3 / (numblks * 256));

    // JOC (Joint Object Coding / Atmos) detection: search for JOC substream marker
    // E-AC-3 JOC substreams have strmtyp=2 and contain joc_payload OAMD blocks.
    // Simple heuristic: look for "JOC " ASCII or 0x6A0C marker in first 64KB.
    let isJoc = false;
    for (let i = pos; i < Math.min(buf.length - 4, pos + 65536); i++) {
      if (buf[i] === 0x4A && buf[i + 1] === 0x4F && buf[i + 2] === 0x43) { // "JOC"
        isJoc = true; break;
      }
    }
    // Also: strmtyp=1 + dependent substreams typically carry Atmos object metadata
    if (strmtyp === 1) isJoc = true;

    return {
      codec: "eac3", sampleRate: srEAC3, channels, acmod, lfeon, bitrate,
      numblks, isJoc, bsid: bsidEAC3, bsmod: 0,
    };
  }
}

async function wrapRawDolbyInMP4(rawBuffer: ArrayBuffer, codecExt: string): Promise<ArrayBuffer> {
  // Minimal MP4 wrap: ftyp + moov + mdat with single track of given codec
  // We use an audio element + MediaSource with appendBuffer to stream the raw data,
  // letting the browser parse it as a fragmented stream.
  // For now we delegate to FFmpeg WASM to remux raw -> MP4 (no decode, just container).
  const ffmpeg = await getFFmpeg();
  const inName = `in.${codecExt}`;
  const outName = "out.m4a";
  await ffmpeg.writeFile(inName, new Uint8Array(rawBuffer));
  await ffmpeg.exec([
    "-i", inName,
    "-c:a", "copy",       // do NOT re-encode; just remux
    "-f", "mp4",
    "-movflags", "+faststart",
    outName,
  ]);
  const data = await ffmpeg.readFile(outName);
  try { await ffmpeg.deleteFile(inName); } catch {}
  try { await ffmpeg.deleteFile(outName); } catch {}
  const bytes = data instanceof Uint8Array ? data : new Uint8Array((data as any).buffer ?? data);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// ─────────────────────────────────────────────────────────────────────────────
// FFmpeg WASM general fallback — for AAC, WMA, APE, WavPack, DSD, etc.
// Decodes any format FFmpeg supports to f32le PCM
// ─────────────────────────────────────────────────────────────────────────────
export async function decodeWithFFmpeg(
  arrayBuffer: ArrayBuffer,
  ext: string,
  nativeSampleRate: number,
  nativeBitDepth: number,
  nativeChannels: number,
  nativeDuration: number,
): Promise<DecodedAudio> {
  try {
    console.log(`[FFmpeg] decodeWithFFmpeg called: ext=${ext}, size=${(arrayBuffer.byteLength/1024/1024).toFixed(2)}MB, sr=${nativeSampleRate}, ch=${nativeChannels}`);
    console.log("[FFmpeg] Getting FFmpeg instance...");
    const ffmpeg = await getFFmpeg();
    console.log("[FFmpeg] Instance ready");

    const inputName = `input_${Date.now()}.${ext}`;
    const outputName = `output_${Date.now()}.pcm`;
    console.log(`[FFmpeg] Writing input file: ${inputName} (${arrayBuffer.byteLength} bytes)`);
    await ffmpeg.writeFile(inputName, new Uint8Array(arrayBuffer));
    console.log("[FFmpeg] Input file written");

    console.log(`[FFmpeg] Executing decode command...`);
    const ffmpegArgs = ["-i", inputName, "-vn", "-f", "f32le", "-acodec", "pcm_f32le"];
    if (nativeChannels > 2) {
      ffmpegArgs.push("-ac", String(nativeChannels));
    }
    ffmpegArgs.push(outputName);
    console.log(`[FFmpeg] Args: ${ffmpegArgs.join(" ")}`);
    const ret = await ffmpeg.exec(ffmpegArgs);
    console.log(`[FFmpeg] exec returned: ${ret}`);

    console.log("[FFmpeg] Reading output file...");
    const pcmData = await ffmpeg.readFile(outputName);
    const pcmBytes = pcmData instanceof Uint8Array ? pcmData : new Uint8Array((pcmData as any).buffer ?? pcmData);
    console.log(`[FFmpeg] Output: ${pcmBytes.byteLength} bytes (${(pcmBytes.byteLength / 4)} samples)`);

    // Clean up virtual FS
    try { await ffmpeg.deleteFile(inputName); } catch {}
    try { await ffmpeg.deleteFile(outputName); } catch {}

    if (pcmBytes.byteLength < 4) throw new Error(`FFmpeg produced empty output for ${ext}`);

    const pcmFloat = new Float32Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength / 4);

    // Use native values — FFmpeg outputs at the file's native sample rate and channels
    // since we removed -ar and -ac flags (no resampling, no downmix)
    const sr = nativeSampleRate || 44100;
    // Determine channel count from PCM data: try nativeChannels first, then detect from length
    // If nativeChannels is wrong, try to infer from total sample count
    let ch = (nativeChannels > 0 && nativeChannels <= 32) ? nativeChannels : 2;

    // Validate: total samples must be divisible by channel count
    // If not, try common channel counts to find the right one
    if (pcmFloat.length % ch !== 0) {
      for (const tryC of [1, 2, 4, 6, 8, 12, 16, 24]) {
        if (pcmFloat.length % tryC === 0) { ch = tryC; break; }
      }
    }

    const numFrames = Math.floor(pcmFloat.length / ch);
    console.log(`[FFmpeg] Decoded ${numFrames} frames, ${ch}ch @ ${sr}Hz (${pcmFloat.length} total samples)`);

    // De-interleave: interleaved [L,R,L,R,...] → per-channel [[L,L,...],[R,R,...]]
    const channelData: Float32Array[] = Array.from({ length: ch }, () => new Float32Array(numFrames));
    for (let i = 0; i < numFrames; i++) {
      for (let c = 0; c < ch; c++) {
        channelData[c][i] = pcmFloat[i * ch + c];
      }
    }

    return {
      channelData,
      sampleRate: sr,
      bitDepth: 32,
      channels: ch,
      duration: numFrames / sr || nativeDuration,
      decoderUsed: `WebAssembly FFmpeg (${ext.toUpperCase()} → f32le PCM · ${ch}ch · ${sr}Hz · no downmix)`,
    };

  } catch (err) {
    console.error(`[FFmpeg WASM] ${ext} decode failed:`, err);
    // Throw the real error instead of returning silent placeholder PCM.
    // Returning fake silence would corrupt all downstream metrics
    // (DR, RMS, spectrogram, waveform).
    throw new Error(
      `FFMPEG_DECODE_FAILED: ${ext.toUpperCase()} could not be decoded by FFmpeg WASM. ` +
      `Reason: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// Alias for internal callers that used the old Web Audio fallback name
export async function decodeWebAudio(
  arrayBuffer: ArrayBuffer,
  nativeSampleRate: number,
  nativeBitDepth: number,
  nativeChannels: number,
  nativeDuration: number,
  ext = "unknown",
): Promise<DecodedAudio> {
  return decodeWithFFmpeg(arrayBuffer, ext, nativeSampleRate, nativeBitDepth, nativeChannels, nativeDuration);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sony 360 Reality Audio — detection only, cannot decode
// Returns a clearly-labelled empty result so analysis still shows metadata
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Decode Sony 360 Reality Audio / MPEG-H 3D Audio.
 *
 * Uses the chosen decoder ('ittiam' | 'fraunhofer') via a Web Worker so
 * the main thread is never blocked, even for 24-channel files.
 *
 * Falls back to a silent placeholder if decoding fails so analysis metadata
 * still shows (spectrogram, tags, etc.).
 *
 * @param arrayBuffer       Raw file bytes
 * @param nativeSampleRate  From tag parser
 * @param nativeChannels    From tag parser (could be 2, 12, 22, 24, …)
 * @param decoderChoice     'ittiam' (default) or 'fraunhofer'
 * @param onProgress        Optional progress callback 0–100
 */
export async function decode360RA(
  arrayBuffer: ArrayBuffer,
  nativeSampleRate: number,
  nativeChannels: number,
  decoderChoice: MpeghDecoderChoice = 'ittiam',
  onProgress?: (pct: number) => void,
): Promise<DecodedAudio> {
  // NOTE: The Web Worker path uses importScripts() which is banned in ES module workers (Vite).
  // We run decode inline on the main thread — acceptable since it's a one-time operation.
  // TODO: Convert mpeghDecodeWorker to a blob-URL classic worker to unblock the main thread.

  // Mark legacy/secondary imports as intentionally retained.
  void decodeMpegh3da;
  void decodeMpeghInWorker;
  void nativeSampleRate;
  void nativeChannels;

  onProgress?.(10);

  // The user picks the decoder via the MPEG-H Decoder Dialog (decoderChoice).
  // No fallback between them — if the chosen decoder fails, the error is
  // surfaced directly so the user can either pick the other one or see why.
  if (decoderChoice === 'fraunhofer') {
    onProgress?.(25);
    const result = await decodeFraunhoferCli(arrayBuffer, {});
    onProgress?.(95);
    return {
      channelData: result.channelData,
      sampleRate: result.sampleRate,
      bitDepth: result.bitDepth,
      channels: result.channels,
      duration: result.duration,
      decoderUsed: `Fraunhofer mpeghdec CLI WASM — MPEG-H 3D Audio / Sony 360 Reality Audio (${result.channels}ch · ${result.sampleRate}Hz · ${result.bitDepth}-bit · no downmix)`,
    };
  }

  // Default: Ittiam libmpegh testbench WASM (LC Profile L4 support).
  onProgress?.(25);
  const ittiam = await decodeMpeghTestbench(arrayBuffer, { cicpSetup: 0, pcmWordSize: 24 });
  onProgress?.(95);
  return {
    channelData: ittiam.channelData,
    sampleRate: ittiam.sampleRate,
    bitDepth: ittiam.bitDepth,
    channels: ittiam.channels,
    duration: ittiam.duration,
    decoderUsed: `Ittiam libmpegh testbench WASM (LC Profile L4) — MPEG-H 3D Audio / Sony 360 Reality Audio (${ittiam.channels}ch · ${ittiam.sampleRate}Hz · ${ittiam.bitDepth}-bit · no downmix)`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main router — pick the right decoder per format
// ─────────────────────────────────────────────────────────────────────────────
export async function decodeAudioFile(
  file: File,
  arrayBuffer: ArrayBuffer,
  ext: string,
  nativeSampleRate: number,
  nativeBitDepth: number,
  nativeChannels: number,
  nativeDuration: number,
  nativeInfo?: { is360RA?: boolean; isAtmos?: boolean; isDolbyDigital?: boolean; isDolbyDigitalPlus?: boolean } | null,
  mpeghDecoderChoice: MpeghDecoderChoice = 'ittiam',
  onDecodeProgress?: (pct: number) => void,
): Promise<DecodedAudio> {
  try {
    // Sony 360RA — decode via chosen WASM decoder in Web Worker
    if (nativeInfo?.is360RA) {
      return await decode360RA(arrayBuffer, nativeSampleRate, nativeChannels, mpeghDecoderChoice, onDecodeProgress);
    }

    switch (ext) {

      // ── FLAC / MQA — libflacjs WASM (libFLAC bit-perfect) ────────────
      case "flac":
      case "mqa":
        return await decodeFLAC(arrayBuffer);

      // ── MP3 — mpg123 WASM ─────────────────────────────────────────────
      case "mp3":
        return await decodeMP3(arrayBuffer);

      // ── OGG Vorbis — libvorbis WASM ───────────────────────────────────
      case "ogg":
        return await decodeOggVorbis(arrayBuffer);

      // ── Opus — opus-decoder WASM (libopus) ────────────────────────────
      case "opus":
        return await decodeOpus(arrayBuffer);

      // ── WAV — manual binary parser (zero resampling) ──────────────────
      // PCM 8/16/24/32-bit int, 32/64-bit float, any sample rate
      case "wav":
      case "wave":
        return await decodeWAV(arrayBuffer);

      // ── AIFF — manual binary parser (big-endian PCM) ──────────────────
      // 8/16/24/32-bit, 80-bit IEEE extended sample rate
      case "aiff":
      case "aif":
        return await decodeAIFF(arrayBuffer);

      // ── M4A / MP4 — mp4box.js + binary PCM (ALAC) or FFmpeg (AAC) ────
      // ALAC: bit-perfect binary extraction · AAC: FFmpeg WASM decode
      case "m4a":
      case "mp4":
      case "aac":
        try {
          return await decodeM4A(
            arrayBuffer, nativeSampleRate, nativeBitDepth, nativeChannels, nativeDuration
          );
        } catch (e: any) {
          if (typeof e?.message === "string" && e.message.startsWith("__360RA__")) {
            // M4A sniffer found mha1/mhm1 that nativeInfo missed.
            // If the user wasn't already prompted (mpeghDecoderChoice is the default 'ittiam'),
            // surface a clear signal so the upstream route can re-prompt and retry.
            // If they did pick a decoder, honor it.
            return await decode360RA(arrayBuffer, nativeSampleRate, nativeChannels, mpeghDecoderChoice, onDecodeProgress);
          }
          throw e;
        }

      // ── Dolby / Immersive — FFmpeg WASM ───────────────────────────────
      // AC-3      = Dolby Digital (legacy 5.1)
      // EC-3      = Dolby Digital Plus (E-AC-3, streaming standard)
      // EAC-3     = same as EC-3
      // EAC-3 JOC = Dolby Atmos (object audio layer on top of E-AC-3)
      // AC-4      = next-gen Dolby (ATSC 3.0, ISOBMFF)
      // IMS       = AC-4 Immersive Stereo (binaural spatial audio)
      // NOTE: JOC/Atmos spatial metadata NOT preserved after PCM decode
      case "ac3":
      case "ec3":
      case "eac3":
      case "ac4":
      case "ims":
        return await decodeDolbyFFmpeg(
          arrayBuffer, ext, nativeSampleRate, nativeChannels, nativeDuration
        );

      // ── WMA — FFmpeg WASM ─────────────────────────────────────────────
      // Windows Media Audio (0x0161 / WMA2)
      case "wma":
      case "wmv":
        return await decodeWithFFmpeg(arrayBuffer, ext, nativeSampleRate, nativeBitDepth, nativeChannels, nativeDuration);

      // ── Monkey's Audio (APE) — FFmpeg WASM ───────────────────────────
      // Lossless compression, very high ratio
      case "ape":
      case "apl":
      case "mac":
        return await decodeWithFFmpeg(arrayBuffer, "ape", nativeSampleRate, nativeBitDepth, nativeChannels, nativeDuration);

      // ── WavPack — FFmpeg WASM ─────────────────────────────────────────
      // Lossless / hybrid lossless
      case "wv":
        return await decodeWithFFmpeg(arrayBuffer, ext, nativeSampleRate, nativeBitDepth, nativeChannels, nativeDuration);

      // ── DSD — FFmpeg WASM ─────────────────────────────────────────────
      // DSD Stream File (.dsf) / DSDIFF (.dff)
      // FFmpeg converts DSD → PCM (DSD64 @ 2.8MHz → PCM 88.2kHz)
      case "dsf":
      case "dff":
      case "dsd":
        return await decodeWithFFmpeg(arrayBuffer, ext, nativeSampleRate || 88200, nativeBitDepth, nativeChannels, nativeDuration);

      // ── TrueHD / MLP — FFmpeg WASM ────────────────────────────────────
      // Dolby TrueHD (Blu-ray lossless, up to 7.1 Atmos)
      case "mlp":
      case "thd":
        return await decodeWithFFmpeg(arrayBuffer, ext, nativeSampleRate, nativeBitDepth, nativeChannels, nativeDuration);

      // ── DTS — FFmpeg WASM ─────────────────────────────────────────────
      case "dts":
      case "dtshd":
        return await decodeWithFFmpeg(arrayBuffer, ext, nativeSampleRate, nativeBitDepth, nativeChannels, nativeDuration);

      // ── Sony 360RA / MPEG-H — chosen WASM decoder in Web Worker ──────
      // mha1/mhm1 inside M4A — MPEG-H 3D Audio (Sony 360 Reality Audio)
      // Supports all channel counts: 2, 12, 22, 24, etc.
      case "mha1":
      case "mhm1":
        return await decode360RA(arrayBuffer, nativeSampleRate, nativeChannels, mpeghDecoderChoice, onDecodeProgress);

      // ── MPEG-H Audio Stream — chosen WASM decoder in Web Worker ──────
      // Raw .mhas bitstream
      case "mhas":
        return await decode360RA(arrayBuffer, nativeSampleRate, nativeChannels, mpeghDecoderChoice, onDecodeProgress);

      // ── Speex — FFmpeg WASM ───────────────────────────────────────────
      case "spx":
        return await decodeWithFFmpeg(arrayBuffer, ext, nativeSampleRate, nativeBitDepth, nativeChannels, nativeDuration);

      // ── AMR — FFmpeg WASM ─────────────────────────────────────────────
      case "amr":
      case "3gp":
        return await decodeWithFFmpeg(arrayBuffer, ext, nativeSampleRate || 8000, nativeBitDepth, nativeChannels || 1, nativeDuration);

      // ── Everything else → FFmpeg WASM ─────────────────────────────────
      default:
        return await decodeWithFFmpeg(
          arrayBuffer, ext, nativeSampleRate, nativeBitDepth, nativeChannels, nativeDuration
        );
    }
  } catch (err) {
    console.error(`[wasmDecoder] ${ext} decoder failed:`, err);
    // For MPEG-H/360RA and Dolby: do NOT fall back to FFmpeg or silent placeholder.
    // FFmpeg cannot decode these properly and silent PCM corrupts every downstream metric.
    const errMsg = err instanceof Error ? err.message : String(err);
    const isDolbyError = /^(DOLBY_DECODE_FAILED|MPEG-H_3DAUDIO_DECODE_FAILED|__360RA__)/.test(errMsg);
    const is360RA = nativeInfo?.is360RA ||
      ext === "mha1" || ext === "mhm1" || ext === "mhas";
    const isDolby = nativeInfo?.isAtmos || nativeInfo?.isDolbyDigital || nativeInfo?.isDolbyDigitalPlus ||
      ext === "ac3" || ext === "ec3" || ext === "eac3" || ext === "ac4" || ext === "ims";
    if (is360RA || isDolby || isDolbyError) throw err;
    // Other formats: try FFmpeg as final attempt
    return await decodeWithFFmpeg(
      arrayBuffer, ext, nativeSampleRate, nativeBitDepth, nativeChannels, nativeDuration
    );
  }
}
