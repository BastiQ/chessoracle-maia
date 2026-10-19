// strength (a target estimated Elo) ⇄ Maia parameters {selfElo, temperature}.
//
// Maia's `selfElo` is the rating of the humans it imitates, not how strong it
// actually plays: sampling its policy (temperature 1) adds human-shaped errors,
// and its rating scale is not Stockfish's. calibration/calibration.json is a
// measured path through parameter space, ordered by estimated strength — see
// calibration/REPORT.md and scripts/calibrate.ts. This module interpolates along
// that path and inverts it.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface CurvePoint {
  /** Estimated strength on the app's Stockfish-anchored scale. */
  estimatedElo: number;
  selfElo: number;
  temperature: number;
}

export interface Calibration {
  version: number;
  status: "identity" | "calibrated";
  model: string;
  strengthMin: number;
  strengthMax: number;
  /** Strictly increasing in estimatedElo. */
  curve: CurvePoint[];
}

export const CALIBRATION_FILE = "calibration/calibration.json";

let cached: Calibration | null = null;

export function calibration(): Calibration {
  cached ??= JSON.parse(readFileSync(join(process.cwd(), CALIBRATION_FILE), "utf8")) as Calibration;
  return cached;
}

export function clampStrength(strength: number, cal = calibration()): number {
  return Math.max(cal.strengthMin, Math.min(cal.strengthMax, strength));
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Target strength → the Maia parameters measured to play at it (clamped to the range). */
export function strengthToParams(strength: number, cal = calibration()): { selfElo: number; temperature: number } {
  const s = clampStrength(strength, cal);
  const curve = cal.curve;
  let i = 0;
  while (i < curve.length - 2 && s > curve[i + 1].estimatedElo) i++;
  const a = curve[i];
  const b = curve[Math.min(i + 1, curve.length - 1)];
  const t = b.estimatedElo === a.estimatedElo ? 0 : Math.max(0, Math.min(1, (s - a.estimatedElo) / (b.estimatedElo - a.estimatedElo)));
  return {
    selfElo: Math.round(lerp(a.selfElo, b.selfElo, t)),
    temperature: Math.round(lerp(a.temperature, b.temperature, t) * 1000) / 1000,
  };
}

/**
 * Inverse: the estimated strength of a parameter pair, if it lies on the
 * calibrated path (null otherwise — the curve is a 1-D path, not a surface).
 */
export function estimatedElo(selfElo: number, temperature = 1, cal = calibration()): number | null {
  const eps = 1e-6;
  for (let i = 0; i < cal.curve.length - 1; i++) {
    const a = cal.curve[i];
    const b = cal.curve[i + 1];
    const dS = b.selfElo - a.selfElo;
    const dT = b.temperature - a.temperature;
    const t = Math.abs(dS) > eps ? (selfElo - a.selfElo) / dS : Math.abs(dT) > eps ? (temperature - a.temperature) / dT : 0;
    if (t < -eps || t > 1 + eps) continue;
    if (Math.abs(lerp(a.selfElo, b.selfElo, t) - selfElo) > 0.5) continue;
    if (Math.abs(lerp(a.temperature, b.temperature, t) - temperature) > 1e-3) continue;
    return Math.round(lerp(a.estimatedElo, b.estimatedElo, t));
  }
  return null;
}

/** The curve must rise with strength, or strengthToParams is not a function. */
export function isMonotonic(cal = calibration()): boolean {
  return cal.curve.every((p, i, c) => i === 0 || p.estimatedElo > c[i - 1].estimatedElo);
}
