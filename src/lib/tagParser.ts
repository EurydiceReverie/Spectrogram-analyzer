/**
 * Audio Tag Parser — Binary parsing for all major tag formats
 *
 * Supported formats:
 *  FLAC  → Vorbis Comment (binary scan after STREAMINFO)
 *  MP3   → ID3v2.3 / ID3v2.4 (binary header parse)
 *  M4A   → iTunes ilst atoms (mp4box.js)
 *  OGG   → Vorbis Comment (first two pages)
 *  WAV   → ID3 chunk / LIST INFO chunk
 *  AIFF  → ID3 chunk / ANNO chunk
 */

export type LyricsType = "plain" | "lrc" | "ttml-lrc" | "ttml" | "unknown";

export interface LyricsData {
  raw: string;
  type: LyricsType;
  lineCount: number;
  hasTimestamps: boolean;
  hasWordTimestamps: boolean;  // TTML-style: <00:00.00> word tags
  hasTranslation: boolean;     // multiple language lines
  preview: string;             // first 3 lines, clean text only
}

export interface ParsedTags {
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  composer?: string;
  lyricist?: string;
  conductor?: string;
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
  isrc?: string;
  copyright?: string;
  comment?: string;
  description?: string;
  rating?: string;
  bpm?: string;
  key?: string;
  language?: string;
  encodedBy?: string;
  encodedApplication?: string;
  encodedLibrary?: string;
  originalArtist?: string;
  originalAlbum?: string;
  originalYear?: string;
  remixer?: string;
  producer?: string;
  engineer?: string;
  grouping?: string;
  mood?: string;
  subtitle?: string;
  sortTitle?: string;
  sortArtist?: string;
  sortAlbum?: string;
  sortAlbumArtist?: string;
  sortComposer?: string;
  cover?: string;          // "Yes (image/jpeg)" etc.
  coverMime?: string;
  md5?: string;
  replayGainTrack?: string;
  replayGainAlbum?: string;
  podcast?: string;
  podcastUrl?: string;
  purchaseDate?: string;
  iTunesAdvisory?: string;  // 0=clean, 1=explicit
  albumTitleId?: string;
  releaseTime?: string;
  part?: string;
  partTotal?: string;
  lyrics?: LyricsData;
  extra: Record<string, string>;  // any unknown tags
}

// ─── Lyrics detection and parsing ────────────────────────────────────────────
export function parseLyrics(raw: string): LyricsData {
  if (!raw || raw.trim().length === 0) {
    return { raw, type: "unknown", lineCount: 0, hasTimestamps: false, hasWordTimestamps: false, hasTranslation: false, preview: "" };
  }

  const lines = raw.split(/\s*\/\s*|\n/).map(l => l.trim()).filter(Boolean);

  // Detect LRC timestamps: [mm:ss.xx]
  const hasTimestamps = lines.some(l => /^\[(\d{1,2}):(\d{2}\.\d{2})\]/.test(l));

  // Detect TTML-style word timestamps: <mm:ss.xx> inside lines
  const hasWordTimestamps = lines.some(l => /<(\d{1,2}):(\d{2}\.\d{2})>/.test(l));

  // Detect translation (multiple lines with same timestamp = different languages)
  const tsMap = new Map<string, number>();
  let hasTranslation = false;
  for (const line of lines) {
    const m = line.match(/^\[(\d{1,2}:\d{2}\.\d{2})\]/);
    if (m) {
      const ts = m[1];
      tsMap.set(ts, (tsMap.get(ts) || 0) + 1);
      if (tsMap.get(ts)! > 1) { hasTranslation = true; break; }
    }
  }

  // Classify type
  let type: LyricsType = "plain";
  if (hasTimestamps && hasWordTimestamps) type = "ttml-lrc"; // Apple TTML embedded in LRC
  else if (hasTimestamps) type = "lrc";

  // Clean preview — strip timestamps and word markers, take first 3 meaningful lines
  const cleanLines: string[] = [];
  for (const line of lines) {
    const clean = line
      .replace(/\[(\d{1,2}):(\d{2}\.\d{2})\]/g, "")   // remove LRC timestamps
      .replace(/<(\d{1,2}):(\d{2}\.\d{2})>/g, "")       // remove word timestamps
      .trim();
    if (clean.length > 2) {
      cleanLines.push(clean);
      if (cleanLines.length >= 3) break;
    }
  }

  return {
    raw,
    type,
    lineCount: lines.filter(l => /^\[(\d{1,2}):(\d{2}\.\d{2})\]/.test(l) || (!hasTimestamps && l.length > 2)).length,
    hasTimestamps,
    hasWordTimestamps,
    hasTranslation,
    preview: cleanLines.join(" / "),
  };
}

const decoder = new TextDecoder("utf-8");

// ─── FLAC — Vorbis Comment ───────────────────────────────────────────────────
// Spec: https://www.xiph.org/vorbis/doc/v-comment.html
// Structure inside FLAC: METADATA_BLOCK_TYPE=4 (VORBIS_COMMENT)
export async function parseFLACTags(file: File): Promise<ParsedTags> {
  // Read enough bytes to cover all metadata blocks (up to 4MB)
  const readSize = Math.min(file.size, 4 * 1024 * 1024);
  const buf = await file.slice(0, readSize).arrayBuffer();
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);

  const tags: ParsedTags = { extra: {} };
  let pos = 4; // skip "fLaC" marker

  while (pos < bytes.length - 4) {
    const blockHeader = bytes[pos];
    const isLast = (blockHeader & 0x80) !== 0;
    const blockType = blockHeader & 0x7F;
    const blockLength = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    pos += 4;

    if (pos + blockLength > bytes.length) break;

    // Block type 4 = VORBIS_COMMENT
    if (blockType === 4) {
      parseVorbisComment(bytes, pos, pos + blockLength, tags);
      break;
    }

    // Block type 6 = PICTURE
    if (blockType === 6) {
      try {
        const mimeLen = view.getUint32(pos + 4, false);
        const mime = decoder.decode(bytes.slice(pos + 8, pos + 8 + mimeLen));
        tags.cover = "Yes";
        tags.coverMime = mime;
      } catch {}
    }

    pos += blockLength;
    if (isLast) break;
  }

  return tags;
}

function parseVorbisComment(
  bytes: Uint8Array,
  start: number,
  end: number,
  tags: ParsedTags
) {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  let pos = start;

  // Vendor string length (little-endian uint32)
  if (pos + 4 > end) return;
  const vendorLen = view.getUint32(pos, true);
  pos += 4;

  const vendor = decoder.decode(bytes.slice(pos, pos + vendorLen));
  tags.encodedLibrary = vendor;
  pos += vendorLen;

  if (pos + 4 > end) return;
  const numComments = view.getUint32(pos, true);
  pos += 4;

  for (let i = 0; i < numComments; i++) {
    if (pos + 4 > end) break;
    const len = view.getUint32(pos, true);
    pos += 4;
    if (pos + len > end) break;

    const raw = decoder.decode(bytes.slice(pos, pos + len));
    pos += len;

    const eq = raw.indexOf("=");
    if (eq < 0) continue;
    const key = raw.slice(0, eq).toUpperCase().trim();
    const val = raw.slice(eq + 1).trim();

    applyVorbisTag(key, val, tags);
  }
}

// ─── OGG Vorbis — Vorbis Comment (first 2 pages) ─────────────────────────────
export async function parseOGGTags(file: File): Promise<ParsedTags> {
  const buf = await file.slice(0, 128 * 1024).arrayBuffer();
  const bytes = new Uint8Array(buf);

  const tags: ParsedTags = { extra: {} };

  // Find second OGG page (comment header) — scan for OggS page
  let pos = 0;
  let pageCount = 0;
  while (pos < bytes.length - 4) {
    if (bytes[pos] === 0x4F && bytes[pos+1] === 0x67 && bytes[pos+2] === 0x67 && bytes[pos+3] === 0x53) {
      pageCount++;
      if (pageCount === 2) {
        // Page data starts after 27-byte header + segment table
        const numSegs = bytes[pos + 26];
        let dataStart = pos + 27 + numSegs;
        // Skip Vorbis comment packet header (7 bytes: type=3 + "vorbis")
        dataStart += 7;
        parseVorbisComment(bytes, dataStart, bytes.length, tags);
        break;
      }
      // Skip to next page
      const numSegs = bytes[pos + 26];
      let pageSize = 27 + numSegs;
      for (let s = 0; s < numSegs; s++) pageSize += bytes[pos + 27 + s];
      pos += pageSize;
    } else {
      pos++;
    }
  }
  return tags;
}

// ─── ID3v2 — MP3 / WAV / AIFF ────────────────────────────────────────────────
// Spec: https://id3.org/id3v2.3.0
export async function parseID3Tags(file: File): Promise<ParsedTags> {
  const buf = await file.slice(0, 512 * 1024).arrayBuffer();
  const bytes = new Uint8Array(buf);
  const tags: ParsedTags = { extra: {} };

  // Find ID3 header (may be at offset 0 or embedded in WAV/AIFF)
  let id3Start = -1;
  for (let i = 0; i < Math.min(bytes.length - 10, 65536); i++) {
    if (bytes[i] === 0x49 && bytes[i+1] === 0x44 && bytes[i+2] === 0x33) {
      id3Start = i;
      break;
    }
  }
  if (id3Start < 0) return tags;

  const view = new DataView(buf);
  const majorVer = bytes[id3Start + 3];
  // const flags = bytes[id3Start + 5];
  // Synchsafe size
  const tagSize =
    ((bytes[id3Start + 6] & 0x7F) << 21) |
    ((bytes[id3Start + 7] & 0x7F) << 14) |
    ((bytes[id3Start + 8] & 0x7F) << 7)  |
     (bytes[id3Start + 9] & 0x7F);

  let pos = id3Start + 10;
  const end = Math.min(id3Start + 10 + tagSize, bytes.length);

  while (pos < end - 10) {
    const frameId = String.fromCharCode(bytes[pos], bytes[pos+1], bytes[pos+2], bytes[pos+3]);
    if (frameId === "\x00\x00\x00\x00") break;

    let frameSize: number;
    if (majorVer >= 4) {
      // ID3v2.4: synchsafe
      frameSize =
        ((bytes[pos+4] & 0x7F) << 21) |
        ((bytes[pos+5] & 0x7F) << 14) |
        ((bytes[pos+6] & 0x7F) << 7)  |
         (bytes[pos+7] & 0x7F);
    } else {
      // ID3v2.3: normal uint32 big-endian
      frameSize = view.getUint32(pos + 4, false);
    }

    pos += 10;
    if (frameSize <= 0 || pos + frameSize > end) break;

    const frameData = bytes.slice(pos, pos + frameSize);
    pos += frameSize;

    if (frameId.startsWith("T")) {
      // Text frame: first byte is encoding
      const enc = frameData[0];
      const text = decodeID3String(frameData.slice(1), enc).trim();
      applyID3TextFrame(frameId, text, tags);
    } else if (frameId === "COMM" || frameId === "COM") {
      // Comment frame
      const enc = frameData[0];
      // skip 3-byte language + content description
      const text = decodeID3String(frameData.slice(4), enc).trim();
      tags.comment = text;
    } else if (frameId === "APIC" || frameId === "PIC") {
      // Attached picture
      const enc = frameData[0];
      let mimeEnd = 1;
      while (mimeEnd < frameData.length && frameData[mimeEnd] !== 0) mimeEnd++;
      const mime = decoder.decode(frameData.slice(1, mimeEnd));
      tags.cover = "Yes";
      tags.coverMime = mime || "image/jpeg";
    } else if (frameId === "UFID") {
      // Unique file ID — ISRC often stored here
      const rawStr = decoder.decode(frameData).replace(/\x00/g, "");
      if (rawStr.includes("ISRC")) {
        const parts = rawStr.split("\x00");
        if (parts.length > 1) tags.isrc = parts[1];
      }
    } else if (frameId === "USLT" || frameId === "ULT") {
      // Unsynchronized lyrics (most common lyrics frame in ID3)
      const lyricsText = parseUSLT(frameData);
      if (lyricsText) tags.lyrics = parseLyrics(lyricsText);
    } else if (frameId === "SYLT") {
      // Synchronized lyrics — treat as LRC
      // SYLT has complex binary format; extract text only for now
      const enc = frameData[0];
      const raw = new TextDecoder(enc === 0 ? "latin1" : "utf-8")
        .decode(frameData.slice(6)).replace(/\x00/g, " ").trim();
      if (raw && !tags.lyrics) tags.lyrics = parseLyrics(raw);
    }
  }

  return tags;
}

function decodeID3String(data: Uint8Array, enc: number): string {
  if (enc === 0) return new TextDecoder("latin1").decode(data).replace(/\x00.*/, "");
  if (enc === 1 || enc === 2) {
    // UTF-16 with or without BOM
    return new TextDecoder("utf-16le").decode(data).replace(/\x00.*/, "");
  }
  return decoder.decode(data).replace(/\x00.*/, ""); // UTF-8
}

// ─── M4A / iTunes atoms ───────────────────────────────────────────────────────
// Uses mp4box.js to extract ilst atom metadata
export async function parseM4ATags(file: File): Promise<ParsedTags> {
  const tags: ParsedTags = { extra: {} };
  try {
    const mp4boxModule = await import("mp4box");
    const MP4Box = (mp4boxModule as any).default ?? mp4boxModule;
    // Suppress MP4Box's own console output for the duration of this best-effort scan.
    // It logs "Invalid box type" warnings whenever we feed it a partial buffer
    // (we only read first 512 KB, so files without faststart trigger many of these).
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    const isMp4BoxNoise = (msg: unknown) => {
      const s = typeof msg === 'string' ? msg : String(msg);
      return /\[BoxParser\]|Invalid box type|Box of type|MP4Box/.test(s);
    };
    console.log   = ((...a: unknown[]) => { if (!isMp4BoxNoise(a[0])) origLog.apply(console, a as any); }) as any;
    console.warn  = ((...a: unknown[]) => { if (!isMp4BoxNoise(a[0])) origWarn.apply(console, a as any); }) as any;
    console.error = ((...a: unknown[]) => { if (!isMp4BoxNoise(a[0])) origError.apply(console, a as any); }) as any;
    const restore = () => { console.log = origLog; console.warn = origWarn; console.error = origError; };

    const mp4 = MP4Box.createFile();

    await new Promise<void>((resolve) => {
      mp4.onReady = (info: any) => {
        // mp4box puts iTunes metadata in info.tracks or info.metadata
        const meta = info.metadata || {};

        const get = (key: string) => meta[key]?.value || meta[key] || undefined;
        const str = (v: any) => (typeof v === "string" ? v.trim() : undefined);

        tags.title       = str(get("title")   || get("©nam") || get("Name"));
        tags.artist      = str(get("artist")  || get("©ART") || get("Performer"));
        tags.albumArtist = str(get("albumartist") || get("aART") || get("Album_Performer"));
        tags.album       = str(get("album")   || get("©alb"));
        tags.composer    = str(get("composer") || get("©wrt") || get("Composer"));
        tags.genre       = str(get("genre")   || get("©gen") || get("gnre"));
        tags.date        = str(get("date")    || get("©day") || get("Year"));
        tags.comment     = str(get("comment") || get("©cmt"));
        tags.isrc        = str(get("ISRC")    || get("isrc"));
        tags.copyright   = str(get("copyright") || get("cprt"));
        tags.encodedBy   = str(get("encodedby") || get("©enc"));
        tags.encodedApplication = str(get("Encoded_Application") || get("tool") || get("©too"));
        tags.sortTitle   = str(get("sortname") || get("sonm"));
        tags.sortArtist  = str(get("sortartist") || get("soar"));
        tags.sortAlbum   = str(get("sortalbum") || get("soal"));
        tags.sortAlbumArtist = str(get("sortalbumartist") || get("soaa"));
        tags.sortComposer = str(get("sortcomposer") || get("soco"));
        tags.discNumber  = str(get("discnumber") || get("disk"));
        tags.bpm         = str(get("bpm") || get("tmpo"));
        tags.rating      = str(get("rtng") || get("rating"));

        // Lyrics — ©lyr atom (plain or LRC or TTML-LRC)
        const lyrRaw = str(get("©lyr") || get("lyr ") || get("lyrics") || get("Lyrics"));
        if (lyrRaw) tags.lyrics = parseLyrics(lyrRaw);

        // Track number (trkn atom has {position, total})
        const trkn = get("trkn") || get("track");
        if (trkn && typeof trkn === "object") {
          tags.trackNumber = String(trkn.position || trkn.track_number || "");
          tags.trackTotal  = String(trkn.total || "");
        } else if (typeof trkn === "string") {
          const parts = trkn.split("/");
          tags.trackNumber = parts[0];
          tags.trackTotal  = parts[1];
        }

        // Disc (disk atom)
        const disk = get("disk");
        if (disk && typeof disk === "object") {
          tags.discNumber = String(disk.position || "");
          tags.discTotal  = String(disk.total || "");
        }

        // Cover art
        const covr = get("covr") || get("cover");
        if (covr) {
          tags.cover = "Yes";
          tags.coverMime = "image/jpeg";
        }

        resolve();
      };
      mp4.onError = () => resolve();

      const buf = new ArrayBuffer(Math.min(file.size, 512 * 1024));
      file.slice(0, buf.byteLength).arrayBuffer().then(ab => {
        const b = ab as any;
        b.fileStart = 0;
        try { mp4.appendBuffer(b); mp4.flush(); } catch { /* ignore */ }
        setTimeout(() => { restore(); resolve(); }, 300);
      });
    });
  } catch (e) {
    console.warn("[tagParser] M4A tag parse failed:", e);
  }
  return tags;
}

// ─── Vorbis tag key → ParsedTags field ───────────────────────────────────────
function applyVorbisTag(key: string, val: string, tags: ParsedTags) {
  switch (key) {
    case "TITLE":               tags.title = val; break;
    case "ARTIST":
    case "PERFORMER":           tags.artist = val; break;
    case "ALBUMARTIST":
    case "ALBUM ARTIST":
    case "ALBUM_PERFORMER":     tags.albumArtist = val; break;
    case "ALBUM":               tags.album = val; break;
    case "COMPOSER":            tags.composer = val; break;
    case "LYRICIST":            tags.lyricist = val; break;
    case "CONDUCTOR":           tags.conductor = val; break;
    case "REMIXER":
    case "MIXARTIST":           tags.remixer = val; break;
    case "PRODUCER":            tags.producer = val; break;
    case "ENGINEER":            tags.engineer = val; break;
    case "LABEL":
    case "ORGANIZATION":
    case "PUBLISHER":           tags.label = val; break;
    case "GENRE":               tags.genre = val; break;
    case "DATE":
    case "YEAR":                tags.date = val; break;
    case "RECORDED_DATE":       tags.recordedDate = val; break;
    case "TRACKNUMBER":
    case "TRACK":               {
      const parts = val.split("/");
      tags.trackNumber = parts[0];
      if (parts[1]) tags.trackTotal = parts[1];
      break;
    }
    case "TRACKTOTAL":
    case "TOTALTRACKS":         tags.trackTotal = val; break;
    case "DISCNUMBER":
    case "DISC":                {
      const parts = val.split("/");
      tags.discNumber = parts[0];
      if (parts[1]) tags.discTotal = parts[1];
      break;
    }
    case "DISCTOTAL":
    case "TOTALDISCS":          tags.discTotal = val; break;
    case "ISRC":                tags.isrc = val; break;
    case "COPYRIGHT":           tags.copyright = val; break;
    case "COMMENT":
    case "DESCRIPTION":         tags.comment = val; break;
    case "BPM":
    case "TEMPO":               tags.bpm = val; break;
    case "KEY":
    case "INITIALKEY":          tags.key = val; break;
    case "LANGUAGE":            tags.language = val; break;
    case "GROUPING":            tags.grouping = val; break;
    case "MOOD":                tags.mood = val; break;
    case "SUBTITLE":            tags.subtitle = val; break;
    case "ORIGINALARTIST":      tags.originalArtist = val; break;
    case "ORIGINALALBUM":       tags.originalAlbum = val; break;
    case "ORIGINALYEAR":        tags.originalYear = val; break;
    case "ENCODER":
    case "ENCODEDBY":           tags.encodedBy = val; break;
    case "ENCODED-BY":
    case "ENCODED_APPLICATION": tags.encodedApplication = val; break;
    case "REPLAYGAIN_TRACK_GAIN": tags.replayGainTrack = val; break;
    case "REPLAYGAIN_ALBUM_GAIN": tags.replayGainAlbum = val; break;
    case "PART":                tags.part = val; break;
    case "PART_POSITION_TOTAL": tags.partTotal = val; break;
    case "SORTNAME":
    case "TITLESORT":           tags.sortTitle = val; break;
    case "ARTISTSORT":
    case "PERFORMERSORT":       tags.sortArtist = val; break;
    case "ALBUMSORT":           tags.sortAlbum = val; break;
    case "MD5_UNENCODED":       tags.md5 = val; break;
    case "LYRICS":
    case "UNSYNCEDLYRICS":
    case "SYNCEDLYRICS":        tags.lyrics = parseLyrics(val); break;
    default:
      tags.extra[key] = val;
  }
}

// ─── ID3 text frame → ParsedTags field ───────────────────────────────────────
function applyID3TextFrame(frameId: string, val: string, tags: ParsedTags) {
  switch (frameId) {
    case "TIT2": case "TT2":   tags.title = val; break;
    case "TIT3":               tags.subtitle = val; break;
    case "TPE1": case "TP1":   tags.artist = val; break;
    case "TPE2": case "TP2":   tags.albumArtist = val; break;
    case "TPE3": case "TP3":   tags.conductor = val; break;
    case "TPE4":               tags.remixer = val; break;
    case "TCOM": case "TCM":   tags.composer = val; break;
    case "TEXT": case "TXT":   tags.lyricist = val; break;
    case "TALB": case "TAL":   tags.album = val; break;
    case "TYER": case "TYE":
    case "TDRC":               tags.date = val; break;
    case "TRCK": case "TRK":   {
      const p = val.split("/");
      tags.trackNumber = p[0];
      if (p[1]) tags.trackTotal = p[1];
      break;
    }
    case "TPOS": case "TPA":   {
      const p = val.split("/");
      tags.discNumber = p[0];
      if (p[1]) tags.discTotal = p[1];
      break;
    }
    case "TCON": case "TCO":   tags.genre = val.replace(/^\(\d+\)/, "").trim(); break;
    case "TCOP": case "TCR":   tags.copyright = val; break;
    case "TPUB": case "TPB":   tags.label = val; break;
    case "TENC": case "TEN":   tags.encodedBy = val; break;
    case "TSSE":               tags.encodedApplication = val; break;
    case "TSRC":               tags.isrc = val; break;
    case "TBPM": case "TBP":   tags.bpm = val; break;
    case "TKEY":               tags.key = val; break;
    case "TLAN":               tags.language = val; break;
    case "TIT1": case "TT1":   tags.grouping = val; break;
    case "TSOT":               tags.sortTitle = val; break;
    case "TSOP":               tags.sortArtist = val; break;
    case "TSOA":               tags.sortAlbum = val; break;
    case "TSO2":               tags.sortAlbumArtist = val; break;
    case "TSOC":               tags.sortComposer = val; break;
    case "TOPE": case "TOA":   tags.originalArtist = val; break;
    case "TOAL": case "TOT":   tags.originalAlbum = val; break;
    case "TORY": case "TOR":   tags.originalYear = val; break;
    case "TMOO":               tags.mood = val; break;
    case "TPRO":               tags.copyright = val; break;
    default:
      tags.extra[frameId] = val;
  }
}

// Parse USLT (Unsynchronized Lyrics) frame from ID3
function parseUSLT(data: Uint8Array): string {
  const enc = data[0];
  // Skip encoding(1) + language(3) + content description (null-terminated)
  let pos = 4;
  if (enc === 0 || enc === 3) {
    while (pos < data.length && data[pos] !== 0) pos++;
    pos++; // skip null
    return new TextDecoder(enc === 0 ? "latin1" : "utf-8").decode(data.slice(pos)).replace(/\x00.*/, "");
  } else {
    while (pos < data.length - 1 && !(data[pos] === 0 && data[pos+1] === 0)) pos++;
    pos += 2;
    return new TextDecoder("utf-16le").decode(data.slice(pos)).replace(/\x00.*/, "");
  }
}

// ─── Main router ─────────────────────────────────────────────────────────────
export async function parseFileTags(file: File): Promise<ParsedTags> {
  const ext = file.name.split(".").pop()?.toLowerCase() || "";

  try {
    switch (ext) {
      case "flac":
        return await parseFLACTags(file);
      case "mp3":
      case "wav":
      case "aif":
      case "aiff":
        return await parseID3Tags(file);
      case "ogg":
        return await parseOGGTags(file);
      case "m4a":
      case "mp4":
        return await parseM4ATags(file);
      default: {
        // Try ID3 first, then give up
        const t = await parseID3Tags(file);
        if (t.title || t.artist) return t;
        return { extra: {} };
      }
    }
  } catch (e) {
    console.warn("[tagParser] Failed:", e);
    return { extra: {} };
  }
}
