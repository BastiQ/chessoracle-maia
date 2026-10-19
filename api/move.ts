// POST /api/move — { fen, strength, opponentElo } → Maia's move.
// Contract: 200 move · 400 bad input · 401 bad token · 422 terminal · 500.

import { Chess, validateFen } from "chess.js";
import { checkBearer } from "../src/auth.js";
import { MODEL_NAME, maiaMove } from "../src/maia.js";
import { json } from "../src/source.js";
import { strengthToParams } from "../src/strength.js";

/** Elo bounds for the opponent rating Maia conditions on. */
const OPPONENT_ELO_MIN = 0;
const OPPONENT_ELO_MAX = 3000;

export async function POST(request: Request): Promise<Response> {
  const started = performance.now();

  const auth = checkBearer(request.headers.get("authorization"));
  if (auth === "unconfigured") return json({ error: "service token not configured" }, 500);
  if (auth !== "ok") return json({ error: "unauthorized" }, 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }
  const { fen, strength, opponentElo } = (body ?? {}) as Record<string, unknown>;

  if (typeof fen !== "string" || fen.length > 120) return json({ error: "fen must be a FEN string" }, 400);
  const valid = validateFen(fen.trim());
  if (!valid.ok) return json({ error: `invalid fen: ${valid.error}` }, 400);
  if (typeof strength !== "number" || !Number.isFinite(strength)) {
    return json({ error: "strength must be a number" }, 400);
  }
  if (opponentElo !== undefined && (typeof opponentElo !== "number" || !Number.isFinite(opponentElo))) {
    return json({ error: "opponentElo must be a number" }, 400);
  }

  let game: Chess;
  try {
    game = new Chess(fen.trim());
  } catch (err) {
    return json({ error: `invalid fen: ${(err as Error).message}` }, 400);
  }
  if (game.isGameOver()) return json({ error: "position is terminal" }, 422);

  const { selfElo, temperature } = strengthToParams(strength);
  const oppoElo = Math.max(OPPONENT_ELO_MIN, Math.min(OPPONENT_ELO_MAX, (opponentElo as number | undefined) ?? strength));

  try {
    const move = await maiaMove(game.fen(), { selfElo, oppoElo, temperature });
    if (!move) return json({ error: "no legal move" }, 422);
    return json({
      uci: move.uci,
      p: move.p,
      top: move.top,
      wdl: move.wdl,
      selfElo,
      temperature,
      latencyMs: Math.round(performance.now() - started),
      model: MODEL_NAME,
    });
  } catch (err) {
    console.error("maia inference failed", err);
    return json({ error: "inference failed" }, 500);
  }
}
