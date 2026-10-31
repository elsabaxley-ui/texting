/**
 * FireMesh — Proximity P2P & Multi-Hop Chat Engine
 * Works across:
 *   1. Local Browser Tabs (BroadcastChannel API)
 *   2. Local Wi-Fi Relay (SSE / HTTP via server.js when running locally)
 *   3. Global Serverless Mesh (MQTT over WebSockets for GitHub Pages / cross-device)
 */

(function () {
  // --- 1. NODE IDENTITY & STATE ---
  const COLORS = ["#ff5722", "#00e676", "#00b0ff", "#ffd600", "#e040fb", "#ff1744"];
  const ANIMALS = ["Fox", "Hawk", "Wolf", "Lynx", "Viper", "Raven", "Falcon", "Panther", "Otter", "Cobra"];

  const savedId = sessionStorage.getItem("firemesh_node_id") || "node-" + Math.random().toString(36).substring(2, 9);
  sessionStorage.setItem("firemesh_node_id", savedId);

  const savedName =
    sessionStorage.getItem("firemesh_handle") ||
    ANIMALS[Math.floor(Math.random() * ANIMALS.length)] + "-" + Math.floor(100 + Math.random() * 900);
  const savedColor =
    sessionStorage.getItem("firemesh_color") || COLORS[Math.floor(Math.random() * COLORS.length)];

  // Slight random initial offset (~5m to 60m) per tab so multiple tabs appear as distinct dots on radar!
  const initialLatOffset = (Math.random() - 0.5) * 0.0006;
  const initialLngOffset = (Math.random() - 0.5) * 0.0006;

  const BASE_LAT = 40.7128;
  const BASE_LNG = -74.006;

  const state = {
    nodeId: savedId,
    handle: savedName,
    color: savedColor,
    lat: BASE_LAT + initialLatOffset,
    lng: BASE_LNG + initialLngOffset,
    usingRealGps: false,
    maxRangeMeters: 250, // default 250m Block
    enableMultiHop: true,
    activeTab: "nearby", // 'nearby' | 'direct' | 'meshlog'
    selectedDmPeer: "",
    unreadDmCount: 0,
    peers: new Map(), // nodeId -> { nodeId, handle, color, lat, lng, lastSeen, hops, via }
    seenPacketIds: new Set(),
    messages: [], // stored chat messages
    radarAngle: 0,
    radarPulses: [], // visual sonar rings
    transports: {
      broadcast: false,
      localServer: false,
      cloudMqtt: false,
    },
  };

  // --- 2. GEOHASH & HAVERSINE DISTANCE UTILITIES ---
  const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

  function encodeGeohash(lat, lng, precision = 7) {
    let idx = 0;
    let bit = 0;
    let evenBit = true;
    let geohash = "";
    let latMin = -90,
      latMax = 90;
    let lngMin = -180,
      lngMax = 180;

    while (geohash.length < precision) {
      if (evenBit) {
        const lngMid = (lngMin + lngMax) / 2;
        if (lng >= lngMid) {
          idx = idx * 2 + 1;
          lngMin = lngMid;
        } else {
          idx = idx * 2;
          lngMax = lngMid;
        }
      } else {
        const latMid = (latMin + latMax) / 2;
        if (lat >= latMid) {
          idx = idx * 2 + 1;
          latMin = latMid;
        } else {
          idx = idx * 2;
          latMax = latMid;
        }
      }
      evenBit = !evenBit;
      if (++bit === 5) {
        geohash += BASE32.charAt(idx);
        bit = 0;
        idx = 0;
      }
    }
    return geohash;
  }

  // Returns distance in meters between two Lat/Lng coordinates
  function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in meters
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  // Returns relative { dx, dy } in meters from (lat1, lon1) to (lat2, lon2)
  function getRelativeMeters(lat1, lon1, lat2, lon2) {
    const dy = (lat2 - lat1) * 111320; // North-South meters
    const dx = (lon2 - lon1) * 111320 * Math.cos((lat1 * Math.PI) / 180); // East-West meters
    return { dx, dy };
  }

  function formatDistance(meters) {
    if (meters < 1) return "<1m";
    if (meters < 1000) return `${Math.round(meters)}m`;
    return `${(meters / 1000).toFixed(2)}km`;
  }

  // --- 3. DOM ELEMENTS ---
  const dom = {
    transportLabel: document.getElementById("transportLabel"),
    geohashText: document.getElementById("geohashText"),
    myAvatarDot: document.getElementById("myAvatarDot"),
    myHandleDisplay: document.getElementById("myHandleDisplay"),
    editProfileBtn: document.getElementById("editProfileBtn"),
    peerCountBadge: document.getElementById("peerCountBadge"),
    radarCanvas: document.getElementById("radarCanvas"),
    radarScaleLabel: document.getElementById("radarScaleLabel"),
    rangeValueText: document.getElementById("rangeValueText"),
    rangeButtons: document.getElementById("rangeButtons"),
    meshHopCheckbox: document.getElementById("meshHopCheckbox"),
    useGpsBtn: document.getElementById("useGpsBtn"),
    resetPosBtn: document.getElementById("resetPosBtn"),
    coordsReadout: document.getElementById("coordsReadout"),
    sendPingBtn: document.getElementById("sendPingBtn"),
    peersList: document.getElementById("peersList"),
    tabNearbyBtn: document.getElementById("tabNearbyBtn"),
    tabDirectBtn: document.getElementById("tabDirectBtn"),
    tabMeshlogBtn: document.getElementById("tabMeshlogBtn"),
    nearbyRangeSub: document.getElementById("nearbyRangeSub"),
    dmUnreadBadge: document.getElementById("dmUnreadBadge"),
    dmSelectorBar: document.getElementById("dmSelectorBar"),
    dmPeerSelect: document.getElementById("dmPeerSelect"),
    messagesContainer: document.getElementById("messagesContainer"),
    meshLogContainer: document.getElementById("meshLogContainer"),
    meshLogList: document.getElementById("meshLogList"),
    clearLogBtn: document.getElementById("clearLogBtn"),
    messageForm: document.getElementById("messageForm"),
    messageInput: document.getElementById("messageInput"),
    shareLocationBtn: document.getElementById("shareLocationBtn"),
    profileModal: document.getElementById("profileModal"),
    handleInput: document.getElementById("handleInput"),
    colorSwatches: document.getElementById("colorSwatches"),
    closeModalBtn: document.getElementById("closeModalBtn"),
    saveProfileBtn: document.getElementById("saveProfileBtn"),
  };

  // --- 4. MULTI-TRANSPORT MESH LAYER ---
  let bcChannel = null;
  let mqttClient = null;
  const MQTT_TOPIC = "firemesh/v1/global-mesh-bus";

  function initTransports() {
    // Transport 1: BroadcastChannel (instant same-device browser tabs)
    if ("BroadcastChannel" in window) {
      bcChannel = new BroadcastChannel("firemesh_local_bus");
      bcChannel.onmessage = (ev) => {
        if (ev.data) onIncomingPacket(ev.data, "local-tab");
      };
      state.transports.broadcast = true;
    }

    // Transport 2: Local Node.js Server Relay (when running `node server.js` on local Wi-Fi)
    try {
      const evtSource = new EventSource("/api/stream");
      evtSource.onopen = () => {
        state.transports.localServer = true;
        updateTransportBadge();
      };
      evtSource.onmessage = (ev) => {
        try {
          const pkt = JSON.parse(ev.data);
          onIncomingPacket(pkt, "wifi-lan");
        } catch (err) {
          // ignore malformed
        }
      };
      evtSource.onerror = () => {
        state.transports.localServer = false;
        updateTransportBadge();
        evtSource.close();
      };
    } catch (e) {
      // Not running via local server.js (e.g., static GitHub Pages)
    }

    // Transport 3: Serverless Public MQTT over WSS (works on GitHub Pages across phones/laptops anywhere)
    if (window.mqtt) {
      try {
        mqttClient = window.mqtt.connect("wss://broker.emqx.io:8084/mqtt", {
          clientId: "firemesh_" + state.nodeId + "_" + Math.random().toString(16).slice(2, 6),
          clean: true,
          connectTimeout: 5000,
          reconnectPeriod: 4000,
        });

        mqttClient.on("connect", () => {
          state.transports.cloudMqtt = true;
          updateTransportBadge();
          mqttClient.subscribe(MQTT_TOPIC, { qos: 0 });
          broadcastAnnounce();
        });

        mqttClient.on("message", (topic, payload) => {
          if (topic === MQTT_TOPIC) {
            try {
              const pkt = JSON.parse(payload.toString());
              onIncomingPacket(pkt, "cloud-wss");
            } catch (e) {
              // ignore
            }
          }
        });

        mqttClient.on("close", () => {
          state.transports.cloudMqtt = false;
          updateTransportBadge();
        });
      } catch (e) {
        console.warn("MQTT connection error:", e);
      }
    }

    updateTransportBadge();
  }

  function updateTransportBadge() {
    const active = [];
    if (state.transports.broadcast) active.push("Tabs");
    if (state.transports.localServer) active.push("Wi-Fi LAN");
    if (state.transports.cloudMqtt) active.push("Global P2P");
    dom.transportLabel.textContent = active.length ? `Mesh: ${active.join(" + ")}` : "Offline Mesh";
  }

  function createPacket(type, payload, targetId = null, ttl = 3) {
    return {
      id: "pkt-" + Date.now() + "-" + Math.random().toString(36).substring(2, 8),
      type, // 'ANNOUNCE' | 'CHAT' | 'DM' | 'PING' | 'FLARE'
      senderId: state.nodeId,
      senderHandle: state.handle,
      senderColor: state.color,
      lat: state.lat,
      lng: state.lng,
      geohash: encodeGeohash(state.lat, state.lng, 7),
      maxRange: state.maxRangeMeters,
      targetId,
      ttl,
      hops: 1,
      path: [state.nodeId],
      payload,
      timestamp: Date.now(),
    };
  }

  function transmitPacket(pkt) {
    state.seenPacketIds.add(pkt.id);

    // 1. BroadcastChannel
    if (bcChannel) {
      try {
        bcChannel.postMessage(pkt);
      } catch (e) {}
    }

    // 2. Local Wi-Fi Server Relay
    if (state.transports.localServer) {
      fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pkt),
      }).catch(() => {});
    }

    // 3. Cloud MQTT WebSocket Mesh
    if (mqttClient && state.transports.cloudMqtt) {
      try {
        mqttClient.publish(MQTT_TOPIC, JSON.stringify(pkt));
      } catch (e) {}
    }
  }

  // --- 5. MESH ROUTING, PROXIMITY FILTERING & MULTI-HOP RELAY ---
  function onIncomingPacket(pkt, viaTransport) {
    if (!pkt || !pkt.id || pkt.senderId === state.nodeId) return;

    // Deduplicate packets already seen
    if (state.seenPacketIds.has(pkt.id)) return;
    state.seenPacketIds.add(pkt.id);

    // Keep Set bounded
    if (state.seenPacketIds.size > 2000) {
      const first = state.seenPacketIds.values().next().value;
      state.seenPacketIds.delete(first);
    }

    // Calculate physical distance from sender to us
    const distanceMeters = calculateDistanceMeters(state.lat, state.lng, pkt.lat, pkt.lng);

    // Update peer table
    const existingPeer = state.peers.get(pkt.senderId);
    state.peers.set(pkt.senderId, {
      nodeId: pkt.senderId,
      handle: pkt.senderHandle || "Unknown",
      color: pkt.senderColor || "#00e676",
      lat: pkt.lat,
      lng: pkt.lng,
      geohash: pkt.geohash,
      distance: distanceMeters,
      lastSeen: Date.now(),
      hops: pkt.hops || 1,
      via: viaTransport,
    });

    if (!existingPeer) {
      addSystemEvent(`📡 Discovered node ${pkt.senderHandle} (${formatDistance(distanceMeters)} away)`);
      // Reply with an immediate announce so they see us right away
      setTimeout(() => broadcastAnnounce(), 150);
    }

    renderPeersList();

    // Check if packet is within physical range OR relayed via multi-hop mesh
    const effectiveRange = Math.max(state.maxRangeMeters, pkt.maxRange || 250);
    const isWithinDirectRange = distanceMeters <= effectiveRange;
    const isRelayedPacket = (pkt.hops || 1) > 1;

    // Multi-Hop Relay Decision:
    // If multi-hop is enabled, TTL > 1, and we are within direct range of the sender,
    // we can rebroadcast the packet so nodes farther away can receive it!
    if (
      state.enableMultiHop &&
      pkt.type !== "ANNOUNCE" &&
      pkt.ttl > 1 &&
      isWithinDirectRange &&
      !pkt.path.includes(state.nodeId)
    ) {
      const relayedPkt = {
        ...pkt,
        ttl: pkt.ttl - 1,
        hops: (pkt.hops || 1) + 1,
        path: [...(pkt.path || []), state.nodeId],
      };
      // Slight jitter to prevent broadcast storms
      setTimeout(() => {
        transmitPacket(relayedPkt);
        logMeshPacket(
          `RELAYED [${pkt.type}] from ${pkt.senderHandle} (hop ${relayedPkt.hops}, TTL ${relayedPkt.ttl})`,
          "relayed"
        );
      }, 40 + Math.random() * 80);
    }

    // Should our node accept & display this packet?
    const canReceive = isWithinDirectRange || (state.enableMultiHop && isRelayedPacket);

    if (!canReceive && pkt.type !== "ANNOUNCE") {
      logMeshPacket(
        `DROPPED [${pkt.type}] from ${pkt.senderHandle} — Out of range (${formatDistance(
          distanceMeters
        )} > ${formatDistance(effectiveRange)})`,
        "dropped"
      );
      return;
    }

    if (pkt.type !== "ANNOUNCE") {
      logMeshPacket(
        `RX [${pkt.type}] from ${pkt.senderHandle} • dist=${formatDistance(distanceMeters)} • hops=${
          pkt.hops
        } • via=${viaTransport}`,
        "rx"
      );
    }

    // Handle Packet Types
    if (pkt.type === "CHAT" || pkt.type === "FLARE") {
      appendChatMessage({
        id: pkt.id,
        channel: "nearby",
        senderId: pkt.senderId,
        senderHandle: pkt.senderHandle,
        senderColor: pkt.senderColor,
        text: pkt.payload.text,
        isFlare: pkt.type === "FLARE",
        distance: distanceMeters,
        hops: pkt.hops || 1,
        timestamp: pkt.timestamp,
        mine: false,
      });
    } else if (pkt.type === "DM") {
      if (pkt.targetId === state.nodeId) {
        appendChatMessage({
          id: pkt.id,
          channel: "direct",
          peerId: pkt.senderId,
          senderId: pkt.senderId,
          senderHandle: pkt.senderHandle,
          senderColor: pkt.senderColor,
          text: pkt.payload.text,
          distance: distanceMeters,
          hops: pkt.hops || 1,
          timestamp: pkt.timestamp,
          mine: false,
        });
        if (state.activeTab !== "direct") {
          state.unreadDmCount++;
          updateUnreadBadge();
        }
      }
    } else if (pkt.type === "PING") {
      state.radarPulses.push({ r: 0, color: pkt.senderColor || "#00e676" });
      addSystemEvent(`📡 Radar ping received from ${pkt.senderHandle} (${formatDistance(distanceMeters)} away)`);
    }
  }

  // --- 6. HEARTBEAT & PEER CLEANUP ---
  function broadcastAnnounce() {
    const pkt = createPacket("ANNOUNCE", { status: "online" }, null, 1);
    transmitPacket(pkt);
  }

  function pruneStalePeers() {
    const now = Date.now();
    let changed = false;
    for (const [id, peer] of state.peers.entries()) {
      if (now - peer.lastSeen > 22000) {
        state.peers.delete(id);
        addSystemEvent(`🔌 Node ${peer.handle} left proximity range`);
        changed = true;
      } else {
        // Recalculate distance in case we moved
        peer.distance = calculateDistanceMeters(state.lat, state.lng, peer.lat, peer.lng);
      }
    }
    if (changed) renderPeersList();
  }

  // --- 7. UI RENDERING & ACTIONS ---
  function updateLocationUI() {
    const gh = encodeGeohash(state.lat, state.lng, 7);
    dom.geohashText.textContent = gh;
    dom.coordsReadout.textContent = `Lat: ${state.lat.toFixed(5)} • Lng: ${state.lng.toFixed(5)} (${
      state.usingRealGps ? "Real GPS" : "Simulated"
    })`;

    // Recompute distances to all peers
    for (const peer of state.peers.values()) {
      peer.distance = calculateDistanceMeters(state.lat, state.lng, peer.lat, peer.lng);
    }
    renderPeersList();
  }

  function renderPeersList() {
    const peersArr = Array.from(state.peers.values()).sort((a, b) => a.distance - b.distance);
    const inRangeCount = peersArr.filter((p) => p.distance <= state.maxRangeMeters).length;
    dom.peerCountBadge.textContent = `${inRangeCount} in range / ${peersArr.length} total`;

    // Update DM dropdown
    const currentDm = dom.dmPeerSelect.value || state.selectedDmPeer;
    dom.dmPeerSelect.innerHTML = `<option value="">Select a discovered node...</option>`;
    peersArr.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.nodeId;
      opt.textContent = `${p.handle} (${formatDistance(p.distance)} away)`;
      if (p.nodeId === currentDm) opt.selected = true;
      dom.dmPeerSelect.appendChild(opt);
    });

    if (peersArr.length === 0) {
      dom.peersList.innerHTML = `
        <div class="empty-peers">
          Waiting for nearby nodes...<br />
          <small>Open this URL in a second tab or phone to see live proximity radar!</small>
        </div>`;
      return;
    }

    dom.peersList.innerHTML = "";
    peersArr.forEach((p) => {
      const inRange = p.distance <= state.maxRangeMeters;
      const item = document.createElement("div");
      item.className = `peer-item ${inRange ? "" : "out-of-range"}`;
      item.innerHTML = `
        <div class="peer-left">
          <span class="peer-dot" style="background:${p.color}"></span>
          <div>
            <div class="peer-name">${escapeHtml(p.handle)}</div>
            <div class="peer-meta">#${p.geohash || "local"} • ${p.via}</div>
          </div>
        </div>
        <div class="peer-right">
          <span class="dist-tag ${inRange ? "" : "far"}">${formatDistance(p.distance)}</span>
          <button class="dm-btn" data-peer="${p.nodeId}">DM</button>
        </div>
      `;
      item.querySelector(".dm-btn").addEventListener("click", () => {
        state.selectedDmPeer = p.nodeId;
        dom.dmPeerSelect.value = p.nodeId;
        switchTab("direct");
      });
      dom.peersList.appendChild(item);
    });
  }

  function appendChatMessage(msg) {
    state.messages.push(msg);
    renderMessages();
  }

  function addSystemEvent(text) {
    state.messages.push({
      id: "sys-" + Date.now() + Math.random(),
      channel: "nearby",
      isSystem: true,
      text,
      timestamp: Date.now(),
    });
    renderMessages();
  }

  function renderMessages() {
    // Keep welcome banner at top
    const welcomeEl = dom.messagesContainer.querySelector(".system-welcome");
    dom.messagesContainer.innerHTML = "";
    if (welcomeEl && state.activeTab === "nearby") {
      dom.messagesContainer.appendChild(welcomeEl);
    }

    const filtered = state.messages.filter((m) => {
      if (state.activeTab === "nearby") return m.channel === "nearby";
      if (state.activeTab === "direct") {
        if (m.channel !== "direct") return false;
        if (!state.selectedDmPeer) return true;
        return m.peerId === state.selectedDmPeer;
      }
      return false;
    });

    filtered.forEach((m) => {
      if (m.isSystem) {
        const sys = document.createElement("div");
        sys.className = "system-event";
        sys.textContent = m.text;
        dom.messagesContainer.appendChild(sys);
        return;
      }

      const row = document.createElement("div");
      row.className = `msg-row ${m.mine ? "mine" : "theirs"}`;

      const timeStr = new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const distBadge = m.mine
        ? `<span class="dist-pill">You</span>`
        : `<span class="dist-pill">${formatDistance(m.distance || 0)} away</span>`;
      const hopBadge =
        (m.hops || 1) > 1
          ? `<span class="hop-pill relayed">⚡ Relayed (${m.hops} hops)</span>`
          : `<span class="hop-pill">Direct P2P</span>`;

      row.innerHTML = `
        <div class="msg-meta">
          <span class="msg-author" style="color:${m.senderColor}">${escapeHtml(m.senderHandle)}</span>
          ${distBadge}
          ${hopBadge}
          <span>${timeStr}</span>
        </div>
        <div class="msg-bubble ${m.isFlare ? "flare-bubble" : ""}">
          ${escapeHtml(m.text)}
        </div>
      `;
      dom.messagesContainer.appendChild(row);
    });

    dom.messagesContainer.scrollTop = dom.messagesContainer.scrollHeight;
  }

  function logMeshPacket(text, cls = "rx") {
    const div = document.createElement("div");
    div.className = `log-entry ${cls}`;
    const t = new Date().toLocaleTimeString();
    div.textContent = `[${t}] ${text}`;
    dom.meshLogList.prepend(div);
  }

  function updateUnreadBadge() {
    if (state.unreadDmCount > 0) {
      dom.dmUnreadBadge.textContent = state.unreadDmCount;
      dom.dmUnreadBadge.classList.remove("hidden");
    } else {
      dom.dmUnreadBadge.classList.add("hidden");
    }
  }

  function switchTab(tab) {
    state.activeTab = tab;
    dom.tabNearbyBtn.classList.toggle("active", tab === "nearby");
    dom.tabDirectBtn.classList.toggle("active", tab === "direct");
    dom.tabMeshlogBtn.classList.toggle("active", tab === "meshlog");

    dom.dmSelectorBar.classList.toggle("hidden", tab !== "direct");
    dom.meshLogContainer.classList.toggle("hidden", tab !== "meshlog");
    dom.messagesContainer.classList.toggle("hidden", tab === "meshlog");
    dom.messageForm.classList.toggle("hidden", tab === "meshlog");

    if (tab === "direct") {
      state.unreadDmCount = 0;
      updateUnreadBadge();
      dom.messageInput.placeholder = "Send hop-routed private message to selected peer...";
    } else if (tab === "nearby") {
      const label = state.maxRangeMeters > 100000 ? "Global" : formatDistance(state.maxRangeMeters);
      dom.messageInput.placeholder = `Broadcast to nearby nodes within ${label}...`;
    }

    renderMessages();
  }

  // --- 8. LIVE PROXIMITY RADAR CANVAS ---
  function drawRadar() {
    const ctx = dom.radarCanvas.getContext("2d");
    const w = dom.radarCanvas.width;
    const h = dom.radarCanvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.min(cx, cy) - 14;

    ctx.clearRect(0, 0, w, h);

    // Concentric range rings
    ctx.strokeStyle = "rgba(0, 230, 118, 0.18)";
    ctx.lineWidth = 1;
    [0.33, 0.66, 1.0].forEach((frac) => {
      ctx.beginPath();
      ctx.arc(cx, cy, maxR * frac, 0, Math.PI * 2);
      ctx.stroke();
    });

    // Crosshairs
    ctx.beginPath();
    ctx.moveTo(cx - maxR, cy);
    ctx.lineTo(cx + maxR, cy);
    ctx.moveTo(cx, cy - maxR);
    ctx.lineTo(cx, cy + maxR);
    ctx.stroke();

    // Rotating sweep beam
    state.radarAngle = (state.radarAngle + 0.025) % (Math.PI * 2);
    const grad = ctx.createConicGradient(state.radarAngle, cx, cy);
    grad.addColorStop(0, "rgba(0, 230, 118, 0.28)");
    grad.addColorStop(0.18, "rgba(0, 230, 118, 0.0)");
    grad.addColorStop(1, "rgba(0, 230, 118, 0.0)");

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
    ctx.fill();

    // Expanding sonar ping pulses
    for (let i = state.radarPulses.length - 1; i >= 0; i--) {
      const p = state.radarPulses[i];
      p.r += 2.2;
      if (p.r > maxR) {
        state.radarPulses.splice(i, 1);
        continue;
      }
      ctx.strokeStyle = p.color;
      ctx.globalAlpha = 1 - p.r / maxR;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, p.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1.0;
    }

    // Scale meters-to-pixels based on selected range (cap visual scale at 2000m for Global mode)
    const visualRangeMeters = state.maxRangeMeters > 50000 ? 500 : state.maxRangeMeters;

    // Draw discovered peers
    for (const peer of state.peers.values()) {
      const { dx, dy } = getRelativeMeters(state.lat, state.lng, peer.lat, peer.lng);
      const dist = Math.sqrt(dx * dx + dy * dy);
      const clampedRatio = Math.min(dist / visualRangeMeters, 1.08);
      const angle = Math.atan2(-dy, dx); // -dy because canvas Y grows downward

      const px = cx + Math.cos(angle) * (clampedRatio * maxR);
      const py = cy + Math.sin(angle) * (clampedRatio * maxR);

      // Connection line if within range
      if (dist <= state.maxRangeMeters) {
        ctx.strokeStyle = "rgba(0, 230, 118, 0.25)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(px, py);
        ctx.stroke();
      }

      // Peer glowing node
      ctx.fillStyle = peer.color || "#00e676";
      ctx.beginPath();
      ctx.arc(px, py, 5.5, 0, Math.PI * 2);
      ctx.fill();

      // Peer label
      ctx.fillStyle = "#e2e8f0";
      ctx.font = "10px -apple-system, sans-serif";
      ctx.fillText(`${peer.handle} (${formatDistance(dist)})`, px + 8, py + 3);
    }

    // Draw Self Node in center
    ctx.fillStyle = state.color;
    ctx.beginPath();
    ctx.arc(cx, cy, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();

    requestAnimationFrame(drawRadar);
  }

  // --- 9. EVENT LISTENERS ---
  function bindEvents() {
    // Send Chat Message
    dom.messageForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = dom.messageInput.value.trim();
      if (!text) return;

      if (state.activeTab === "direct") {
        const targetId = dom.dmPeerSelect.value || state.selectedDmPeer;
        if (!targetId) {
          alert("Please select a discovered peer from the dropdown first!");
          return;
        }
        state.selectedDmPeer = targetId;
        const pkt = createPacket("DM", { text }, targetId, 4);
        transmitPacket(pkt);
        logMeshPacket(`TX [DM] to ${targetId} (TTL=4)`, "rx");

        appendChatMessage({
          id: pkt.id,
          channel: "direct",
          peerId: targetId,
          senderId: state.nodeId,
          senderHandle: state.handle,
          senderColor: state.color,
          text,
          distance: 0,
          hops: 1,
          timestamp: pkt.timestamp,
          mine: true,
        });
      } else {
        const pkt = createPacket("CHAT", { text }, null, 3);
        transmitPacket(pkt);
        logMeshPacket(`TX [CHAT] broadcast (range ≤ ${formatDistance(state.maxRangeMeters)}, TTL=3)`, "rx");

        appendChatMessage({
          id: pkt.id,
          channel: "nearby",
          senderId: state.nodeId,
          senderHandle: state.handle,
          senderColor: state.color,
          text,
          distance: 0,
          hops: 1,
          timestamp: pkt.timestamp,
          mine: true,
        });
      }

      dom.messageInput.value = "";
    });

    // Location Flare button
    dom.shareLocationBtn.addEventListener("click", () => {
      const gh = encodeGeohash(state.lat, state.lng, 7);
      const text = `📍 Location Flare: Geohash #${gh} (${state.lat.toFixed(5)}, ${state.lng.toFixed(5)})`;
      const pkt = createPacket("FLARE", { text }, null, 3);
      transmitPacket(pkt);
      state.radarPulses.push({ r: 0, color: state.color });

      appendChatMessage({
        id: pkt.id,
        channel: "nearby",
        senderId: state.nodeId,
        senderHandle: state.handle,
        senderColor: state.color,
        text,
        isFlare: true,
        distance: 0,
        hops: 1,
        timestamp: pkt.timestamp,
        mine: true,
      });
    });

    // Radar Pulse Ping button
    dom.sendPingBtn.addEventListener("click", () => {
      state.radarPulses.push({ r: 0, color: state.color });
      const pkt = createPacket("PING", {}, null, 2);
      transmitPacket(pkt);
      logMeshPacket(`TX [PING] sonar pulse sent to nearby peers`, "rx");
    });

    // Range Selector buttons
    dom.rangeButtons.querySelectorAll(".range-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        dom.rangeButtons.querySelectorAll(".range-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const r = Number(btn.dataset.range);
        state.maxRangeMeters = r;

        const labels = {
          50: "50m (Room)",
          250: "250m (Block)",
          1500: "1.5km (Neighborhood)",
          99999999: "Global (All Nodes)",
        };
        dom.rangeValueText.textContent = labels[r] || `${r}m`;
        dom.radarScaleLabel.textContent = r > 50000 ? "Range: Global" : `Range: ${formatDistance(r)}`;
        dom.nearbyRangeSub.textContent = r > 50000 ? "(Global)" : `(≤ ${formatDistance(r)})`;
        if (state.activeTab === "nearby") {
          dom.messageInput.placeholder = `Broadcast to nearby nodes within ${
            r > 50000 ? "Global" : formatDistance(r)
          }...`;
        }
        renderPeersList();
      });
    });

    // Multi-hop toggle
    dom.meshHopCheckbox.addEventListener("change", (e) => {
      state.enableMultiHop = e.target.checked;
    });

    // Walk Simulator buttons (15m steps)
    const stepDeg = 15 / 111320; // ~15 meters in latitude degrees
    document.querySelectorAll(".walk-btn[data-dir]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.usingRealGps = false;
        const dir = btn.dataset.dir;
        if (dir.includes("N")) state.lat += stepDeg;
        if (dir.includes("S")) state.lat -= stepDeg;
        if (dir.includes("E")) state.lng += stepDeg / Math.cos((state.lat * Math.PI) / 180);
        if (dir.includes("W")) state.lng -= stepDeg / Math.cos((state.lat * Math.PI) / 180);
        updateLocationUI();
        broadcastAnnounce();
      });
    });

    dom.resetPosBtn.addEventListener("click", () => {
      state.usingRealGps = false;
      state.lat = BASE_LAT;
      state.lng = BASE_LNG;
      updateLocationUI();
      broadcastAnnounce();
    });

    // Real GPS button
    dom.useGpsBtn.addEventListener("click", () => {
      if (!navigator.geolocation) {
        alert("Geolocation is not supported by this browser.");
        return;
      }
      dom.useGpsBtn.textContent = "⏳ Locating...";
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          state.usingRealGps = true;
          state.lat = pos.coords.latitude;
          state.lng = pos.coords.longitude;
          dom.useGpsBtn.textContent = "✅ GPS Locked";
          updateLocationUI();
          broadcastAnnounce();
        },
        () => {
          dom.useGpsBtn.textContent = "📍 Real GPS";
          alert("Could not get GPS fix — using interactive Walk Simulator coordinates.");
        },
        { enableHighAccuracy: true, timeout: 8000 }
      );
    });

    // Channel tabs
    dom.tabNearbyBtn.addEventListener("click", () => switchTab("nearby"));
    dom.tabDirectBtn.addEventListener("click", () => switchTab("direct"));
    dom.tabMeshlogBtn.addEventListener("click", () => switchTab("meshlog"));

    dom.dmPeerSelect.addEventListener("change", (e) => {
      state.selectedDmPeer = e.target.value;
      renderMessages();
    });

    dom.clearLogBtn.addEventListener("click", () => {
      dom.meshLogList.innerHTML = "";
    });

    // Profile Identity Modal
    dom.editProfileBtn.addEventListener("click", () => {
      dom.handleInput.value = state.handle;
      dom.colorSwatches.querySelectorAll(".swatch").forEach((s) => {
        s.classList.toggle("selected", s.dataset.color === state.color);
      });
      dom.profileModal.classList.remove("hidden");
    });

    dom.colorSwatches.querySelectorAll(".swatch").forEach((s) => {
      s.addEventListener("click", () => {
        dom.colorSwatches.querySelectorAll(".swatch").forEach((b) => b.classList.remove("selected"));
        s.classList.add("selected");
      });
    });

    dom.closeModalBtn.addEventListener("click", () => {
      dom.profileModal.classList.add("hidden");
    });

    dom.saveProfileBtn.addEventListener("click", () => {
      const newHandle = dom.handleInput.value.trim();
      const selectedSwatch = dom.colorSwatches.querySelector(".swatch.selected");
      if (newHandle) {
        state.handle = newHandle;
        sessionStorage.setItem("firemesh_handle", newHandle);
      }
      if (selectedSwatch) {
        state.color = selectedSwatch.dataset.color;
        sessionStorage.setItem("firemesh_color", state.color);
      }
      syncIdentityUI();
      dom.profileModal.classList.add("hidden");
      broadcastAnnounce();
    });
  }

  function syncIdentityUI() {
    dom.myHandleDisplay.textContent = state.handle;
    dom.myAvatarDot.style.background = state.color;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // --- 10. BOOTSTRAP ---
  function init() {
    syncIdentityUI();
    updateLocationUI();
    bindEvents();
    initTransports();
    requestAnimationFrame(drawRadar);

    // Announce immediately and every 5 seconds
    setTimeout(broadcastAnnounce, 200);
    setInterval(broadcastAnnounce, 5000);
    setInterval(pruneStalePeers, 4000);
  }

  init();
})();
