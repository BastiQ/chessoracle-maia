# chessoracle-maia

The human-like opponent for [Chess Oracle](https://chessoracle.co): a small HTTP
service that serves **Maia-3**, a neural network trained to predict the move a
*human* of a given rating would play. Chess Oracle calls it server-to-server for
the opponent's move. Stockfish stays Chess Oracle's judge; this service never
evaluates anything for the coach.

Licensed **AGPL-3.0** (see [LICENSE](./LICENSE)), as is the Maia-3 model it serves.
This repository is the Corresponding Source of the running service.

## API

| Route | Auth | Response |
|---|---|---|
| `POST /api/move` | `Authorization: Bearer $MAIA_SERVICE_TOKEN` | `200 { uci, p, top: [{uci,p}], wdl: {win,draw,loss}, selfElo, temperature, latencyMs, model }` |
| `GET /api/health` | public | loads the model (a warm-up) → `{ ok, model, sha256, source }` |
| `GET /` | public | plain-text AGPL notice + source link |

`POST /api/move` body: `{ fen, strength, opponentElo }`.

- `fen` — the position; Maia moves for the side to move. Validated with chess.js.
- `strength` — the **target estimated Elo**, clamped to the calibrated range
  (`calibration/calibration.json` → `strengthMin`…`strengthMax`, currently 400–2230). The service maps it to
  Maia's parameters `{selfElo, temperature}` (see *Strength* below).
- `opponentElo` — the rating Maia believes its opponent has (the player's).
  Optional; defaults to `strength`.

Errors: `400` bad input · `401` missing/wrong token · `422` terminal position (mate,
stalemate, draw by rule) · `500` misconfigured or inference failure. A client should
treat any non-200 as "use another opponent", never retry in a loop.

## Strength

Maia's `selfElo` is the rating of the humans it imitates, not how strong it plays
when sampled. [`scripts/calibrate.ts`](./scripts/calibrate.ts) measures that: Maia
plays the same strength-limited Stockfish Chess Oracle uses as its opponent, and the
results become a curve `estimatedElo ⇄ {selfElo, temperature}` in
[`calibration/calibration.json`](./calibration/calibration.json). See
[`calibration/REPORT.md`](./calibration/REPORT.md) for the method and results.
[`src/strength.ts`](./src/strength.ts) interpolates and inverts the curve.

What the calibration found (1,000 games, Stockfish 18 lite-single anchors at
UCI_Elo 1320/1500/1800/2200/2600):

- At temperature 1 (sampling the raw policy, the most human setting) Maia's
  strength rises steadily up to selfElo ~1400 (estimated ≈ 1420), then flattens
  out: selfElo 2600 is only ≈ 1720 on this scale.
- Above that the path keeps selfElo at 2600 and lowers the temperature: T = 0.5 ≈
  2010, 0.25 ≈ 2070, 0 (argmax) ≈ 2230. So the served range is **400–2230**.
  Advanced (2000) plays at T ≈ 0.5; 2200 is nearly argmax.
- 2500+ is out of reach for the 5M model: even argmax scores 17% against UCI_Elo
  2600 (selfElo 3000 is no stronger than 2600).
- The bottom (selfElo 200–500) comes from the self-play ladder, below the
  lowest anchor, and selfElo 200 is probably below the ratings Maia was trained
  on, so treat the 400–700 band as approximate.

Reproduce (each batch appends to `calibration/raw/games.jsonl`; `fit` uses all of them):

```bash
npm run calibrate -- play --match m1400,sf1500,24 --match m500,m800,48 --workers 6
npm run calibrate -- fit
```

## Run and test

```bash
npm install
npm test                                 # encoding, policy probes, strength, HTTP contract
npm run typecheck
MAIA_SERVICE_TOKEN=dev npm run dev       # http://localhost:3100 (no Vercel link needed)
curl -s localhost:3100/api/health
curl -s -H 'Authorization: Bearer dev' -H 'content-type: application/json' \
  -d '{"fen":"rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1","strength":1300,"opponentElo":1300}' \
  localhost:3100/api/move
npm run calibrate -- --help              # strength calibration (slow; run in the background)
```

`scripts/dev-server.ts` routes requests to the same handlers Vercel runs. With
`HANDLERS=<bundle dir>` it serves a built bundle instead (`vercel build` output with
the `includeFiles` copied in), which is how the bundle was checked before deploying.

## Deploy (Vercel)

Plain Vercel Functions (no framework), Node 24, Fluid Compute. Set
`MAIA_SERVICE_TOKEN` (the same secret Chess Oracle sends). `vercel.json` adds the
model, the calibration table and onnxruntime's wasm to every function bundle via
`includeFiles` — file tracing does not find them, because they are read at runtime.
Callers should use the **production** URL: preview deployments sit behind Vercel's
Deployment Protection.

Implementation notes:
- `onnxruntime-web` resolves to its Node build (`ort.node.min.mjs`), which loads
  `ort-wasm-simd-threaded.{mjs,wasm}` (14 MB). One session per instance,
  single-threaded, graph optimisation `basic` (the export's `all`/`extended` fusions
  are broken on this graph's fp16 casts).
- Fluid Compute shares an instance between concurrent requests, and a wasm session
  must not run overlapping calls, so `session.run` is serialized by a promise queue
  (~40 ms per move warm; cold load ~5 s, which `GET /api/health` pre-pays).

## Provenance

| What | Where | Pin |
|---|---|---|
| Model (upstream) | [CSSLab/maia3](https://github.com/CSSLab/maia3), weights [UofTCSSLab/Maia3-5M](https://huggingface.co/UofTCSSLab/Maia3-5M) | code `1e13597c42d4858b7cfd7cfdae01e297263364b2`, weights `b6559de2398d7140b985f28fd2c19fb5e47ddabe` |
| ONNX export (third-party conversion) | [bqrio/maia3-onnx](https://huggingface.co/bqrio/maia3-onnx) | revision `923df9a2e9396b54a09b168bb858ebbd5e5b76bc` |
| File served | `models/maia3-5m.fp16.onnx` (10,755,531 bytes) | sha256 `ca22fc3031975932e693f9758149302efc177749165443ed52de828add8864fa` |

- The weights are the Maia-3 5M checkpoint by CSSLab (University of Toronto), from
  *Chessformer: A Unified Architecture for Chess Modeling* (Monroe, Eilender,
  Chalmers, Tang, Anderson — ICLR 2026). AGPL-3.0.
- `models/maia3-5m.fp16.onnx` is committed byte-for-byte as published by
  bqrio/maia3-onnx at the revision above: a **third-party** fp16 ONNX conversion of
  the upstream PyTorch checkpoint (fp16 weights, fp32 I/O, opset 17). It was not
  re-exported here. `GET /api/health` reports the sha256 of the file actually loaded.
- **Modification:** the wrapper code in this repository (`src/`, `api/`,
  `scripts/`) is the modification of the work — board encoding and the move
  vocabulary transcribed from upstream `maia3/utils.py` (`get_all_possible_moves`,
  `mirror_move`), `maia3/dataset.py` (`tokenize_board`, `get_legal_moves_mask`) and
  `maia3/models.py` (Elo handling), plus legal-move masking with chess.js,
  temperature sampling, the HTTP API and the strength calibration. The model weights
  are unmodified.
