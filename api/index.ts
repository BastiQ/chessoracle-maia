// GET / — the AGPL-3.0 notice and where to get the source (§13).

import { SOURCE_URL } from "../src/source.js";

const NOTICE = `chessoracle-maia — Maia-3 human-like chess move service for Chess Oracle.

This service is free software, licensed under the GNU Affero General Public
License v3.0 (AGPL-3.0). It serves the Maia-3 model (CSSLab, University of
Toronto; AGPL-3.0) through a small wrapper.

Corresponding Source (wrapper code, model weights and their provenance):
${SOURCE_URL}

API: POST /api/move (bearer token) · GET /api/health
`;

export function GET(): Response {
  return new Response(NOTICE, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
