/**
 * Closeby — Daylight Proximity & Multi-Hop Texting
 * Supports:
 *   - Real Names & Initials badges
 *   - Dedicated Messages view + separate Radar & Range view
 *   - 3-Layer Transport (Local Tabs, Local Wi-Fi LAN, Global Serverless WSS)
 */

(function () {
  const PALETTE = ["#E05A47", "#2E7D6B", "#3B6FD8", "#D9822B", "#8E55EA", "#C94A7C"];

  // Helper to extract 1-2 character initials from a name or initials string
  function getInitials(nameStr) {
    const cleaned = String(nameStr || "").trim();
    if (!cleaned) return "ME";
    const parts = cleaned.split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return cleaned.slice(0, 2).toUpperCase();
  }

  function safeGetStorage(key) {
    try {
      return localStorage.getItem(key) || "";
    } catch (e) {
      return "";
    }
  }

  function safeSetStorage(key, val) {
    try {
      localStorage.setItem(key, val);
    } catch (e) {}
  }

  // Ensure every browser tab/window has its own unique ID (even if tab is duplicated)
  let savedId = "";
  try {
    if (!window.name || !window.name.startsWith("closeby_peer_")) {
      window.name = "closeby_peer_" + Math.random().toString(36).substring(2, 9);
    }
    savedId = window.name;
  } catch (e) {
    savedId = "closeby_peer_" + Math.random().toString(36).substring(2, 9);
  }

  function normalizeName(str) {
    return String(str || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  // Deterministic 4-character cryptographic tag from (Normalized Name + 4-Digit Secret PIN)
  function computeIdentityTag(nameStr, pinStr) {
    const input = normalizeName(nameStr) + "::pin::" + String(pinStr || "").trim();
    let h1 = 0xdeadbeef ^ input.length;
    let h2 = 0x41c6ce57 ^ input.length;
    for (let i = 0; i < input.length; i++) {
      const ch = input.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    return ((h1 >>> 0) & 0xffff).toString(16).toUpperCase().padStart(4, "0");
  }

  // Compress & center-crop any uploaded image file to a fast 96x96 JPEG data URL (~2.5 KB)
  function resizeImageToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          const size = 96;
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext("2d");
          const minSide = Math.min(img.width, img.height);
          const sx = (img.width - minSide) / 2;
          const sy = (img.height - minSide) / 2;
          ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);
          resolve(canvas.toDataURL("image/jpeg", 0.78));
        };
        img.onerror = reject;
        img.src = ev.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  const savedHandle = safeGetStorage("closeby_locked_name");
  const savedTag = safeGetStorage("closeby_identity_tag");
  const savedAvatar = safeGetStorage("closeby_avatar_url");
  const savedColor =
    safeGetStorage("closeby_badge_color") || PALETTE[Math.floor(Math.random() * PALETTE.length)];

  const BASE_LAT = 40.7128;
  const BASE_LNG = -74.006;

  const knownNames = new Map(); // normalizedName -> identityTag
  if (savedHandle && savedTag) {
    knownNames.set(normalizeName(savedHandle), savedTag);
  }

  const state = {
    nodeId: savedId,
    handle: savedHandle || "Set Name",
    identityTag: savedTag || "",
    isVerified: Boolean(savedHandle && savedTag),
    avatar: savedAvatar || "",
    color: savedColor,
    lat: BASE_LAT,
    lng: BASE_LNG,
    usingRealGps: false,
    gpsAccuracyYards: null,
    maxRangeMeters: 250,
    enableMultiHop: true,
    activeMainView: "chat", // 'chat' | 'radar'
    activeThread: "nearby", // 'nearby' or peerId for 1-on-1 DM
    unreadByPeer: new Map(), // peerId -> count
    peers: new Map(), // nodeId -> { nodeId, handle, initials, color, avatar, lat, lng, distance, lastSeen, via, verified }
    seenPacketIds: new Set(),
    messages: [],
    radarAngle: 0,
    radarPulses: [],
    transports: {
      broadcast: false,
      localServer: false,
      cloudMqtt: false,
    },
  };

  // --- GEOHASH & DISTANCE ---
  const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

  function encodeGeohash(lat, lng, precision = 7) {
    let idx = 0,
      bit = 0,
      evenBit = true,
      geohash = "";
    let latMin = -90,
      latMax = 90,
      lngMin = -180,
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

  function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
    const R_YARDS = 6967410; // Earth radius in yards
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R_YARDS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function getRelativeMeters(lat1, lon1, lat2, lon2) {
    const dy = (lat2 - lat1) * 121741; // yards per degree latitude
    const dx = (lon2 - lon1) * 121741 * Math.cos((lat1 * Math.PI) / 180);
    return { dx, dy };
  }

  function formatDistance(yards) {
    if (yards < 1) return "<1 yd";
    if (yards < 1000) return `${Math.round(yards)} yd`;
    return `${(yards / 1760).toFixed(1)} mi`;
  }

  // --- DOM REFERENCES ---
  const dom = {
    transportLabel: document.getElementById("transportLabel"),
    navChatBtn: document.getElementById("navChatBtn"),
    navRadarBtn: document.getElementById("navRadarBtn"),
    peerCountBadge: document.getElementById("peerCountBadge"),
    navRangeBadge: document.getElementById("navRangeBadge"),
    editProfileBtn: document.getElementById("editProfileBtn"),
    myAvatarBadge: document.getElementById("myAvatarBadge"),
    myHandleDisplay: document.getElementById("myHandleDisplay"),
    chatView: document.getElementById("chatView"),
    radarView: document.getElementById("radarView"),
    channelNearbyBtn: document.getElementById("channelNearbyBtn"),
    sidebarRangeTag: document.getElementById("sidebarRangeTag"),
    dmUnreadBadge: document.getElementById("dmUnreadBadge"),
    peersList: document.getElementById("peersList"),
    activeThreadAvatar: document.getElementById("activeThreadAvatar"),
    activeThreadTitle: document.getElementById("activeThreadTitle"),
    activeThreadSubtitle: document.getElementById("activeThreadSubtitle"),
    quickRangeSwitcher: document.getElementById("quickRangeSwitcher"),
    messagesContainer: document.getElementById("messagesContainer"),
    messageForm: document.getElementById("messageForm"),
    messageInput: document.getElementById("messageInput"),
    shareLocationBtn: document.getElementById("shareLocationBtn"),
    radarCanvas: document.getElementById("radarCanvas"),
    radarScaleLabel: document.getElementById("radarScaleLabel"),
    rangeValueText: document.getElementById("rangeValueText"),
    rangeButtons: document.getElementById("rangeButtons"),
    meshHopCheckbox: document.getElementById("meshHopCheckbox"),
    sendPingBtn: document.getElementById("sendPingBtn"),
    useGpsBtn: document.getElementById("useGpsBtn"),
    resetPosBtn: document.getElementById("resetPosBtn"),
    coordsReadout: document.getElementById("coordsReadout"),
    geohashText: document.getElementById("geohashText"),
    meshLogList: document.getElementById("meshLogList"),
    clearLogBtn: document.getElementById("clearLogBtn"),
    profileModal: document.getElementById("profileModal"),
    modalAvatarPreview: document.getElementById("modalAvatarPreview"),
    avatarFileInput: document.getElementById("avatarFileInput"),
    removePhotoBtn: document.getElementById("removePhotoBtn"),
    authSignedOutSection: document.getElementById("authSignedOutSection"),
    authSignedInSection: document.getElementById("authSignedInSection"),
    handleInput: document.getElementById("handleInput"),
    pinInput: document.getElementById("pinInput"),
    claimColorSwatches: document.getElementById("claimColorSwatches"),
    claimIdentityBtn: document.getElementById("claimIdentityBtn"),
    authErrorBox: document.getElementById("authErrorBox"),
    verifiedNameHeading: document.getElementById("verifiedNameHeading"),
    verifiedTagSub: document.getElementById("verifiedTagSub"),
    colorSwatches: document.getElementById("colorSwatches"),
    saveProfileBtn: document.getElementById("saveProfileBtn"),
  };

  // --- TRANSPORTS ---
  let bcChannel = null;
  const mqttClients = [];
  let lastPollTimestamp = 0;
  const hasServerBackend =
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" ||
    location.hostname.startsWith("192.168.") ||
    location.hostname.endsWith(".lhr.life") ||
    location.hostname.endsWith(".vercel.app");
  const MQTT_TOPIC = "closeby/v2/global-mesh-bus";

  function initTransports() {
    if ("BroadcastChannel" in window) {
      try {
        bcChannel = new BroadcastChannel("firemesh_local_bus");
        bcChannel.onmessage = (ev) => {
          if (ev.data) onIncomingPacket(ev.data, "Local");
        };
        state.transports.broadcast = true;
      } catch (e) {}
    }

    if (hasServerBackend) {
      // 1. SSE Stream (for local server)
      if (!location.hostname.endsWith(".vercel.app")) {
        try {
          const evtSource = new EventSource("/api/stream");
          evtSource.onopen = () => {
            state.transports.localServer = true;
            updateTransportStatus();
          };
          evtSource.onmessage = (ev) => {
            try {
              onIncomingPacket(JSON.parse(ev.data), "Server");
            } catch (e) {}
          };
          evtSource.onerror = () => {
            evtSource.close();
          };
        } catch (e) {}
      }

      // 2. Reliable HTTPS JSON Polling (works on school Chromebooks, Vercel & mobile)
      const pollServer = () => {
        fetch(`/api/poll?since=${lastPollTimestamp}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (!data) return;
            state.transports.localServer = true;
            updateTransportStatus();
            if (data.names && typeof data.names === "object") {
              Object.entries(data.names).forEach(([norm, tag]) => {
                if (!knownNames.has(norm)) knownNames.set(norm, tag);
              });
            }
            if (Array.isArray(data.packets)) {
              if (data.now) lastPollTimestamp = data.now - 500;
              data.packets.forEach((pkt) => onIncomingPacket(pkt, "Online"));
            }
          })
          .catch(() => {});
      };
      pollServer();
      setInterval(pollServer, 1200);
    }

    // 3. Multi-Broker Serverless WebSocket Relay (Port 443 + 8084 + 8884)
    if (window.mqtt) {
      const BROKERS = [
        "wss://mqtt.eclipseprojects.io:443/mqtt",
        "wss://broker.emqx.io:8084/mqtt",
        "wss://broker.hivemq.com:8884/mqtt",
      ];

      BROKERS.forEach((brokerUrl) => {
        try {
          const client = window.mqtt.connect(brokerUrl, {
            clientId: "cb_" + state.nodeId + "_" + Math.random().toString(16).slice(2, 6),
            clean: true,
            connectTimeout: 5000,
            reconnectPeriod: 4000,
          });

          client.on("connect", () => {
            state.transports.cloudMqtt = true;
            updateTransportStatus();
            client.subscribe(MQTT_TOPIC, { qos: 0 });
            broadcastAnnounce();
          });

          client.on("message", (topic, payload) => {
            if (topic === MQTT_TOPIC) {
              try {
                onIncomingPacket(JSON.parse(payload.toString()), "Online");
              } catch (e) {}
            }
          });

          client.on("close", () => {
            state.transports.cloudMqtt = mqttClients.some((c) => c.connected);
            updateTransportStatus();
          });

          mqttClients.push(client);
        } catch (e) {}
      });
    }

    updateTransportStatus();
  }

  function updateTransportStatus() {
    if (state.transports.localServer && state.transports.cloudMqtt) {
      dom.transportLabel.textContent = "Live Connected";
    } else if (state.transports.localServer) {
      dom.transportLabel.textContent = "Live Connected";
    } else if (state.transports.cloudMqtt) {
      dom.transportLabel.textContent = "Live Online";
    } else {
      dom.transportLabel.textContent = "Ready";
    }
  }

  function createPacket(type, payload, targetId = null, ttl = 3) {
    return {
      id: "pkt-" + Date.now() + "-" + Math.random().toString(36).substring(2, 8),
      type,
      senderId: state.nodeId,
      senderHandle: state.handle,
      senderColor: state.color,
      senderAvatar: state.avatar || "",
      identityTag: state.identityTag,
      verified: state.isVerified,
      lat: state.lat,
      lng: state.lng,
      hasGps: state.usingRealGps,
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

    if (bcChannel) {
      try {
        bcChannel.postMessage(pkt);
      } catch (e) {}
    }

    if (hasServerBackend) {
      fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pkt),
      }).catch(() => {});
    }

    mqttClients.forEach((client) => {
      if (client && client.connected) {
        try {
          client.publish(MQTT_TOPIC, JSON.stringify(pkt));
        } catch (e) {}
      }
    });
  }

  function computePeerDistance(peerLat, peerLng, peerHasGps) {
    if (state.usingRealGps && peerHasGps) {
      return calculateDistanceMeters(state.lat, state.lng, peerLat, peerLng);
    }
    return 0;
  }

  // --- PACKET HANDLING & MULTI-HOP RELAY ---
  function onIncomingPacket(pkt, via) {
    if (!pkt || !pkt.id || pkt.senderId === state.nodeId) return;
    if (state.seenPacketIds.has(pkt.id)) return;
    state.seenPacketIds.add(pkt.id);

    if (state.seenPacketIds.size > 2000) {
      const oldest = state.seenPacketIds.values().next().value;
      state.seenPacketIds.delete(oldest);
    }

    // Anti-Catfish Check: Verify sender's PIN tag matches known name registry
    if (pkt.senderHandle && pkt.identityTag) {
      const norm = normalizeName(pkt.senderHandle);
      const knownTag = knownNames.get(norm);
      if (knownTag && knownTag !== pkt.identityTag) {
        logActivity(`Blocked impersonation attempt for "${pkt.senderHandle}"`, "dropped");
        return;
      }
      knownNames.set(norm, pkt.identityTag);
    }

    const distanceMeters = computePeerDistance(pkt.lat, pkt.lng, pkt.hasGps);
    const existing = state.peers.get(pkt.senderId);

    state.peers.set(pkt.senderId, {
      nodeId: pkt.senderId,
      handle: pkt.senderHandle || "Someone",
      initials: getInitials(pkt.senderHandle || "S"),
      color: pkt.senderColor || "#2E7D6B",
      avatar: pkt.senderAvatar || (existing && existing.avatar) || "",
      identityTag: pkt.identityTag || "",
      verified: Boolean(pkt.verified),
      lat: pkt.lat,
      lng: pkt.lng,
      hasGps: Boolean(pkt.hasGps),
      geohash: pkt.geohash,
      distance: distanceMeters,
      lastSeen: Date.now(),
      hops: pkt.hops || 1,
      via,
    });

    if (!existing) {
      addSystemNotice(`${pkt.senderHandle} is nearby (${formatDistance(distanceMeters)} away)`);
      setTimeout(broadcastAnnounce, 150);
    }

    renderSidebarPeople();

    const effectiveRange = Math.max(state.maxRangeMeters, pkt.maxRange || 250);
    const isWithinDirectRange = distanceMeters <= effectiveRange;
    const isRelayed = (pkt.hops || 1) > 1;

    // Relay packet if multi-hop is enabled
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
      setTimeout(() => {
        transmitPacket(relayedPkt);
        logActivity(`Relayed message from ${pkt.senderHandle} (hop ${relayedPkt.hops})`, "relayed");
      }, 45 + Math.random() * 60);
    }

    const canReceive = isWithinDirectRange || (state.enableMultiHop && isRelayed);
    if (!canReceive && pkt.type !== "ANNOUNCE") {
      logActivity(
        `Ignored message from ${pkt.senderHandle} — outside range (${formatDistance(distanceMeters)})`,
        "dropped"
      );
      return;
    }

    if (pkt.type === "CHAT" || pkt.type === "FLARE") {
      logActivity(`Received from ${pkt.senderHandle} (${formatDistance(distanceMeters)} away)`, "rx");
      appendMessage({
        id: pkt.id,
        thread: "nearby",
        senderId: pkt.senderId,
        senderHandle: pkt.senderHandle,
        senderColor: pkt.senderColor,
        senderAvatar: pkt.senderAvatar || (existing && existing.avatar) || "",
        verified: Boolean(pkt.verified),
        text: pkt.payload.text,
        isCheckin: pkt.type === "FLARE",
        distance: distanceMeters,
        hops: pkt.hops || 1,
        timestamp: pkt.timestamp,
        mine: false,
      });
    } else if (pkt.type === "DM" && pkt.targetId === state.nodeId) {
      logActivity(`Direct message from ${pkt.senderHandle}`, "rx");
      appendMessage({
        id: pkt.id,
        thread: pkt.senderId,
        senderId: pkt.senderId,
        senderHandle: pkt.senderHandle,
        senderColor: pkt.senderColor,
        senderAvatar: pkt.senderAvatar || (existing && existing.avatar) || "",
        verified: Boolean(pkt.verified),
        text: pkt.payload.text,
        distance: distanceMeters,
        hops: pkt.hops || 1,
        timestamp: pkt.timestamp,
        mine: false,
      });

      if (state.activeThread !== pkt.senderId) {
        const prev = state.unreadByPeer.get(pkt.senderId) || 0;
        state.unreadByPeer.set(pkt.senderId, prev + 1);
        renderSidebarPeople();
      }
    } else if (pkt.type === "PING") {
      state.radarPulses.push({ r: 0, color: pkt.senderColor || "#2E7D6B" });
      addSystemNotice(`📡 ${pkt.senderHandle} sent a proximity ping (${formatDistance(distanceMeters)} away)`);
    }
  }

  function broadcastAnnounce() {
    if (!state.isVerified) return;
    const pkt = createPacket("ANNOUNCE", { status: "online" }, null, 1);
    transmitPacket(pkt);
  }

  function pruneStalePeers() {
    const now = Date.now();
    let changed = false;
    for (const [id, peer] of state.peers.entries()) {
      if (now - peer.lastSeen > 22000) {
        state.peers.delete(id);
        changed = true;
      } else {
        peer.distance = computePeerDistance(peer.lat, peer.lng, peer.hasGps);
      }
    }
    if (changed) renderSidebarPeople();
  }

  // --- UI UPDATES ---
  function renderAvatarBox(el, avatarUrl, initials, color) {
    if (!el) return;
    if (avatarUrl && avatarUrl.startsWith("data:image/")) {
      el.innerHTML = `<img src="${avatarUrl}" class="avatar-img" alt="" />`;
      el.style.background = "transparent";
    } else {
      el.textContent = initials;
      el.style.background = color;
    }
  }

  function avatarInnerHtml(avatarUrl, initials) {
    if (avatarUrl && avatarUrl.startsWith("data:image/")) {
      return `<img src="${avatarUrl}" class="avatar-img" alt="" />`;
    }
    return escapeHtml(initials);
  }

  function syncIdentityUI() {
    const initials = getInitials(state.handle);
    renderAvatarBox(dom.myAvatarBadge, state.avatar, initials, state.color);
    dom.myHandleDisplay.textContent = state.handle;
    renderAvatarBox(dom.modalAvatarPreview, state.avatar, initials, state.color);
    if (dom.removePhotoBtn) {
      dom.removePhotoBtn.classList.toggle("hidden", !state.avatar);
    }
  }

  function updateLocationReadout() {
    const gh = encodeGeohash(state.lat, state.lng, 7);
    dom.geohashText.textContent = gh;
    if (state.usingRealGps) {
      const acc = state.gpsAccuracyYards ? ` • ±${Math.round(state.gpsAccuracyYards)} yd` : "";
      dom.coordsReadout.textContent = `Live GPS Active (${state.lat.toFixed(5)}, ${state.lng.toFixed(5)}${acc})`;
    } else {
      dom.coordsReadout.textContent = `Local Network (Allow Location for exact yard distance)`;
    }

    for (const peer of state.peers.values()) {
      peer.distance = computePeerDistance(peer.lat, peer.lng, peer.hasGps);
    }
    renderSidebarPeople();
  }

  function setRangeMeters(meters) {
    state.maxRangeMeters = meters;
    const shortLabel = meters > 50000 ? "All" : formatDistance(meters);
    const descriptive = {
      50: "50 yd (Room)",
      250: "250 yd (Block)",
      1760: "1 mi (Neighborhood)",
      99999999: "Global (Anywhere)",
    };

    dom.navRangeBadge.textContent = shortLabel;
    dom.sidebarRangeTag.textContent = meters > 50000 ? "Global" : `≤ ${shortLabel}`;
    dom.radarScaleLabel.textContent = meters > 50000 ? "Radius: Global" : `Radius: ${shortLabel}`;
    dom.rangeValueText.textContent = descriptive[meters] || shortLabel;

    // Sync both quick switcher and radar page buttons
    document.querySelectorAll("[data-range]").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.range) === meters);
    });

    updateThreadHeader();
    renderSidebarPeople();
  }

  function switchThread(threadId) {
    state.activeThread = threadId;
    dom.channelNearbyBtn.classList.toggle("active", threadId === "nearby");

    if (threadId !== "nearby") {
      state.unreadByPeer.delete(threadId);
    }

    updateThreadHeader();
    renderSidebarPeople();
    renderMessages();
  }

  function updateThreadHeader() {
    const shortRange = state.maxRangeMeters > 50000 ? "anywhere" : formatDistance(state.maxRangeMeters);

    if (state.activeThread === "nearby") {
      dom.activeThreadAvatar.textContent = "📍";
      dom.activeThreadAvatar.style.background = "var(--accent-soft)";
      dom.activeThreadAvatar.style.color = "var(--accent)";
      dom.activeThreadTitle.textContent = "Everyone Nearby";
      dom.activeThreadSubtitle.textContent = `People within ${shortRange} can see and relay these messages`;
      dom.quickRangeSwitcher.classList.remove("hidden");
      dom.messageInput.placeholder = `Message everyone within ${shortRange}...`;
    } else {
      const peer = state.peers.get(state.activeThread);
      const name = peer ? peer.handle : "Direct Chat";
      const initials = peer ? peer.initials : getInitials(name);
      const distStr = peer ? `${formatDistance(peer.distance)} away` : "Nearby";

      renderAvatarBox(
        dom.activeThreadAvatar,
        peer ? peer.avatar : "",
        initials,
        peer ? peer.color : "var(--sage)"
      );
      dom.activeThreadAvatar.style.color = "#fff";
      dom.activeThreadTitle.textContent = name;
      dom.activeThreadSubtitle.textContent = `Direct message • ${distStr}`;
      dom.quickRangeSwitcher.classList.add("hidden");
      dom.messageInput.placeholder = `Message ${name} directly...`;
    }
  }

  function renderSidebarPeople() {
    const peersArr = Array.from(state.peers.values()).sort((a, b) => a.distance - b.distance);
    const inRangeCount = peersArr.filter((p) => p.distance <= state.maxRangeMeters).length;
    dom.peerCountBadge.textContent = `${inRangeCount} nearby`;

    // Total unread DMs
    let totalUnread = 0;
    for (const c of state.unreadByPeer.values()) totalUnread += c;
    if (totalUnread > 0) {
      dom.dmUnreadBadge.textContent = `${totalUnread} new`;
      dom.dmUnreadBadge.classList.remove("hidden");
    } else {
      dom.dmUnreadBadge.classList.add("hidden");
    }

    if (peersArr.length === 0) {
      dom.peersList.innerHTML = `
        <div class="empty-people">
          No one else is in range yet.<br />
          <span>Open a second tab or connect with your phone to test live proximity chat.</span>
        </div>`;
      return;
    }

    dom.peersList.innerHTML = "";
    peersArr.forEach((p) => {
      const inRange = p.distance <= state.maxRangeMeters;
      const unread = state.unreadByPeer.get(p.nodeId) || 0;
      const btn = document.createElement("button");
      btn.className = `convo-item ${state.activeThread === p.nodeId ? "active" : ""}`;
      const vBadge = p.verified ? `<span class="verified-check" title="PIN-Protected Identity">✓</span>` : "";
      btn.innerHTML = `
        <div class="convo-avatar" style="background:${p.color}">${avatarInnerHtml(p.avatar, p.initials)}</div>
        <div class="convo-info">
          <div class="convo-top">
            <span class="convo-name">${escapeHtml(p.handle)}${vBadge}</span>
            <span class="dist-chip ${inRange ? "" : "outside"}">${formatDistance(p.distance)}</span>
          </div>
          <div class="convo-preview">
            ${unread > 0 ? `<strong>${unread} new message${unread > 1 ? "s" : ""}</strong>` : "Tap to message directly"}
          </div>
        </div>
      `;
      btn.addEventListener("click", () => switchThread(p.nodeId));
      dom.peersList.appendChild(btn);
    });
  }

  function appendMessage(msg) {
    state.messages.push(msg);
    renderMessages();
  }

  function addSystemNotice(text) {
    state.messages.push({
      id: "sys-" + Date.now() + Math.random(),
      thread: "nearby",
      isSystem: true,
      text,
      timestamp: Date.now(),
    });
    renderMessages();
  }

  function renderMessages() {
    dom.messagesContainer.innerHTML = `
      <div class="day-divider">
        <span>${state.activeThread === "nearby" ? "Today • Local Proximity Broadcast" : "Direct Conversation"}</span>
      </div>
    `;

    const visible = state.messages.filter((m) => m.thread === state.activeThread);

    visible.forEach((m) => {
      if (m.isSystem) {
        const notice = document.createElement("div");
        notice.className = "system-notice";
        notice.textContent = m.text;
        dom.messagesContainer.appendChild(notice);
        return;
      }

      const group = document.createElement("div");
      group.className = `msg-group ${m.mine ? "mine" : "theirs"}`;

      const initials = getInitials(m.senderHandle);
      const peerObj = state.peers.get(m.senderId);
      const avatarSrc = m.mine ? state.avatar : m.senderAvatar || (peerObj && peerObj.avatar) || "";
      const timeStr = new Date(m.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const distBadge = m.mine ? "" : `<span class="meta-pill">${formatDistance(m.distance || 0)}</span>`;
      const hopBadge =
        (m.hops || 1) > 1 ? `<span class="meta-pill hop">${m.hops} hops</span>` : "";

      const vCheck =
        m.verified || (m.mine && state.isVerified)
          ? `<span class="verified-check" title="PIN-Protected Identity">✓</span>`
          : "";

      group.innerHTML = `
        <div class="msg-avatar" style="background:${m.senderColor}">${avatarInnerHtml(avatarSrc, initials)}</div>
        <div class="msg-content">
          <div class="msg-header-meta">
            <span class="msg-sender-name">${escapeHtml(m.mine ? "You" : m.senderHandle)}${vCheck}</span>
            ${distBadge}
            ${hopBadge}
            <span>${timeStr}</span>
          </div>
          <div class="bubble ${m.isCheckin ? "checkin-bubble" : ""}">
            ${escapeHtml(m.text)}
          </div>
        </div>
      `;
      dom.messagesContainer.appendChild(group);
    });

    dom.messagesContainer.scrollTop = dom.messagesContainer.scrollHeight;
  }

  function logActivity(text, type = "rx") {
    const placeholder = dom.meshLogList.querySelector(".log-placeholder");
    if (placeholder) placeholder.remove();

    const item = document.createElement("div");
    item.className = `log-item ${type}`;
    const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    item.textContent = `${t} — ${text}`;
    dom.meshLogList.prepend(item);
  }

  // --- DAYLIGHT RADAR CANVAS (ON TAB 2) ---
  function drawRadar() {
    const ctx = dom.radarCanvas.getContext("2d");
    const w = dom.radarCanvas.width;
    const h = dom.radarCanvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.min(cx, cy) - 22;

    ctx.clearRect(0, 0, w, h);

    // Subtle warm sage rings
    ctx.strokeStyle = "rgba(46, 125, 107, 0.16)";
    ctx.lineWidth = 1.2;
    [0.33, 0.66, 1.0].forEach((f) => {
      ctx.beginPath();
      ctx.arc(cx, cy, maxR * f, 0, Math.PI * 2);
      ctx.stroke();
    });

    // Crosshair lines
    ctx.strokeStyle = "rgba(46, 125, 107, 0.1)";
    ctx.beginPath();
    ctx.moveTo(cx - maxR, cy);
    ctx.lineTo(cx + maxR, cy);
    ctx.moveTo(cx, cy - maxR);
    ctx.lineTo(cx, cy + maxR);
    ctx.stroke();

    // Gentle rotating sweep
    state.radarAngle = (state.radarAngle + 0.018) % (Math.PI * 2);
    const grad = ctx.createConicGradient(state.radarAngle, cx, cy);
    grad.addColorStop(0, "rgba(46, 125, 107, 0.15)");
    grad.addColorStop(0.2, "rgba(46, 125, 107, 0.0)");
    grad.addColorStop(1, "rgba(46, 125, 107, 0.0)");

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
    ctx.fill();

    // Expanding ping rings
    for (let i = state.radarPulses.length - 1; i >= 0; i--) {
      const p = state.radarPulses[i];
      p.r += 2;
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
      ctx.globalAlpha = 1;
    }

    const visualRangeMeters = state.maxRangeMeters > 50000 ? 500 : state.maxRangeMeters;

    // Draw discovered people with their Initials
    let peerIdx = 0;
    for (const peer of state.peers.values()) {
      peerIdx++;
      const dist = computePeerDistance(peer.lat, peer.lng, peer.hasGps);
      let angle = 0;
      let ratio = 0.22;

      if (state.usingRealGps && peer.hasGps && dist >= 1) {
        const { dx, dy } = getRelativeMeters(state.lat, state.lng, peer.lat, peer.lng);
        ratio = Math.max(0.18, Math.min(dist / visualRangeMeters, 1.05));
        angle = Math.atan2(-dy, dx);
      } else {
        // Same spot (<1 yd): space peers neatly around inner ring so badges don't overlap center
        angle = (peerIdx * 2.1) % (Math.PI * 2);
      }

      const px = cx + Math.cos(angle) * (ratio * maxR);
      const py = cy + Math.sin(angle) * (ratio * maxR);

      if (dist <= state.maxRangeMeters) {
        ctx.strokeStyle = "rgba(46, 125, 107, 0.25)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(px, py);
        ctx.stroke();
      }

      // Peer circle with initials
      ctx.fillStyle = peer.color;
      ctx.beginPath();
      ctx.arc(px, py, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#FFFFFF";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = "#FFFFFF";
      ctx.font = "bold 10px Plus Jakarta Sans, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(peer.initials, px, py);

      // Name & distance label underneath
      ctx.fillStyle = "#1E201D";
      ctx.font = "600 11px Plus Jakarta Sans, sans-serif";
      ctx.fillText(`${peer.handle} (${formatDistance(dist)})`, px, py + 22);
    }

    // Center node (You)
    ctx.fillStyle = state.color;
    ctx.beginPath();
    ctx.arc(cx, cy, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#FFFFFF";
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.fillStyle = "#FFFFFF";
    ctx.font = "bold 10.5px Plus Jakarta Sans, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(getInitials(state.handle), cx, cy);

    requestAnimationFrame(drawRadar);
  }

  // --- EVENTS ---
  function bindEvents() {
    // Top Main Navigation Switcher (Messages vs Radar & Range)
    dom.navChatBtn.addEventListener("click", () => {
      state.activeMainView = "chat";
      dom.navChatBtn.classList.add("active");
      dom.navRadarBtn.classList.remove("active");
      dom.chatView.classList.remove("hidden");
      dom.radarView.classList.add("hidden");
    });

    dom.navRadarBtn.addEventListener("click", () => {
      state.activeMainView = "radar";
      dom.navRadarBtn.classList.add("active");
      dom.navChatBtn.classList.remove("active");
      dom.radarView.classList.remove("hidden");
      dom.chatView.classList.add("hidden");
    });

    // Select "Everyone Nearby" broadcast channel
    dom.channelNearbyBtn.addEventListener("click", () => switchThread("nearby"));

    // Send Message
    dom.messageForm.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!state.isVerified) {
        openProfileModal();
        return;
      }
      const text = dom.messageInput.value.trim();
      if (!text) return;

      if (state.activeThread === "nearby") {
        const pkt = createPacket("CHAT", { text }, null, 3);
        transmitPacket(pkt);
        appendMessage({
          id: pkt.id,
          thread: "nearby",
          senderId: state.nodeId,
          senderHandle: state.handle,
          senderColor: state.color,
          senderAvatar: state.avatar,
          verified: true,
          text,
          distance: 0,
          hops: 1,
          timestamp: pkt.timestamp,
          mine: true,
        });
      } else {
        const targetId = state.activeThread;
        const pkt = createPacket("DM", { text }, targetId, 4);
        transmitPacket(pkt);
        appendMessage({
          id: pkt.id,
          thread: targetId,
          senderId: state.nodeId,
          senderHandle: state.handle,
          senderColor: state.color,
          senderAvatar: state.avatar,
          verified: true,
          text,
          distance: 0,
          hops: 1,
          timestamp: pkt.timestamp,
          mine: true,
        });
      }

      dom.messageInput.value = "";
    });

    // Check-in button
    dom.shareLocationBtn.addEventListener("click", () => {
      if (!state.isVerified) {
        openProfileModal();
        return;
      }
      const gh = encodeGeohash(state.lat, state.lng, 7);
      const text = `📍 Checked in near zone #${gh}`;
      const pkt = createPacket("FLARE", { text }, null, 3);
      transmitPacket(pkt);
      appendMessage({
        id: pkt.id,
        thread: "nearby",
        senderId: state.nodeId,
        senderHandle: state.handle,
        senderColor: state.color,
        senderAvatar: state.avatar,
        verified: true,
        text,
        isCheckin: true,
        distance: 0,
        hops: 1,
        timestamp: pkt.timestamp,
        mine: true,
      });
      if (state.activeThread !== "nearby") switchThread("nearby");
    });

    // Range buttons (both in chat header and radar tab)
    document.querySelectorAll("[data-range]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setRangeMeters(Number(btn.dataset.range));
      });
    });

    dom.meshHopCheckbox.addEventListener("change", (e) => {
      state.enableMultiHop = e.target.checked;
    });

    dom.sendPingBtn.addEventListener("click", () => {
      if (!state.isVerified) {
        openProfileModal();
        return;
      }
      state.radarPulses.push({ r: 0, color: state.color });
      const pkt = createPacket("PING", {}, null, 2);
      transmitPacket(pkt);
      logActivity("Sent proximity ping to nearby devices", "rx");
    });

    dom.useGpsBtn.addEventListener("click", () => {
      startLiveGps(true);
    });

    dom.clearLogBtn.addEventListener("click", () => {
      dom.meshLogList.innerHTML = `<div class="log-placeholder">Activity cleared.</div>`;
    });

    // PIN-Protected Real Name & Locked Identity Modal
    function openProfileModal() {
      dom.authErrorBox.classList.add("hidden");
      if (state.isVerified) {
        dom.authSignedOutSection.classList.add("hidden");
        dom.authSignedInSection.classList.remove("hidden");
        dom.verifiedNameHeading.textContent = state.handle;
        dom.verifiedTagSub.textContent = `Verified PIN Tag #${state.identityTag}`;
        renderAvatarBox(dom.modalAvatarPreview, state.avatar, getInitials(state.handle), state.color);
        dom.colorSwatches.querySelectorAll(".color-dot").forEach((dot) => {
          dot.classList.toggle("selected", dot.dataset.color === state.color);
        });
      } else {
        dom.authSignedOutSection.classList.remove("hidden");
        dom.authSignedInSection.classList.add("hidden");
        renderAvatarBox(
          dom.modalAvatarPreview,
          state.avatar,
          getInitials(dom.handleInput.value || "ME"),
          state.color
        );
        dom.claimColorSwatches.querySelectorAll(".color-dot").forEach((dot) => {
          dot.classList.toggle("selected", dot.dataset.color === state.color);
        });
        setTimeout(() => dom.handleInput.focus(), 50);
      }
      if (dom.removePhotoBtn) {
        dom.removePhotoBtn.classList.toggle("hidden", !state.avatar);
      }
      dom.profileModal.classList.remove("hidden");
    }

    dom.editProfileBtn.addEventListener("click", openProfileModal);

    // Profile Photo Upload & Removal
    if (dom.avatarFileInput) {
      dom.avatarFileInput.addEventListener("change", async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          const dataUrl = await resizeImageToDataUrl(file);
          state.avatar = dataUrl;
          safeSetStorage("closeby_avatar_url", dataUrl);
          syncIdentityUI();
          renderMessages();
          broadcastAnnounce();
        } catch (err) {
          alert("Could not load that image file. Please try another photo.");
        }
        dom.avatarFileInput.value = "";
      });
    }

    if (dom.removePhotoBtn) {
      dom.removePhotoBtn.addEventListener("click", () => {
        state.avatar = "";
        safeSetStorage("closeby_avatar_url", "");
        syncIdentityUI();
        renderMessages();
        broadcastAnnounce();
      });
    }

    dom.handleInput.addEventListener("input", () => {
      if (!state.avatar) {
        dom.modalAvatarPreview.textContent = getInitials(dom.handleInput.value || "ME");
      }
    });

    dom.claimColorSwatches.querySelectorAll(".color-dot").forEach((dot) => {
      dot.addEventListener("click", () => {
        dom.claimColorSwatches.querySelectorAll(".color-dot").forEach((d) => d.classList.remove("selected"));
        dot.classList.add("selected");
        state.color = dot.dataset.color;
        if (!state.avatar) {
          dom.modalAvatarPreview.style.background = state.color;
        }
      });
    });

    dom.colorSwatches.querySelectorAll(".color-dot").forEach((dot) => {
      dot.addEventListener("click", () => {
        dom.colorSwatches.querySelectorAll(".color-dot").forEach((d) => d.classList.remove("selected"));
        dot.classList.add("selected");
        if (!state.avatar) {
          dom.modalAvatarPreview.style.background = dot.dataset.color;
        }
      });
    });

    dom.claimIdentityBtn.addEventListener("click", async () => {
      dom.authErrorBox.classList.add("hidden");
      const rawName = dom.handleInput.value.trim();
      const rawPin = dom.pinInput.value.trim();

      if (rawName.length < 2) {
        dom.authErrorBox.textContent = "Please enter your real name (at least 2 letters).";
        dom.authErrorBox.classList.remove("hidden");
        return;
      }

      if (!/^\d{4}$/.test(rawPin)) {
        dom.authErrorBox.textContent = "Please enter a 4-digit numeric PIN (e.g. 1234) to protect your name.";
        dom.authErrorBox.classList.remove("hidden");
        return;
      }

      const norm = normalizeName(rawName);
      const tag = computeIdentityTag(rawName, rawPin);

      // 1. Check local knownNames registry from peers & server
      const existingTag = knownNames.get(norm);
      if (existingTag && existingTag !== tag) {
        dom.authErrorBox.textContent = `"${rawName}" is already claimed and PIN-locked! Enter the matching 4-digit PIN if this is your account, or use your own real name.`;
        dom.authErrorBox.classList.remove("hidden");
        return;
      }

      // 2. Check server / Vercel name registry if available
      if (hasServerBackend) {
        try {
          const resp = await fetch("/api/claim", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ senderHandle: rawName, identityTag: tag }),
          });
          if (resp.status === 409) {
            const errData = await resp.json();
            dom.authErrorBox.textContent =
              errData.message || `"${rawName}" is already PIN-locked by another user.`;
            dom.authErrorBox.classList.remove("hidden");
            return;
          }
        } catch (e) {}
      }

      // Lock identity permanently on this device
      const chosenDot = dom.claimColorSwatches.querySelector(".color-dot.selected");
      if (chosenDot) {
        state.color = chosenDot.dataset.color;
        safeSetStorage("closeby_badge_color", state.color);
      }

      state.handle = rawName;
      state.identityTag = tag;
      state.isVerified = true;
      knownNames.set(norm, tag);

      safeSetStorage("closeby_locked_name", rawName);
      safeSetStorage("closeby_identity_tag", tag);

      syncIdentityUI();
      dom.profileModal.classList.add("hidden");
      broadcastAnnounce();
    });

    dom.saveProfileBtn.addEventListener("click", () => {
      const chosenDot = dom.colorSwatches.querySelector(".color-dot.selected");
      if (chosenDot) {
        state.color = chosenDot.dataset.color;
        safeSetStorage("closeby_badge_color", state.color);
      }
      syncIdentityUI();
      dom.profileModal.classList.add("hidden");
      broadcastAnnounce();
    });

    // Prompt to claim & lock real name on first visit
    if (!state.isVerified) {
      openProfileModal();
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  let gpsWatchId = null;

  function startLiveGps(showAlertOnError = false) {
    if (!navigator.geolocation) {
      if (showAlertOnError) alert("Geolocation is not supported by your browser.");
      return;
    }

    if (dom.useGpsBtn) dom.useGpsBtn.textContent = "Locating...";

    const onGpsSuccess = (pos) => {
      state.usingRealGps = true;
      state.lat = pos.coords.latitude;
      state.lng = pos.coords.longitude;
      state.gpsAccuracyYards = (pos.coords.accuracy || 10) * 1.09361; // meters to yards
      if (dom.useGpsBtn) dom.useGpsBtn.textContent = "📍 Live GPS On";
      updateLocationReadout();
      broadcastAnnounce();
    };

    const onGpsError = () => {
      if (dom.useGpsBtn) dom.useGpsBtn.textContent = "📍 Enable GPS";
      if (showAlertOnError) {
        alert("Please allow Location access in your browser settings for exact yard distance.");
      }
    };

    navigator.geolocation.getCurrentPosition(onGpsSuccess, onGpsError, {
      enableHighAccuracy: true,
      timeout: 8000,
      maximumAge: 10000,
    });

    if (gpsWatchId === null) {
      gpsWatchId = navigator.geolocation.watchPosition(onGpsSuccess, () => {}, {
        enableHighAccuracy: true,
        maximumAge: 5000,
      });
    }
  }

  function init() {
    syncIdentityUI();
    updateLocationReadout();
    updateThreadHeader();
    renderMessages();
    bindEvents();
    initTransports();
    startLiveGps(false);
    requestAnimationFrame(drawRadar);

    setTimeout(broadcastAnnounce, 200);
    setInterval(broadcastAnnounce, 5000);
    setInterval(pruneStalePeers, 4000);
  }

  init();
})();
