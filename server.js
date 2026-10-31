/**
 * FireMesh Local Wi-Fi & Development Server
 * Zero external dependencies — uses built-in Node.js http, fs, path, os.
 * Serves the static app AND provides a local Wi-Fi SSE relay (/api/stream, /api/publish)
 * so devices on the same Wi-Fi can communicate even without internet!
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = process.env.PORT || 3000;
const sseClients = new Set();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  // CORS headers for local testing
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. SSE Stream for Local Wi-Fi Mesh Relay
  if (req.method === "GET" && req.url === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    sseClients.add(res);

    req.on("close", () => {
      sseClients.delete(res);
    });
    return;
  }

  // 2. Publish Packet to Local Wi-Fi Mesh Relay
  if (req.method === "POST" && req.url === "/api/publish") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on("end", () => {
      for (const client of sseClients) {
        client.write(`data: ${body}\n\n`);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // 3. Static File Server
  let safeUrl = req.url.split("?")[0];
  if (safeUrl === "/") safeUrl = "/index.html";

  const filePath = path.join(__dirname, safeUrl);
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(content);
  });
});

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "localhost";
}

server.listen(PORT, "0.0.0.0", () => {
  const ip = getLocalIp();
  console.log(`\n🔥 FireMesh Proximity Chat Server running!`);
  console.log(`   ➜ Local Mac:   http://localhost:${PORT}`);
  console.log(`   ➜ Local Wi-Fi: http://${ip}:${PORT}  (Open on your phone!)`);
});
