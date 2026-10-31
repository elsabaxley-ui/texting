# 🔥 FireMesh — Proximity P2P & Multi-Hop Chat

A FireChat-inspired **Proximity & Multi-Hop Mesh Chat** web application that runs in any mobile or desktop browser.

## ✨ Features
- **Live Proximity Radar:** Visualizes nearby nodes in real time with exact distance (`meters`/`km`) and relative direction.
- **Distance-Filtered Channels:** Switch your radio reach between **50m (Room)**, **250m (Block)**, **1.5km (Neighborhood)**, or **Global**.
- **Multi-Hop Mesh Relay:** Packets include `TTL` (Time-To-Live) and hop path tracking. Intermediate nodes automatically relay packets to extend range across peers (`Direct P2P` vs `⚡ Relayed • 2 hops`).
- **3-Layer Hybrid Mesh Transport:**
  1. **Local Tabs (`BroadcastChannel`)** — Instant zero-latency discovery between tabs on the same computer.
  2. **Local Wi-Fi LAN (`server.js` SSE Relay)** — Works across phones and laptops on the same Wi-Fi network without internet.
  3. **Serverless Global P2P (`MQTT over WSS`)** — Works automatically when hosted on **GitHub Pages** so any two phones/computers can discover each other with zero backend setup.
- **Interactive Walk Simulator + Real GPS:** Test moving closer/farther in 15m steps or lock onto your device's real GPS coordinates.

## 🚀 Run Locally
```bash
node server.js
```
Then open `http://localhost:3000` in two browser tabs (or open the printed Wi-Fi URL on your phone!).

## 🌐 Deploy to GitHub Pages
1. Push this repository to GitHub (`https://github.com/elsabaxley-ui/texting.git`).
2. Go to **Settings → Pages** in your GitHub repository.
3. Under **Build and deployment**, select **Deploy from a branch** → `main` / `/ (root)` and click **Save**.
4. Your live proximity chat app will be online at `https://elsabaxley-ui.github.io/texting/`!
