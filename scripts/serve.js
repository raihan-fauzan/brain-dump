// Static file server for local use and LAN access from a tablet.
// Usage: node scripts/serve.js [port]
// Prints the LAN URL so the tablet can open the app over Wi-Fi.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
  ".zip": "application/zip",
};

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const full = join(ROOT, rel);
  if (!full.startsWith(ROOT + sep) && full !== ROOT) return null;
  return full;
}

const server = createServer(async (req, res) => {
  try {
    let path = safePath(req.url || "/");
    if (!path) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    let info = await stat(path).catch(() => null);
    if (info?.isDirectory()) {
      path = join(path, "index.html");
      info = await stat(path).catch(() => null);
    }
    if (!info) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }

    const body = await readFile(path);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(path)] || "application/octet-stream",
      "Cache-Control": "no-cache",
      // Service worker needs to control the whole scope.
      "Service-Worker-Allowed": "/",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end(`Server error: ${err.message}`);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  Brain Dump running\n`);
  console.log(`  Local:   http://localhost:${PORT}/`);
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === "IPv4" && !addr.internal) {
        console.log(`  Network: http://${addr.address}:${PORT}/   (${name})`);
      }
    }
  }
  console.log(`\n  Open the Network URL on your tablet (same Wi-Fi).\n`);
});
