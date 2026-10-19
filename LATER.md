# Later ideas

Potential improvements that aren't part of the current service, roughly sorted by relevance (best first).

1. **A stronger Maia for a Full Strength tier.** The served 5M model tops out at about 2230 on the app's Stockfish scale ([calibration/REPORT.md](calibration/REPORT.md)). Playing its top move at selfElo 2600 scores only 17% against UCI_Elo 2600, and selfElo 3000 is no stronger. Reaching 2500–2600 would let Chess Oracle offer a human-like Full Strength opponent. The remaining lever is a larger checkpoint from the same pinned export ([bqrio/maia3-onnx](https://huggingface.co/bqrio/maia3-onnx) @ `923df9a2`): `maia3-23m.fp16.onnx` (45.8 MB) or `maia3-79m.fp16.onnx` (156 MB).

    **To measure first:**
    - **Strength.** Run `scripts/calibrate.ts` with the big model (selfElo 2600 at T = 0 and 0.25, against `sf2200` and `sf2600`, plus a few games against the 5M model so the ratings tie into the existing scale). Keep its games in a separate file, so `games.jsonl` stays the 5M data.
    - **Warm and cold latency** per move in single-threaded wasm (5M: ~40 ms warm, ~5 s cold).
    - **Bundle size** against Vercel's 250 MB limit (the 79M model plus the 14 MB ORT wasm fits, barely).

    Serve the larger model only for the top tier if it is much slower, and record its provenance (sha256, revision) the way the README does for the 5M model.
