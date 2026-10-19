/** Where the Corresponding Source of this service lives (AGPL-3.0 §13). */
export const SOURCE_URL = "https://github.com/BastiQ/chessoracle-maia";

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
