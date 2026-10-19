// Strength calibration: what does Maia at {selfElo, temperature} actually play like,
// on the scale of Chess Oracle's own Stockfish opponent?
//
//   npm run calibrate -- play --match m1500,sf1500,40 [--match ...] [--workers 6]
//   npm run calibrate -- fit            # games.jsonl → calibration.json + REPORT.md
//
// Players (the `--match a,b,games` tokens):
//   m<selfElo>[t<T>]   Maia-3 at selfElo, temperature T (default 1)
//   sf<elo>            Stockfish 18 lite-single (the exact wasm Chess Oracle ships)
//                      with UCI_LimitStrength + UCI_Elo, at the app's movetime for
//                      that strength. These are the fixed anchors of the scale.
//   sfskill<n>         the same engine at Skill Level n, no Elo limit (the app's
//                      Beginner tier is sfskill2 at 150 ms) — rated, not anchored.
//
// Each match is played from a balanced opening set, every opening once with each
// colour. Games end naturally (mate, stalemate, repetition, 50 moves, material) or
// are adjudicated by a full-strength native Stockfish: ±800 cp for 6 plies is a win,
// a dead-level ending after move 60 is a draw, and the cap at move 150 scores by eval.
// Maia is told its opponent's nominal rating (oppoElo), as in the product where
// it is told the player's.
//
// `fit` puts every game into one Bradley–Terry (Elo-logistic) maximum-likelihood
// fit: Stockfish anchors are fixed at their UCI_Elo, every other player gets a
// free rating. Maia-vs-Maia games (the self-play ladder below the lowest anchor)
// fit differences, anchored through the players that also met Stockfish.

import { type ChildProcess, fork, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Chess } from "chess.js";

const ROOT = join(import.meta.dirname, "..");
const RAW = join(ROOT, "calibration/raw/games.jsonl");
const SF_WASM_JS = join(ROOT, "node_modules/stockfish/bin/stockfish-18-lite-single.js");
const ADJUDICATOR = process.env.ADJUDICATOR ?? "/opt/homebrew/bin/stockfish";

// The app's opponent movetimes (chessoracle lib/levels.ts): 150 ms Beginner
// (skill 2), 300 ms at UCI_Elo 1500, 500 ms at 2200. Anchors in between take the
// time of the nearest-below tier; 1800 is interpolated.
const SF_MOVETIME: Record<number, number> = { 1320: 300, 1500: 300, 1800: 400, 2200: 500 };
const sfMovetime = (elo: number) =>
  SF_MOVETIME[elo] ?? (elo < 1500 ? 300 : elo < 2200 ? Math.round(300 + ((elo - 1500) / 700) * 200) : 500);

const ADJ = { nodes: 20_000, winCp: 800, winPlies: 6, drawCp: 15, drawPlies: 20, drawAfterPly: 120, capPly: 300, capCp: 300 };

// Balanced, well-trodden openings (6-10 plies), each played with both colours.
const OPENINGS: [string, string][] = [
  ["Ruy Lopez", "e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6"],
  ["Italian", "e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6"],
  ["Scotch", "e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f3d4 g8f6"],
  ["Petroff", "e2e4 e7e5 g1f3 g8f6 f3e5 d7d6 e5f3 f6e4"],
  ["Vienna", "e2e4 e7e5 b1c3 g8f6 f2f4 d7d5 f4e5 f6e4"],
  ["Sicilian Najdorf", "e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6"],
  ["Sicilian Taimanov", "e2e4 c7c5 g1f3 e7e6 d2d4 c5d4 f3d4 b8c6"],
  ["French", "e2e4 e7e6 d2d4 d7d5 b1c3 g8f6 c1g5 f8e7"],
  ["Caro-Kann", "e2e4 c7c6 d2d4 d7d5 b1c3 d5e4 c3e4 c8f5"],
  ["Scandinavian", "e2e4 d7d5 e4d5 d8d5 b1c3 d5a5 d2d4 g8f6"],
  ["Pirc", "e2e4 d7d6 d2d4 g8f6 b1c3 g7g6 g1f3 f8g7"],
  ["Alekhine", "e2e4 g8f6 e4e5 f6d5 d2d4 d7d6 g1f3 c8g4"],
  ["QGD", "d2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c1g5 f8e7"],
  ["Slav", "d2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 d5c4"],
  ["QGA", "d2d4 d7d5 c2c4 d5c4 g1f3 g8f6 e2e3 e7e6"],
  ["London", "d2d4 d7d5 c1f4 g8f6 e2e3 e7e6 g1f3 c7c5"],
  ["King's Indian", "d2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6"],
  ["Nimzo-Indian", "d2d4 g8f6 c2c4 e7e6 b1c3 f8b4 e2e3 e8g8"],
  ["Grunfeld", "d2d4 g8f6 c2c4 g7g6 b1c3 d7d5 c4d5 f6d5"],
  ["Queen's Indian", "d2d4 g8f6 c2c4 e7e6 g1f3 b7b6 g2g3 c8b7"],
  ["Catalan", "d2d4 g8f6 c2c4 e7e6 g2g3 d7d5 f1g2 f8e7"],
  ["Dutch", "d2d4 f7f5 g2g3 g8f6 f1g2 e7e6 g1f3 f8e7"],
  ["English", "c2c4 e7e5 b1c3 g8f6 g2g3 d7d5 c4d5 f6d5"],
  ["Reti", "g1f3 d7d5 g2g3 g8f6 f1g2 e7e6 e1g1 f8e7"],
];

// ---------------------------------------------------------------------------
// Players

type Player =
  | { kind: "maia"; id: string; selfElo: number; temperature: number }
  | { kind: "sf"; id: string; elo: number | null; skill: number; movetimeMs: number };

function parsePlayer(token: string): Player {
  let m = /^m(\d+)(?:t([\d.]+))?$/.exec(token);
  if (m) {
    const temperature = m[2] ? Number(m[2]) : 1;
    return { kind: "maia", id: `maia:${m[1]}:t${temperature}`, selfElo: Number(m[1]), temperature };
  }
  m = /^sf(\d+)$/.exec(token);
  if (m) {
    const elo = Number(m[1]);
    // The app sets a Skill Level next to UCI_Elo; with UCI_LimitStrength on,
    // Stockfish derives the level from UCI_Elo and ignores it.
    return { kind: "sf", id: `sf:${elo}`, elo, skill: 20, movetimeMs: sfMovetime(elo) };
  }
  m = /^sfskill(\d+)$/.exec(token);
  if (m) return { kind: "sf", id: `sfskill:${m[1]}`, elo: null, skill: Number(m[1]), movetimeMs: 150 };
  throw new Error(`bad player token: ${token}`);
}

/** The rating a player claims, which Maia is told as oppoElo. */
function nominalElo(p: Player): number {
  if (p.kind === "maia") return p.selfElo;
  return p.elo ?? 800; // the app's Beginner tier (skill 2) is pitched at ~600-800
}

// ---------------------------------------------------------------------------
// UCI engine process

class Uci {
  private proc: ChildProcess;
  private waiters: { test: (line: string) => boolean; resolve: (line: string) => void }[] = [];
  private lastInfo = "";

  constructor(cmd: string, args: string[]) {
    this.proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"] });
    createInterface({ input: this.proc.stdout! }).on("line", (line) => {
      if (line.startsWith("info") && line.includes(" score ")) this.lastInfo = line;
      const i = this.waiters.findIndex((w) => w.test(line));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(line);
    });
  }

  send(cmd: string) {
    this.proc.stdin!.write(cmd + "\n");
  }

  private until(prefix: string): Promise<string> {
    return new Promise((resolve) => this.waiters.push({ test: (l) => l.startsWith(prefix), resolve }));
  }

  async init(options: Record<string, string | number | boolean>) {
    this.send("uci");
    await this.until("uciok");
    for (const [k, v] of Object.entries(options)) this.send(`setoption name ${k} value ${v}`);
    this.send("isready");
    await this.until("readyok");
  }

  async newGame() {
    this.send("ucinewgame");
    this.send("isready");
    await this.until("readyok");
  }

  /** bestmove + the final score (side-to-move POV, cp; mate → ±10000). */
  async go(moves: string[], limit: string): Promise<{ best: string; cp: number }> {
    this.lastInfo = "";
    this.send(`position startpos${moves.length ? " moves " + moves.join(" ") : ""}`);
    this.send(`go ${limit}`);
    const line = await this.until("bestmove");
    const mate = / score mate (-?\d+)/.exec(this.lastInfo);
    const cp = / score cp (-?\d+)/.exec(this.lastInfo);
    const score = mate ? (Number(mate[1]) > 0 ? 10_000 : -10_000) : cp ? Number(cp[1]) : 0;
    return { best: line.split(" ")[1], cp: score };
  }

  quit() {
    this.send("quit");
  }
}

// ---------------------------------------------------------------------------
// Worker: plays one game per job

interface Job {
  n: number;
  white: Player;
  black: Player;
  opening: number;
  seed: number;
}

interface GameRecord {
  white: string;
  black: string;
  /** 1 white win, 0.5 draw, 0 black win. */
  score: number;
  reason: string;
  plies: number;
  opening: string;
  whiteOppoElo: number;
  blackOppoElo: number;
  seed: number;
  moves: string;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function worker() {
  const { maiaMove, warmUp } = await import("../src/maia.js");
  await warmUp();
  const adjudicator = new Uci(ADJUDICATOR, []);
  await adjudicator.init({ Threads: 1, Hash: 16 });
  let sf: Uci | null = null;
  let sfConfig = "";

  async function engineFor(p: Extract<Player, { kind: "sf" }>) {
    const config = `${p.elo}:${p.skill}`;
    if (!sf || sfConfig !== config) {
      sf?.quit();
      sf = new Uci(process.execPath, [SF_WASM_JS]);
      await sf.init(
        p.elo
          ? { Hash: 16, UCI_LimitStrength: true, UCI_Elo: p.elo, "Skill Level": p.skill }
          : { Hash: 16, UCI_LimitStrength: false, "Skill Level": p.skill },
      );
      sfConfig = config;
    }
    return sf;
  }

  async function play(job: Job): Promise<GameRecord> {
    const random = mulberry32(job.seed);
    const [openingName, openingLine] = OPENINGS[job.opening];
    const game = new Chess();
    const moves: string[] = [];
    for (const uci of openingLine.split(" ")) {
      game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      moves.push(uci);
    }
    for (const p of [job.white, job.black]) if (p.kind === "sf") await (await engineFor(p)).newGame();
    await adjudicator.newGame();

    let winStreak = 0;
    let drawStreak = 0;
    let lastSign = 0;
    let result: { score: number; reason: string } | null = null;

    while (!result) {
      const mover = game.turn() === "w" ? job.white : job.black;
      const other = game.turn() === "w" ? job.black : job.white;
      let uci: string;
      if (mover.kind === "maia") {
        const m = await maiaMove(game.fen(), {
          selfElo: mover.selfElo,
          oppoElo: nominalElo(other),
          temperature: mover.temperature,
          random,
        });
        uci = m!.uci;
      } else {
        uci = (await (await engineFor(mover)).go(moves, `movetime ${mover.movetimeMs}`)).best;
      }
      game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      moves.push(uci);

      if (game.isCheckmate()) result = { score: game.turn() === "w" ? 0 : 1, reason: "mate" };
      else if (game.isStalemate()) result = { score: 0.5, reason: "stalemate" };
      else if (game.isInsufficientMaterial()) result = { score: 0.5, reason: "material" };
      else if (game.isThreefoldRepetition()) result = { score: 0.5, reason: "repetition" };
      else if (game.isDrawByFiftyMoves()) result = { score: 0.5, reason: "fifty" };
      if (result) break;

      const { cp } = await adjudicator.go(moves, `nodes ${ADJ.nodes}`);
      const white = game.turn() === "w" ? cp : -cp;
      const sign = Math.abs(white) >= ADJ.winCp ? Math.sign(white) : 0;
      winStreak = sign !== 0 && sign === lastSign ? winStreak + 1 : sign !== 0 ? 1 : 0;
      lastSign = sign;
      drawStreak = Math.abs(white) <= ADJ.drawCp ? drawStreak + 1 : 0;
      if (winStreak >= ADJ.winPlies) result = { score: sign > 0 ? 1 : 0, reason: "adjudicated-win" };
      else if (moves.length >= ADJ.drawAfterPly && drawStreak >= ADJ.drawPlies) result = { score: 0.5, reason: "adjudicated-draw" };
      else if (moves.length >= ADJ.capPly) {
        result = { score: white >= ADJ.capCp ? 1 : white <= -ADJ.capCp ? 0 : 0.5, reason: "cap" };
      }
    }

    return {
      white: job.white.id,
      black: job.black.id,
      score: result.score,
      reason: result.reason,
      plies: moves.length,
      opening: openingName,
      whiteOppoElo: nominalElo(job.black),
      blackOppoElo: nominalElo(job.white),
      seed: job.seed,
      moves: moves.join(" "),
    };
  }

  process.on("message", async (job: Job | "quit") => {
    if (job === "quit") {
      sf?.quit();
      adjudicator.quit();
      process.exit(0);
    }
    try {
      process.send!({ n: job.n, record: await play(job) });
    } catch (err) {
      process.send!({ n: job.n, error: String((err as Error).stack ?? err) });
    }
  });
  process.send!({ ready: true });
}

// ---------------------------------------------------------------------------
// Coordinator

async function playMatches(args: string[]) {
  const matches: { a: Player; b: Player; games: number }[] = [];
  let workers = 6;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--match") {
      const [a, b, g] = args[++i].split(",");
      matches.push({ a: parsePlayer(a), b: parsePlayer(b), games: Number(g) });
    } else if (args[i] === "--workers") workers = Number(args[++i]);
  }
  if (!matches.length) throw new Error("no --match given");

  // Every opening once per colour, cycling through the set.
  const jobs: Job[] = [];
  for (const { a, b, games } of matches) {
    for (let g = 0; g < games; g++) {
      const swap = g % 2 === 1;
      jobs.push({
        n: jobs.length,
        white: swap ? b : a,
        black: swap ? a : b,
        opening: Math.floor(g / 2) % OPENINGS.length,
        seed: (Date.now() ^ (jobs.length * 2654435761)) >>> 0,
      });
    }
  }
  mkdirSync(join(ROOT, "calibration/raw"), { recursive: true });
  console.log(`${jobs.length} games on ${workers} workers`);

  let next = 0;
  let done = 0;
  const started = Date.now();
  await new Promise<void>((finish) => {
    const procs: ChildProcess[] = [];
    const feed = (p: ChildProcess) => {
      if (next < jobs.length) p.send(jobs[next++]);
      else {
        p.send("quit");
        if (++quitters === procs.length) finish();
      }
    };
    let quitters = 0;
    for (let w = 0; w < Math.min(workers, jobs.length); w++) {
      const p = fork(import.meta.filename, ["worker"], { execArgv: ["--import", "tsx"] });
      procs.push(p);
      p.on("message", (msg: { ready?: boolean; n?: number; record?: GameRecord; error?: string }) => {
        if (msg.record) {
          appendFileSync(RAW, JSON.stringify(msg.record) + "\n");
          done++;
          const r = msg.record;
          const mins = ((Date.now() - started) / 60000).toFixed(1);
          console.log(`[${done}/${jobs.length} ${mins}m] ${r.white} vs ${r.black}: ${r.score} (${r.reason}, ${r.plies} plies, ${r.opening})`);
        } else if (msg.error) {
          console.error(`game ${msg.n} failed: ${msg.error}`);
        }
        feed(p);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Fit

interface Fitted {
  id: string;
  rating: number;
  se: number;
  games: number;
  score: number;
  anchored: boolean;
}

function anchorOf(id: string): number | null {
  const m = /^sf:(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

/** Bradley–Terry on the Elo scale, Newton–Raphson, weak Gaussian prior on free ratings. */
function fitRatings(games: GameRecord[]): Map<string, Fitted> {
  const ids = [...new Set(games.flatMap((g) => [g.white, g.black]))].sort();
  const free = ids.filter((id) => anchorOf(id) === null);
  const index = new Map(free.map((id, i) => [id, i]));
  const k = Math.log(10) / 400;
  // A weak, neutral prior: it only keeps a player with no wins (or no losses)
  // finite, and is the same for everyone so it does not presume the answer.
  const prior = (_id: string) => 1400;
  const PRIOR_SD = 800;
  const rating = new Map<string, number>(ids.map((id) => [id, anchorOf(id) ?? prior(id)]));

  let hessian: number[][] = [];
  for (let iter = 0; iter < 500; iter++) {
    const n = free.length;
    const grad = new Array(n).fill(0);
    hessian = Array.from({ length: n }, () => new Array(n).fill(0));
    for (const id of free) {
      const i = index.get(id)!;
      grad[i] -= (rating.get(id)! - prior(id)) / PRIOR_SD ** 2;
      hessian[i][i] -= 1 / PRIOR_SD ** 2;
    }
    for (const g of games) {
      const p = 1 / (1 + Math.exp(-k * (rating.get(g.white)! - rating.get(g.black)!)));
      const w = k * k * p * (1 - p);
      const iw = index.get(g.white);
      const ib = index.get(g.black);
      if (iw !== undefined) {
        grad[iw] += k * (g.score - p);
        hessian[iw][iw] -= w;
      }
      if (ib !== undefined) {
        grad[ib] -= k * (g.score - p);
        hessian[ib][ib] -= w;
      }
      if (iw !== undefined && ib !== undefined) {
        hessian[iw][ib] += w;
        hessian[ib][iw] += w;
      }
    }
    const step = solve(hessian.map((r) => r.map((v) => -v)), grad);
    let maxStep = 0;
    for (const id of free) {
      // Damped: far from the optimum p(1-p) ~ 0, and a full Newton step explodes.
      const s = Math.max(-200, Math.min(200, step[index.get(id)!]));
      rating.set(id, rating.get(id)! + s);
      maxStep = Math.max(maxStep, Math.abs(s));
    }
    if (maxStep < 0.01) break;
  }
  const cov = invert(hessian.map((r) => r.map((v) => -v)));

  const out = new Map<string, Fitted>();
  for (const id of ids) {
    const mine = games.filter((g) => g.white === id || g.black === id);
    const score = mine.reduce((s, g) => s + (g.white === id ? g.score : 1 - g.score), 0);
    const i = index.get(id);
    out.set(id, {
      id,
      rating: rating.get(id)!,
      se: i === undefined ? 0 : Math.sqrt(cov[i][i]),
      games: mine.length,
      score,
      anchored: i === undefined,
    });
  }
  return out;
}

function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let j = c; j <= n; j++) m[r][j] -= f * m[c][j];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

function invert(a: number[][]): number[][] {
  return a.map((_, j) => solve(a, a.map((__, i) => (i === j ? 1 : 0)))).reduce<number[][]>(
    (acc, col, j) => {
      col.forEach((v, i) => (acc[i][j] = v));
      return acc;
    },
    a.map(() => new Array(a.length).fill(0)),
  );
}

/** Pool-adjacent-violators: the weighted isotonic (non-decreasing) fit. */
function isotonic(values: number[], weights: number[]): number[] {
  const blocks: { sum: number; w: number; n: number }[] = [];
  values.forEach((v, i) => {
    blocks.push({ sum: v * weights[i], w: weights[i], n: 1 });
    while (blocks.length > 1 && blocks.at(-2)!.sum / blocks.at(-2)!.w >= blocks.at(-1)!.sum / blocks.at(-1)!.w) {
      const b = blocks.pop()!;
      const a = blocks.at(-1)!;
      a.sum += b.sum;
      a.w += b.w;
      a.n += b.n;
    }
  });
  return blocks.flatMap((b) => new Array(b.n).fill(b.sum / b.w));
}

/** Chess Oracle's tiers need 2200; above it the service serves whatever was measured, up to here. */
const STRENGTH_MAX = 2200;
const STRENGTH_CAP = 2600;

type Point = { estimatedElo: number; selfElo: number; temperature: number };

function fit() {
  const games: GameRecord[] = readFileSync(RAW, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const fitted = fitRatings(games);
  const maia = [...fitted.values()]
    .map((f) => {
      const m = /^maia:(\d+):t([\d.]+)$/.exec(f.id);
      return m ? { ...f, selfElo: Number(m[1]), temperature: Number(m[2]) } : null;
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);

  // The product path: T = 1 along selfElo first (isotonic, so noise cannot fold
  // the curve back on itself) — the most human setting. Where T = 1 tops out,
  // the path continues by lowering temperature at one selfElo: of the selfElos
  // that were measured cooler, the one whose path climbs highest.
  const t1 = maia.filter((f) => f.temperature === 1).sort((a, b) => a.selfElo - b.selfElo);
  const smooth = isotonic(t1.map((f) => f.rating), t1.map((f) => 1 / Math.max(f.se, 1) ** 2));
  const increasing = (points: Point[]) =>
    points.reduce<Point[]>((acc, p) => (!acc.length || p.estimatedElo > acc.at(-1)!.estimatedElo ? [...acc, p] : acc), []);
  const t1Path = (upTo: number) =>
    increasing(
      t1.flatMap((f, i) => (f.selfElo <= upTo ? [{ estimatedElo: Math.round(smooth[i]), selfElo: f.selfElo, temperature: 1 }] : [])),
    );
  const candidates: Point[][] = [t1Path(Infinity)];
  for (const s of new Set(maia.filter((f) => f.temperature < 1).map((f) => f.selfElo))) {
    const base = t1Path(s);
    if (base.at(-1)?.selfElo !== s) continue; // need the T = 1 point to start cooling from
    const cooler = maia
      .filter((f) => f.selfElo === s && f.temperature < 1)
      .sort((a, b) => b.temperature - a.temperature)
      .map((f) => ({ estimatedElo: Math.round(f.rating), selfElo: s, temperature: f.temperature }));
    candidates.push(increasing([...base, ...cooler]));
  }
  // Highest top wins; on a tie the earlier (warmer, T = 1-only) path is kept.
  const curve = candidates.reduce((best, c) => (c.at(-1)!.estimatedElo > best.at(-1)!.estimatedElo ? c : best));
  // Never claim a strength that was not measured: the range ends where the
  // measurements end (capped at STRENGTH_CAP).
  const top = curve.at(-1)!.estimatedElo;
  const reaches = top >= STRENGTH_MAX;
  const strengthMin = Math.ceil(curve[0].estimatedElo / 10) * 10;
  const strengthMax = Math.min(STRENGTH_CAP, Math.floor(top / 10) * 10);

  const calibration = {
    version: 1,
    status: "calibrated",
    model: "maia3-5m.fp16",
    strengthMin,
    strengthMax,
    curve,
    method: {
      scale: "Stockfish 18 lite-single (the wasm Chess Oracle ships) at UCI_LimitStrength + UCI_Elo, fixed at its label",
      anchors: Object.fromEntries([...fitted.keys()].filter((id) => anchorOf(id) !== null).map((id) => [id, `${sfMovetime(anchorOf(id)!)} ms/move`])),
      oppoElo: "Maia is told its opponent's nominal rating (anchor label, or the other Maia's selfElo)",
      fit: "Bradley–Terry (Elo logistic) MLE over all games; T=1 ratings made monotonic by weighted isotonic regression",
      adjudication: ADJ,
      reachesMax: reaches,
      games: games.length,
    },
    players: Object.fromEntries(
      [...fitted.values()].map((f) => [f.id, { rating: Math.round(f.rating), se: Math.round(f.se), games: f.games, score: f.score }]),
    ),
  };
  writeFileSync(join(ROOT, "calibration/calibration.json"), JSON.stringify(calibration, null, 2) + "\n");
  writeFileSync(join(ROOT, "calibration/REPORT.md"), report(games, fitted, calibration));
  console.log(readFileSync(join(ROOT, "calibration/REPORT.md"), "utf8"));
}

function report(games: GameRecord[], fitted: Map<string, Fitted>, cal: { curve: Point[]; strengthMin: number; strengthMax: number; method: { reachesMax: boolean } }): string {
  const rows = [...fitted.values()].sort((a, b) => a.rating - b.rating);
  const reasons = games.reduce<Record<string, number>>((acc, g) => ((acc[g.reason] = (acc[g.reason] ?? 0) + 1), acc), {});
  const pairs = new Map<string, { n: number; score: number }>();
  for (const g of games) {
    const [a, b, s] = g.white < g.black ? [g.white, g.black, g.score] : [g.black, g.white, 1 - g.score];
    const key = `${a} vs ${b}`;
    const cur = pairs.get(key) ?? { n: 0, score: 0 };
    pairs.set(key, { n: cur.n + 1, score: cur.score + s });
  }
  return `# Maia-3 strength calibration

Generated by \`npm run calibrate -- fit\` from \`calibration/raw/games.jsonl\` (${games.length} games).

**Scale.** Ratings are on the scale of Chess Oracle's own Stockfish opponent: the
same Stockfish 18 lite-single wasm, with \`UCI_LimitStrength\` + \`UCI_Elo\` at the
app's movetimes, fixed at its \`UCI_Elo\` label. "Estimated 1500" means "scores like
our 1500 Stockfish", not a FIDE or Lichess rating.

**Method.** Every opening of a 24-line balanced set is played once with each colour.
Games end naturally or are adjudicated by full-strength native Stockfish
(±${ADJ.winCp} cp for ${ADJ.winPlies} plies = win; |eval| ≤ ${ADJ.drawCp} cp for ${ADJ.drawPlies} plies after ply ${ADJ.drawAfterPly} = draw;
the cap at ply ${ADJ.capPly} scores ±${ADJ.capCp} cp as a win, else a draw). One Bradley–Terry (Elo
logistic) maximum-likelihood fit covers all games: Stockfish anchors are fixed,
every other player is free. Maia self-play games (selfElo s vs s+300) extend the
scale below the lowest anchor. Maia is told its opponent's nominal rating
(\`oppoElo\`), as the product tells it the player's.

## Product curve (\`calibration.json → curve\`)

| estimated Elo | selfElo | temperature |
|---:|---:|---:|
${cal.curve.map((p) => `| ${p.estimatedElo} | ${p.selfElo} | ${p.temperature} |`).join("\n")}

Range served: **${cal.strengthMin}–${cal.strengthMax}**${cal.method.reachesMax ? "" : ` — ⚠ even the coolest measured setting stays below ${STRENGTH_MAX}`} (the range ends where measurement ends, capped at ${STRENGTH_CAP}).
\`src/strength.ts\` interpolates linearly between points.

## Fitted ratings

| player | rating | ±SE | games | score |
|---|---:|---:|---:|---:|
${rows.map((f) => `| ${f.id} | ${Math.round(f.rating)} | ${f.anchored ? "anchor" : Math.round(f.se)} | ${f.games} | ${f.score}/${f.games} (${((100 * f.score) / f.games).toFixed(0)}%) |`).join("\n")}

## Matches

| match | games | score (first player) |
|---|---:|---:|
${[...pairs.entries()].sort().map(([k, v]) => `| ${k} | ${v.n} | ${v.score} (${((100 * v.score) / v.n).toFixed(0)}%) |`).join("\n")}

Game endings: ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(", ")}.
`;
}

// ---------------------------------------------------------------------------

const [mode, ...rest] = process.argv.slice(2);
if (mode === "worker") await worker();
else if (mode === "play") await playMatches(rest);
else if (mode === "fit") {
  if (!existsSync(RAW)) throw new Error(`no games yet: ${RAW}`);
  fit();
} else {
  console.log("usage: calibrate play --match m1500,sf1500,40 [--match ...] [--workers 6] | calibrate fit");
}
