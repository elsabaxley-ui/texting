/**
 * Closeby Local & Tunnel Relay Server
 * Zero external dependencies — uses built-in Node.js http, fs, path, os.
 * Supports both Server-Sent Events (/api/stream) AND fast JSON polling (/api/poll)
 * so phones over cellular, Wi-Fi, or HTTPS tunnels work 100% reliably.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = process.env.PORT || 3000;
const sseClients = new Set();
const recentPackets = []; // Rolling buffer of recent packets for instant phone sync
const nameRegistry = new Map(); // normalizedName -> identityTag
const MAX_BUFFER = 80;

function normalizeName(str) {
  return String(str || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // 1. SSE Stream for Real-Time Relay
  if (req.method === "GET" && parsedUrl.pathname === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");

    // Send recent packets so newly connected phones immediately see active users & messages
    const cutoff = Date.now() - 60000;
    for (const item of recentPackets) {
      if (item.serverTime >= cutoff) {
        res.write(`data: ${item.raw}\n\n`);
      }
    }

    sseClients.add(res);
    req.on("close", () => {
      sseClients.delete(res);
    });
    return;
  }

  // 2. JSON Polling Endpoint (100% reliable fallback for mobile cellular & tunnels)
  if (req.method === "GET" && parsedUrl.pathname === "/api/poll") {
    const since = Number(parsedUrl.searchParams.get("since") || 0);
    const items = recentPackets
      .filter((item) => item.serverTime > since)
      .map((item) => item.pkt);

    const names = {};
    for (const [normName, tag] of nameRegistry.entries()) {
      names[normName] = tag;
    }

    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ now: Date.now(), packets: items, names }));
    return;
  }

  // 3. Publish Packet or Claim Name
  if (req.method === "POST" && (parsedUrl.pathname === "/api/publish" || parsedUrl.pathname === "/api/claim")) {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on("end", () => {
      try {
        const pkt = JSON.parse(body);
        if (pkt.senderHandle && pkt.identityTag) {
          const norm = normalizeName(pkt.senderHandle);
          const existingTag = nameRegistry.get(norm);
          if (existingTag && existingTag !== pkt.identityTag) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ok: false,
                error: "NAME_TAKEN",
                message: `"${pkt.senderHandle}" is already PIN-locked by another user. Enter the matching 4-digit PIN if this is your name.`,
              })
            );
            return;
          }
          nameRegistry.set(norm, pkt.identityTag);
        }

        if (parsedUrl.pathname === "/api/claim") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        const now = Date.now();
        // Replace older ANNOUNCE from the same sender to keep buffer fresh
        if (pkt.type === "ANNOUNCE") {
          for (let i = recentPackets.length - 1; i >= 0; i--) {
            if (recentPackets[i].pkt.type === "ANNOUNCE" && recentPackets[i].pkt.senderId === pkt.senderId) {
              recentPackets.splice(i, 1);
            }
          }
        }
        recentPackets.push({ serverTime: now, raw: body, pkt });
        while (recentPackets.length > MAX_BUFFER) {
          recentPackets.shift();
        }
      } catch (e) {}

      for (const client of sseClients) {
        client.write(`data: ${body}\n\n`);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // 4. Static Files
  let safeUrl = parsedUrl.pathname;
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
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
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
  console.log(`\n💬 Closeby Server running!`);
  console.log(`   ➜ Local Mac:   http://localhost:${PORT}`);
  console.log(`   ➜ Local Wi-Fi: http://${ip}:${PORT}  (Open on your phone!)`);
});
