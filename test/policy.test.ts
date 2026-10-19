// Live policy probes: obvious positions must put the obvious move on top.
// Proves the encoding end to end (a wrong mirror or vocabulary shows up here).
import { Chess } from "chess.js";
import { beforeAll, describe, expect, it } from "vitest";
import { MODEL_SHA256, maiaMove, warmUp } from "../src/maia.js";

const argmax = (fen: string, elo = 1500) => maiaMove(fen, { selfElo: elo, oppoElo: elo, temperature: 0 });

beforeAll(async () => {
  await warmUp();
});

describe("Maia-3 policy", () => {
  it("loads the pinned weights", async () => {
    expect((await warmUp()).sha256).toBe(MODEL_SHA256);
  });

  it("takes a free queen (Black to move: exd5)", async () => {
    const r = await argmax("rnbqkbnr/pppp1ppp/4p3/3Q4/8/8/PPPP1PPP/RNB1KBNR b KQkq - 0 3");
    expect(r!.uci).toBe("e6d5");
    expect(r!.p).toBeGreaterThan(0.5);
  });

  it("finds mate in one (Black: Ra1#)", async () => {
    const fen = "r5k1/8/8/8/8/8/1r6/7K b - - 0 1";
    const r = await argmax(fen);
    const game = new Chess(fen);
    game.move({ from: r!.uci.slice(0, 2), to: r!.uci.slice(2, 4) });
    expect(game.isCheckmate()).toBe(true);
  });

  it("recaptures the knight on d5", async () => {
    const r = await argmax("rnbqkbnr/ppp2ppp/8/3N4/8/8/PPPP1PPP/RNBQKB1R b KQkq - 0 4");
    expect(r!.uci.slice(2, 4)).toBe("d5");
  });

  it("plays the only legal move at probability 1", async () => {
    const r = await argmax("7k/6Q1/8/8/8/8/8/K7 b - - 0 1");
    expect(r!.uci).toBe("h8g7");
    expect(r!.p).toBeCloseTo(1, 6);
  });

  it("answers 1.e4 with a human book move", async () => {
    const r = await argmax("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1");
    expect(["e7e5", "c7c5", "e7e6", "c7c6"]).toContain(r!.uci);
  });

  it("plays a normal developing move as White after 1.e4 e5 (unmirrored frame)", async () => {
    const r = await argmax("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2");
    expect(["g1f3", "f1c4", "b1c3", "d2d4"]).toContain(r!.uci);
  });

  it("promotes as Black (the mirrored promotion block)", async () => {
    const r = await argmax("8/8/8/8/8/8/6p1/1K2k3 b - - 0 1");
    expect(r!.uci).toBe("g2g1q");
  });

  it("returns null for a terminal position", async () => {
    expect(await argmax("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3")).toBeNull();
  });

  it("returns a normalised top list and value head", async () => {
    const r = await maiaMove("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1", {
      selfElo: 1200,
      oppoElo: 1200,
      temperature: 1,
    });
    const { win, draw, loss } = r!.wdl;
    expect(win + draw + loss).toBeCloseTo(1, 5);
    expect(r!.top.length).toBe(5);
    expect(r!.top.map((t) => t.p)).toEqual([...r!.top.map((t) => t.p)].sort((a, b) => b - a));
  });

  it("is reproducible with an injected RNG", async () => {
    const fen = "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 4 4";
    const pick = async (roll: number) =>
      (await maiaMove(fen, { selfElo: 1500, oppoElo: 1500, temperature: 1, random: () => roll }))!.uci;
    expect(await pick(0)).toBe((await argmax(fen))!.uci);
    expect(await pick(0.3)).toBe(await pick(0.3));
  });

  it("serves concurrent calls without ORT errors (the run queue)", async () => {
    const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
    const results = await Promise.all(
      Array.from({ length: 10 }, () => maiaMove(fen, { selfElo: 1500, oppoElo: 1500, temperature: 1 })),
    );
    expect(results.every((r) => r && /^[a-h][1-8][a-h][1-8]$/.test(r.uci))).toBe(true);
  });
});
