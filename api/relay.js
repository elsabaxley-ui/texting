/**
 * Vercel Serverless Relay & Anti-Catfish Name Registry
 * Handles /api/poll, /api/publish, and /api/claim-name over standard HTTPS
 * so school Chromebooks work even behind strict WebSocket firewalls.
 */

const recentPackets = global.__closebyPackets || (global.__closebyPackets = []);
const nameRegistry = global.__closebyNames || (global.__closebyNames = new Map());
const MAX_BUFFER = 100;

function normalizeName(str) {
  return String(str || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

module.exports = function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const url = req.url || "";

  // 1. Poll recent packets & registered names
  if (req.method === "GET") {
    const since = Number((req.query && req.query.since) || 0);
    const packets = recentPackets
      .filter((item) => item.serverTime > since)
      .map((item) => item.pkt);

    const names = {};
    for (const [normName, tag] of nameRegistry.entries()) {
      names[normName] = tag;
    }

    return res.status(200).json({
      now: Date.now(),
      packets,
      names,
    });
  }

  // 2. Claim / Verify Name + PIN Tag or Publish Packet
  if (req.method === "POST") {
    const pkt = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

    // Check Anti-Catfish Name Registry
    if (pkt.senderHandle && pkt.identityTag) {
      const norm = normalizeName(pkt.senderHandle);
      const existingTag = nameRegistry.get(norm);
      if (existingTag && existingTag !== pkt.identityTag) {
        return res.status(409).json({
          ok: false,
          error: "NAME_TAKEN",
          message: `"${pkt.senderHandle}" is already PIN-locked by another user. Enter the matching 4-digit PIN if this is your name.`,
        });
      }
      nameRegistry.set(norm, pkt.identityTag);
    }

    if (url.includes("claim")) {
      return res.status(200).json({ ok: true });
    }

    const now = Date.now();
    if (pkt.type === "ANNOUNCE") {
      for (let i = recentPackets.length - 1; i >= 0; i--) {
        if (recentPackets[i].pkt.type === "ANNOUNCE" && recentPackets[i].pkt.senderId === pkt.senderId) {
          recentPackets.splice(i, 1);
        }
      }
    }

    recentPackets.push({ serverTime: now, pkt });
    while (recentPackets.length > MAX_BUFFER) {
      recentPackets.shift();
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
};
