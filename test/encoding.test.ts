// Pure encoding checks against upstream CSSLab/maia3 (utils.py, dataset.py).
import { describe, expect, it } from "vitest";
import { encodeTokens, legalMoves, mirrorUci, moveIndex } from "../src/maia.js";

describe("move vocabulary (get_all_possible_moves)", () => {
  it("indexes plain moves as from*64 + to, square = (rank-1)*8 + file", () => {
    expect(moveIndex("a1a2")).toBe(0 * 64 + 8);
    expect(moveIndex("e2e4")).toBe(12 * 64 + 28);
    expect(moveIndex("h8h1")).toBe(63 * 64 + 7);
  });

  it("indexes promotions as 4096 + fromFile*32 + toFile*4 + {q,r,b,n}", () => {
    expect(moveIndex("a7a8q")).toBe(4096);
    expect(moveIndex("a7b8n")).toBe(4096 + 0 * 32 + 1 * 4 + 3);
    expect(moveIndex("h7h8r")).toBe(4096 + 7 * 32 + 7 * 4 + 1);
    expect(moveIndex("h7h8n")).toBe(4351); // last vocabulary entry
  });

  it("rejects promotions outside the mirrored rank-7 → rank-8 frame", () => {
    expect(moveIndex("a2a1q")).toBe(-1);
  });
});

describe("mirror_move", () => {
  it("flips ranks and keeps files + promotion suffix", () => {
    expect(mirrorUci("e7e5")).toBe("e2e4");
    expect(mirrorUci("a2a1q")).toBe("a7a8q");
  });
});

describe("tokenize_board", () => {
  const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";

  it("puts the mover's pieces in channels 0-5 and the opponent's in 6-11", () => {
    const t = encodeTokens(`${START} w - - 0 1`);
    expect(t[0 * 12 + 3]).toBe(1); // a1: own rook
    expect(t[4 * 12 + 5]).toBe(1); // e1: own king
    expect(t[56 * 12 + 9]).toBe(1); // a8: enemy rook
    expect(t.reduce((a, b) => a + b, 0)).toBe(32);
  });

  it("mirrors the board when Black is to move (start position is symmetric)", () => {
    expect([...encodeTokens(`${START} b - - 0 1`)]).toEqual([...encodeTokens(`${START} w - - 0 1`)]);
  });

  it("maps Black's a8 rook to the mover's a1 when Black is to move", () => {
    const t = encodeTokens("r7/8/8/8/8/8/8/R7 b - - 0 1");
    expect(t[0 * 12 + 3]).toBe(1);
    expect(t[56 * 12 + 9]).toBe(1);
  });
});

describe("legal mask", () => {
  it("covers every legal move, with unique in-vocabulary indices", () => {
    const fens = [
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      "4k3/1P6/8/8/8/8/6p1/4K3 b - - 0 1", // Black promotes g2-g1 (mirrored to g7-g8)
      "4k3/1P6/8/8/8/8/6p1/4K3 w - - 0 1",
    ];
    for (const fen of fens) {
      const moves = legalMoves(fen);
      const idx = moves.map((m) => m.idx);
      expect(idx.every((i) => i >= 0 && i < 4352)).toBe(true);
      expect(new Set(idx).size).toBe(idx.length);
    }
    expect(legalMoves(fens[1]).filter((m) => m.uci.startsWith("g2g1"))).toHaveLength(4);
  });
});
