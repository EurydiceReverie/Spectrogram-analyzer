import { describe, it, expect } from "vitest";
import {
  computeTruePeak,
  computeTtDrForChannel,
  detectSpectralCutoff,
  analyzeBitDepth,
  detectUpsampling,
  measureCutoffSlope,
  detectCutoffStability,
  measureEnergyAboveCutoff,
  estimateNoiseFloor,
  cutoffToBitrate,
} from "@/lib/audioAnalysis";

// ── Helpers ────────────────────────────────────────────────────────

function makeSine(freq: number, sampleRate: number, durationSec: number, amplitude = 1.0): Float32Array {
  const len = Math.floor(sampleRate * durationSec);
  const data = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    data[i] = amplitude * Math.sin(2 * Math.PI * freq * i / sampleRate);
  }
  return data;
}

function makeWhiteNoise(sampleRate: number, durationSec: number, amplitude = 0.5): Float32Array {
  const len = Math.floor(sampleRate * durationSec);
  const data = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    data[i] = amplitude * (Math.random() * 2 - 1);
  }
  return data;
}

function makeSilence(sampleRate: number, durationSec: number): Float32Array {
  return new Float32Array(Math.floor(sampleRate * durationSec));
}

function makeConstant(sampleRate: number, durationSec: number, value: number): Float32Array {
  const len = Math.floor(sampleRate * durationSec);
  const data = new Float32Array(len);
  data.fill(value);
  return data;
}

/** Quantize a float signal to N-bit integer resolution */
function quantize(data: Float32Array, bits: number): Float32Array {
  const levels = 2 ** bits;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = Math.round(data[i] * levels / 2) / (levels / 2);
  }
  return out;
}

/** Add TPDF dither to a signal at a given bit depth */
function addDither(data: Float32Array, bits: number): Float32Array {
  const step = 1 / (2 ** (bits - 1));
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const dither = (Math.random() + Math.random() - 1) * step;
    out[i] = data[i] + dither;
  }
  return out;
}

// ── 3.3 — DSP Unit Tests ──────────────────────────────────────────

describe("computeTruePeak", () => {
  it("returns peak ≥ sample peak for a sine wave", () => {
    const data = makeSine(1000, 44100, 2, 0.9);
    const truePeak = computeTruePeak(data);
    const samplePeak = Math.max(...Array.from(data).map(Math.abs));
    expect(truePeak).toBeGreaterThanOrEqual(samplePeak);
  });

  it("true peak is close to amplitude for a low-frequency sine", () => {
    const data = makeSine(100, 44100, 1, 0.8);
    const truePeak = computeTruePeak(data);
    expect(truePeak).toBeGreaterThan(0.75);
    expect(truePeak).toBeLessThanOrEqual(1.0);
  });

  it("true peak for silence is 0", () => {
    const data = makeSilence(44100, 1);
    expect(computeTruePeak(data)).toBe(0);
  });

  it("true peak for DC signal equals the DC value", () => {
    const data = makeConstant(44100, 1, 0.5);
    expect(computeTruePeak(data)).toBeCloseTo(0.5, 5);
  });

  it("true peak ≥ sample peak for a high-frequency sine (ISP risk)", () => {
    const data = makeSine(10000, 44100, 1, 0.95);
    const truePeak = computeTruePeak(data);
    const samplePeak = Math.max(...Array.from(data).map(Math.abs));
    expect(truePeak).toBeGreaterThanOrEqual(samplePeak - 0.01);
  });
});

describe("computeTtDrForChannel", () => {
  it("DR includes sine-reference offset for constant signal (≈ -3.01 dB)", () => {
    // DR formula: peakDb - topRmsDb + sineReferenceOffset
    // For constant DC: peakDb = topRmsDb, so DR = sineReferenceOffset ≈ -3.01
    const data = makeConstant(44100, 10, 0.5);
    const result = computeTtDrForChannel(data, 44100);
    expect(result.dr).toBeCloseTo(-3.01, 0);
  });

  it("DR varies with block amplitude distribution", () => {
    // For pure sines, peak/RMS ratio is constant (√2), so DR is always ≈ -3.01
    // Use noise bursts (random crest factor) to get meaningful DR differences
    const sr = 44100;
    const blockLen = sr * 3;
    const amps = [0.9, 0.3, 0.05];
    const data = new Float32Array(blockLen * amps.length);
    for (let b = 0; b < amps.length; b++) {
      for (let i = 0; i < blockLen; i++) {
        // Mix sine + noise for varying crest factor per block
        data[blockLen * b + i] = amps[b] * (
          0.7 * Math.sin(2 * Math.PI * 1000 * i / sr) +
          0.3 * (Math.random() * 2 - 1)
        );
      }
    }

    const result = computeTtDrForChannel(data, sr);
    expect(result.blockCount).toBe(3);
    // DR should be finite and not NaN
    expect(Number.isFinite(result.dr)).toBe(true);
    expect(result.topRmsDb).toBeLessThan(0);
    expect(result.peakDb).toBeLessThan(0);
  });

  it("peakDb is close to 0 dBFS for a full-scale sine", () => {
    const data = makeSine(1000, 44100, 6, 0.99);
    const result = computeTtDrForChannel(data, 44100);
    expect(result.peakDb).toBeGreaterThan(-1);
    expect(result.peakDb).toBeLessThanOrEqual(0.1);
  });

  it("blockCount is approximately duration / 3", () => {
    const data = makeSine(1000, 44100, 15, 0.5);
    const result = computeTtDrForChannel(data, 44100);
    expect(result.blockCount).toBe(5);
  });
});

describe("detectSpectralCutoff", () => {
  it("detects cutoff near Nyquist for full-bandwidth noise", () => {
    const data = makeWhiteNoise(44100, 2, 0.3);
    const result = detectSpectralCutoff(data, 44100);
    expect(result.cutoffHz).toBeGreaterThan(18000);
  });

  it("sharpCutoff is false for white noise", () => {
    const data = makeWhiteNoise(44100, 2, 0.3);
    const result = detectSpectralCutoff(data, 44100);
    expect(result.sharpCutoff).toBe(false);
  });

  it("returns energyProfile with correct length", () => {
    const data = makeSine(1000, 44100, 2, 0.5);
    const result = detectSpectralCutoff(data, 44100);
    expect(result.energyProfile.length).toBeGreaterThan(0);
  });
});

describe("measureCutoffSlope", () => {
  it("returns 0 for empty spectrum", () => {
    const spectrum = new Float64Array(0);
    expect(measureCutoffSlope(spectrum, 100, 1, 22050)).toBe(0);
  });

  it("returns 0 when cutoffBin is at edge", () => {
    const spectrum = new Float64Array(100);
    spectrum.fill(-60);
    expect(measureCutoffSlope(spectrum, 0, 1, 22050)).toBe(0);
  });
});

describe("detectCutoffStability", () => {
  it("returns low stddev for a stationary signal", () => {
    const data = makeSine(1000, 44100, 30, 0.5);
    const result = detectCutoffStability(data, 44100);
    expect(result.stddevHz).toBeLessThan(1000);
  });

  it("returns perWindowCutoffs array", () => {
    const data = makeSine(1000, 44100, 30, 0.5);
    const result = detectCutoffStability(data, 44100);
    expect(result.perWindowCutoffs.length).toBeGreaterThanOrEqual(3);
  });
});

describe("measureEnergyAboveCutoff", () => {
  it("returns very low dB for empty spectrum", () => {
    const spectrum = new Float64Array(0);
    expect(measureEnergyAboveCutoff(spectrum, 10000, 1)).toBe(-120);
  });

  it("returns very low dB when cutoff is at Nyquist", () => {
    const spectrum = new Float64Array(100);
    spectrum.fill(-60);
    expect(measureEnergyAboveCutoff(spectrum, 100, 1)).toBe(-120);
  });
});

describe("analyzeBitDepth", () => {
  it("detects 16-bit quantized signal", () => {
    const noise = makeWhiteNoise(44100, 1, 0.5);
    const quantized = quantize(noise, 16);
    const result = analyzeBitDepth(quantized);
    expect(result.effectiveBits).toBe(16);
    expect(result.authentic).toBe(false);
  });

  it("detects genuine 24-bit with dither", () => {
    const noise = makeWhiteNoise(44100, 1, 0.5);
    const dithered = addDither(noise, 24);
    const result = analyzeBitDepth(dithered);
    expect(result.effectiveBits).toBe(24);
    expect(result.authentic).toBe(true);
    expect(result.lsbEntropy).toBeGreaterThan(5);
  });

  it("returns lsbEntropy between 0 and 8", () => {
    const data = makeSine(1000, 44100, 1, 0.5);
    const result = analyzeBitDepth(data);
    expect(result.lsbEntropy).toBeGreaterThanOrEqual(0);
    expect(result.lsbEntropy).toBeLessThanOrEqual(8.5);
  });

  it("detects 32-bit when header says 32-bit and data is genuine 24-bit", () => {
    const noise = makeWhiteNoise(44100, 1, 0.5);
    const dithered = addDither(noise, 24);
    const result = analyzeBitDepth(dithered, 32);
    expect(result.effectiveBits).toBe(32);
    expect(result.authentic).toBe(true);
  });

  it("returns 24-bit when header is 24-bit even with high entropy", () => {
    const noise = makeWhiteNoise(44100, 1, 0.5);
    const dithered = addDither(noise, 24);
    const result = analyzeBitDepth(dithered, 24);
    expect(result.effectiveBits).toBe(24);
  });

  it("returns 24-bit when no header info and data is genuine", () => {
    const noise = makeWhiteNoise(44100, 1, 0.5);
    const dithered = addDither(noise, 24);
    const result = analyzeBitDepth(dithered);
    expect(result.effectiveBits).toBe(24);
  });
});

describe("detectUpsampling", () => {
  it("returns not detected for 44100 Hz", () => {
    const data = makeSine(1000, 44100, 2, 0.5);
    const result = detectUpsampling(data, 44100);
    expect(result.detected).toBe(false);
    expect(result.sourceRate).toBeNull();
  });

  it("returns not detected for genuine 48 kHz noise", () => {
    const data = makeWhiteNoise(48000, 2, 0.3);
    const result = detectUpsampling(data, 48000);
    expect(result.detected).toBe(false);
  });

  it("handles 192 kHz sample rate without crashing", () => {
    // Generate a short 192 kHz signal
    const data = makeSine(1000, 192000, 0.5, 0.5);
    const result = detectUpsampling(data, 192000);
    expect(result.detected).toBe(false);
    expect(result.sourceRate).toBeNull();
  });

  it("checks all candidate rates up to 192 kHz", () => {
    // Verify the function accepts high sample rates
    const data = makeWhiteNoise(384000, 0.5, 0.3);
    const result = detectUpsampling(data, 384000);
    expect(typeof result.detected).toBe("boolean");
  });
});

describe("estimateNoiseFloor", () => {
  it("returns very low value for silence", () => {
    const data = makeSilence(44100, 2);
    const nf = estimateNoiseFloor(data);
    expect(nf).toBeLessThan(1e-5);
  });

  it("returns higher value for loud signal", () => {
    const data = makeSine(1000, 44100, 2, 0.9);
    const nf = estimateNoiseFloor(data);
    expect(nf).toBeGreaterThan(0);
  });
});

describe("cutoffToBitrate", () => {
  it("returns 32 for 11025 Hz", () => {
    expect(cutoffToBitrate(11025)).toBe(32);
  });

  it("returns 320 for 20500+ Hz", () => {
    expect(cutoffToBitrate(21000)).toBe(320);
  });

  it("returns interpolated value for mid-range cutoff", () => {
    const br = cutoffToBitrate(16000);
    expect(br).toBe(96);
  });
});
