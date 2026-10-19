// The handlers are plain (Request) => Response functions, so the HTTP contract
// is tested without a server. Live checks against `vercel dev` are in README.
import { beforeAll, describe, expect, it } from "vitest";
import { GET as health } from "../api/health.js";
import { GET as index } from "../api/index.js";
import { POST as move } from "../api/move.js";
import { checkBearer } from "../src/auth.js";
import { MODEL_SHA256 } from "../src/maia.js";

const TOKEN = "test-token";
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function req(body: unknown, token: string | null = TOKEN): Request {
  return new Request("http://localhost/api/move", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeAll(() => {
  process.env.MAIA_SERVICE_TOKEN = TOKEN;
});

describe("auth", () => {
  it("accepts only the exact bearer token and fails closed when unset", () => {
    expect(checkBearer(`Bearer ${TOKEN}`, TOKEN)).toBe("ok");
    expect(checkBearer(`bearer ${TOKEN}`, TOKEN)).toBe("ok");
    expect(checkBearer(`Bearer ${TOKEN}x`, TOKEN)).toBe("unauthorized");
    expect(checkBearer(TOKEN, TOKEN)).toBe("unauthorized");
    expect(checkBearer(null, TOKEN)).toBe("unauthorized");
    expect(checkBearer(`Bearer ${TOKEN}`, "")).toBe("unconfigured");
  });
});

describe("POST /api/move", () => {
  it("returns a legal move with the contract's fields", async () => {
    const res = await move(req({ fen: START, strength: 1300, opponentElo: 1300 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      ["latencyMs", "model", "p", "selfElo", "temperature", "top", "uci", "wdl"].sort(),
    );
    expect(body.model).toBe("maia3-5m.fp16");
    expect(body.top.map((t: { uci: string }) => t.uci)).toContain(body.uci);
  });

  it("clamps strength above the 2200 cap", async () => {
    const body = await (await move(req({ fen: START, strength: 3000, opponentElo: 1500 }))).json();
    const capped = await (await move(req({ fen: START, strength: 2200, opponentElo: 1500 }))).json();
    expect(body.selfElo).toBe(capped.selfElo);
    expect(body.temperature).toBe(capped.temperature);
  });

  it("401s a missing or wrong token", async () => {
    expect((await move(req({ fen: START, strength: 1300 }, null))).status).toBe(401);
    expect((await move(req({ fen: START, strength: 1300 }, "nope"))).status).toBe(401);
  });

  it("400s bad input", async () => {
    expect((await move(req("{not json"))).status).toBe(400);
    expect((await move(req({ fen: "not a fen", strength: 1300 }))).status).toBe(400);
    expect((await move(req({ fen: START }))).status).toBe(400);
    expect((await move(req({ fen: START, strength: "1300" }))).status).toBe(400);
    expect((await move(req({ fen: START, strength: 1300, opponentElo: null }))).status).toBe(400);
    expect((await move(req({ fen: "8/8/8/8/8/8/8/8 w - - 0 1", strength: 1300 }))).status).toBe(400);
  });

  it("422s a terminal position", async () => {
    const mate = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
    const stalemate = "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1";
    expect((await move(req({ fen: mate, strength: 1300 }))).status).toBe(422);
    expect((await move(req({ fen: stalemate, strength: 1300 }))).status).toBe(422);
  });

  it("500s when the service token is not configured", async () => {
    delete process.env.MAIA_SERVICE_TOKEN;
    try {
      expect((await move(req({ fen: START, strength: 1300 }))).status).toBe(500);
    } finally {
      process.env.MAIA_SERVICE_TOKEN = TOKEN;
    }
  });
});

describe("GET /api/health and /", () => {
  it("reports the pinned model and the source link", async () => {
    const body = await (await health()).json();
    expect(body).toEqual({
      ok: true,
      model: "maia3-5m.fp16",
      sha256: MODEL_SHA256,
      source: "https://github.com/BastiQ/chessoracle-maia",
    });
  });

  it("serves the AGPL notice", async () => {
    const text = await index().text();
    expect(text).toContain("AGPL-3.0");
    expect(text).toContain("https://github.com/BastiQ/chessoracle-maia");
  });
});
