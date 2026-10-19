// Maia-3 policy network, server-side (Node, onnxruntime-web on the wasm backend).
//
// Maia is trained to predict the move a HUMAN of a given rating actually played,
// so its mistakes are human-shaped — unlike a strength-limited Stockfish, which
// plays strong moves and then an almost random bad one. This module is a move
// GENERATOR only: it never evaluates a position for anyone.
//
// The encoding below is transcribed from the upstream maia3 source
// (CSSLab/maia3 @ 1e13597: maia3/utils.py get_all_possible_moves + mirror_move,
// maia3/dataset.py tokenize_board + get_legal_moves_mask, maia3/models.py
// forward) — NOT inferred from the model card, which documents the tensor shapes
// but not the move vocabulary.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Chess } from "chess.js";
import type { InferenceSession } from "onnxruntime-web";

/** Weights: Maia-3 5M, fp16 (~10.8 MB), committed byte-for-byte — see README. */
export const MODEL_NAME = "maia3-5m.fp16";
export const MODEL_FILE = "models/maia3-5m.fp16.onnx";
/** sha256 of the pinned file (bqrio/maia3-onnx @ 923df9a2e9396b54a09b168bb858ebbd5e5b76bc). */
export const MODEL_SHA256 = "ca22fc3031975932e693f9758149302efc177749165443ed52de828add8864fa";

/** Upstream clamps + linearly interpolates Elo over [0, 5000] (models.py). */
const ELO_MAX = 5000;

/** tokenize_board's channel order: pawn..king for the mover, then the opponent. */
const PIECE_CHANNEL: Record<string, number> = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 };

/** Promotion sub-order inside each (from-file, to-file) pair (utils.py). */
const PROMO_ORDER = ["q", "r", "b", "n"];

export interface MaiaCandidate {
  /** Real-board UCI (already un-mirrored when Maia is Black). */
  uci: string;
  /** Softmax probability over the LEGAL moves only, at the requested temperature. */
  p: number;
}

export interface MaiaMove {
  uci: string;
  /** The chosen move's probability. */
  p: number;
  /** Top candidates by probability, best first. */
  top: MaiaCandidate[];
  /** Side-to-move win/draw/loss from the model's value head. */
  wdl: { win: number; draw: number; loss: number };
  /** Time spent in session.run (excludes queueing). */
  latencyMs: number;
}

export interface MaiaOptions {
  /** Rating Maia should play at (the side it is moving for). */
  selfElo: number;
  /** Rating it believes its opponent has. */
  oppoElo: number;
  /** 0 = argmax (the single most human move); 1 = sample the raw policy. */
  temperature?: number;
  /** Uniform [0, 1) source; injectable so calibration runs are reproducible. */
  random?: () => number;
  /** How many candidates to return in `top` (default 5). */
  topN?: number;
}

/** Square index in Maia's frame: a1 = 0 … h8 = 63 (python-chess numbering). */
function squareIndex(name: string): number {
  return (Number(name[1]) - 1) * 8 + (name.charCodeAt(0) - 97);
}

/**
 * Upstream `mirror_move`: flip the RANK of both squares, keep the file and the
 * promotion suffix. Maia always sees the position with the mover on the bottom,
 * so a Black move is mirrored on the way in (for the legal mask) and the model's
 * answer mirrored back on the way out.
 */
export function mirrorUci(uci: string): string {
  const flip = (sq: string) => sq[0] + String(9 - Number(sq[1]));
  return flip(uci.slice(0, 2)) + flip(uci.slice(2, 4)) + uci.slice(4);
}

/**
 * Index of a (mirrored, i.e. mover-at-the-bottom) UCI move in Maia's 4352-entry
 * vocabulary:
 *   0…4095    from * 64 + to        (get_all_possible_moves' nested square loops)
 *   4096…4351 promotions, always rank 7 → rank 8 because the board is mirrored:
 *             4096 + fromFile * 32 + toFile * 4 + {q,r,b,n}
 * Returns -1 for anything outside the vocabulary.
 */
export function moveIndex(uci: string): number {
  const promo = uci.length > 4 ? uci[4].toLowerCase() : "";
  if (!promo) return squareIndex(uci.slice(0, 2)) * 64 + squareIndex(uci.slice(2, 4));
  const pieceIdx = PROMO_ORDER.indexOf(promo);
  if (pieceIdx < 0 || uci[1] !== "7" || uci[3] !== "8") return -1;
  const fromFile = uci.charCodeAt(0) - 97;
  const toFile = uci.charCodeAt(2) - 97;
  return 4096 + fromFile * 32 + toFile * 4 + pieceIdx;
}

/**
 * Upstream `tokenize_board`: a 64x12 one-hot of piece placement ONLY — no side to
 * move, castling rights or en-passant square. When Black is to move the board is
 * mirrored (ranks flipped AND colours swapped, python-chess `Board.mirror()`), so
 * channels 0-5 are always the MOVER's pieces and 6-11 the opponent's.
 * Row-major: index = square * 12 + channel.
 */
export function encodeTokens(fen: string): Float32Array {
  const [placement, turn] = fen.split(" ");
  const black = turn === "b";
  const tokens = new Float32Array(64 * 12);
  const rows = placement.split("/"); // rank 8 first
  for (let r = 0; r < 8; r++) {
    let file = 0;
    for (const ch of rows[r]) {
      if (ch >= "1" && ch <= "8") {
        file += Number(ch);
        continue;
      }
      const isWhite = ch === ch.toUpperCase();
      // FEN row 0 is rank 8, so the un-mirrored square is (7 - r) * 8 + file.
      // Mirroring flips the rank (sq ^ 56) and swaps the colour.
      const square = black ? r * 8 + file : (7 - r) * 8 + file;
      const mine = black ? !isWhite : isWhite;
      tokens[square * 12 + PIECE_CHANNEL[ch.toLowerCase()] + (mine ? 0 : 6)] = 1;
      file++;
    }
  }
  return tokens;
}

/**
 * Every legal move in `fen`, paired with its vocabulary index in Maia's frame.
 * This is the mask: a policy net has no notion of legality, so an unmasked argmax
 * eventually emits an illegal move.
 */
export function legalMoves(fen: string): { uci: string; idx: number }[] {
  const game = new Chess(fen);
  const black = game.turn() === "b";
  const out: { uci: string; idx: number }[] = [];
  for (const m of game.moves({ verbose: true })) {
    const uci = m.from + m.to + (m.promotion ?? "");
    const idx = moveIndex(black ? mirrorUci(uci) : uci);
    if (idx >= 0) out.push({ uci, idx });
  }
  return out;
}

function softmax(values: number[]): number[] {
  const max = Math.max(...values);
  const exps = values.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

function clampElo(elo: number): number {
  return Math.max(0, Math.min(ELO_MAX, elo));
}

// ---------------------------------------------------------------------------
// Session: one per process, created lazily, run() strictly serialized.
//
// Fluid Compute sends concurrent requests to the same instance, and a single
// wasm ORT session must not run overlapping calls — so every run goes through a
// promise queue. One forward pass is ~tens of ms, so the queue is cheap.

type Ort = typeof import("onnxruntime-web");

interface Loaded {
  ort: Ort;
  session: InferenceSession;
  sha256: string;
}

let loading: Promise<Loaded> | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function load(): Promise<Loaded> {
  const ort = await import("onnxruntime-web");
  // Single-threaded: no worker threads inside a function instance.
  ort.env.wasm.numThreads = 1;
  const buffer = await readFile(join(process.cwd(), MODEL_FILE));
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  // 'basic' per the export's model card: ORT's `all`/`extended` CPU fusions hit
  // a SimplifiedLayerNormFusion bug on this graph's fp16 cast boundaries.
  const session = await ort.InferenceSession.create(buffer, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "basic",
  });
  return { ort, session, sha256 };
}

/** Load (once) and return the model's provenance. Used by /api/health as a warm-up. */
export async function warmUp(): Promise<{ model: string; sha256: string }> {
  if (!loading) {
    loading = load();
    // A failed load must not poison the instance forever: retry on next call.
    loading.catch(() => {
      loading = null;
    });
  }
  const { sha256 } = await loading;
  return { model: MODEL_NAME, sha256 };
}

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * The move a `selfElo` human would play in `fen`, sampled from Maia's policy at
 * `temperature`. Returns null when the position has no legal move (terminal).
 * `fen` must already be validated (chess.js accepts it).
 */
export async function maiaMove(fen: string, opts: MaiaOptions): Promise<MaiaMove | null> {
  const legal = legalMoves(fen);
  if (!legal.length) return null;

  await warmUp();
  const { ort, session } = await loading!;
  const tokens = encodeTokens(fen);

  const { logits, value, latencyMs } = await serialized(async () => {
    const started = performance.now();
    const out = await session.run({
      tokens: new ort.Tensor("float32", tokens, [1, 64, 12]),
      elo_self: new ort.Tensor("float32", new Float32Array([clampElo(opts.selfElo)]), [1]),
      elo_oppo: new ort.Tensor("float32", new Float32Array([clampElo(opts.oppoElo)]), [1]),
    });
    return {
      logits: out.logits_move.data as Float32Array,
      value: [...(out.logits_value.data as Float32Array)],
      latencyMs: performance.now() - started,
    };
  });

  const temperature = opts.temperature ?? 1;
  // Softmax over the legal survivors only. Temperature divides the logits, so
  // t -> 0 collapses onto the argmax; at t = 0 report the raw policy and argmax.
  const scores = legal.map((m) => logits[m.idx]);
  const probs = softmax(temperature > 0 ? scores.map((s) => s / temperature) : scores);
  const ranked: MaiaCandidate[] = legal
    .map((m, i) => ({ uci: m.uci, p: probs[i] }))
    .sort((a, b) => b.p - a.p);

  let chosen = ranked[0];
  if (temperature > 0) {
    // Sampling is where the human-shaped error comes from: a 1500 does not
    // always play their own best move either.
    let roll = (opts.random ?? Math.random)();
    for (const cand of ranked) {
      roll -= cand.p;
      if (roll <= 0) {
        chosen = cand;
        break;
      }
    }
  }

  const [loss, draw, win] = softmax(value);
  return {
    uci: chosen.uci,
    p: chosen.p,
    top: ranked.slice(0, opts.topN ?? 5),
    wdl: { win, draw, loss },
    latencyMs,
  };
}
