const camera = document.getElementById("camera");
const sceneCanvas = document.getElementById("scene");
const startBtn = document.getElementById("startBtn");
const switchBtn = document.getElementById("switchBtn");
const copyUrlBtn = document.getElementById("copyUrlBtn");
const statusEl = document.getElementById("status");
const connectionHintEl = document.getElementById("connectionHint");

const handLandmarksUrl = "https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js";
const pixiModuleUrl = "https://cdn.jsdelivr.net/npm/pixi.js@8.7.0/dist/pixi.mjs";

const state = {
  stream: null,
  currentFacingMode: "user",
  hands: null,
  videoReady: false,
  trackLoopRunning: false,
  processingFrame: false,
  demoMode: true,
  pointerDown: false,
  cameraPlacement: null,
  trails: new Map(),
  pixi: null,
  pixiInitStarted: false,
  pixiAvailable: false,
  lastStatusAt: 0,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

function fract(value) {
  return value - Math.floor(value);
}

function hashNoise(value) {
  return fract(Math.sin(value * 127.1 + 311.7) * 43758.5453123);
}

function smoothNoise1D(value) {
  const base = Math.floor(value);
  const progress = value - base;
  const eased = progress * progress * (3 - 2 * progress);
  return lerp(hashNoise(base), hashNoise(base + 1), eased) * 2 - 1;
}

function setStatus(message, force = false) {
  const now = performance.now();
  if (!force && now - state.lastStatusAt < 120 && statusEl.textContent === message) {
    return;
  }
  state.lastStatusAt = now;
  statusEl.textContent = message;
}

function setConnectionHint(message) {
  connectionHintEl.textContent = message;
}

function isSecureEnough() {
  return window.isSecureContext || location.hostname === "localhost" || location.hostname === "127.0.0.1";
}

function updateConnectionHint() {
  if (isSecureEnough()) {
    setConnectionHint("On phones, camera access works best from HTTPS. A local IP can still open the page, but the camera usually needs a secure host such as GitHub Pages.");
    return;
  }

  setConnectionHint("This page can open over Wi-Fi, but camera permission usually needs HTTPS. GitHub Pages is the quickest route for phone testing.");
}

function getPhoneShareUrl() {
  return location.href;
}

function resizeScene() {
  const rect = sceneCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  sceneCanvas.width = Math.max(1, Math.floor(rect.width * dpr));
  sceneCanvas.height = Math.max(1, Math.floor(rect.height * dpr));

  if (state.pixi?.app && rect.width > 0 && rect.height > 0) {
    state.pixi.app.renderer.resize(Math.floor(rect.width), Math.floor(rect.height));
  }
}

function getDisplaySize() {
  return {
    width: Math.max(1, sceneCanvas.clientWidth),
    height: Math.max(1, sceneCanvas.clientHeight),
  };
}

function ensurePixiTargets(width, height) {
  if (!state.pixi) {
    return;
  }

  if (state.pixi.backgroundCanvas.width !== Math.ceil(width) || state.pixi.backgroundCanvas.height !== Math.ceil(height)) {
    state.pixi.backgroundCanvas.width = Math.ceil(width);
    state.pixi.backgroundCanvas.height = Math.ceil(height);
  }

  if (state.pixi.rippleCanvas.width !== Math.ceil(width) || state.pixi.rippleCanvas.height !== Math.ceil(height)) {
    state.pixi.rippleCanvas.width = Math.ceil(width);
    state.pixi.rippleCanvas.height = Math.ceil(height);
  }
}

function isMirroredCamera() {
  return state.currentFacingMode === "user";
}

function getCameraPlacement(width, height) {
  if (!state.videoReady || camera.videoWidth === 0 || camera.videoHeight === 0) {
    return null;
  }

  const videoRatio = camera.videoWidth / camera.videoHeight;
  const canvasRatio = width / height;
  let drawWidth = width;
  let drawHeight = height;
  let offsetX = 0;
  let offsetY = 0;

  if (videoRatio > canvasRatio) {
    drawWidth = height * videoRatio;
    offsetX = (width - drawWidth) / 2;
  } else {
    drawHeight = width / videoRatio;
    offsetY = (height - drawHeight) / 2;
  }

  return { drawWidth, drawHeight, offsetX, offsetY };
}

function getCanvasPointFromRaw(point, width, height, placement = state.cameraPlacement) {
  const currentPlacement = placement || getCameraPlacement(width, height);
  if (!currentPlacement) {
    return {
      x: point.x * width,
      y: point.y * height,
    };
  }

  const sourceX = currentPlacement.offsetX + point.x * currentPlacement.drawWidth;
  const sourceY = currentPlacement.offsetY + point.y * currentPlacement.drawHeight;
  return {
    x: isMirroredCamera() ? width - sourceX : sourceX,
    y: sourceY,
  };
}

function createTrail(id) {
  return {
    id,
    points: [],
    wakes: [],
    active: false,
    lastPoint: null,
    lastWakePoint: null,
    lastWakeAt: 0,
    idleFrames: 0,
  };
}

function getPointDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function getAngle(a, b, c) {
  const abx = a.x - b.x;
  const aby = a.y - b.y;
  const cbx = c.x - b.x;
  const cby = c.y - b.y;
  const dot = abx * cbx + aby * cby;
  const magnitude = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (magnitude === 0) {
    return 0;
  }

  return Math.acos(clamp(dot / magnitude, -1, 1));
}

function getPalmCenter(landmarks) {
  const palmIndices = [0, 5, 9, 13, 17];
  const center = palmIndices.reduce(
    (accumulator, index) => ({
      x: accumulator.x + landmarks[index].x,
      y: accumulator.y + landmarks[index].y,
    }),
    { x: 0, y: 0 },
  );

  return {
    x: center.x / palmIndices.length,
    y: center.y / palmIndices.length,
  };
}

function isFingerExtended(landmarks, tipIndex, pipIndex, mcpIndex) {
  const tip = landmarks[tipIndex];
  const pip = landmarks[pipIndex];
  const mcp = landmarks[mcpIndex];
  return getAngle(tip, pip, mcp) > (155 * Math.PI) / 180;
}

function isThumbExtended(landmarks, handedness, palmCenter) {
  const wrist = landmarks[0];
  const thumbCmc = landmarks[1];
  const thumbMcp = landmarks[2];
  const thumbIp = landmarks[3];
  const thumbTip = landmarks[4];
  const indexMcp = landmarks[5];
  const indexTip = landmarks[8];
  const direction = handedness === "right" ? -1 : 1;
  const spread = direction * (thumbTip.x - thumbMcp.x);
  const tipAway = getPointDistance(thumbTip, palmCenter);
  const ipAway = getPointDistance(thumbIp, palmCenter);
  const mcpAway = getPointDistance(thumbMcp, wrist);
  const webDistance = getPointDistance(thumbTip, indexMcp);
  const tipToIndexTip = getPointDistance(thumbTip, indexTip);
  const straight = getAngle(thumbTip, thumbIp, thumbMcp) > (145 * Math.PI) / 180;
  const open = getAngle(thumbTip, thumbMcp, thumbCmc) > (150 * Math.PI) / 180;

  return straight
    && open
    && spread > 0.04
    && tipAway > ipAway + 0.016
    && tipAway > mcpAway * 0.86
    && webDistance > 0.085
    && tipToIndexTip > 0.11;
}

function getActiveFingers(landmarks, handedness) {
  const palmCenter = getPalmCenter(landmarks);
  const fingerMap = [
    { id: "thumb", tip: 4, pip: 3, mcp: 2 },
    { id: "index", tip: 8, pip: 6, mcp: 5 },
    { id: "middle", tip: 12, pip: 10, mcp: 9 },
    { id: "ring", tip: 16, pip: 14, mcp: 13 },
    { id: "pinky", tip: 20, pip: 18, mcp: 17 },
  ];

  return fingerMap.filter((finger) => {
    if (finger.id === "thumb") {
      return isThumbExtended(landmarks, handedness, palmCenter);
    }

    const tip = landmarks[finger.tip];
    const pip = landmarks[finger.pip];
    const mcp = landmarks[finger.mcp];
    const wrist = landmarks[0];
    return isFingerExtended(landmarks, finger.tip, finger.pip, finger.mcp)
      && getPointDistance(tip, wrist) > getPointDistance(pip, wrist) * 1.02
      && getAngle(tip, pip, mcp) > (155 * Math.PI) / 180;
  });
}

function pushTrailPoint(trail, x, y, strength = 1) {
  const lastPoint = trail.points[trail.points.length - 1];
  const now = performance.now();
  const nextPoint = { x, y, strength, createdAt: now };

  if (lastPoint) {
    const distance = getPointDistance(nextPoint, lastPoint);
    if (distance < 2.3) {
      return;
    }
  }

  trail.points.push(nextPoint);
  if (trail.points.length > 20) {
    trail.points.shift();
  }
  trail.lastPoint = nextPoint;

  if (lastPoint) {
    const wakeDistance = trail.lastWakePoint ? getPointDistance(nextPoint, trail.lastWakePoint) : Infinity;
    if (wakeDistance > 70 && now - trail.lastWakeAt > 130) {
      const directionLength = Math.max(1, getPointDistance(nextPoint, lastPoint));
      trail.wakes.push({
        x,
        y,
        directionX: (x - lastPoint.x) / directionLength,
        directionY: (y - lastPoint.y) / directionLength,
        strength,
        createdAt: now,
      });
      if (trail.wakes.length > 8) {
        trail.wakes.shift();
      }
      trail.lastWakePoint = nextPoint;
      trail.lastWakeAt = now;
    }
  }
}

function drawBackdrop(backgroundCtx, width, height, demoMode) {
  backgroundCtx.clearRect(0, 0, width, height);
  const gradient = backgroundCtx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, demoMode ? "rgba(24, 30, 39, 1)" : "rgba(4, 8, 15, 1)");
  gradient.addColorStop(1, demoMode ? "rgba(8, 11, 16, 1)" : "rgba(2, 4, 10, 1)");
  backgroundCtx.fillStyle = gradient;
  backgroundCtx.fillRect(0, 0, width, height);

  const bloom = backgroundCtx.createRadialGradient(width * 0.24, height * 0.14, 0, width * 0.24, height * 0.14, width * 0.48);
  bloom.addColorStop(0, demoMode ? "rgba(90, 112, 145, 0.24)" : "rgba(36, 72, 122, 0.18)");
  bloom.addColorStop(1, "rgba(0, 0, 0, 0)");
  backgroundCtx.fillStyle = bloom;
  backgroundCtx.fillRect(0, 0, width, height);

  if (demoMode) {
    backgroundCtx.strokeStyle = "rgba(210, 224, 255, 0.07)";
    backgroundCtx.lineWidth = 1;
    for (let x = width * 0.12; x < width; x += width * 0.12) {
      backgroundCtx.beginPath();
      backgroundCtx.moveTo(x, 0);
      backgroundCtx.lineTo(x, height);
      backgroundCtx.stroke();
    }
    for (let y = height * 0.14; y < height; y += height * 0.14) {
      backgroundCtx.beginPath();
      backgroundCtx.moveTo(0, y);
      backgroundCtx.lineTo(width, y);
      backgroundCtx.stroke();
    }

    backgroundCtx.fillStyle = "rgba(255, 255, 255, 0.045)";
    backgroundCtx.fillRect(width * 0.64, height * 0.22, width * 0.18, height * 0.22);
    backgroundCtx.fillRect(width * 0.16, height * 0.58, width * 0.14, height * 0.18);
  }
}

function getLiveTrailPoints(trail, now, maxAge = 900) {
  return trail.points.filter((point) => now - point.createdAt < maxAge);
}

function getLiveTrailEnergy(now) {
  let energy = 0;
  for (const trail of state.trails.values()) {
    const livePoints = getLiveTrailPoints(trail, now, 1000);
    const liveWakes = trail.wakes.filter((wake) => now - wake.createdAt < 1400);
    if (!trail.active && livePoints.length < 2 && liveWakes.length === 0) {
      continue;
    }
    energy += Math.max(0, livePoints.length - 1) + liveWakes.length * 0.9;
  }
  return energy;
}

function drawWakeShape(context, wake, age, scale = 1) {
  const progress = clamp(age / 1550, 0, 1);
  const perpendicularX = -wake.directionY;
  const perpendicularY = wake.directionX;
  const travel = (8 + progress * 24) * scale;
  const length = (24 + progress * 90) * scale;
  const width = (8 + progress * 24) * scale;
  const headX = wake.x + wake.directionX * travel;
  const headY = wake.y + wake.directionY * travel;
  const tailX = headX - wake.directionX * length;
  const tailY = headY - wake.directionY * length;
  const offsetX = perpendicularX * width;
  const offsetY = perpendicularY * width;

  context.beginPath();
  context.moveTo(tailX + offsetX, tailY + offsetY);
  context.quadraticCurveTo(
    headX - wake.directionX * length * 0.3 + offsetX * 0.38,
    headY - wake.directionY * length * 0.3 + offsetY * 0.38,
    headX,
    headY,
  );
  context.quadraticCurveTo(
    headX - wake.directionX * length * 0.3 - offsetX * 0.38,
    headY - wake.directionY * length * 0.3 - offsetY * 0.38,
    tailX - offsetX,
    tailY - offsetY,
  );
}

function drawRippleStroke(context, point, previous, next, liveCount, index, now) {
  const tangentX = next.x - previous.x;
  const tangentY = next.y - previous.y;
  const tangentLength = Math.hypot(tangentX, tangentY) || 1;
  const dirX = tangentX / tangentLength;
  const dirY = tangentY / tangentLength;
  const normalX = -dirY;
  const normalY = dirX;
  const tailFade = 1 - index / Math.max(1, liveCount - 1);
  const ageFade = 1 - clamp((now - point.createdAt) / 1000, 0, 1);
  const speed = clamp(tangentLength / 24, 0, 1.1);
  const reach = 12 + tailFade * 12 + point.strength * 6 + speed * 5;
  const sideOffset = 4 + tailFade * 6 + point.strength * 3;
  const darkAlpha = (0.02 + tailFade * 0.018) * ageFade;
  const lightAlpha = (0.03 + tailFade * 0.028) * ageFade;

  context.save();
  context.translate(point.x, point.y);
  context.rotate(Math.atan2(dirY, dirX));
  context.scale(1.3 + speed * 0.2, 0.7 + tailFade * 0.4);

  context.globalCompositeOperation = "source-over";
  context.fillStyle = `rgba(92, 92, 92, ${darkAlpha})`;
  context.beginPath();
  context.ellipse(-reach * 0.2, sideOffset, reach * 0.78, reach * 0.24, 0, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = `rgba(255, 255, 255, ${lightAlpha})`;
  context.beginPath();
  context.ellipse(reach * 0.12, -sideOffset * 0.82, reach * 0.72, reach * 0.2, 0, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = `rgba(255, 255, 255, ${lightAlpha * 0.6})`;
  context.beginPath();
  context.arc(0, 0, 3.6 + point.strength * 1.8, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function updateRippleMap(now) {
  if (!state.pixi) {
    return;
  }

  const { width, height } = getDisplaySize();
  ensurePixiTargets(width, height);
  const rippleCtx = state.pixi.rippleCtx;
  const mapWidth = state.pixi.rippleCanvas.width;
  const mapHeight = state.pixi.rippleCanvas.height;

  rippleCtx.save();
  rippleCtx.setTransform(1, 0, 0, 1, 0, 0);
  rippleCtx.globalCompositeOperation = "source-over";
  rippleCtx.fillStyle = "rgba(128, 128, 255, 0.06)";
  rippleCtx.fillRect(0, 0, mapWidth, mapHeight);
  rippleCtx.globalCompositeOperation = "lighter";
  rippleCtx.filter = "blur(4px)";

  for (const trail of state.trails.values()) {
    const livePoints = getLiveTrailPoints(trail, now, 1000);
    if (livePoints.length < 2) {
      continue;
    }

    for (let index = 0; index < livePoints.length; index += 1) {
      const point = livePoints[index];
      const previous = livePoints[Math.max(0, index - 1)];
      const next = livePoints[Math.min(livePoints.length - 1, index + 1)];
      drawRippleStroke(rippleCtx, point, previous, next, livePoints.length, index, now);
    }
  }

  for (const trail of state.trails.values()) {
    const visibleWakes = trail.wakes.filter((wake) => now - wake.createdAt < 1450);
    for (const wake of visibleWakes) {
      const age = now - wake.createdAt;
      const progress = clamp(age / 1450, 0, 1);
      rippleCtx.save();
      rippleCtx.globalAlpha = Math.sin(progress * Math.PI) * 0.12;
      rippleCtx.strokeStyle = "rgba(255, 255, 255, 0.88)";
      rippleCtx.lineWidth = Math.max(0.7, 1.2 - progress * 0.6);
      drawWakeShape(rippleCtx, wake, age, 0.8);
      rippleCtx.stroke();
      rippleCtx.globalAlpha = Math.sin(progress * Math.PI) * 0.08;
      rippleCtx.strokeStyle = "rgba(72, 72, 72, 0.86)";
      rippleCtx.lineWidth = Math.max(0.7, 1.1 - progress * 0.55);
      drawWakeShape(rippleCtx, wake, age, 1);
      rippleCtx.stroke();
      rippleCtx.restore();
    }
  }

  rippleCtx.filter = "none";
  rippleCtx.restore();
  state.pixi.rippleTexture.source.update();
}

function syncBackground(width, height, now) {
  ensurePixiTargets(width, height);
  drawBackdrop(state.pixi.backgroundCtx, width, height, state.demoMode);
  state.pixi.backgroundTexture.source.update();
  state.pixi.backgroundSprite.width = width;
  state.pixi.backgroundSprite.height = height;
  state.pixi.overlaySprite.width = width;
  state.pixi.overlaySprite.height = height;

  if (state.videoReady && camera.readyState >= 2) {
    const textureSource = state.pixi.videoTexture?.source;
    textureSource?.update?.();
    const placement = getCameraPlacement(width, height);
    state.cameraPlacement = placement;
    if (placement) {
      state.pixi.videoSprite.visible = true;
      state.pixi.videoSprite.y = placement.offsetY;
      state.pixi.videoSprite.width = placement.drawWidth;
      state.pixi.videoSprite.height = placement.drawHeight;
      if (isMirroredCamera()) {
        state.pixi.videoSprite.scale.x = -1;
        state.pixi.videoSprite.x = placement.offsetX + placement.drawWidth;
      } else {
        state.pixi.videoSprite.scale.x = 1;
        state.pixi.videoSprite.x = placement.offsetX;
      }
    }
  } else {
    state.pixi.videoSprite.visible = false;
  }
}

function renderFrame(now) {
  const { width, height } = getDisplaySize();
  if (state.pixi) {
    syncBackground(width, height, now);
    updateRippleMap(now);
    const activeEnergy = getLiveTrailEnergy(now);
    const scale = activeEnergy > 0
      ? clamp((state.demoMode ? 16 : 12) + activeEnergy * 0.24, 8, state.demoMode ? 28 : 22)
      : 0;
    state.pixi.displacementFilter.scale.x = scale;
    state.pixi.displacementFilter.scale.y = scale * 0.82;
    state.pixi.overlaySprite.alpha = clamp(activeEnergy * 0.005, 0, 0.22);
  }

  requestAnimationFrame(renderFrame);
}

function tracePointMotion(event) {
  const rect = sceneCanvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function emitDemoTrail(event, strength = 1) {
  const point = tracePointMotion(event);
  const demoTrail = state.trails.get("demo") || createTrail("demo");
  state.trails.set("demo", demoTrail);
  pushTrailPoint(demoTrail, point.x, point.y, strength);
  demoTrail.active = true;
  demoTrail.idleFrames = 0;
}

function bindDemoInput() {
  window.addEventListener("pointerdown", (event) => {
    state.pointerDown = true;
    emitDemoTrail(event, 1.2);
  });

  window.addEventListener("pointermove", (event) => {
    if (!state.pointerDown && event.pointerType !== "mouse") {
      return;
    }
    emitDemoTrail(event, state.pointerDown ? 1.2 : 1);
  });

  window.addEventListener("pointerup", () => {
    state.pointerDown = false;
  });

  window.addEventListener("pointercancel", () => {
    state.pointerDown = false;
  });
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function ensureHands() {
  if (state.hands) {
    return state.hands;
  }

  await loadScript(handLandmarksUrl);
  state.hands = new window.Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });

  state.hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6,
  });

  state.hands.onResults((results) => {
    const width = sceneCanvas.clientWidth;
    const height = sceneCanvas.clientHeight;
    const palm = results.multiHandLandmarks?.[0];
    const handedness = results.multiHandedness?.[0]?.label?.toLowerCase() || "right";

    if (!palm) {
      if (state.videoReady) {
        for (const trail of state.trails.values()) {
          trail.active = false;
        }
        setStatus("Camera is live. Put one hand in frame.");
      }
      return;
    }

    const activeFingers = getActiveFingers(palm, handedness);
    if (activeFingers.length === 0) {
      for (const trail of state.trails.values()) {
        trail.active = false;
      }
      setStatus("Fist detected. Open your hand to resume.");
      return;
    }

    activeFingers.forEach((finger) => {
      const trail = state.trails.get(finger.id) || createTrail(finger.id);
      state.trails.set(finger.id, trail);
      const point = getCanvasPointFromRaw(palm[finger.tip], width, height);
      pushTrailPoint(trail, point.x, point.y, finger.id === "thumb" ? 1.08 : 1);
      trail.active = true;
      trail.idleFrames = 0;
    });

    for (const [id, trail] of state.trails) {
      if (!activeFingers.some((finger) => finger.id === id)) {
        trail.active = false;
      }
    }

    setStatus(`Tracking ${activeFingers.length} finger${activeFingers.length > 1 ? "s" : ""}.`);
  });

  return state.hands;
}

async function initPixi() {
  if (state.pixiInitStarted || state.pixiAvailable) {
    return;
  }

  state.pixiInitStarted = true;
  try {
    const modules = await import(pixiModuleUrl);
    const app = new modules.Application();
    await app.init({
      canvas: sceneCanvas,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      preference: "webgl",
      resizeTo: document.querySelector(".app"),
      resolution: window.devicePixelRatio || 1,
    });

    const backgroundCanvas = document.createElement("canvas");
    const backgroundCtx = backgroundCanvas.getContext("2d");
    const backgroundTexture = modules.Texture.from(backgroundCanvas);
    const backgroundSprite = new modules.Sprite(backgroundTexture);

    const videoSprite = new modules.Sprite();
    videoSprite.visible = false;

    const rippleCanvas = document.createElement("canvas");
    const rippleCtx = rippleCanvas.getContext("2d");
    const rippleTexture = modules.Texture.from(rippleCanvas);
    const rippleSprite = new modules.Sprite(rippleTexture);
    rippleSprite.visible = false;

    const overlaySprite = new modules.Sprite(rippleTexture);
    overlaySprite.alpha = 0;
    overlaySprite.blendMode = "screen";

    app.stage.addChild(backgroundSprite);
    app.stage.addChild(videoSprite);
    app.stage.addChild(overlaySprite);
    app.stage.addChild(rippleSprite);

    const displacementFilter = new modules.DisplacementFilter(rippleSprite);
    displacementFilter.scale.x = 16;
    displacementFilter.scale.y = 14;
    app.stage.filters = [displacementFilter];

    state.pixi = {
      app,
      modules,
      backgroundCanvas,
      backgroundCtx,
      backgroundTexture,
      backgroundSprite,
      videoSprite,
      videoTexture: null,
      rippleCanvas,
      rippleCtx,
      rippleTexture,
      rippleSprite,
      overlaySprite,
      displacementFilter,
    };

    state.pixiAvailable = true;
  } catch (error) {
    console.warn("Pixi renderer unavailable, keeping the app in demo mode.", error);
    state.pixiAvailable = false;
    state.pixiInitStarted = false;
  }
}

async function startCamera() {
  try {
    setStatus("Starting camera...");
    if (!isSecureEnough()) {
      throw new Error("Camera needs HTTPS on phones. Use GitHub Pages or another secure host for the real phone flow.");
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera access is not supported in this browser.");
    }

    await ensureHands();
    await initPixi();
    resizeScene();

    if (state.stream) {
      state.stream.getTracks().forEach((track) => track.stop());
    }

    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: state.currentFacingMode,
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    camera.srcObject = state.stream;
    camera.classList.toggle("mirrored", isMirroredCamera());
    await camera.play();

    if (state.pixi && !state.pixi.videoTexture) {
      state.pixi.videoTexture = state.pixi.modules.Texture.from(camera);
      state.pixi.videoSprite.texture = state.pixi.videoTexture;
    }

    state.demoMode = false;
    state.videoReady = true;
    state.trackLoopRunning = true;
    state.cameraPlacement = null;
    state.trails.clear();
    switchBtn.disabled = false;

    const sendFrame = async () => {
      if (!state.trackLoopRunning) {
        return;
      }

      if (camera.readyState >= 2 && !state.processingFrame) {
        state.processingFrame = true;
        try {
          await state.hands.send({ image: camera });
        } finally {
          state.processingFrame = false;
        }
      }
      requestAnimationFrame(sendFrame);
    };

    requestAnimationFrame(sendFrame);
    setStatus("Camera ready. Move your fingers to create ripples.");
  } catch (error) {
    console.error(error);
    state.demoMode = true;
    state.videoReady = false;
    state.trackLoopRunning = false;
    switchBtn.disabled = true;
    state.trails.clear();
    setStatus("Demo mode: move or drag the mouse to draw water trails.");
  }
}

function switchCamera() {
  state.currentFacingMode = state.currentFacingMode === "user" ? "environment" : "user";
  state.trackLoopRunning = false;
  startCamera();
}

async function copyPhoneLink() {
  const link = getPhoneShareUrl();
  try {
    await navigator.clipboard.writeText(link);
    setStatus("Phone link copied.");
  } catch (error) {
    console.warn("Copy failed:", error);
    setStatus(link);
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch (error) {
    console.warn("Service worker registration skipped:", error);
  }
}

window.addEventListener("resize", resizeScene);
startBtn.addEventListener("click", startCamera);
switchBtn.addEventListener("click", switchCamera);
copyUrlBtn.addEventListener("click", copyPhoneLink);
bindDemoInput();

resizeScene();
initPixi();
renderFrame(performance.now());
setStatus("Demo mode: move or drag the mouse to draw water trails.");
updateConnectionHint();
registerServiceWorker();
