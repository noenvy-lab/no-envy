// A small static file server for local checks. Listens on 127.0.0.1 only.
// Usage: node tools/serve.mjs [port] [folder]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export function startServer(root, port = 0) {
  const base = resolve(root);
  const server = createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, "http://x").pathname);
      const file = normalize(join(base, path.endsWith("/") ? `${path}index.html` : path));
      if (file !== base && !file.startsWith(base + sep)) throw new Error("outside root");
      const body = await readFile(file);
      response.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
  return new Promise((done) => {
    server.listen(port, "127.0.0.1", () => done({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 5180);
  const root = process.argv[3] ?? join(fileURLToPath(new URL(".", import.meta.url)), "..", "site");
  const { url } = await startServer(root, port);
  console.log(`Serving ${root} at ${url}`);
}
