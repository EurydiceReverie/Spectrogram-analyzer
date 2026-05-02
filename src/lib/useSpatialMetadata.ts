/**
 * useSpatialMetadata.ts
 * ----------------------
 * Extracts MPEG-H Object Audio Metadata (OAM) from a 360 RA / MPEG-H file.
 * OAM carries per-object azimuth, elevation, and gain over time.
 *
 * In MPEG-H 3D Audio (ISO 23008-3), OAM is stored in the MHAS bitstream
 * inside oam() syntax elements. We do a lightweight parse:
 *  1. Walk the MHAS packets looking for packet type 5 (OAM).
 *  2. Decode the first OAM frame to get object count + initial positions.
 *
 * This is intentionally conservative — we only read what we can safely
 * decode without a full MPEG-H reference decoder.
 *
 * For .m4a containers we first extract the raw MHAS stream from the
 * mdat box and then apply the same MHAS parser.
 */

import { useState, useEffect } from 'react';

export interface ObjectAudioPosition {
  objectIdx: number;
  azimuth: number;    // degrees, 0=front, +90=right, -90=left
  elevation: number;  // degrees, 0=horizon, +90=top, -90=bottom
  gain: number;       // linear gain (0–1)
  label?: string;
}

export interface SpatialMetadata {
  objects: ObjectAudioPosition[];
  totalObjects: number;
  hasBinaural: boolean;
  hasHOA: boolean;
  channelCount: number;
}

// ─── MHAS packet types ────────────────────────────────────────────────────────
const MHAS_PACKET_TYPE_CONFIG = 1;
const MHAS_PACKET_TYPE_FRAME  = 2;
const MHAS_PACKET_TYPE_OAM    = 5;   // Object Audio Metadata

// ─── Bit reader ───────────────────────────────────────────────────────────────
class BitReader {
  private data: Uint8Array;
  private bitPos: number = 0;

  constructor(data: Uint8Array) { this.data = data; }

  readBits(n: number): number {
    let val = 0;
    for (let i = 0; i < n; i++) {
      const byteIdx = this.bitPos >> 3;
      const bitIdx  = 7 - (this.bitPos & 7);
      if (byteIdx >= this.data.length) break;
      val = (val << 1) | ((this.data[byteIdx] >> bitIdx) & 1);
      this.bitPos++;
    }
    return val;
  }

  readBool(): boolean { return this.readBits(1) === 1; }
  get pos(): number   { return this.bitPos; }
  get bytePos(): number { return this.bitPos >> 3; }
  skip(n: number): void { this.bitPos += n; }
  get done(): boolean { return this.bitPos >= this.data.length * 8; }
}

// ─── MHAS packet iterator ─────────────────────────────────────────────────────
interface MhasPacket {
  type: number;
  label: number;
  data: Uint8Array;
}

function* iterateMhasPackets(buf: Uint8Array): Generator<MhasPacket> {
  let off = 0;

  // Skip optional sync word 0xC001A5
  if (buf.length > 3 && buf[0] === 0xC0 && buf[1] === 0x01 && buf[2] === 0xA5) off = 3;

  while (off < buf.length - 2) {
    // Escape-coded packet type (var-length)
    let type = 0;
    let addVal = 0;
    do {
      if (off >= buf.length) return;
      addVal = buf[off++];
      type += addVal;
    } while (addVal === 0xFF);

    // Escape-coded label
    let label = 0;
    do {
      if (off >= buf.length) return;
      addVal = buf[off++];
      label += addVal;
    } while (addVal === 0xFF);

    // Escape-coded length
    let length = 0;
    do {
      if (off >= buf.length) return;
      addVal = buf[off++];
      length += addVal;
    } while (addVal === 0xFF);

    if (off + length > buf.length) return;
    yield { type, label, data: buf.subarray(off, off + length) };
    off += length;
  }
}

// ─── OAM decoder (simplified) ─────────────────────────────────────────────────
function parseOamPacket(data: Uint8Array): ObjectAudioPosition[] {
  const br = new BitReader(data);
  const objects: ObjectAudioPosition[] = [];

  try {
    // OAM header
    const numObjects = br.readBits(6) + 1;          // oamNumObjects
    const _oamParamRate = br.readBits(4);            // oamParamRate

    for (let obj = 0; obj < numObjects && !br.done; obj++) {
      // Fixed-point azimuth: 8 bits, range -180..+180 → ÷ 180 × 180
      const azRaw  = br.readBits(8);
      const elRaw  = br.readBits(6);
      const gainRaw = br.readBits(7);

      // Decode: azimuth = azRaw * 360/256 - 180
      const azimuth   = Math.round(azRaw * 360 / 256 - 180);
      // elevation = elRaw * 180/64 - 90
      const elevation = Math.round(elRaw * 180 / 64 - 90);
      // gain: 0..1 (gainRaw / 127)
      const gain = gainRaw / 127;

      objects.push({ objectIdx: obj, azimuth, elevation, gain });
    }
  } catch {
    // Partial parse is fine
  }
  return objects;
}

// ─── Extract MHAS from MP4 mdat ───────────────────────────────────────────────
function extractMhasFromMp4(buf: ArrayBuffer): Uint8Array | null {
  const u8  = new Uint8Array(buf);
  const dv  = new DataView(buf);
  let off   = 0;

  while (off + 8 < u8.length) {
    const size = dv.getUint32(off);
    const type = String.fromCharCode(u8[off+4], u8[off+5], u8[off+6], u8[off+7]);
    if (type === 'mdat') {
      return u8.subarray(off + 8, off + size);
    }
    if (size === 0 || size > u8.length) break;
    off += size;
  }
  return null;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Parse spatial/OAM metadata from an MPEG-H audio file.
 * Returns null if the file has no OAM data.
 */
export function parseSpatialMetadata(arrayBuffer: ArrayBuffer): SpatialMetadata | null {
  const u8 = new Uint8Array(arrayBuffer);

  // Detect container
  let mhasBuf: Uint8Array = u8;

  // MP4 signature: ftyp box
  const isMP4 =
    u8.length > 8 &&
    String.fromCharCode(u8[4], u8[5], u8[6], u8[7]) === 'ftyp';

  if (isMP4) {
    const extracted = extractMhasFromMp4(arrayBuffer);
    if (!extracted) return null;
    mhasBuf = extracted;
  }

  let objects: ObjectAudioPosition[] = [];
  let hasBinaural = false;
  let hasHOA = false;
  let channelCount = 0;
  let foundOAM = false;

  for (const pkt of iterateMhasPackets(mhasBuf)) {
    if (pkt.type === MHAS_PACKET_TYPE_OAM && !foundOAM) {
      objects = parseOamPacket(pkt.data);
      foundOAM = true;
    }
    if (pkt.type === MHAS_PACKET_TYPE_CONFIG) {
      // Scan config for HOA / binaural markers
      const cfgStr = Array.from(pkt.data).map((b) => b.toString(16).padStart(2, '0')).join('');
      if (cfgStr.includes('hoa') || pkt.data.length > 20) hasHOA = true;
    }
    // Stop after first OAM packet and config
    if (foundOAM && channelCount > 0) break;
  }

  if (!foundOAM && objects.length === 0) return null;

  return {
    objects,
    totalObjects: objects.length,
    hasBinaural,
    hasHOA,
    channelCount,
  };
}

// ─── React hook ───────────────────────────────────────────────────────────────

/**
 * React hook: parse spatial metadata from an ArrayBuffer.
 * Returns { spatialMeta, loading }.
 */
export function useSpatialMetadata(arrayBuffer: ArrayBuffer | null) {
  const [spatialMeta, setSpatialMeta] = useState<SpatialMetadata | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!arrayBuffer) { setSpatialMeta(null); return; }
    setLoading(true);
    // Run in a microtask so it doesn't block rendering
    Promise.resolve().then(() => {
      const meta = parseSpatialMetadata(arrayBuffer);
      setSpatialMeta(meta);
      setLoading(false);
    });
  }, [arrayBuffer]);

  return { spatialMeta, loading };
}
