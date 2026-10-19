import { describe, expect, it } from "vitest";
import { type Calibration, calibration, estimatedElo, isMonotonic, strengthToParams } from "../src/strength.js";

const SAMPLE: Calibration = {
  version: 1,
  status: "calibrated",
  model: "test",
  strengthMin: 500,
  strengthMax: 2200,
  curve: [
    { estimatedElo: 500, selfElo: 600, temperature: 1 },
    { estimatedElo: 1500, selfElo: 1800, temperature: 1 },
    { estimatedElo: 1900, selfElo: 2600, temperature: 1 },
    { estimatedElo: 2200, selfElo: 2600, temperature: 0.5 },
  ],
};

describe("committed calibration", () => {
  it("is monotonic, and never serves beyond the measured top or 2600", () => {
    const cal = calibration();
    expect(isMonotonic(cal)).toBe(true);
    expect(cal.strengthMax).toBeLessThanOrEqual(2600);
    expect(cal.curve[0].estimatedElo).toBeLessThanOrEqual(cal.strengthMin);
    expect(cal.curve.at(-1)!.estimatedElo).toBeGreaterThanOrEqual(cal.strengthMax);
  });

  it("maps every strength in range to a parameter pair that maps back", () => {
    const cal = calibration();
    for (let s = cal.strengthMin; s <= cal.strengthMax; s += 50) {
      const { selfElo, temperature } = strengthToParams(s);
      expect(Math.abs(estimatedElo(selfElo, temperature)! - s)).toBeLessThanOrEqual(5);
    }
  });
});

describe("strengthToParams / estimatedElo", () => {
  it("interpolates selfElo along the T=1 part of the path", () => {
    expect(strengthToParams(1000, SAMPLE)).toEqual({ selfElo: 1200, temperature: 1 });
    expect(estimatedElo(1200, 1, SAMPLE)).toBe(1000);
  });

  it("lowers temperature only on the top segment", () => {
    expect(strengthToParams(2050, SAMPLE)).toEqual({ selfElo: 2600, temperature: 0.75 });
    expect(estimatedElo(2600, 0.75, SAMPLE)).toBe(2050);
  });

  it("clamps out-of-range targets", () => {
    expect(strengthToParams(100, SAMPLE)).toEqual({ selfElo: 600, temperature: 1 });
    expect(strengthToParams(9999, SAMPLE)).toEqual({ selfElo: 2600, temperature: 0.5 });
  });

  it("returns null off the calibrated path", () => {
    expect(estimatedElo(1200, 0.5, SAMPLE)).toBeNull();
  });

  it("detects a non-monotonic curve", () => {
    const bad = { ...SAMPLE, curve: [SAMPLE.curve[1], SAMPLE.curve[0]] };
    expect(isMonotonic(bad)).toBe(false);
  });
});
