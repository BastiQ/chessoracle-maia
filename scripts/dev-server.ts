// Local harness: serves the Vercel handlers over plain node:http, routed the way
// vercel.json routes them. `vercel dev` would need the directory linked to a
// Vercel project; this needs nothing.
//
//   MAIA_SERVICE_TOKEN=dev npm run dev            # http://localhost:3100
//   PORT=3200 HANDLERS=<dir with api/*.js> npm run dev   # serve a built bundle

import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Handler = (request: Request) => Response | Promise<Response>;

const port = Number(process.env.PORT ?? 3100);
const root = process.env.HANDLERS ? resolve(process.env.HANDLERS) : resolve(import.meta.dirname, "..");
const ext = process.env.HANDLERS ? ".js" : ".ts";
if (process.env.HANDLERS) process.chdir(root); // a Vercel function runs with cwd = its bundle root

const load = async (name: string) =>
  (await import(pathToFileURL(join(root, "api", name + ext)).href)) as Record<string, Handler>;
const routes: Record<string, Record<string, Handler>> = {
  "/": await load("index"),
  "/api": await load("index"),
  "/api/health": await load("health"),
  "/api/move": await load("move"),
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  const handler = routes[url.pathname]?.[req.method ?? "GET"];
  if (!handler) {
    res.writeHead(routes[url.pathname] ? 405 : 404).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const request = new Request(url, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
  const response = await handler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`maia service on http://localhost:${port} (handlers: ${root})`));
