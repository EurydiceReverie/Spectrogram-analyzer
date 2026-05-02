// ========================================
// Parse REAL sample rate from file binary
// (AudioContext resamples to browser rate — we need the original)
// ========================================

export interface NativeFileInfo {
  sampleRate: number;      // original, from file header
  bitDepth: number;        // original bit depth
  channels: number;        // original channel count
  duration: number;        // from header (claimed)
  format: string;
  isAtmos: boolean;        // Dolby Atmos JOC
  isDolbyDigital: boolean; // AC-3
  isDolbyDigitalPlus: boolean; // E-AC-3
  is360RA: boolean;        // Sony 360 Reality Audio
  channelLayout: string;
}

export async function parseNativeFileInfo(file: File): Promise<NativeFileInfo | null> {
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  const buf = await file.slice(0, 512).arrayBuffer();
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // ── FLAC / MQA ────────────────────────────────────────────────────
  // MQA is stored in a FLAC container — same magic bytes.
  // fLaC marker + STREAMINFO block
  if (bytes[0] === 0x66 && bytes[1] === 0x4C && bytes[2] === 0x61 && bytes[3] === 0x43) {
    // STREAMINFO at offset 8, field layout:
    // Sample rate: bits 80-99 (byte 18 bits 7-0, byte 19, byte 20 bits 7-4) = 20 bits
    // Channels: bits 100-102 (+1)
    // Bit depth: bits 103-107 (+1)
    // Total samples: bits 108-143
    try {
      const sr = ((bytes[18] & 0xFF) << 12) | ((bytes[19] & 0xFF) << 4) | ((bytes[20] & 0xF0) >> 4);
      const ch = ((bytes[20] & 0x0E) >> 1) + 1;
      const bd = (((bytes[20] & 0x01) << 4) | ((bytes[21] & 0xF0) >> 4)) + 1;
      // Total samples (36 bits: bottom 4 bits of byte21, bytes 22-25)
      const totalHi = (bytes[21] & 0x0F);
      const totalLo = (bytes[22] << 24) | (bytes[23] << 16) | (bytes[24] << 8) | bytes[25];
      const totalSamples = totalHi * 4294967296 + (totalLo >>> 0);
      const duration = sr > 0 ? totalSamples / sr : 0;
      // MQA files use .mqa extension but are FLAC containers
      const isMqa = ext === "mqa";
      return {
        sampleRate: sr, bitDepth: bd, channels: ch, duration,
        format: isMqa ? "MQA (FLAC container)" : "FLAC",
        isAtmos: false, isDolbyDigital: false,
        isDolbyDigitalPlus: false, is360RA: false,
        channelLayout: getChannelLayout(ch),
      };
    } catch { return null; }
  }

  // ── WAV / RF64 ────────────────────────────────────────────────────
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    // RIFF....WAVE
    if (bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45) {
      try {
        // fmt chunk usually at offset 12
        const sr = view.getUint32(24, true);
        const ch = view.getUint16(22, true);
        const bd = view.getUint16(34, true);
        const byteRate = view.getUint32(28, true);
        const fileSize = file.size;
        const duration = byteRate > 0 ? (fileSize - 44) / byteRate : 0;
        return {
          sampleRate: sr, bitDepth: bd, channels: ch, duration,
          format: "WAV", isAtmos: false, isDolbyDigital: false,
          isDolbyDigitalPlus: false, is360RA: false,
          channelLayout: getChannelLayout(ch),
        };
      } catch { return null; }
    }
  }

  // ── AIFF ──────────────────────────────────────────────────────────
  if (bytes[0] === 0x46 && bytes[1] === 0x4F && bytes[2] === 0x52 && bytes[3] === 0x4D) {
    try {
      // COMM chunk: channels(2), sampleFrames(4), bitDepth(2), sampleRate(10 byte 80-bit)
      // Find COMM chunk
      for (let i = 12; i < 400; i += 8) {
        if (bytes[i] === 0x43 && bytes[i+1] === 0x4F && bytes[i+2] === 0x4D && bytes[i+3] === 0x4D) {
          const ch = view.getInt16(i + 8, false);
          const frames = view.getUint32(i + 10, false);
          const bd = view.getInt16(i + 14, false);
          // 80-bit IEEE 754 extended precision sample rate (big-endian):
          // bytes i+16..i+17: sign(1) + exponent(15 bits), biased by 16383
          // bytes i+18..i+25: 64-bit mantissa (explicit integer bit at bit 63)
          // sr = mantissaHigh32 * 2^(exponent - 16383 - 31)
          // where 31 accounts for the implicit point after bit 31 of the high 32 bits
          const expBiased = view.getUint16(i + 16, false) & 0x7FFF;
          const mantHigh  = view.getUint32(i + 18, false); // upper 32 bits of 64-bit mantissa
          const shift = expBiased - 16383 - 31;
          const sr = Math.round(shift >= 0
            ? mantHigh * Math.pow(2, shift)
            : mantHigh / Math.pow(2, -shift));
          return {
            sampleRate: sr, bitDepth: bd, channels: ch,
            duration: sr > 0 ? frames / sr : 0,
            format: "AIFF", isAtmos: false, isDolbyDigital: false,
            isDolbyDigitalPlus: false, is360RA: false,
            channelLayout: getChannelLayout(ch),
          };
        }
      }
    } catch { return null; }
  }

  // ── AC-4 (Dolby AC-4 / Atmos IMS) ────────────────────────────────
  if (ext === "ac4" || ext === "ims") {
    return {
      sampleRate: 48000, bitDepth: 24, channels: 2, duration: 0,
      format: ext === "ims" ? "Dolby AC-4 IMS (Immersive Stereo / binaural)" : "Dolby AC-4",
      isAtmos: true, isDolbyDigital: false, isDolbyDigitalPlus: false, is360RA: false,
      channelLayout: "Binaural (AC-4 IMS)",
    };
  }

  // ── AC-3 / E-AC-3 (Dolby Digital / Dolby Digital Plus) ────────────
  if (ext === "ac3" || ext === "ec3" || ext === "eac3") {
    // AC-3/E-AC-3 sync word = 0x0B77 (big-endian)
    const hasSyncWord = bytes[0] === 0x0B && bytes[1] === 0x77;
    // bsid: AC-3 = bits 5-9 of byte5 = (bytes[5] >> 3) & 0x1F → bsid ≤ 8
    // E-AC-3 bsid = 11 (0xB), bsid=16 = E-AC-3 JOC (Atmos)
    const bsid = hasSyncWord ? (bytes[5] >> 3) & 0x1F : 0;
    const isEAC3 = bsid > 10; // E-AC-3 if bsid ≥ 11
    const isAtmosJOC = bsid === 16; // JOC = Atmos enhancement layer
    const isAC3 = hasSyncWord && !isEAC3;
    const isDDP = isEAC3;

    // AC-3 sample rate: fscod at bits 6-7 of byte 4 (after 2-byte syncword + 2-byte crc)
    // AC-3: byte4 = crc2 high, byte5 = fscod(2)|frmsizecod(6)|bsid(5)|...
    // For AC-3: fscod is top 2 bits of byte 4 (index 4) — BUT syncword is at 0,1; crc at 2,3; fscod at byte4[7:6]
    // Standard: first sync frame layout: [0-1]=0x0B77, [2-3]=crc, [4]=fscod(2)|frmsizecod(6)
    const srCodes = [48000, 44100, 32000, 0];
    let sampleRate = 48000;
    if (isAC3 && hasSyncWord) {
      const fscod = (bytes[4] >> 6) & 0x3;
      sampleRate = srCodes[fscod] || 48000;
    } else if (isEAC3 && hasSyncWord) {
      // E-AC-3: fscod at bits 15-14 of the 16-bit word after syncword
      // E-AC-3 frame header: [0-1]=0x0B77, [2-3]=strmtyp(2)|substreamid(3)|frmsiz(11), [4]=fscod(2)|numblkscod(2)|acmod(3)|lfeon(1)
      const fscod = (bytes[4] >> 6) & 0x3;
      sampleRate = srCodes[fscod] || 48000;
    }

    // Channel count from acmod field
    // E-AC-3: acmod at bits 5-3 of byte4; lfeon at bit 2
    // AC-3: acmod at bits 12-10 of the BSI word (byte5 bits 2-0 + byte6 bit 7)
    let channels = 6; // default 5.1
    if (hasSyncWord) {
      try {
        if (isEAC3) {
          // E-AC-3 BSI: byte4 = fscod(2)|numblkscod(2)|acmod(3)|lfeon(1)
          const acmod = (bytes[4] >> 1) & 0x7;
          const lfeon = bytes[4] & 0x1;
          const acmodCh = [2, 1, 2, 3, 3, 4, 4, 5];
          channels = acmodCh[acmod] + lfeon;
        } else {
          // AC-3 BSI: byte5 = fscod(2)|frmsizecod(6) ... actually byte4 has fscod
          // byte5 = bsid(5)|bsmod(3), byte6 = acmod(3)|...
          const acmod = (bytes[6] >> 5) & 0x7;
          const lfeon = (bytes[6] >> 4) & 0x1;
          const acmodCh = [2, 1, 2, 3, 3, 4, 4, 5];
          channels = acmodCh[acmod] + lfeon;
        }
      } catch { channels = 6; }
    }

    // Estimate bitrate from frame size for duration calculation
    // AC-3 frmsize: bytes[4] bits 5-0 = frmsizecod; look up table gives kbps
    const ac3BitrateTable = [32,40,48,56,64,80,96,112,128,160,192,224,256,320,384,448,512,576,640];
    let bitrateKbps = isAtmosJOC ? 768 : (channels >= 6 ? 384 : 192);
    if (isAC3 && hasSyncWord) {
      const frmsizecod = bytes[4] & 0x3F;
      const idx = Math.floor(frmsizecod / 2);
      if (idx < ac3BitrateTable.length) bitrateKbps = ac3BitrateTable[idx];
    }

    const formatStr = isAtmosJOC
      ? "Dolby Digital Plus / E-AC-3 JOC (Atmos)"
      : isDDP
        ? "Dolby Digital Plus (E-AC-3)"
        : "Dolby Digital (AC-3)";

    return {
      sampleRate,
      bitDepth: 24,
      channels,
      duration: bitrateKbps > 0 ? (file.size * 8) / (bitrateKbps * 1000) : 0,
      format: formatStr,
      isAtmos: isAtmosJOC || isDDP,
      isDolbyDigital: isAC3,
      isDolbyDigitalPlus: isDDP,
      is360RA: false,
      channelLayout: channels === 1 ? "Mono (C)"
        : channels === 2 ? "Stereo (L R)"
        : channels === 4 ? "3.1 (L R C LFE)"
        : channels === 6 ? "5.1 (L R C LFE Ls Rs)"
        : channels === 8 ? "7.1 (L R C LFE Ls Rs Lrs Rrs)"
        : `${channels}ch`,
    };
  }

  // ── M4A / MP4 / MHAS ──────────────────────────────────────────────
  // For any M4A/MP4 file, use parseMp4ForMpeghInfo which reads up to 8MB
  // and correctly detects mha1/mhm1/ac-3/ec-3/ac-4/alac/aac codecs.
  if (ext === "m4a" || ext === "mp4" || ext === "mhas" ||
      ext === "mha1" || ext === "mhm1") {
    // ftyp box check (bytes 4-7 should be 'ftyp' for valid MP4/M4A)
    // Also handle .mha1/.mhm1 files which may not have ftyp but are still MP4
    const isMp4 = (bytes[4] === 0x66 && bytes[5] === 0x74) || // 'ft' of 'ftyp'
                  ext === "mhas" || ext === "mha1" || ext === "mhm1";
    if (isMp4) {
      try {
        const info = await parseMp4ForMpeghInfo(file);
        if (info) {
          console.log(`[parseNativeFileInfo] parseMp4ForMpeghInfo: codec=${info.format} is360RA=${info.is360RA}`);
          return info;
        }
      } catch (e) {
        console.warn(`[parseNativeFileInfo] parseMp4ForMpeghInfo failed:`, e);
      }
    }
    // Fallback: raw binary scan for known codec FourCCs.
    // Scan the full file (capped at 32 MB) to catch mha1/mhm1 even when:
    //   - the moov box sits AFTER mdat (file ends with metadata)
    //   - the file is fragmented (samples in moof/mdat at high offsets)
    //   - it's a large multi-channel file where stsd is beyond 600 KB
    const rawBuf = await file.slice(0, Math.min(file.size, 32 * 1024 * 1024)).arrayBuffer();
    const rawU8 = new Uint8Array(rawBuf);
    const scanForMpeghCodec = (u8: Uint8Array, baseOffset: number): NativeFileInfo | null => {
      for (let i = 4; i < u8.length - 4; i++) {
        // 'mha1' = 6D 68 61 31
        if (u8[i] === 0x6D && u8[i+1] === 0x68 && u8[i+2] === 0x61 && u8[i+3] === 0x31) {
          console.log(`[parseNativeFileInfo] Raw scan found mha1 at offset ${baseOffset + i}`);
          return {
            sampleRate: 48000, bitDepth: 24, channels: 0, duration: 0,
            format: "Sony 360 Reality Audio (mha1) / MPEG-H 3D Audio",
            isAtmos: false, isDolbyDigital: false, isDolbyDigitalPlus: false,
            is360RA: true, channelLayout: "Object-based 3D Audio",
          };
        }
        // 'mhm1' = 6D 68 6D 31
        if (u8[i] === 0x6D && u8[i+1] === 0x68 && u8[i+2] === 0x6D && u8[i+3] === 0x31) {
          console.log(`[parseNativeFileInfo] Raw scan found mhm1 at offset ${baseOffset + i}`);
          return {
            sampleRate: 48000, bitDepth: 24, channels: 0, duration: 0,
            format: "Sony 360 Reality Audio (mhm1) / MPEG-H 3D Audio",
            isAtmos: false, isDolbyDigital: false, isDolbyDigitalPlus: false,
            is360RA: true, channelLayout: "Object-based 3D Audio",
          };
        }
      }
      return null;
    };

    // 1. Scan the head of the file (covers most MP4s with moov-first layout
    //    and the first 32 MB of mdat-first files).
    const head = scanForMpeghCodec(rawU8, 0);
    if (head) return head;

    // 2. Scan the TAIL of the file too — covers mp4s where moov is placed
    //    after the audio mdat (common for streamed/recorded captures).
    if (file.size > rawU8.length) {
      const tailStart = Math.max(rawU8.length, file.size - 4 * 1024 * 1024);
      const tailBuf = await file.slice(tailStart, file.size).arrayBuffer();
      const tail = scanForMpeghCodec(new Uint8Array(tailBuf), tailStart);
      if (tail) return tail;
    }
  }

  return null;
}

/**
 * Walk MP4 boxes to find the MPEG-H track (mha1/mhm1) and return real
 * channel count, sample rate and duration.  Reads up to 256 KB so it can
 * reach the moov box of most Sony 360 RA files without loading the whole file.
 */
async function parseMp4ForMpeghInfo(file: File): Promise<NativeFileInfo | null> {
  // Read up to 8MB — moov box can be at the END of M4A files (streaming/progressive layout).
  // ALAC files especially (São Paulo.m4a = 104MB) have moov well before data.
  const READ_SIZE = Math.min(file.size, 8 * 1024 * 1024);
  const buf  = await file.slice(0, READ_SIZE).arrayBuffer();
  const u8   = new Uint8Array(buf);
  const dv   = new DataView(buf);
  const len  = buf.byteLength;

  // ── tiny box iterator ──────────────────────────────────────────────
  function readBoxSize(off: number): number {
    if (off + 8 > len) return 0;
    const s = dv.getUint32(off);
    if (s === 1) return dv.getUint32(off + 8) * 0x100000000 + dv.getUint32(off + 12); // 64-bit
    if (s === 0) return len - off;
    return s;
  }
  function readBoxType(off: number): string {
    return String.fromCharCode(u8[off+4], u8[off+5], u8[off+6], u8[off+7]);
  }
  function findBox(start: number, end: number, target: string): number {
    let o = start;
    while (o + 8 <= end && o < len) {
      const s = readBoxSize(o);
      if (s < 8) break;
      if (readBoxType(o) === target) return o;
      o += s;
    }
    return -1;
  }

  // ── Find moov ─────────────────────────────────────────────────────
  // Some files have a small stub 'moov' at start (progressive download) —
  // skip it if it has no 'trak' children and keep looking for the real moov.
  let off = 0;
  let moovStart = -1, moovEnd = -1;
  while (off + 8 < len) {
    const s = readBoxSize(off);
    if (s < 8) break;
    if (readBoxType(off) === 'moov') {
      const candidateEnd = Math.min(off + s, len);
      // Check if this moov has at least one trak child
      const hasTrak = findBox(off + 8, candidateEnd, 'trak') >= 0;
      if (hasTrak) {
        moovStart = off;
        moovEnd = candidateEnd;
        break;
      }
        // Stub moov — skip and continue
    }
    off += s;
  }

  if (moovStart < 0) {
    // Fragmented MP4: no trak-containing moov found.
    // Raw scan for stsd box to get codec info.
    // Optimized: search for 0x73 ('s') first, then verify full FourCC
    for (let i = 4; i < len - 8; i++) {
      if (u8[i] !== 0x73 || u8[i+1] !== 0x74 || u8[i+2] !== 0x73 || u8[i+3] !== 0x64) continue; // 'stsd'
      {
        const eStart = (i - 4) + 16;
        if (eStart + 8 < len) {
          const codec = String.fromCharCode(u8[eStart+4],u8[eStart+5],u8[eStart+6],u8[eStart+7]).toLowerCase().trim();
          // Also find mdhd nearby for sample rate/duration
          let sr = 48000, dur = 0;
          // Look for mdhd within 2KB before stsd
          for (let k = Math.max(0, i - 2000); k < i; k++) {
            if (String.fromCharCode(u8[k],u8[k+1],u8[k+2],u8[k+3]) === 'mdhd') {
              const v = u8[k-4+8];
              if (v === 0) {
                sr = dv.getUint32(k-4+20);
                const dur32 = dv.getUint32(k-4+24);
                dur = sr > 0 ? (dur32 >>> 0) / sr : 0;
              }
              break;
            }
          }
          const is360 = codec === 'mha1' || codec === 'mhm1';
          if (codec.length === 4) {
            return {
              sampleRate: sr, bitDepth: 24,
              channels: is360 ? 0 : 2,
              duration: dur,
              format: is360 ? `Sony 360 Reality Audio (${codec})` : codec.toUpperCase(),
              isAtmos: codec === 'ec-3' || codec === 'ac-4',
              isDolbyDigital: codec === 'ac-3',
              isDolbyDigitalPlus: codec === 'ec-3',
              is360RA: is360,
              channelLayout: is360 ? 'Object-based 3D Audio' : 'Stereo (L R)',
            };
          }
        }
        break;
      } // stsd block
    }
    return null;
  }

  // ── Walk traks to find MPEG-H track ───────────────────────────────
  let trakOff = moovStart + 8;
  while (trakOff + 8 < moovEnd) {
    const trakSize = readBoxSize(trakOff);
    const trakType = readBoxType(trakOff);
    if (trakSize < 8) break;

    if (trakType === 'trak') {
      const trakEnd = Math.min(trakOff + trakSize, moovEnd);

      // ── mdia ──────────────────────────────────────────────────────
      const mdiaOff = findBox(trakOff + 8, trakEnd, 'mdia');
      if (mdiaOff >= 0) {
        const mdiaEnd = Math.min(mdiaOff + readBoxSize(mdiaOff), trakEnd);

        // ── hdlr — skip non-audio tracks (video, hint, text, etc.) ─
        // hdlr box: 8 header + 4 version/flags + 4 pre_defined + 4 handler_type
        const hdlrOff = findBox(mdiaOff + 8, mdiaEnd, 'hdlr');
        if (hdlrOff >= 0) {
          const handlerType = readBoxType(hdlrOff + 16); // 8 hdr + 4 ver/flags + 4 pre_defined
          if (handlerType !== 'soun') {
            // Not an audio track — skip (video='vide', hint='hint', text='text', etc.)
            trakOff += trakSize;
            continue;
          }
        }

        // ── mdhd — timescale + duration ───────────────────────────
        let timescale = 48000;
        let durationSec = 0;
        const mdhdOff = findBox(mdiaOff + 8, mdiaEnd, 'mdhd');
        if (mdhdOff >= 0) {
          // mdhd box layout (ISO 14496-12):
          // offset 0-3: box size
          // offset 4-7: 'mdhd'
          // offset 8:   version (0 or 1)
          // offset 9-11: flags (3 bytes)
          // version 0: creation_time(4) + modification_time(4) + timescale(4) + duration(4)
          //   → timescale at mdhdOff+20, duration at mdhdOff+24
          // version 1: creation_time(8) + modification_time(8) + timescale(4) + duration(8)
          //   → timescale at mdhdOff+28, duration at mdhdOff+32
          const v = dv.getUint8(mdhdOff + 8);
          if (v === 1) {
            timescale = dv.getUint32(mdhdOff + 28);
            const durHi = dv.getUint32(mdhdOff + 32);
            const durLo = dv.getUint32(mdhdOff + 36);
            const dur64 = durHi * 0x100000000 + (durLo >>> 0);
            durationSec = timescale > 0 ? dur64 / timescale : 0;
          } else {
            // version 0
            timescale = dv.getUint32(mdhdOff + 20);
            const dur32 = dv.getUint32(mdhdOff + 24);
            durationSec = timescale > 0 ? (dur32 >>> 0) / timescale : 0;
          }
        }

        // ── minf → stbl → stsd ────────────────────────────────────
        const minfOff = findBox(mdiaOff + 8, mdiaEnd, 'minf');
        if (minfOff >= 0) {
          const minfEnd = Math.min(minfOff + readBoxSize(minfOff), mdiaEnd);
          const stblOff = findBox(minfOff + 8, minfEnd, 'stbl');
          if (stblOff >= 0) {
            const stblEnd = Math.min(stblOff + readBoxSize(stblOff), minfEnd);
            const stsdOff = findBox(stblOff + 8, stblEnd, 'stsd');
            if (stsdOff >= 0) {
              // stsd: 4 version/flags + 4 entry_count, then entries
              const entryCount = dv.getUint32(stsdOff + 12);
              if (entryCount > 0) {
                // First entry starts at stsdOff + 16
                const eOff = stsdOff + 16;
                if (eOff + 8 < len) {
                  const codec = readBoxType(eOff);
                  const is360RA = codec === 'mha1' || codec === 'mhm1';

                  // AudioSampleEntry layout (ISO 14496-12 §12.2.3):
                  // eOff = start of codec box (4 size + 4 type = 8 byte header)
                  // After box header: 6 reserved + 2 data_reference_index = 8 bytes
                  // Then: 8 bytes reserved (pre_defined)
                  // channelcount : 2 bytes  → at eOff + 8 + 8 + 8 = eOff + 24
                  // samplesize   : 2 bytes  → at eOff + 26
                  // pre_defined  : 2 bytes  → at eOff + 28
                  // reserved     : 2 bytes  → at eOff + 30
                  // samplerate   : 4 bytes (16.16 fixed) → at eOff + 32
                  const channelCount    = eOff + 26 < len ? dv.getUint16(eOff + 24) : 2;
                  const sampleSize      = eOff + 28 < len ? dv.getUint16(eOff + 26) : 16;
                  const sampleRateFixed = eOff + 36 < len ? dv.getUint32(eOff + 32) : 0;
                  // sampleRateFixed is 16.16 fixed point — upper 16 bits is Hz
                  const sampleRate      = (sampleRateFixed >>> 16) & 0xFFFF;

                  if (is360RA) {
                    const mhaCResult = parseMhaSpecificBoxChannels(u8, dv, eOff, stsdOff + readBoxSize(stsdOff), len);
                    const realChannels = (mhaCResult !== null && mhaCResult > 0)
                      ? mhaCResult
                      : (mhaCResult === 0 ? 0 : (channelCount > 2 ? channelCount : 0));

                    const formatLabel = codec === 'mha1'
                      ? "Sony 360 Reality Audio (mha1)"
                      : "Sony 360 Reality Audio (mhm1)";

                    return {
                      sampleRate: sampleRate || 48000,
                      bitDepth: 24,
                      channels: realChannels || 0,
                      duration: durationSec,
                      format: formatLabel,
                      isAtmos: false, isDolbyDigital: false,
                      isDolbyDigitalPlus: false, is360RA: true,
                      channelLayout: realChannels > 2
                        ? `Object-based 3D Audio (up to ${realChannels}ch MPEG-H)`
                        : realChannels === 0
                          ? "Object-based 3D Audio (channel count determined at decode)"
                          : "Binaural / Object-based (360RA)",
                    };
                  }

                  // ── Dolby codecs inside M4A container ─────────────────
                  // ac-4 = Dolby AC-4 (may include Atmos IMS)
                  // ec-3 = E-AC-3 / Dolby Digital Plus (may include Atmos JOC)
                  // ac-3 = Dolby Digital (legacy 5.1)
                  if (codec === 'ac-4' || codec === 'ec-3' || codec === 'ac-3') {
                    const isAC4 = codec === 'ac-4';
                    const isEC3 = codec === 'ec-3';
                    const isAC3 = codec === 'ac-3';

                    // ── EC-3: parse dec3 box for real channel count ───────
                    // AudioSampleEntry.channelCount is always 2 for EC-3 (base stereo).
                    // Real channel count is in the EC3SpecificBox ('dec3') nested inside.
                    let ch = channelCount > 0 ? channelCount : (isAC3 ? 6 : 2);
                    let hasAtmosJOC = false;

                    if (isEC3) {
                      // Scan for 'dec3' box inside the stsd entry
                      const entryEnd2 = Math.min(eOff + readBoxSize(eOff), len);
                      for (let j = eOff + 36; j + 8 < entryEnd2; j++) {
                        if (readBoxType(j) === 'dec3') {
                          // EC3SpecificBox layout (ETSI TS 102 366 §F.4):
                          // readBoxType(j) reads type at j+4..j+7, so j = box start (size field)
                          // data starts at j+8 (after 4-byte size + 4-byte type)
                          // 2 bytes: data_rate(13 bits) | num_ind_sub(3 bits)
                          // For each ind sub: fscod(2)|bsid(5)|bsmod(3)|acmod(3)|lfeon(1)|reserved(1)|num_dep_sub(4)|...
                          const dec3Data = j + 8; // skip box header (size+type = 8 bytes)
                          if (dec3Data + 3 < len) {
                            const b0 = u8[dec3Data];
                            const b1 = u8[dec3Data + 1];
                            const numIndSub = (((b0 & 0xFF) << 8) | (b1 & 0xFF)) & 0x7; // low 3 bits
                            let chCount = 0;
                            // acmod→channels: 0=2,1=1,2=2,3=3,4=3,5=4,6=4,7=5
                            const acmodCh = [2,1,2,3,3,4,4,5];
                            let bitPos = 16; // start after first 2 bytes (data_rate+num_ind_sub)
                            for (let sub = 0; sub <= numIndSub && bitPos + 15 < (entryEnd2 - j) * 8; sub++) {
                              const byteIdx = dec3Data + Math.floor(bitPos / 8);
                              const bitOff = bitPos % 8;
                              if (byteIdx + 3 >= len) break;
                              // Read 16 bits at bitPos
                              const word = ((u8[byteIdx] << 8) | u8[byteIdx + 1]) << bitOff;
                              const word2 = (word | (u8[byteIdx + 2] >> (8 - bitOff))) & 0xFFFF;
                              // fscod(2)|bsid(5)|bsmod(3)|acmod(3)|lfeon(1)
                              const acmod = (word2 >> 6) & 0x7;
                              const lfeon = (word2 >> 5) & 0x1;
                              chCount += acmodCh[acmod] + lfeon;
                              // num_dep_sub(4) at bit 14 of this substream
                              const numDepSub = (word2 >> 1) & 0xF;
                              // JOC = Atmos: bsid=16 (EAC-3 enhancement layer) indicates JOC
                              const bsid = (word2 >> 8) & 0x1F;
                              if (bsid === 16) hasAtmosJOC = true;
                              // Advance: 13 bits for main fields + num_dep_sub*9 or 1
                              bitPos += 13 + (numDepSub > 0 ? numDepSub * 9 : 1);
                            }
                            if (chCount > 0) ch = chCount;
                          }
                          break;
                        }
                      }
                      // Common EC-3 Atmos files: if bsid=16 found or ch derived from JOC
                      // Atmos JOC is an overlay on top of the base mix
                    }

                    // ── AC-4: parse dac4 box for channel count ────────────
                    if (isAC4) {
                      const entryEnd3 = Math.min(eOff + readBoxSize(eOff), len);
                      for (let j = eOff + 36; j + 8 < entryEnd3; j++) {
                        if (readBoxType(j) === 'dac4') {
                          // AC4SpecificBox — detect IMS (Immersive Stereo) from bitstream_version
                          // AC4SpecificBox: 4-byte size, 4-byte type, then:
                          // byte 0: ac4_dsi_version(3) | bitstream_version_high(5)
                          // byte 1: bitstream_version_low(2) | fs_index(1) | frame_rate_index(4) | ...
                          // IMS = channel_mode == 7 (binaural) in AC4PresentationV1
                          // For simplicity: channelCount==2 + AC-4 = likely IMS on Amazon Music
                          // We detect IMS by checking if the file has stereo (ch=2) AC-4
                          // (AC-4 5.1/Atmos would have ch>2 or specific bitstream flags)
                          // byte at j+8: ac4_dsi_version bits
                          // AC-4 Immersive Stereo = 2ch (IMS), standard = 5.1 or 7.1
                          break;
                        }
                      }
                    }

                    const isAtmos = isEC3 || isAC4;
                    // For EC-3 JOC (Atmos), the bed channel count from dec3 is the
                    // downmix bed (e.g. 3.1, 5.1) — Atmos objects are on top.
                    // Display: show bed channels + "Atmos" label.
                    const chLayout = ch === 1 ? 'Mono (C)'
                      : ch === 2 ? 'Stereo (L R)'
                      : ch === 4 ? '3.1 (L R C LFE)'
                      : ch === 6 ? '5.1 (L R C LFE Ls Rs)'
                      : ch === 8 ? '7.1 (L R C LFE Ls Rs Lrs Rrs)'
                      : `${ch} channels`;

                    const formatStr = isAC4
                      ? `Dolby AC-4${ch <= 2 ? ' (Immersive Stereo / Atmos)' : ' (Atmos)'}`
                      : isEC3
                        ? `Dolby Digital Plus (E-AC-3${hasAtmosJOC ? ' / Dolby Atmos' : ''})`
                        : 'Dolby Digital (AC-3)';

                    return {
                      sampleRate: sampleRate || 48000,
                      bitDepth: 24,
                      channels: ch,
                      duration: durationSec,
                      format: formatStr,
                      isAtmos,
                      isDolbyDigital: isAC3,
                      isDolbyDigitalPlus: isEC3,
                      is360RA: false,
                      channelLayout: hasAtmosJOC ? `${chLayout} + Atmos Objects` : chLayout,
                    };
                  }

                  // ── ALAC — read ALACSpecificBox for true sr/ch/bd ──────
                  // AudioSampleEntry for ALAC has sampleRate=0 — real values are
                  // inside the nested ALACSpecificBox ('alac' child box)
                  if (codec === 'alac') {
                    // Scan for nested 'alac' child box starting after AudioSampleEntry header
                    const entryEnd = Math.min(eOff + readBoxSize(eOff), len);
                    let alacSr = sampleRate || 44100;
                    let alacCh = channelCount || 2;
                    let alacBd = sampleSize || 16;
                    for (let j = eOff + 36; j + 8 < entryEnd; j++) {
                      if (readBoxType(j) === 'alac') {
                        // ALACSpecificBox: box hdr(8) + version/flags(4) + ALACSpecificConfig:
                        // frameLength(4), compatibleVersion(1), bitDepth(1),
                        // tuningCurrentBackOff(1), tuningMaxBackOff(1), byteStreamVersion(1),
                        // numChannels(1), maxRun(2), maxFrameBytes(4), avgBitRate(4), sampleRate(4)
                        const cfg = j + 8 + 4; // skip box hdr(8) + version/flags(4)
                        if (cfg + 24 < len) {
                          alacBd = u8[cfg + 5] || alacBd;
                          alacCh = u8[cfg + 9] || alacCh;
                          alacSr = dv.getUint32(cfg + 20) || alacSr;
                        }
                        break;
                      }
                    }
                    return {
                      sampleRate: alacSr,
                      bitDepth: alacBd,
                      channels: alacCh,
                      duration: durationSec,
                      format: 'ALAC (Apple Lossless)',
                      isAtmos: false, isDolbyDigital: false,
                      isDolbyDigitalPlus: false, is360RA: false,
                      channelLayout: getChannelLayout(alacCh),
                    };
                  }

                  // ── AAC (mp4a) ─────────────────────────────────────────
                  if (codec === 'mp4a') {
                    return {
                      sampleRate: sampleRate || 44100,
                      bitDepth: sampleSize || 16,
                      channels: channelCount || 2,
                      duration: durationSec,
                      format: 'AAC (M4A)',
                      isAtmos: false, isDolbyDigital: false,
                      isDolbyDigitalPlus: false, is360RA: false,
                      channelLayout: getChannelLayout(channelCount || 2),
                    };
                  }
                }
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

/**
 * Look inside an mha1/mhm1 AudioSampleEntry for the MHASpecificBox (mhaC).
 *
 * Sony 360 Reality Audio files are OBJECT-BASED — the AudioSampleEntry
 * channelcount field is always 2 (binaural rendering hint) regardless of
 * how many audio objects are in the bitstream (2, 12, 22, 24, etc.).
 *
 * The real object count lives inside the MPEG-H bitstream itself and can
 * only be determined by the decoder at runtime. However, the mhaC box
 * contains a profileLevelIndication byte that tells us the profile:
 *
 *   0x0B = LC Profile L1  → up to  8 objects
 *   0x0C = LC Profile L2  → up to 14 objects
 *   0x0D = LC Profile L3  → up to 14 objects
 *   0x0E = LC Profile L4  → up to 24 objects (Sony 360 RA 24ch)
 *
 * We also try the referenceChannelLayout CICP field as a secondary hint.
 *
 * Returns:
 *   positive number = best estimate of rendered channel count
 *   null            = cannot determine (caller shows "object-based" hint)
 */
function parseMhaSpecificBoxChannels(
  u8: Uint8Array, dv: DataView,
  sampleEntryOff: number, searchEnd: number, bufLen: number,
): number | null {
  // Walk boxes inside the sample entry starting after AudioSampleEntry (28 bytes + 8 entry header)
  let o = sampleEntryOff + 8 + 28;
  const end = Math.min(searchEnd, bufLen);
  while (o + 8 < end) {
    const s = dv.getUint32(o) >>> 0;
    if (s < 8 || o + s > end) break;
    const t = String.fromCharCode(u8[o+4], u8[o+5], u8[o+6], u8[o+7]);
    if (t === 'mhaC' && o + 12 < bufLen) {
      // mhaC layout (ISO 23008-3 §A.3):
      //   o+8:  configurationVersion (1 byte, = 1)
      //   o+9:  mpegh3daProfileLevelIndication (1 byte)
      //   o+10: referenceChannelLayout (1 byte, = CICP index)
      //   o+11..o+12: mpegh3daConfigLength (2 bytes, big-endian)
      //   o+13..: mpegh3daConfig bitstream
      const profileLevel = dv.getUint8(o + 9);
      const cicp         = dv.getUint8(o + 10);

      // 1) Try CICP first — reliable for channel-based layouts
      const cicpCh = cicpToChannels(cicp);
      if (cicpCh > 0 && cicpCh !== 2) return cicpCh;

      // 2) Use profile level to give best-effort max object count
      //    This is what Sony 360 RA uses for object-based content
      const profileCh = profileLevelToMaxChannels(profileLevel);
      if (profileCh > 0) return profileCh;

      // 3) CICP=2 means "object-based binaural" — show as object-based unknown
      if (cicpCh === 2) return 0; // signals "object-based, count unknown"
    }
    o += s;
  }
  return null;
}

/**
 * MPEG-H LC Profile Level → maximum rendered output channels.
 * Source: ISO/IEC 23008-3:2022 Table 94.
 */
function profileLevelToMaxChannels(level: number): number {
  // LC Profile levels (most common in Sony 360 RA)
  if (level >= 0x0B && level <= 0x0E) {
    return [8, 14, 14, 24][level - 0x0B];
  }
  // Baseline Profile levels
  if (level >= 0x10 && level <= 0x14) {
    return [8, 14, 14, 24, 24][level - 0x10];
  }
  return 0;
}

/** Map CICP (ISO 23001-8) speaker layout index → channel count */
function cicpToChannels(cicp: number): number {
  const map: Record<number, number> = {
    1: 1,   // mono
    2: 2,   // stereo / binaural
    3: 3,   // 3.0
    4: 4,   // 4.0
    5: 5,   // 5.0
    6: 6,   // 5.1
    7: 8,   // 7.1 surround
    9: 6,   // 5.1 rear
    10: 8,  // 7.1 wide
    11: 12, // 7.1+4H
    12: 24, // 22.2 (NHK)
    13: 8,  // 7.1 screen
    14: 8,  // 7.1.2
    15: 10, // 7.1.4
    16: 12, // 7.1.6
    17: 6,  // 5.1.2
    18: 8,  // 5.1.4
    19: 8,  // 5.1.6
    20: 3,  // 3.0
  };
  return map[cicp] ?? 0;
}

function getChannelLayout(ch: number): string {
  const layouts: Record<number, string> = {
    1: "Mono (C)",
    2: "Stereo (L R)",
    3: "L R C",
    4: "L R Ls Rs",
    5: "L R C Ls Rs",
    6: "5.1 (L R C LFE Ls Rs)",
    7: "6.1 (L R C LFE Ls Rs Cs)",
    8: "7.1 (L R C LFE Ls Rs Lrs Rrs)",
    10: "9.1",
    12: "Atmos 11.1",
  };
  return layouts[ch] || `${ch} channels`;
}

// ========================================
// Real FFT (Cooley-Tukey radix-2 in-place)
// ========================================

export function fft(real: Float64Array, imag: Float64Array) {
  const n = real.length;
  if (n <= 1) return;

  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wReal = Math.cos(angle);
    const wImag = Math.sin(angle);

    for (let i = 0; i < n; i += len) {
      let curReal = 1;
      let curImag = 0;
      for (let k = 0; k < halfLen; k++) {
        const idx = i + k;
        const idx2 = idx + halfLen;
        const tReal = curReal * real[idx2] - curImag * imag[idx2];
        const tImag = curReal * imag[idx2] + curImag * real[idx2];
        real[idx2] = real[idx] - tReal;
        imag[idx2] = imag[idx] - tImag;
        real[idx] += tReal;
        imag[idx] += tImag;
        const newCurReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = newCurReal;
      }
    }
  }
}

export function hannWindow(data: Float32Array, offset: number, size: number, output: Float64Array) {
  for (let i = 0; i < size; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    output[i] = (data[offset + i] || 0) * w;
  }
}

// ========================================
// Spectrogram
// ========================================

export interface SpectrogramData {
  magnitudes: Float32Array[];
  timeSlices: number;
  freqBins: number;
  sampleRate: number;
  duration: number;
  minDb: number;
  maxDb: number;
  // Multichannel support
  channels: SpectrogramChannel[];  // one per audio channel
  numChannels: number;
}

export interface SpectrogramChannel {
  name: string;           // "L", "R", "C", "LFE", "Ls", "Rs", etc.
  index: number;
  magnitudes: Float32Array[];
  timeSlices: number;
  minDb: number;
  maxDb: number;
}

// Standard channel names for common layouts
const CHANNEL_NAMES: Record<number, string[]> = {
  1:  ["C"],
  2:  ["L", "R"],
  3:  ["L", "R", "C"],
  4:  ["L", "R", "Ls", "Rs"],
  5:  ["L", "R", "C", "Ls", "Rs"],
  6:  ["L", "R", "C", "LFE", "Ls", "Rs"],
  7:  ["L", "R", "C", "LFE", "Ls", "Rs", "Cs"],
  8:  ["L", "R", "C", "LFE", "Ls", "Rs", "Lrs", "Rrs"],
  10: ["L", "R", "C", "LFE", "Ls", "Rs", "Lrs", "Rrs", "Ltm", "Rtm"],
  12: ["L", "R", "C", "LFE", "Ls", "Rs", "Lrs", "Rrs", "Ltm", "Rtm", "Ltf", "Rtf"],
};

// ========================================
// Waveform — real peak amplitude per bar
// ========================================
export function computeWaveform(allChannels: Float32Array[], numBars = 2000): Float32Array {
  if (!allChannels.length) return new Float32Array(0);
  const left = allChannels[0];
  const right = allChannels[1] ?? allChannels[0];
  const totalSamples = left.length;
  const blockSize = Math.max(1, Math.floor(totalSamples / numBars));
  // Per bar: [leftMax, leftMin, rightMax, rightMin]
  const out = new Float32Array(numBars * 4);

  for (let i = 0; i < numBars; i++) {
    const start = i * blockSize;
    const end = Math.min(start + blockSize, totalSamples);
    let lMax = 0, lMin = 0, rMax = 0, rMin = 0;

    for (let j = start; j < end; j++) {
      const l = left[j] || 0;
      const r = right[j] || 0;
      if (l > lMax) lMax = l;
      if (l < lMin) lMin = l;
      if (r > rMax) rMax = r;
      if (r < rMin) rMin = r;
    }

    const base = i * 4;
    out[base] = lMax;
    out[base + 1] = lMin;
    out[base + 2] = rMax;
    out[base + 3] = rMin;
  }
  return out;
}

function computeSingleChannelSpec(
  channelData: Float32Array,
  fftSize: number,
  maxSlices: number
): { magnitudes: Float32Array[]; minDb: number; maxDb: number } {
  const totalSamples = channelData.length;
  const freqBins = fftSize / 2;

  // If there's not enough data even for one FFT frame, return empty
  if (totalSamples < fftSize) {
    return { magnitudes: [], minDb: -120, maxDb: 0 };
  }

  // Compute hop size so we get ~maxSlices time slices evenly across the signal.
  // Clamp: min hop = 1, max hop avoids giant sparse gaps for very long files.
  const idealHop = Math.floor((totalSamples - fftSize) / Math.max(maxSlices - 1, 1));
  const hopSize = Math.max(1, idealHop);

  // Hann window coefficients pre-computed once
  const hann = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));
  }

  const magnitudes: Float32Array[] = [];
  let minDb = 0, maxDb = -200;
  const real = new Float64Array(fftSize);
  const imag = new Float64Array(fftSize);

  let offset = 0;
  while (offset + fftSize <= totalSamples && magnitudes.length < maxSlices) {
    // Apply Hann window directly — avoids Float32→Float64 cast in hannWindow()
    for (let i = 0; i < fftSize; i++) {
      real[i] = (channelData[offset + i] || 0) * hann[i];
    }
    imag.fill(0);
    fft(real, imag);

    const slice = new Float32Array(freqBins);
    for (let k = 0; k < freqBins; k++) {
      // Hann-windowed one-sided FFT magnitude normalization.
      // Hann window coherent gain = 0.5, so peak bin energy = amplitude * fftSize * 0.5.
      // Divide by (fftSize * 0.5) to normalize to 0 dBFS for a full-scale sine.
      // Multiply by 2 for one-sided (positive-freq only) amplitude.
      const mag = (Math.sqrt(real[k] * real[k] + imag[k] * imag[k]) * 2) / (fftSize * 0.5);
      // Floor at -160 dBFS to avoid -Infinity polluting the range
      const db = Math.max(20 * Math.log10(mag + 1e-10), -160);
      slice[k] = db;
      if (db > maxDb) maxDb = db;
      if (db > -159 && db < minDb) minDb = db;
    }
    magnitudes.push(slice);
    offset += hopSize;
  }

  // Fallback if signal was pure silence
  if (!isFinite(maxDb) || maxDb < -159) maxDb = 0;
  if (!isFinite(minDb) || minDb > maxDb) minDb = maxDb - 120;

  // Clamp floor at -140 dBFS — anything below is numerical noise
  minDb = Math.max(minDb, -140);

  return { magnitudes, minDb, maxDb };
}

export function computeSpectrogram(
  allChannelData: Float32Array[],
  sampleRate: number,
  fftSize = 4096,
  _overlap = 0.875,
  nativeDuration?: number
): SpectrogramData {
  const numCh = allChannelData.length;
  // 2048 slices = ~1 FFT frame per ~45ms at 44.1kHz/4096-pt = very sharp time resolution
  // This matches Spek / SoX quality. More slices = better transient detail.
  const maxSlices = 2048;
  const names = CHANNEL_NAMES[numCh] || Array.from({ length: numCh }, (_, i) => `Ch${i + 1}`);
  const duration = nativeDuration && nativeDuration > 0
    ? nativeDuration
    : allChannelData[0].length / sampleRate;

  const channels: SpectrogramChannel[] = allChannelData.map((ch, idx) => {
    const { magnitudes, minDb, maxDb } = computeSingleChannelSpec(ch, fftSize, maxSlices);
    return { name: names[idx] ?? `Ch${idx + 1}`, index: idx, magnitudes, timeSlices: magnitudes.length, minDb, maxDb };
  });

  const globalMin = Math.min(...channels.map(c => c.minDb));
  const globalMax = Math.max(...channels.map(c => c.maxDb));
  const primary = channels[0];

  return {
    magnitudes: primary.magnitudes,
    timeSlices: primary.timeSlices,
    freqBins: fftSize / 2,
    sampleRate,
    duration,
    minDb: globalMin,
    maxDb: globalMax,
    channels,
    numChannels: numCh,
  };
}

// ========================================
// MediaInfo type
// ========================================

export interface MediaInfo {
  // General track
  format: string;
  formatProfile?: string;
  codec?: string;
  fileSize: string;
  duration: string;
  overallBitrate?: string;
  overallBitrateMode?: string;
  encoding?: string;
  encoder?: string;
  writingLibrary?: string;
  writingApp?: string;
  // Audio stream
  sampleRate: string;
  samplingCount?: string;
  bitDepth?: string;
  channels: string;
  channelLayout?: string;
  channelPositions?: string;
  audioBitrate?: string;
  bitrateMode?: string;
  compressionMode?: string;
  streamSize?: string;
  // Tags — all fields from Vorbis/ID3/iTunes
  title?: string;
  sortTitle?: string;
  artist?: string;
  sortArtist?: string;
  albumArtist?: string;
  sortAlbumArtist?: string;
  album?: string;
  sortAlbum?: string;
  composer?: string;
  sortComposer?: string;
  lyricist?: string;
  conductor?: string;
  remixer?: string;
  producer?: string;
  engineer?: string;
  performer?: string;
  label?: string;
  publisher?: string;
  genre?: string;
  date?: string;
  recordedDate?: string;
  encodedDate?: string;
  taggedDate?: string;
  trackNumber?: string;
  trackTotal?: string;
  discNumber?: string;
  discTotal?: string;
  part?: string;
  partTotal?: string;
  isrc?: string;
  copyright?: string;
  cover?: string;
  coverMime?: string;
  comment?: string;
  description?: string;
  grouping?: string;
  subtitle?: string;
  mood?: string;
  bpm?: string;
  key?: string;
  language?: string;
  rating?: string;
  originalArtist?: string;
  originalAlbum?: string;
  originalYear?: string;
  replayGainTrack?: string;
  replayGainAlbum?: string;
  podcast?: string;
  podcastUrl?: string;
  iTunesAdvisory?: string;
  tagger?: string;
  tagFormat?: string;
  extraTags?: Record<string, string>;
  // Lyrics
  lyricsType?: string;       // "LRC" | "TTML-LRC" | "Plain" | none
  lyricsLines?: number;
  lyricsPreview?: string;
  lyricsRaw?: string;
  lyricsHasTranslation?: boolean;
  lyricsHasWordTimestamps?: boolean;
  // Analysis / encoding details
  mqaDetected?: string;
  mqaOriginalRate?: string;
  mqaStudio?: string;
  lossyTranscoded?: string;
  spectralBandwidth?: string;
  effectiveBitDepth?: string;
  md5?: string;
  msEncoded?: string;
  phaseStatus?: string;
}

// ========================================
// Verdict & Fake Detection
// ========================================

export type VerdictStatus = "genuine" | "fake" | "suspicious" | "inconclusive" | "defective";

export interface FakeDetectionResult {
  verdict: VerdictStatus;
  verdictLabel: string;
  confidence: number; // 0-100
  claimedBitrate: number; // kbps from file size
  actualBitrate: number | null; // estimated from spectrum
  frequencyCutoff: number; // Hz
  reasons: string[];
  details: string;
  cutoffSlopeDbPerOct: number;    // 2.1: edge sharpness (dB/octave, always negative)
  cutoffStabilityHz: number;      // 2.2: time-localised cutoff stddev (Hz)
  energyAboveCutoffDb: number;    // 2.3: energy ratio above cutoff vs total (dB, always ≤ 0)
}

// Cutoff frequency → estimated original MP3 bitrate mapping
// These are well-known empirical values for LAME/FhG encoders
const CUTOFF_TO_BITRATE: [number, number][] = [
  [11025, 32],
  [12000, 40],
  [13000, 48],
  [14000, 56],
  [15000, 64],
  [15500, 80],
  [16000, 96],
  [16500, 112],
  [17000, 128],
  [17500, 144],
  [18000, 160],
  [18500, 192],
  [19000, 224],
  [19500, 256],
  [20000, 320],
  [20500, 320],
];

function cutoffToBitrate(cutoffHz: number): number {
  if (cutoffHz >= 20500) return 320;
  if (cutoffHz <= 11025) return 32;
  
  for (let i = 0; i < CUTOFF_TO_BITRATE.length - 1; i++) {
    const [f0, br0] = CUTOFF_TO_BITRATE[i];
    const [f1, br1] = CUTOFF_TO_BITRATE[i + 1];
    if (cutoffHz >= f0 && cutoffHz <= f1) {
      const t = (cutoffHz - f0) / (f1 - f0);
      return Math.round(br0 + (br1 - br0) * t);
    }
  }
  return 320;
}

// Robust spectral cutoff detection — the core algorithm
// Uses energy drop-off analysis across multiple segments
// Cannot be fooled by audio optimizers that add noise above cutoff
function detectSpectralCutoff(
  data: Float32Array, 
  sampleRate: number
): { cutoffHz: number; sharpCutoff: boolean; energyProfile: Float64Array } {
  const fftSize = 16384; // High resolution for precise cutoff detection
  const nyquist = sampleRate / 2;
  const numSegments = Math.min(Math.floor(data.length / fftSize), 32);
  
  if (numSegments < 2) return { cutoffHz: nyquist, sharpCutoff: false, energyProfile: new Float64Array(0) };
  
  const bins = fftSize / 2;
  const avgSpectrum = new Float64Array(bins);
  const real = new Float64Array(fftSize);
  const imag = new Float64Array(fftSize);
  
  // Average spectrum across many segments for stability
  for (let seg = 0; seg < numSegments; seg++) {
    const offset = Math.floor((data.length - fftSize) * seg / Math.max(numSegments - 1, 1));
    hannWindow(data, offset, fftSize, real);
    imag.fill(0);
    fft(real, imag);
    
    for (let k = 0; k < bins; k++) {
      const mag = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]) / fftSize;
      avgSpectrum[k] += mag;
    }
  }
  
  for (let k = 0; k < bins; k++) {
    avgSpectrum[k] /= numSegments;
  }
  
  const binRes = sampleRate / fftSize;
  
  // Convert to dB for analysis
  const dbSpectrum = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    dbSpectrum[k] = 20 * Math.log10(avgSpectrum[k] + 1e-10);
  }
  
  // Smooth the spectrum with a wide window to find the overall energy envelope
  const smoothWindow = 64;
  const smoothed = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    let sum = 0;
    let count = 0;
    for (let w = -smoothWindow; w <= smoothWindow; w++) {
      const idx = k + w;
      if (idx >= 0 && idx < bins) {
        sum += dbSpectrum[idx];
        count++;
      }
    }
    smoothed[k] = sum / count;
  }
  
  // Find the cutoff: look for where energy drops sharply
  // Start from high frequencies and work down
  // Use the "energy cliff" method: find where the smoothed energy
  // drops more than 20dB below the average mid-frequency energy
  
  // Reference energy: average between 1kHz and 8kHz
  const refBinLow = Math.floor(1000 / binRes);
  const refBinHigh = Math.floor(8000 / binRes);
  let refEnergy = 0;
  for (let k = refBinLow; k < refBinHigh && k < bins; k++) {
    refEnergy += smoothed[k];
  }
  refEnergy /= (refBinHigh - refBinLow);
  
  // Scan from top down for where energy drops below threshold
  const dropThreshold = -30; // dB below reference
  let cutoffBin = bins - 1;
  let sharpCutoff = false;
  
  // Start from Nyquist and scan down
  for (let k = bins - 1; k > refBinHigh; k--) {
    const drop = smoothed[k] - refEnergy;
    if (drop > dropThreshold) {
      cutoffBin = k;
      break;
    }
  }
  
  // Check if the cutoff is "sharp" (brick-wall, characteristic of lossy codecs)
  // by looking at the gradient around the cutoff point
  if (cutoffBin < bins - 10 && cutoffBin > refBinHigh) {
    const belowCutoff = smoothed[cutoffBin - 10] || -100;
    const aboveCutoff = smoothed[Math.min(cutoffBin + 20, bins - 1)] || -100;
    const gradient = belowCutoff - aboveCutoff;
    // A sharp cutoff has >15dB drop over a small frequency range
    sharpCutoff = gradient > 15;
  }
  
  const cutoffHz = Math.min(cutoffBin * binRes, nyquist);
  
  return { cutoffHz, sharpCutoff, energyProfile: smoothed };
}

// ========================================
// Analysis result
// ========================================

export interface ChannelStat {
  name: string;
  peakDb: number;
  peakLinear: number;
  rmsDb: number;
  dr: number;
  drPeakDb: number;
  drTopRmsDb: number;
  drBlockCount: number;
}

export interface AnalysisResult {
  fileName: string;
  fileSize: number;
  duration: number;
  sampleRate: number;        // browser-decoded (may be resampled)
  nativeSampleRate: number;  // real from file header
  nativeBitDepth: number;    // real from file header
  nativeChannels: number;    // real from file header
  nativeDuration: number;    // from header (claimed)
  nativeInfo: NativeFileInfo | null;
  channels: number;
  bitDepth: number;
  format: string;
  formatExt: string;
  
  truePeak: number;
  samplePeak: number;
  samplePeakLinear: number;
  rmsLevel: number;
  replayGainTrackGain: number;
  dynamicRange: number;
  crestFactor: number;
  channelStats: ChannelStat[];
  clippingDetected: boolean;
  clippingSamples: number;
  
  frequencyCutoff: number;
  lossyDetected: boolean;
  
  noiseFloor: number;
  ditheringDetected: boolean;
  
  stereoCorrelation: number;
  phaseIssues: boolean;
  channelBalance: number;
  
  bitDepthAuthentic: boolean;
  effectiveBitDepth: number;
  lsbEntropy: number;            // 2.4: 0–8, higher = more genuine bit depth
  sampleRateAuthentic: boolean;
  upsamplingDetected: boolean;
  upsampledFromRate: number | null;  // 2.5: detected source sample rate (e.g. 44100)
  bitPerfect: boolean;
  integrityReason: string;
  
  compressionLevel: string;
  limitingDetected: boolean;

  // Stereo / phase details
  msEncoded: boolean;
  msRatio: number; // 0–1, how much M/S content vs L/R

  spectrogram: SpectrogramData;
  waveform: Float32Array;
  mediaInfo: MediaInfo;
  fakeDetection: FakeDetectionResult;
}

function dbFromLinear(value: number): number {
  return 20 * Math.log10(Math.max(value, 1e-12));
}

function rmsDb(data: Float32Array): number {
  let sumSq = 0;
  for (let i = 0; i < data.length; i++) sumSq += data[i] * data[i];
  return dbFromLinear(Math.sqrt(sumSq / Math.max(data.length, 1)));
}

function peakLinear(data: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const v = Math.abs(data[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

function computeTtDrForChannel(data: Float32Array, sampleRate: number): { dr: number; peakDb: number; topRmsDb: number; blockCount: number } {
  // DR14 / PMF-compatible estimator:
  // - 3-second chunks
  // - RMS is average of loudest 20% RMS chunks
  // - Peak uses second-highest chunk peak when available, matching behavior noted by foo_dr_meter changelog
  const blockSize = Math.max(1, Math.floor(sampleRate * 3));
  const blockRms: number[] = [];
  const blockPeaks: number[] = [];

  for (let start = 0; start < data.length; start += blockSize) {
    const end = Math.min(start + blockSize, data.length);
    if (end <= start) continue;
    let sumSq = 0;
    let peak = 0;
    for (let i = start; i < end; i++) {
      const sample = data[i];
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
      sumSq += sample * sample;
    }
    blockRms.push(Math.sqrt(sumSq / (end - start)));
    blockPeaks.push(peak);
  }

  if (!blockRms.length) return { dr: 0, peakDb: -Infinity, topRmsDb: -Infinity, blockCount: 0 };

  blockRms.sort((a, b) => b - a);
  blockPeaks.sort((a, b) => b - a);

  const topCount = Math.max(1, Math.ceil(blockRms.length * 0.2));
  const loudestRms = blockRms.slice(0, topCount).reduce((a, b) => a + b, 0) / topCount;
  const peakForDr = blockPeaks.length > 1 && blockPeaks[1] > 0 ? blockPeaks[1] : blockPeaks[0];

  const peakDb = dbFromLinear(peakForDr);
  const topRmsDb = dbFromLinear(loudestRms);
  // DR Offline / PMF meters reference RMS to a full-scale sine, causing a -3.0103 dB offset
  // versus simple peak-dBFS minus RMS-dBFS.
  const sineReferenceOffsetDb = 20 * Math.log10(Math.SQRT1_2);
  return {
    dr: peakDb - topRmsDb + sineReferenceOffsetDb,
    peakDb,
    topRmsDb,
    blockCount: blockRms.length,
  };
}

function computeChannelStats(allChannels: Float32Array[], sampleRate: number): ChannelStat[] {
  const names = CHANNEL_NAMES[allChannels.length] || Array.from({ length: allChannels.length }, (_, i) => `Ch${i + 1}`);
  return allChannels.map((channel, i) => {
    const peak = peakLinear(channel);
    const drInfo = computeTtDrForChannel(channel, sampleRate);
    return {
      name: names[i] ?? `Ch${i + 1}`,
      peakDb: dbFromLinear(peak),
      peakLinear: peak,
      // For DR14/PMF compatibility, displayed RMS is the DR-window RMS, not full-track RMS.
      rmsDb: drInfo.topRmsDb,
      dr: drInfo.dr,
      drPeakDb: drInfo.peakDb,
      drTopRmsDb: drInfo.topRmsDb,
      drBlockCount: drInfo.blockCount,
    };
  });
}

function applyBs1770KWeighting(data: Float32Array, sampleRate: number): Float32Array {
  // ITU-R BS.1770 K-weighting: high-shelf pre-filter + RLB high-pass.
  // Coefficients are sample-rate adapted using RBJ-style biquad transforms.
  const out = new Float32Array(data.length);

  const shelfGainDb = 3.999843853973347;
  const shelfFreq = 1681.974450955533;
  const shelfQ = 0.7071752369554196;
  const k1 = Math.tan(Math.PI * shelfFreq / sampleRate);
  const vh = Math.pow(10, shelfGainDb / 20);
  const vb = Math.sqrt(vh);
  const a01 = 1 + (vb / shelfQ) * k1 + k1 * k1;
  const b01 = (vh + (vh / shelfQ) * k1 + k1 * k1) / a01;
  const b11 = 2 * (k1 * k1 - vh) / a01;
  const b21 = (vh - (vh / shelfQ) * k1 + k1 * k1) / a01;
  const a11 = 2 * (k1 * k1 - 1) / a01;
  const a21 = (1 - (vb / shelfQ) * k1 + k1 * k1) / a01;

  const hpFreq = 38.13547087613982;
  const hpQ = 0.5003270373253902;
  const k2 = Math.tan(Math.PI * hpFreq / sampleRate);
  const a02 = 1 + k2 / hpQ + k2 * k2;
  const b02 = 1 / a02;
  const b12 = -2 / a02;
  const b22 = 1 / a02;
  const a12 = 2 * (k2 * k2 - 1) / a02;
  const a22 = (1 - k2 / hpQ + k2 * k2) / a02;

  let x11 = 0, x21 = 0, y11 = 0, y21 = 0;
  let x12 = 0, x22 = 0, y12 = 0, y22 = 0;

  for (let i = 0; i < data.length; i++) {
    const x0 = data[i];
    const y01 = b01 * x0 + b11 * x11 + b21 * x21 - a11 * y11 - a21 * y21;
    x21 = x11; x11 = x0; y21 = y11; y11 = y01;

    const y02 = b02 * y01 + b12 * x12 + b22 * x22 - a12 * y12 - a22 * y22;
    x22 = x12; x12 = y01; y22 = y12; y12 = y02;
    out[i] = y02;
  }

  return out;
}

function computeReplayGainTrackGain(allChannels: Float32Array[], sampleRate: number): { loudness: number; gain: number } {
  // ReplayGain 2.0 / EBU R128-style integrated loudness, target -18 LUFS.
  // This is calculated from decoded PCM. Exact Foobar values can still differ by component/version.
  if (!allChannels.length) return { loudness: -Infinity, gain: 0 };
  const weightedChannels = allChannels.map(ch => applyBs1770KWeighting(ch, sampleRate));
  const blockSize = Math.max(1, Math.floor(sampleRate * 0.4));
  const hopSize = Math.max(1, Math.floor(sampleRate * 0.1));
  const length = weightedChannels[0].length;
  const powers: number[] = [];

  for (let start = 0; start + blockSize <= length; start += hopSize) {
    let blockPower = 0;
    for (let ch = 0; ch < weightedChannels.length; ch++) {
      const data = weightedChannels[ch];
      let sumSq = 0;
      for (let i = start; i < start + blockSize; i++) sumSq += data[i] * data[i];
      const weight = ch >= 4 ? Math.pow(10, 1.5 / 10) : 1;
      blockPower += (sumSq / blockSize) * weight;
    }
    if (blockPower > 0) powers.push(blockPower);
  }

  if (!powers.length) return { loudness: -Infinity, gain: 0 };
  const absGated = powers.filter(p => 10 * Math.log10(Math.max(p, 1e-12)) - 0.691 > -70);
  const base = absGated.length ? absGated : powers;
  const avgAbs = base.reduce((a, b) => a + b, 0) / base.length;
  const relGated = base.filter(p => p > avgAbs * 0.1); // -10 LU relative gate
  const finalBlocks = relGated.length ? relGated : base;
  const finalPower = finalBlocks.reduce((a, b) => a + b, 0) / finalBlocks.length;
  const loudness = 10 * Math.log10(Math.max(finalPower, 1e-12)) - 0.691;
  return { loudness, gain: -18 - loudness };
}

export type ProgressCallback = (progress: number) => void;

export interface AnalyzeAudioOptions {
  /** Which MPEG-H WASM decoder to use for 360 RA files (default: 'ittiam') */
  mpeghDecoderChoice?: 'ittiam' | 'fraunhofer';
  /** Called with 0-100 during the MPEG-H WASM decode phase */
  onDecodeProgress?: (pct: number) => void;
}

export async function analyzeAudio(
  file: File,
  onProgress?: ProgressCallback,
  options?: AnalyzeAudioOptions,
): Promise<AnalysisResult> {
  onProgress?.(3);

  // Parse real native info from file header BEFORE any decoding
  const nativeInfo = await parseNativeFileInfo(file);
  const ext = file.name.split(".").pop()?.toLowerCase() || "unknown";
  onProgress?.(6);

  // Read file bytes
  const arrayBuffer = await file.arrayBuffer();
  onProgress?.(10);

  // Load WASM decoder module
  onProgress?.(11);
  const { decodeAudioFile } = await import("./wasmDecoders");
  onProgress?.(12);

  const nativeSampleRate = nativeInfo?.sampleRate ?? 44100;
  const nativeBitDepth   = nativeInfo?.bitDepth   ?? 16;
  const nativeChannels   = nativeInfo?.channels    ?? 2;
  const nativeDuration   = nativeInfo?.duration    ?? 0;

  // Decode — this is the slow part (WASM init + decode)
  // For 360 RA files use real Worker decode-progress; for others simulate 12→27
  const mpeghDecoderChoice = options?.mpeghDecoderChoice ?? 'ittiam';
  const is360RA = nativeInfo?.is360RA || ['mha1','mhm1','mhas'].includes(ext);

  let decodeProgressTimer: ReturnType<typeof setInterval> | null = null;

  if (!is360RA) {
    // Simulate decode progress 12→27 slowly, so UI never appears frozen.
    // FFmpeg CDN download can take 5-30s on first load — keep incrementing.
    let fakeP = 12;
    decodeProgressTimer = setInterval(() => {
      if (fakeP < 27) {
        fakeP += 1;
        onProgress?.(fakeP);
      }
      // Don't stop at 26 — keep at 27 until decode actually finishes
    }, 800);
  }

  const decoded = await decodeAudioFile(
    file, arrayBuffer, ext,
    nativeSampleRate, nativeBitDepth, nativeChannels, nativeDuration,
    nativeInfo,
    mpeghDecoderChoice,
    // For 360RA files, map worker progress (0-100) → overall progress (12-27)
    is360RA ? (pct: number) => {
      const mapped = 12 + Math.round(pct * 15 / 100);
      onProgress?.(mapped);
      options?.onDecodeProgress?.(pct);
    } : undefined,
  );

  if (decodeProgressTimer) { clearInterval(decodeProgressTimer); decodeProgressTimer = null; }
  onProgress?.(28);
  options?.onDecodeProgress?.(100);

  // Use decoded values (may be more accurate than nativeInfo for some formats)
  const finalSampleRate = decoded.sampleRate || nativeSampleRate;
  const finalBitDepth   = decoded.bitDepth   || nativeBitDepth;
  const finalChannels   = decoded.channels   || nativeChannels;
  const finalDuration   = decoded.duration   || nativeDuration;

  const channelData = decoded.channelData;
  if (!Array.isArray(channelData) || channelData.length === 0 || !channelData[0] || channelData[0].length === 0) {
    throw new Error(
      `Decoder "${decoded.decoderUsed || 'unknown'}" returned no PCM data ` +
      `(channels=${channelData?.length ?? 0}, samples=${channelData?.[0]?.length ?? 0}). ` +
      `The file may be corrupted, encrypted, or use an unsupported MPEG-H profile.`
    );
  }
  const left  = channelData[0];
  const right  = channelData.length > 1 ? channelData[1] : null;
  const totalLen = left.length;

  // Concise log so console shows which decoder produced the PCM
  console.log(`[AudioAnalysis] ${decoded.decoderUsed}`);
  
  // ---- Peak & RMS ----
  let samplePeak = 0;
  let clippingSamples = 0;
  let sumSq = 0;
  const clipThresh = 0.9999;
  
  for (let i = 0; i < totalLen; i++) {
    const v = Math.abs(left[i]);
    if (v > samplePeak) samplePeak = v;
    if (v >= clipThresh) clippingSamples++;
    sumSq += left[i] * left[i];
  }
  if (right) {
    for (let i = 0; i < right.length; i++) {
      const v = Math.abs(right[i]);
      if (v > samplePeak) samplePeak = v;
      if (v >= clipThresh) clippingSamples++;
      sumSq += right[i] * right[i];
    }
  }
  
  const peakDb = dbFromLinear(samplePeak);
  const channelStats = computeChannelStats(channelData, finalSampleRate);
  const replayGain = computeReplayGainTrackGain(channelData, finalSampleRate);
  const primaryStats = channelStats.slice(0, Math.min(2, channelStats.length));
  const dynamicRange = primaryStats.length
    ? Math.round(primaryStats.reduce((sum, ch) => sum + ch.dr, 0) / primaryStats.length)
    : 0;
  const rmsDb = primaryStats.length
    ? primaryStats.reduce((sum, ch) => sum + ch.rmsDb, 0) / primaryStats.length
    : -Infinity;
  
  onProgress?.(30);
  
  // ---- True Peak ----
  const truePeak = computeTruePeak(left);
  const truePeakDb = 20 * Math.log10(truePeak + 1e-10);
  onProgress?.(35);
  
  // ---- Spectral cutoff (core fake detection) ----
  onProgress?.(38);
  const spectralResult = detectSpectralCutoff(left, finalSampleRate);
  const cutoffFreq = spectralResult.cutoffHz;
  const nyquist = finalSampleRate / 2;
  const isLossy = spectralResult.sharpCutoff && cutoffFreq < nyquist * 0.85;
  onProgress?.(50);
  
  // ---- Noise floor ----
  const noiseFloor = estimateNoiseFloor(left);
  const noiseFloorDb = 20 * Math.log10(noiseFloor + 1e-10);
  onProgress?.(54);
  
  // ---- Dithering ----
  const ditheringDetected = detectDithering(left);
  onProgress?.(57);
  
  // ---- Stereo ----
  let stereoCorrelation = 1;
  let phaseIssues = false;
  let channelBalance = 0;
  let msEncoded = false;
  let msRatio = 0;
  if (right) {
    const s = analyzeStereo(left, right);
    stereoCorrelation = s.correlation;
    phaseIssues = s.phaseIssues;
    channelBalance = s.balance;
    msEncoded = s.msEncoded;
    msRatio = s.msRatio;
  }
  onProgress?.(62);
  
  // ---- Bit depth ----
  const bitInfo = analyzeBitDepth(left, finalBitDepth || undefined);
  
  // ---- Sample rate ----
  const upsampleResult = detectUpsampling(left, finalSampleRate);
  const upsamplingDetected = upsampleResult.detected;
  
  // ---- Compression ----
  const compInfo = analyzeCompression(left, dynamicRange);
  onProgress?.(65);
  
  // ---- Format ----
  const nominalBitDepth = finalBitDepth > 0 ? finalBitDepth : guessBitDepth(ext, bitInfo.effectiveBits);
  
  // ---- MQA detection (real watermark scan + filename hint) ----
  onProgress?.(68);
  const mqaResult = detectMQA(left, right, finalSampleRate, finalBitDepth || 16, decoded.rawIntSamples);
  // If filename contains "MQA" but watermark not found → flag as unconfirmed
  const filenameSuggestsMqa = /mqa/i.test(file.name) || ext === "mqa";
  if (filenameSuggestsMqa && !mqaResult.detected) {
    console.log("[MQA] Filename suggests MQA but watermark not found — likely fake/mislabeled MQA");
  }
  
  // ---- Parse file tags (Vorbis/ID3/iTunes) ----
  onProgress?.(70);
  const { parseFileTags } = await import("./tagParser");
  const fileTags = await parseFileTags(file);
  onProgress?.(73);
  
  // ---- Spectrogram — all channels, native sample rate, native duration ----
  onProgress?.(75);
  const spectrogram = computeSpectrogram(channelData, finalSampleRate, 4096, 0.875, finalDuration);
  onProgress?.(88);

  // ---- Waveform (real peak data per bar) ----
  const waveform = computeWaveform(channelData, 2000);
  onProgress?.(90);
  
  // ---- Fake detection (Fakin' The Funk style) ----
  const fakeDetection = performFakeDetection(
    file, finalSampleRate, finalDuration, ext, spectralResult, bitInfo, upsamplingDetected, clippingSamples, left, upsampleResult.sourceRate
  );
  onProgress?.(93);
  
  // ---- Integrity ----
  const reasons: string[] = [];
  if (fakeDetection.verdict === "fake") reasons.push(fakeDetection.details);
  if (upsamplingDetected) reasons.push("Upsampling detected");
  if (!bitInfo.authentic && nominalBitDepth > 16) reasons.push(`Effective depth only ~${bitInfo.effectiveBits}-bit`);
  if (clippingSamples > 100) reasons.push("Clipping detected");
  
  const bitPerfect = fakeDetection.verdict === "genuine" && reasons.length === 0;
  const integrityReason = reasons.length > 0 ? reasons.join("; ") : "No processing artifacts detected";
  
  // ---- MediaInfo ----
  onProgress?.(95);
  const mediaInfo = buildMediaInfo(
    file, finalSampleRate, finalDuration, finalChannels, ext,
    nominalBitDepth,
    cutoffFreq, isLossy,
    bitInfo, mqaResult, compInfo, fakeDetection,
    { correlation: stereoCorrelation, phaseIssues, msEncoded, msRatio },
    nativeInfo,
    decoded.decoderUsed,
    fileTags,
    filenameSuggestsMqa
  );
  onProgress?.(100);

  return {
    fileName: file.name,
    fileSize: file.size,
    duration: finalDuration,
    sampleRate: finalSampleRate,
    nativeSampleRate: finalSampleRate,
    nativeBitDepth: finalBitDepth,
    nativeChannels: finalChannels,
    nativeDuration: finalDuration,
    nativeInfo,
    channels: finalChannels,
    bitDepth: finalBitDepth > 0 ? finalBitDepth : nominalBitDepth,
    format: nativeInfo?.format ?? formatLabel(ext),
    formatExt: ext,
    truePeak: truePeakDb,    // full precision dBFS, no rounding
    samplePeak: peakDb,      // full precision dBFS, no rounding
    samplePeakLinear: samplePeak,
    rmsLevel: replayGain.loudness,
    replayGainTrackGain: replayGain.gain,
    dynamicRange,
    crestFactor: peakDb - rmsDb,
    channelStats,
    clippingDetected: clippingSamples > 0,
    clippingSamples,
    frequencyCutoff: cutoffFreq,
    lossyDetected: isLossy,
    noiseFloor: noiseFloorDb,
    ditheringDetected,
    stereoCorrelation,
    phaseIssues,
    channelBalance,
    bitDepthAuthentic: bitInfo.authentic,
    effectiveBitDepth: bitInfo.effectiveBits,
    lsbEntropy: bitInfo.lsbEntropy,
    sampleRateAuthentic: !upsamplingDetected,
    upsamplingDetected,
    upsampledFromRate: upsampleResult.sourceRate,
    bitPerfect,
    integrityReason,
    compressionLevel: compInfo.level,
    limitingDetected: compInfo.limiting,
    msEncoded,
    msRatio,
    spectrogram,
    waveform,
    mediaInfo,
    fakeDetection,
  };
}

// ========================================
// Fake Detection Engine
// ========================================

// 2.1 — Measure cutoff edge slope (dB/octave)
// Samples the smoothed spectrum ±0.5 octave around the cutoff bin.
// Lossy encoders produce a brick-wall ≈ −90 dB/oct; genuine recordings roll off gradually ≈ −12 to −24 dB/oct.
function measureCutoffSlope(
  smoothedSpectrum: Float64Array,
  cutoffBin: number,
  binResolution: number,
  nyquist: number,
): number {
  const bins = smoothedSpectrum.length;
  if (cutoffBin < 4 || cutoffBin >= bins - 4) return 0;

  // ±0.5 octave around cutoff
  const cutoffHz = cutoffBin * binResolution;
  const loHz = cutoffHz / Math.SQRT2;   // −0.5 octave
  const hiHz = cutoffHz * Math.SQRT2;   // +0.5 octave
  const loBin = Math.max(1, Math.round(loHz / binResolution));
  const hiBin = Math.min(bins - 1, Math.round(hiHz / binResolution));

  if (hiBin <= loBin) return 0;

  // Average dB in the two bands
  let sumLo = 0, sumHi = 0;
  for (let k = loBin; k < cutoffBin && k < bins; k++) sumLo += smoothedSpectrum[k];
  for (let k = cutoffBin; k <= hiBin && k < bins; k++) sumHi += smoothedSpectrum[k];

  const countLo = Math.max(1, cutoffBin - loBin);
  const countHi = Math.max(1, hiBin - cutoffBin + 1);
  const avgLo = sumLo / countLo;
  const avgHi = sumHi / countHi;

  // dB difference over 1 octave (the interval spans ~1 octave total)
  // slope = (dB_hi − dB_lo) / log2(hiHz/loHz)
  const octaves = Math.log2(hiHz / loHz);
  if (octaves <= 0) return 0;

  return (avgHi - avgLo) / octaves; // always negative (energy drops above cutoff)
}

// 2.2 — Time-localised cutoff stability
// Splits audio into N windows, finds the cutoff in each, returns the standard deviation.
// Lossy files: cutoff is rock-stable (stddev < 200 Hz). Genuine: cutoff drifts with content (> 1 kHz).
function detectCutoffStability(
  data: Float32Array,
  sampleRate: number,
): { stddevHz: number; perWindowCutoffs: number[] } {
  const fftSize = 8192;
  const nyquist = sampleRate / 2;
  const binRes = sampleRate / fftSize;
  const windowSeconds = 5;
  const windowSamples = windowSeconds * sampleRate;
  const numWindows = Math.min(Math.max(Math.floor(data.length / windowSamples), 3), 10);

  if (numWindows < 3) return { stddevHz: 0, perWindowCutoffs: [] };

  const cutoffs: number[] = [];
  const real = new Float64Array(fftSize);
  const imag = new Float64Array(fftSize);
  const bins = fftSize / 2;

  for (let w = 0; w < numWindows; w++) {
    const winStart = Math.floor((data.length - fftSize) * w / Math.max(numWindows - 1, 1));
    if (winStart + fftSize > data.length) break;

    hannWindow(data, winStart, fftSize, real);
    imag.fill(0);
    fft(real, imag);

    const dbSpec = new Float64Array(bins);
    for (let k = 0; k < bins; k++) {
      dbSpec[k] = 20 * Math.log10(Math.sqrt(real[k] * real[k] + imag[k] * imag[k]) / fftSize + 1e-10);
    }

    // Reference: average energy 1–8 kHz
    const refLo = Math.floor(1000 / binRes);
    const refHi = Math.floor(8000 / binRes);
    let refE = 0;
    for (let k = refLo; k < refHi && k < bins; k++) refE += dbSpec[k];
    refE /= Math.max(1, refHi - refLo);

    // Scan from top down for where energy drops below −30 dB relative to reference
    let cutoffBin = bins - 1;
    for (let k = bins - 1; k > refHi; k--) {
      if (dbSpec[k] - refE > -30) { cutoffBin = k; break; }
    }
    cutoffs.push(cutoffBin * binRes);
  }

  if (cutoffs.length < 2) return { stddevHz: 0, perWindowCutoffs: cutoffs };

  const mean = cutoffs.reduce((a, b) => a + b, 0) / cutoffs.length;
  const variance = cutoffs.reduce((sum, c) => sum + (c - mean) * (c - mean), 0) / cutoffs.length;
  const stddev = Math.sqrt(variance);

  return { stddevHz: stddev, perWindowCutoffs: cutoffs };
}

// 2.3 — Energy-above-cutoff ratio
// Integrates FFT energy from cutoffHz to Nyquist and compares to total energy.
// Genuine files: trace energy above cutoff ≈ −50 to −70 dB.
// Lossy files: clean wall, energy ≈ −90 dB or below (noise floor).
function measureEnergyAboveCutoff(
  smoothedDbSpectrum: Float64Array,
  cutoffHz: number,
  binResolution: number,
): number {
  const bins = smoothedDbSpectrum.length;
  if (bins === 0 || cutoffHz <= 0) return -120;

  const cutoffBin = Math.max(1, Math.round(cutoffHz / binResolution));

  // Convert smoothed dB back to linear power for proper energy integration
  let totalPower = 0;
  let abovePower = 0;

  for (let k = 1; k < bins; k++) {
    const linear = Math.pow(10, smoothedDbSpectrum[k] / 10); // power (magnitude²)
    totalPower += linear;
    if (k >= cutoffBin) abovePower += linear;
  }

  if (totalPower <= 0 || abovePower <= 0) return -120;

  return 10 * Math.log10(abovePower / totalPower); // dB ratio, always ≤ 0
}

function performFakeDetection(
  file: File,
  sampleRate: number,
  duration: number,
  ext: string,
  spectral: { cutoffHz: number; sharpCutoff: boolean; energyProfile: Float64Array },
  bitInfo: { effectiveBits: number; authentic: boolean },
  upsamplingDetected: boolean,
  clippingSamples: number,
  rawData: Float32Array,
  upsampledFromRate: number | null,
): FakeDetectionResult {
  const nyquist = sampleRate / 2;
  const claimedBitrate = Math.round((file.size * 8) / (duration || 1) / 1000);
  const losslessFormats = ['flac', 'wav', 'aiff', 'aif', 'alac', 'ape', 'wv'];
  const isLosslessFormat = losslessFormats.includes(ext);
  
  const reasons: string[] = [];
  let confidence = 0;
  let actualBitrate: number | null = null;
  
  // 2.1 — Measure cutoff edge slope (dB/octave)
  const binRes = sampleRate / (spectral.energyProfile.length * 2);
  const cutoffBin = Math.round(spectral.cutoffHz / binRes);
  const cutoffSlope = measureCutoffSlope(spectral.energyProfile, cutoffBin, binRes, nyquist);
  
  // 2.2 — Time-localised cutoff stability
  const stability = detectCutoffStability(rawData, sampleRate);
  
  // 2.3 — Energy-above-cutoff ratio
  const energyAboveDb = measureEnergyAboveCutoff(spectral.energyProfile, spectral.cutoffHz, binRes);
  
  // Core check: spectral cutoff analysis
  const estimatedBitrate = cutoffToBitrate(spectral.cutoffHz);
  
  // Check 1: Lossless file with lossy spectral signature
  if (isLosslessFormat && spectral.sharpCutoff && spectral.cutoffHz < nyquist * 0.85) {
    actualBitrate = estimatedBitrate;
    const cutoffKhz = (spectral.cutoffHz / 1000).toFixed(1);
    reasons.push(
      `Spectral cutoff at ${cutoffKhz} kHz indicates lossy source (~${estimatedBitrate} kbps)`
    );
    
    // Confidence based on how far below nyquist the cutoff is
    const ratio = spectral.cutoffHz / nyquist;
    if (ratio < 0.6) confidence = 98;      // Very clear: e.g. 128kbps in a 44.1kHz FLAC
    else if (ratio < 0.7) confidence = 95;
    else if (ratio < 0.8) confidence = 88;
    else confidence = 75;
  }
  
  // Check 2: Lossy file claiming higher bitrate than actual
  if (!isLosslessFormat && spectral.sharpCutoff) {
    actualBitrate = estimatedBitrate;
    // Compare estimated vs claimed: if off by >30%, suspicious
    if (estimatedBitrate < claimedBitrate * 0.65) {
      reasons.push(
        `Claimed ~${claimedBitrate} kbps but spectral analysis suggests ~${estimatedBitrate} kbps`
      );
      confidence = Math.max(confidence, 85);
    }
  }
  
  // Check 3: Fake 24-bit (all data in 16-bit grid)
  if (isLosslessFormat && !bitInfo.authentic && bitInfo.effectiveBits <= 16) {
    const nominalBd = guessBitDepth(ext, bitInfo.effectiveBits);
    if (nominalBd > 16) {
      reasons.push(
        `Claimed ${nominalBd}-bit but only ~${bitInfo.effectiveBits}-bit effective`
      );
      confidence = Math.max(confidence, 80);
    }
  }
  
  // Check 4: Upsampled (2.5 — multi-rate detection)
  if (upsamplingDetected) {
    const srcLabel = upsampledFromRate ? `${(upsampledFromRate / 1000).toFixed(1)} kHz` : "lower rate";
    reasons.push(
      `${(sampleRate / 1000).toFixed(1)} kHz file appears upsampled from ${srcLabel}`
    );
    confidence = Math.max(confidence, 70);
  }
  
  // Check 5: Cutoff edge sharpness (2.1)
  // Lossy encoders: brick-wall ≈ −90 dB/oct. Genuine: gradual ≈ −12 to −24 dB/oct.
  // Only applies when we already have a cutoff below Nyquist
  if (spectral.cutoffHz < nyquist * 0.9 && cutoffSlope < 0) {
    const slopeAbs = Math.abs(cutoffSlope);
    if (slopeAbs > 60) {
      // Very steep edge — strong lossy indicator
      reasons.push(
        `Cutoff edge slope ${cutoffSlope.toFixed(0)} dB/oct (brick-wall, lossy signature)`
      );
      confidence = Math.max(confidence, Math.min(confidence + 12, 98));
    } else if (slopeAbs > 40) {
      // Moderately steep — could be lossy or aggressive EQ
      reasons.push(
        `Cutoff edge slope ${cutoffSlope.toFixed(0)} dB/oct (steep rolloff)`
      );
      confidence = Math.max(confidence, Math.min(confidence + 6, 95));
    }
    // slopeAbs ≤ 40: gradual rolloff → consistent with genuine, no boost
  }
  
  // Check 6: Time-localised cutoff stability (2.2)
  // Lossy files: cutoff is rock-stable across the entire track. Genuine: varies with content.
  if (stability.stddevHz > 0 && spectral.cutoffHz < nyquist * 0.9) {
    if (stability.stddevHz < 200) {
      // Extremely stable cutoff → lossy fingerprint
      reasons.push(
        `Cutoff stable across track (σ ${stability.stddevHz.toFixed(0)} Hz) — lossy encoder signature`
      );
      confidence = Math.max(confidence, Math.min(confidence + 10, 98));
    } else if (stability.stddevHz > 1500) {
      // High variance → genuine content-dependent rolloff
      // Reduce confidence slightly (the file might be genuine after all)
      confidence = Math.max(confidence - 8, 0);
    }
    // 200–1500 Hz: ambiguous, no adjustment
  }
  
  // Check 7: Energy-above-cutoff ratio (2.3)
  // Genuine files have trace HF energy above the cutoff (−50 to −70 dB ratio).
  // Lossy files have a clean wall down to noise floor (−90 dB or below).
  if (spectral.cutoffHz < nyquist * 0.9 && energyAboveDb > -120) {
    if (energyAboveDb > -55) {
      // Significant energy above cutoff — almost certainly genuine
      // If we previously flagged this file, reduce confidence
      confidence = Math.max(confidence - 15, 0);
    } else if (energyAboveDb < -85) {
      // Near-zero energy above cutoff — lossy wall
      reasons.push(
        `Energy above cutoff at ${energyAboveDb.toFixed(0)} dB (clean wall, lossy signature)`
      );
      confidence = Math.max(confidence, Math.min(confidence + 10, 98));
    }
    // −55 to −85 dB: ambiguous (could be gentle genuine rolloff or mild lossy), no adjustment
  }
  
  // Determine verdict
  // Tiered thresholds: ≥85 FAKE, 60–84 SUSPICIOUS, 30–59 INCONCLUSIVE, <30 GENUINE
  let verdict: VerdictStatus;
  let verdictLabel: string;

  if (reasons.length === 0) {
    verdict = "genuine";
    verdictLabel = "✓ GENUINE";
    confidence = 0; // N/A for genuine
  } else if (confidence >= 85) {
    verdict = "fake";
    verdictLabel = "✗ FAKE";
  } else if (confidence >= 60) {
    verdict = "suspicious";
    verdictLabel = "⚠ SUSPICIOUS";
  } else if (confidence >= 30) {
    verdict = "inconclusive";
    verdictLabel = "? INCONCLUSIVE";
  } else {
    verdict = "genuine";
    verdictLabel = "✓ GENUINE";
    confidence = 0;
    reasons.length = 0; // low-confidence reasons are noise
  }
  
  const details = reasons.length > 0 ? reasons.join(". ") : "File appears to be genuine quality";
  
  return {
    verdict,
    verdictLabel,
    confidence,
    claimedBitrate,
    actualBitrate,
    frequencyCutoff: spectral.cutoffHz,
    reasons,
    details,
    cutoffSlopeDbPerOct: cutoffSlope,
    cutoffStabilityHz: stability.stddevHz,
    energyAboveCutoffDb: energyAboveDb,
  };
}

// ========================================
// Helper functions
// ========================================

function formatLabel(ext: string, nativeInfo?: NativeFileInfo | null): string {
  // For M4A/MP4: use actual codec from nativeInfo if available
  if ((ext === "m4a" || ext === "mp4") && nativeInfo?.format) {
    return nativeInfo.format; // Already set correctly by parseMp4ForMpeghInfo
  }
  const labels: Record<string, string> = {
    flac: "FLAC",
    mqa:  "MQA (FLAC container)",
    wav:  "WAV (PCM)",
    aiff: "AIFF",
    aif:  "AIFF",
    mp3:  "MP3 (MPEG-1 Layer 3)",
    aac:  "AAC (M4A)",
    m4a:  "M4A (AAC-LC / ALAC)",
    mp4:  "MP4 (AAC-LC / ALAC)",
    ogg:  "OGG Vorbis",
    opus: "Opus",
    ac3:  "Dolby Digital (AC-3)",
    ec3:  "Dolby Digital Plus (E-AC-3)",
    eac3: "Dolby Digital Plus (E-AC-3)",
    ac4:  "Dolby AC-4",
    ims:  "Dolby AC-4 IMS (Immersive Stereo)",
    wma:  "Windows Media Audio",
    ape:  "Monkey's Audio (APE)",
    wv:   "WavPack",
    dsf:  "DSD (DSF)",
    dff:  "DSD (DSDIFF)",
    mha1: "Sony 360 Reality Audio (MPEG-H mha1)",
    mhm1: "Sony 360 Reality Audio (MPEG-H mhm1)",
    mhas: "MPEG-H 3D Audio Stream",
    dts:  "DTS",
    dtshd:"DTS-HD Master Audio",
    thd:  "Dolby TrueHD",
    mlp:  "MLP (Meridian Lossless Packing)",
  };
  return labels[ext] || ext.toUpperCase();
}

function buildMediaInfo(
  file: File,
  sampleRate: number,
  duration: number,
  channels: number,
  ext: string,
  bitDepth: number,
  cutoffFreq: number,
  isLossy: boolean,
  bitInfo: { effectiveBits: number; authentic: boolean },
  mqaResult: { detected: boolean; originalRate: number | null; isStudio: boolean },
  compInfo: { level: string; limiting: boolean },
  fakeDetection: FakeDetectionResult,
  stereoInfo: { correlation: number; phaseIssues: boolean; msEncoded: boolean; msRatio: number },
  nativeInfo: NativeFileInfo | null,
  decoderUsed: string,
  tags: import("./tagParser").ParsedTags,
  filenameSuggestsMqa = false,
): MediaInfo {
  const losslessFormats = ['flac', 'wav', 'aiff', 'aif', 'alac', 'ape', 'wv'];
  const isLosslessFormat = losslessFormats.includes(ext);
  const dur = duration > 0 ? duration : 1;
  const overallKbps = Math.round((file.size * 8) / dur / 1000);
  const nativeSR = sampleRate;
  const nativeCh = channels;
  const samplingCount = Math.round(dur * nativeSR);

  const phaseStatus = stereoInfo.phaseIssues
    ? "Phase issues detected"
    : stereoInfo.correlation > 0.98
      ? "Mono-compatible (high correlation)"
      : stereoInfo.correlation > 0.5
        ? "Normal stereo"
        : "Wide stereo";

  // Special format labels — use nativeInfo.format which already has the correct label
  // e.g. "Dolby AC-4 (Immersive Stereo / Atmos)" or "Dolby Digital Plus (E-AC-3)"
  let formatLabel2 = nativeInfo?.format ?? formatLabel(ext, nativeInfo);
  // Only override with generic Atmos label for EC-3 (not AC-4 which has its own label)
  if (nativeInfo?.isAtmos && nativeInfo?.isDolbyDigitalPlus) formatLabel2 = "Dolby Digital Plus with Atmos (JOC)";
  if (nativeInfo?.is360RA) formatLabel2 = "Sony 360 Reality Audio";
  // MQA: confirmed watermark → show full MQA info; filename-only → show "MQA (unconfirmed)"
  if (mqaResult.detected) {
    const rateStr = mqaResult.originalRate ? ` · ${mqaResult.originalRate / 1000}kHz original` : '';
    const studioStr = mqaResult.isStudio ? ' Studio' : '';
    formatLabel2 = `MQA${studioStr}${rateStr} (in FLAC container)`;
  } else if (filenameSuggestsMqa) {
    formatLabel2 = "MQA (watermark not detected — possibly fake or re-encoded)";
  }

  const chLayout = nativeInfo?.channelLayout ?? getChannelLayout(nativeCh);

  // Codec type override for special formats
  let codecName = getCodecName(ext, nativeInfo);
  if (nativeInfo?.is360RA) {
    const codecFmt = nativeInfo.format?.toLowerCase() ?? "";
    codecName = codecFmt.includes("mhm1")
      ? "Sony 360 Reality Audio / MPEG-H (mhm1)"
      : "Sony 360 Reality Audio / MPEG-H (mha1)";
  }
  // Only override codec for EC-3 JOC (not AC-4 which has its own label)
  if (nativeInfo?.isAtmos && nativeInfo?.isDolbyDigitalPlus) codecName = "Dolby Digital Plus / E-AC-3 JOC (Atmos)";
  // AC-4: distinguish IMS (2ch binaural) from full Atmos object audio
  if (nativeInfo?.isAtmos && !nativeInfo?.isDolbyDigitalPlus && !nativeInfo?.is360RA) {
    const fmtLower = nativeInfo?.format?.toLowerCase() ?? "";
    const isIMS = fmtLower.includes("immersive") || fmtLower.includes("ims") || ext === "ims";
    codecName = isIMS
      ? "Dolby AC-4 IMS (Immersive Stereo / binaural Atmos)"
      : "Dolby AC-4 (Atmos / ac-4)";
  }

  return {
    // General
    format: formatLabel2,
    formatProfile: isLosslessFormat ? "Lossless" : "Lossy",
    codec: codecName,
    fileSize: formatFileSize(file.size),
    duration: `${formatDuration(dur)} (${dur.toFixed(3)} s)`,
    overallBitrate: `${overallKbps.toLocaleString()} kbps`,
    overallBitrateMode: isLosslessFormat ? "VBR" : "CBR/VBR",
    encoding: isLosslessFormat ? "Lossless" : "Lossy",
    // Audio stream — use REAL values from header
    sampleRate: `${nativeSR.toLocaleString()} Hz`,
    samplingCount: samplingCount.toLocaleString(),
    bitDepth: `${bitDepth} bits`,
    channels: `${nativeCh} ch`,
    channelLayout: chLayout,
    channelPositions: nativeInfo?.channelLayout,
    audioBitrate: fakeDetection.actualBitrate
      ? `~${fakeDetection.actualBitrate} kbps (est. actual) / ${overallKbps.toLocaleString()} kbps (claimed)`
      : `${overallKbps.toLocaleString()} kbps`,
    bitrateMode: isLosslessFormat ? "VBR" : (ext === 'mp3' ? "CBR/VBR" : "VBR"),
    compressionMode: isLosslessFormat ? "Lossless" : "Lossy",
    streamSize: isLosslessFormat
      ? `${formatFileSize(file.size - Math.round(file.size * 0.012))} (est.)`
      : formatFileSize(Math.round((overallKbps * 1000 * dur) / 8)),
    // Tags from file (Vorbis Comment / ID3 / iTunes)
    title:           tags.title,
    sortTitle:       tags.sortTitle,
    artist:          tags.artist || tags.performer,
    sortArtist:      tags.sortArtist,
    albumArtist:     tags.albumArtist,
    sortAlbumArtist: tags.sortAlbumArtist,
    album:           tags.album,
    sortAlbum:       tags.sortAlbum,
    composer:        tags.composer,
    sortComposer:    tags.sortComposer,
    lyricist:        tags.lyricist,
    conductor:       tags.conductor,
    remixer:         tags.remixer,
    producer:        tags.producer,
    engineer:        tags.engineer,
    label:           tags.label || tags.publisher,
    genre:           tags.genre,
    date:            tags.date,
    recordedDate:    tags.recordedDate,
    encodedDate:     tags.encodedDate,
    taggedDate:      tags.taggedDate,
    trackNumber:     tags.trackNumber,
    trackTotal:      tags.trackTotal,
    discNumber:      tags.discNumber,
    discTotal:       tags.discTotal,
    part:            tags.part,
    partTotal:       tags.partTotal,
    isrc:            tags.isrc,
    copyright:       tags.copyright,
    cover:           tags.cover || (tags.coverMime ? `Yes (${tags.coverMime})` : undefined),
    coverMime:       tags.coverMime,
    comment:         tags.comment || tags.description,
    grouping:        tags.grouping,
    subtitle:        tags.subtitle,
    mood:            tags.mood,
    bpm:             tags.bpm,
    key:             tags.key,
    language:        tags.language,
    rating:          tags.rating,
    originalArtist:  tags.originalArtist,
    originalAlbum:   tags.originalAlbum,
    originalYear:    tags.originalYear,
    replayGainTrack: tags.replayGainTrack,
    replayGainAlbum: tags.replayGainAlbum,
    iTunesAdvisory:  tags.iTunesAdvisory,
    writingLibrary:  tags.encodedLibrary,
    writingApp:      tags.encodedApplication,
    encoder:         tags.encodedBy,
    md5:             tags.md5,
    extraTags:       Object.keys(tags.extra).length > 0 ? tags.extra : undefined,
    // Lyrics
    lyricsType:               tags.lyrics ? tags.lyrics.type.toUpperCase().replace("-", " / ") : undefined,
    lyricsLines:              tags.lyrics?.lineCount,
    lyricsPreview:            tags.lyrics?.preview,
    lyricsRaw:                tags.lyrics?.raw,
    lyricsHasTranslation:     tags.lyrics?.hasTranslation,
    lyricsHasWordTimestamps:  tags.lyrics?.hasWordTimestamps,
    tagFormat:       ext === "flac" ? "Vorbis Comment" : ext === "mp3" ? "ID3v2" :
                     (ext === "m4a" || ext === "mp4") ? "iTunes (ilst)" :
                     ext === "ogg" ? "Vorbis Comment" : "Unknown",
    // Analysis
    spectralBandwidth: formatFrequency(cutoffFreq),
    effectiveBitDepth: `${bitInfo.effectiveBits}-bit effective`,
    mqaDetected: mqaResult.detected ? "Yes" : "No",
    mqaOriginalRate: mqaResult.originalRate ? `${mqaResult.originalRate / 1000} kHz` : undefined,
    mqaStudio: mqaResult.isStudio ? "Yes" : "No",
    lossyTranscoded: fakeDetection.verdict === "fake" ? "Yes — FAKE" : (isLossy && isLosslessFormat) ? "Suspected" : "No",
    msEncoded: nativeCh === 1 ? "N/A (mono)" : stereoInfo.msEncoded ? `Yes (side ratio: ${(stereoInfo.msRatio * 100).toFixed(1)}%)` : "No",
    phaseStatus: nativeCh === 1 ? "N/A (mono)" : phaseStatus,
  };
}

// Codec ID / FourCC / type identifier shown in MediaInfo-style
function getCodecName(ext: string, nativeInfo?: NativeFileInfo | null): string {
  // For M4A: use the real codec from nativeInfo.format if available
  if ((ext === "m4a" || ext === "mp4" || ext === "aac") && nativeInfo?.format) {
    const fmt = nativeInfo.format.toLowerCase();
    if (fmt.includes("alac"))         return "ALAC (Apple Lossless Audio Codec)";
    if (fmt.includes("immersive stereo") || fmt.includes("ims")) return "Dolby AC-4 IMS (Immersive Stereo / Atmos binaural)";
    if (fmt.includes("ac-4") || fmt.includes("ac4") || fmt.includes("dolby ac-4")) return "Dolby AC-4 (Atmos / ac-4)";
    if (fmt.includes("atmos") || fmt.includes("joc") || fmt.includes("e-ac-3 joc")) return "Dolby Digital Plus / E-AC-3 JOC (Atmos)";
    if (fmt.includes("e-ac-3") || fmt.includes("eac-3") || fmt.includes("ec-3"))    return "Dolby Digital Plus / E-AC-3 (ec-3)";
    if (fmt.includes("ac-3") || fmt.includes("dolby digital"))                       return "Dolby Digital / AC-3 (ac-3)";
    if (fmt.includes("360") || fmt.includes("mha1"))  return "Sony 360 Reality Audio / MPEG-H (mha1)";
    if (fmt.includes("mhm1"))                         return "Sony 360 Reality Audio / MPEG-H (mhm1)";
    if (fmt.includes("aac"))          return "AAC-LC (mp4a-40-2)";
  }
  const codecs: Record<string, string> = {
    flac: "FLAC (fLaC)",
    mqa:  "MQA (in FLAC container)",
    wav:  "PCM / WAVE (fmt )",
    aiff: "PCM / AIFF (COMM)",
    aif:  "PCM / AIFF (COMM)",
    mp3:  "MPEG-1 Layer III (ID3 / Xing)",
    aac:  "AAC-LC (mp4a-40-2)",
    m4a:  "AAC-LC / ALAC (mp4a / alac)",
    mp4:  "AAC-LC / ALAC (mp4a / alac)",
    ogg:  "Vorbis (OggS)",
    opus: "Opus (OggS / OpusHead)",
    ac3:  "Dolby Digital / AC-3 (0x0B77 / ac-3)",
    ec3:  "Dolby Digital Plus / E-AC-3 (0x0B77 / ec-3)",
    eac3: "Dolby Digital Plus / E-AC-3 (0x0B77 / ec-3)",
    ac4:  "Dolby AC-4 (IMS / Atmos) — proprietary",
    ims:  "Dolby AC-4 IMS (Immersive Stereo binaural)",
    wma:  "Windows Media Audio (0x0161)",
    ape:  "Monkey's Audio (MAC)",
    wv:   "WavPack (wvpk)",
    dsf:  "DSD / DSF (DSD )",
    dff:  "DSD / DSDIFF (FRM8)",
    mha1: "Sony 360 Reality Audio / MPEG-H (mha1)",
    mhm1: "Sony 360 Reality Audio / MPEG-H (mhm1)",
    mhas: "MPEG-H 3D Audio Stream (mhas)",
    dts:  "DTS Coherent Acoustics (DTSHDHDR / DTSHD)",
    dtshd:"DTS-HD Master Audio (DTSHDHDR)",
    thd:  "Dolby TrueHD / MLP (TrueHD)",
    mlp:  "Meridian Lossless Packing (TrueHD/MLP)",
  };
  return codecs[ext] || ext.toUpperCase();
}

// ─── Real MQA Detection ──────────────────────────────────────────────────────
// Based on https://github.com/Dniel97/MQA-identifier-python
// Algorithm:
//  1. XOR left & right channel samples (integer domain)
//  2. Extract 1 bit per sample at LSB position 16, 17, or 18 (try all three)
//  3. Slide through first ~3 seconds looking for 36-bit magic: 0xBE0498C88
//  4. On match: decode 4-bit original sample rate (samples i+3..i+6)
//     base = bit6==0 ? 44100 : 48000, multiplier = 2^(4-bit value)
//  5. Decode 5-bit OSR (samples i+3..i+7) → original sample rate

// ─── Real MQA Detection ──────────────────────────────────────────────────────
// Based on https://github.com/purpl3F0x/MQA_identifier (reference C++ implementation)
// Algorithm (exact match to C++ reference):
//  1. Use raw FLAC integer samples (reconstruct from float32 using bit depth scale)
//  2. XOR left ^ right channels
//  3. Extract bit at position (bps - 16):
//     - 16-bit FLAC → pos=0 (LSB)
//     - 24-bit FLAC → pos=8
//  4. OR bit into accumulator LSB, shift left each sample (3 parallel buffers at pos, pos+1, pos+2)
//  5. Check against magic 0xBE0498C88 (36-bit, mask 0xFFFFFFFFF — 9 hex digits)
//  6. On match: decode 5-bit original sample rate code from samples at offset +3..+7
//     OriginalSampleRateDecoder: LSB=0→44100 base, LSB=1→48000 base;
//     upper 3 bits (reversed) = power-of-2 multiplier
//  (provenance / MQA Studio detection intentionally omitted — not needed)

// ── MQA Detection ────────────────────────────────────────────────────────────
// Exact port of https://github.com/purpl3F0x/MQA_identifier (Stavros Avramidis)
// Scans decoded PCM for 36-bit magic word 0xBE0498C88 in the L XOR R watermark.
// Uses BigInt because JS bitwise operators only work on 32 bits.
const MQA_MAGIC = 0x0BE0498C88n;
const MQA_MASK  = 0x0FFFFFFFFFn; // 36-bit mask

function mqaOriginalSampleRateDecoder(c: number): number {
  const base = (c & 1) ? 48000 : 44100;
  const mult = 1 << (((c >> 3) & 1) | (((c >> 2) & 1) << 1) | (((c >> 1) & 1) << 2));
  return base * (mult > 16 ? mult * 2 : mult);
}

function detectMQA(
  left: Float32Array,
  right: Float32Array | null,
  sampleRate: number,
  bitDepth = 16,
  rawIntSamples?: Int32Array[], // Raw Int32 PCM from decoder (preserves exact LSBs)
): { detected: boolean; originalRate: number | null; isStudio: boolean } {
  if (!right || left.length < 100 || sampleRate < 44100 || (bitDepth !== 16 && bitDepth !== 24)) {
    return { detected: false, originalRate: null, isStudio: false };
  }

  const scale = Math.pow(2, bitDepth - 1);
  const pos = bitDepth - 16; // 0 for 16-bit, 8 for 24-bit
  const searchLen = Math.min(left.length, sampleRate * 3);

  // Helper: get integer sample for channel ch at index i
  // Use raw Int32 if available (exact), otherwise reconstruct from Float32
  const getL = rawIntSamples?.[0]
    ? (i: number) => rawIntSamples[0][i]
    : (i: number) => Math.round(left[i] * scale) | 0;
  const getR = rawIntSamples?.[1]
    ? (i: number) => rawIntSamples[1][i]
    : (i: number) => Math.round(right[i] * scale) | 0;

  let buf0 = 0n, buf1 = 0n, buf2 = 0n;

  for (let i = 0; i < searchLen; i++) {
    const xorVal = (getL(i) ^ getR(i)) >>> 0;

    buf0 |= BigInt((xorVal >>> pos)       & 1);
    buf1 |= BigInt((xorVal >>> (pos + 1)) & 1);
    buf2 |= BigInt((xorVal >>> (pos + 2)) & 1);

    let matched: { buf: bigint; p: number } | null = null;
    if (buf0 === MQA_MAGIC)      matched = { buf: buf0, p: pos };
    else if (buf1 === MQA_MAGIC) matched = { buf: buf1, p: pos + 1 };
    else if (buf2 === MQA_MAGIC) matched = { buf: buf2, p: pos + 2 };

    if (matched) {
      const p = matched.p;
      let orsf = 0;
      for (let m = 3; m < 8; m++) {
        const si = i + m;
        if (si < left.length) {
          orsf |= (((getL(si) ^ getR(si)) >>> p) & 1) << (7 - m);
        }
      }
      let provenance = 0;
      for (let m = 29; m < 34; m++) {
        const si = i + m;
        if (si < left.length) {
          provenance |= (((getL(si) ^ getR(si)) >>> p) & 1) << (33 - m);
        }
      }
      const originalRate = mqaOriginalSampleRateDecoder(orsf);
      const isStudio = provenance > 8;
      console.log(`[MQA] ✅ Detected at sample ${i}, bitDepth=${bitDepth}, p=${p}, orsf=${orsf}, originalRate=${originalRate}Hz, studio=${isStudio}, rawSamples=${!!rawIntSamples}`);
      return { detected: true, originalRate, isStudio };
    }

    buf0 = (buf0 << 1n) & MQA_MASK;
    buf1 = (buf1 << 1n) & MQA_MASK;
    buf2 = (buf2 << 1n) & MQA_MASK;
  }

  console.log(`[MQA] ❌ Not detected (searched ${searchLen} samples, bitDepth=${bitDepth}, pos=${pos}, rawSamples=${!!rawIntSamples})`);
  return { detected: false, originalRate: null, isStudio: false };
}

// True Peak (ITU-R BS.1770-4) — 4× oversampled windowed-sinc polyphase FIR
// 12-tap filter, 4 phases = 48 coefficients total
// Phase sums normalised to 1.0 so inter-sample peaks are measured accurately.
const SINC_FIR_PHASES = 4;
const SINC_FIR_TAPS = 12;
const SINC_FIR_COEFFS: readonly number[] = [
  // Phase 0 (t = 0.00) — sinc(n/4) × Kaiser(β=6), normalised so Σ=1
  -0.000786, -0.004840, 0.010506, 0.071099, 0.173727, 0.247441,
   0.247441, 0.173727, 0.071099, 0.010506, -0.004840, -0.000786,
  // Phase 1 (t = 0.25)
  -0.000661, -0.004764, 0.005259, 0.055038, 0.153102, 0.251078,
   0.233258, 0.156428, 0.064794, 0.006424, -0.005159, -0.000969,
  // Phase 2 (t = 0.50)
  -0.000538, -0.004401, 0.000692, 0.040086, 0.128165, 0.242027,
   0.242027, 0.128165, 0.040086, 0.000692, -0.004401, -0.000538,
  // Phase 3 (t = 0.75)
  -0.000969, -0.005159, 0.006424, 0.064794, 0.156428, 0.233258,
   0.251078, 0.153102, 0.055038, 0.005259, -0.004764, -0.000661,
];

function computeTruePeak(data: Float32Array): number {
  let samplePeak = 0;
  const len = data.length;

  // First pass: find sample peak
  for (let i = 0; i < len; i++) {
    const v = Math.abs(data[i]);
    if (v > samplePeak) samplePeak = v;
  }

  let truePeak = samplePeak;
  const halfTaps = SINC_FIR_TAPS / 2; // 6

  // Second pass: 4× oversample using windowed-sinc polyphase FIR
  // Process ALL samples including edges — ITU-R BS.1770-4 requires full coverage.
  // Samples outside the buffer are zero-padded.
  for (let i = 0; i < len; i++) {
    for (let phase = 0; phase < SINC_FIR_PHASES; phase++) {
      let sum = 0;
      const coeffBase = phase * SINC_FIR_TAPS;
      for (let tap = 0; tap < SINC_FIR_TAPS; tap++) {
        const idx = i - halfTaps + tap + 1;
        const sample = (idx >= 0 && idx < len) ? data[idx] : 0;
        sum += sample * SINC_FIR_COEFFS[coeffBase + tap];
      }
      const absSum = Math.abs(sum);
      if (absSum > truePeak) truePeak = absSum;
    }
  }

  return truePeak;
}

function estimateNoiseFloor(data: Float32Array): number {
  const blockSize = 4096; // larger block = more stable estimate
  const numBlocks = Math.floor(data.length / blockSize);
  if (numBlocks < 4) return 1e-10;
  const rmsValues: number[] = [];
  
  for (let i = 0; i < numBlocks; i++) {
    let sum = 0;
    const offset = i * blockSize;
    for (let j = 0; j < blockSize; j++) {
      sum += data[offset + j] * data[offset + j];
    }
    const rms = Math.sqrt(sum / blockSize);
    if (rms > 1e-10) rmsValues.push(rms);
  }
  
  rmsValues.sort((a, b) => a - b);
  // Use 2nd percentile (not 5th) — quietest blocks = true noise floor
  const idx = Math.floor(rmsValues.length * 0.02);
  return rmsValues[idx] || 1e-10;
}

function detectDithering(data: Float32Array): boolean {
  let transitions = 0;
  const quant = 1 / 32768;
  const len = Math.min(data.length, 100000);
  
  for (let i = 1; i < len; i++) {
    const prev = Math.round(data[i - 1] / quant);
    const curr = Math.round(data[i] / quant);
    if ((prev & 1) !== (curr & 1)) transitions++;
  }
  
  const rate = transitions / (len - 1);
  return rate > 0.44 && rate < 0.56;
}

function analyzeStereo(left: Float32Array, right: Float32Array) {
  let sumLR = 0, sumLL = 0, sumRR = 0;
  let rmsL = 0, rmsR = 0;
  // M/S analysis: Mid = (L+R)/2, Side = (L-R)/2
  let sumMM = 0, sumSS = 0;
  const len = Math.min(left.length, right.length);
  
  for (let i = 0; i < len; i++) {
    sumLR += left[i] * right[i];
    sumLL += left[i] * left[i];
    sumRR += right[i] * right[i];
    rmsL += Math.abs(left[i]);
    rmsR += Math.abs(right[i]);
    const mid  = (left[i] + right[i]) * 0.5;
    const side = (left[i] - right[i]) * 0.5;
    sumMM += mid * mid;
    sumSS += side * side;
  }
  
  const correlation = sumLR / (Math.sqrt(sumLL * sumRR) + 1e-10);
  const balance = 20 * Math.log10((rmsR + 1e-10) / (rmsL + 1e-10));

  // M/S ratio: if side energy is significant relative to mid, signal was likely M/S encoded
  // Pure mono-to-stereo will have sumSS ≈ 0; true stereo has side energy
  const msRatio = sumSS / (sumMM + sumSS + 1e-20);
  // M/S encoded heuristic: side energy exists but correlation is very high (>0.95) with uneven mid/side balance
  // More reliable: check if RMS of side is non-trivial but correlation still high — typical of M/S matrix
  const sideLevelDb = 10 * Math.log10(sumSS / len + 1e-20);
  const midLevelDb  = 10 * Math.log10(sumMM / len + 1e-20);
  // M/S encoded: mid dominates but side is present and correlation is very high
  const msEncoded = correlation > 0.85 && msRatio > 0.05 && msRatio < 0.45 && (midLevelDb - sideLevelDb) > 3;
  
  return {
    correlation,
    phaseIssues: correlation < -0.1,
    balance,
    msEncoded,
    msRatio,
  };
}

function analyzeBitDepth(data: Float32Array, headerBitDepth?: number) {
  // 2.4 — Dither-aware bit-depth estimation
  // Instead of just counting trailing zeros, we measure the entropy of the
  // least-significant bits when samples are scaled to 24-bit integer range.
  //
  // Genuine 24-bit (dithered): LSBs are uniformly distributed → high entropy
  // 16-bit padded to 24-bit:   LSBs are all zero or sparse   → low entropy
  // 20-bit padded to 24-bit:   bottom 4 bits sparse           → moderate entropy
  // 32-bit: Float32 has 24-bit mantissa, so we rely on header + entropy combo

  const sampleLen = Math.min(data.length, 200000);
  if (sampleLen < 100) return { effectiveBits: 16 as number, authentic: false, lsbEntropy: 0 };

  // 1. Classic 16-bit quantization check
  let quantized16Count = 0;
  const step16 = 1 / 32768;
  for (let i = 0; i < sampleLen; i++) {
    const val = data[i];
    if (val === 0) continue;
    const rounded16 = Math.round(val / step16) * step16;
    if (Math.abs(val - rounded16) < step16 * 0.01) {
      quantized16Count++;
    }
  }
  const ratio16 = quantized16Count / sampleLen;

  // 2. LSB entropy check — scale to 24-bit and examine bottom 8 bits
  const scale24 = 8388608; // 2^23, maps [-1,1) to [-2^23, 2^23)
  const histogram = new Uint32Array(256);

  for (let i = 0; i < sampleLen; i++) {
    const val = data[i];
    if (val === 0) continue;
    const scaled = Math.round(val * scale24);
    const lsb = Math.abs(scaled) & 0xFF;
    histogram[lsb]++;
  }

  // Compute Shannon entropy of the 256-bin LSB histogram
  const totalLsb = sampleLen;
  let entropy = 0;
  for (let b = 0; b < 256; b++) {
    if (histogram[b] === 0) continue;
    const p = histogram[b] / totalLsb;
    entropy -= p * Math.log2(p);
  }
  // Max entropy = log2(256) = 8.0 (perfectly uniform)
  // 16-bit padded: entropy ≈ 0 (all LSBs zero)
  // 20-bit padded: entropy ≈ 4 (bottom 4 bits random, top 4 of the 8 zero)
  // 24-bit dithered: entropy ≈ 7.5–8.0

  const lsbEntropy = entropy;

  // 3. Combined decision
  // Float32 mantissa is 24-bit, so we can't see below 24-bit via LSB analysis.
  // If the header claims 32-bit and the data is genuinely deep (high entropy),
  // trust the header — the source was 32-bit, decoded to Float32.
  let effectiveBits: number;
  if (ratio16 > 0.98 && lsbEntropy < 2.0) {
    effectiveBits = 16; // firmly 16-bit (no dither, no LSB data)
  } else if (ratio16 > 0.98 && lsbEntropy >= 2.0) {
    effectiveBits = 24; // 16-bit quantized but with dither noise → likely 24-bit source that was requantized
  } else if (lsbEntropy > 6.5) {
    // Rich LSB data → genuine 24-bit or deeper
    if (headerBitDepth === 32) {
      effectiveBits = 32; // header says 32-bit, data confirms deep → trust header
    } else if (headerBitDepth === 24 || !headerBitDepth) {
      effectiveBits = 24;
    } else {
      effectiveBits = headerBitDepth; // trust header for unusual depths like 20-bit
    }
  } else if (lsbEntropy > 4.0) {
    effectiveBits = 20; // partial LSB data → likely 20-bit
  } else {
    effectiveBits = 16; // sparse LSBs → padded
  }

  // Authentic if the file has data beyond 16-bit resolution
  const authentic = effectiveBits >= 20;

  return { effectiveBits, authentic, lsbEntropy };
}

function detectUpsampling(data: Float32Array, sampleRate: number): { detected: boolean; sourceRate: number | null } {
  const fftSize = 8192;
  if (data.length < fftSize) return { detected: false, sourceRate: null };

  const real = new Float64Array(fftSize);
  const imag = new Float64Array(fftSize);
  const numSeg = Math.min(Math.floor(data.length / fftSize), 8);
  const spectrum = new Float64Array(fftSize / 2);

  for (let s = 0; s < numSeg; s++) {
    const off = Math.floor((data.length - fftSize) * s / Math.max(numSeg - 1, 1));
    hannWindow(data, off, fftSize, real);
    imag.fill(0);
    fft(real, imag);
    for (let k = 0; k < fftSize / 2; k++) {
      spectrum[k] += Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
    }
  }

  const binRes = sampleRate / fftSize;
  const totalBins = fftSize / 2;

  // Check common source rates: sub-44.1kHz through 384kHz
  const candidates = [8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000];

  for (const srcRate of candidates) {
    if (srcRate >= sampleRate) continue;

    const srcNyquist = srcRate / 2;
    const srcBin = Math.floor(srcNyquist / binRes);
    if (srcBin < 2 || srcBin >= totalBins) continue;

    // Compare energy just below vs just above the source Nyquist
    // Use a 1 kHz band on each side for stability
    const bandWidth = Math.max(1, Math.floor(1000 / binRes));
    const belowStart = Math.max(1, srcBin - bandWidth);
    const aboveEnd = Math.min(totalBins - 1, srcBin + bandWidth);

    let eBelow = 0, eAbove = 0;
    for (let k = belowStart; k < srcBin; k++) eBelow += spectrum[k];
    for (let k = srcBin; k <= aboveEnd; k++) eAbove += spectrum[k];

    const binsBelow = Math.max(1, srcBin - belowStart);
    const binsAbove = Math.max(1, aboveEnd - srcBin + 1);
    const avgBelow = eBelow / binsBelow;
    const avgAbove = eAbove / binsAbove;

    // If energy above source Nyquist is negligible → upsampled from this rate
    if (avgAbove < avgBelow * 0.01) {
      return { detected: true, sourceRate: srcRate };
    }
  }

  return { detected: false, sourceRate: null };
}

function analyzeCompression(data: Float32Array, dynamicRange: number) {
  let level: string;
  let limiting = false;
  
  if (dynamicRange < 6) {
    level = "Heavy";
    limiting = true;
  } else if (dynamicRange < 10) {
    level = "Moderate";
    limiting = true;
  } else if (dynamicRange < 14) {
    level = "Light";
  } else {
    level = "Minimal";
  }
  
  let nearPeak = 0;
  const thresh = 0.98;
  const sampleLen = Math.min(data.length, 200000);
  for (let i = 0; i < sampleLen; i++) {
    if (Math.abs(data[i]) > thresh) nearPeak++;
  }
  if (nearPeak / sampleLen > 0.005) limiting = true;
  
  return { level, limiting };
}

function guessBitDepth(ext: string, effectiveBits: number): number {
  if (['flac', 'wav', 'aiff', 'aif', 'alac', 'ape', 'wv', 'dsf', 'dff'].includes(ext)) {
    if (effectiveBits >= 28) return 32;
    if (effectiveBits >= 20) return 24;
    return 16;
  }
  if (['mp3', 'aac', 'ogg', 'opus', 'wma', 'ac3', 'ec3', 'eac3'].includes(ext)) return 16;
  if (ext === 'm4a') {
    if (effectiveBits >= 28) return 32;
    if (effectiveBits >= 20) return 24;
    return 16;
  }
  return effectiveBits >= 28 ? 32 : effectiveBits > 20 ? 24 : 16;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export function formatDuration(seconds: number): string {
  const min = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60);
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

export function formatDb(db: number): string {
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

export function formatFrequency(hz: number): string {
  if (hz < 1000) return `${Math.round(hz)} Hz`;
  return `${(hz / 1000).toFixed(1)} kHz`;
}

// ── Test-only exports ──────────────────────────────────────────────
// These are used by unit tests (3.3) and calibration tests (3.2).
// They expose internal DSP helpers that are not part of the public API.
export {
  computeTruePeak,
  computeTtDrForChannel,
  detectSpectralCutoff,
  measureCutoffSlope,
  detectCutoffStability,
  measureEnergyAboveCutoff,
  analyzeBitDepth,
  detectUpsampling,
  estimateNoiseFloor,
  cutoffToBitrate,
};
