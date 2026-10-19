// GET /api/health (public) — loads the model session (a warm-up) and reports
// what is being served, so a deploy can be checked against the README's pin.

import { warmUp } from "../src/maia.js";
import { SOURCE_URL, json } from "../src/source.js";

export async function GET(): Promise<Response> {
  try {
    const { model, sha256 } = await warmUp();
    return json({ ok: true, model, sha256, source: SOURCE_URL });
  } catch (err) {
    console.error("maia warm-up failed", err);
    return json({ ok: false, error: "model failed to load", source: SOURCE_URL }, 500);
  }
}
