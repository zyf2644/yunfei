const camera = document.getElementById("camera");
const pixiCanvas = document.getElementById("pixi");
const canvas = document.getElementById("output");
const ctx = canvas.getContext("2d");
const startBtn = document.getElementById("startBtn");
const switchBtn = document.getElementById("switchBtn");
const copyUrlBtn = document.getElementById("copyUrlBtn");
const statusEl = document.getElementById("status");
const connectionHintEl = document.getElementById("connectionHint");
const refractionCanvas = document.createElement("canvas");
const refractionCtx = refractionCanvas.getContext("2d");
const liquidCanvas = document.createElement("canvas");
const liquidCtx = liquidCanvas.getContext("2d");

let stream = null;
let currentFacingMode = "user";
let hands = null;
let videoReady = false;
let trackLoopRunning = false;
let processingFrame = false;
let demoMode = true;
let pointerDown = false;
let trails = new Map();
let cameraPlacement = null;
let pixiRenderer = null;
let pixiInitStarted = false;
let pixiAvailable = false;

const handLandmarksUrl = "https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js";
const pixiModuleUrl = "https://cdn.jsdelivr.net/npm/pixi.js@8.7.0/dist/pixi.mjs";

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (pixiRenderer?.app?.renderer && rect.width > 0 && rect.height > 0) {
    pixiRenderer.app.renderer.resize(Math.floor(rect.width), Math.floor(rect.height));
  }
}

function isSecureEnough() {
  return window.isSecureContext || location.hostname === "localhost" || location.hostname === "127.0.0.1";
}

function setStatus(message) {
  statusEl.textContent = message;
}

function setConnectionHint(message) {
  connectionHintEl.textContent = message;
}

function getPhoneShareUrl() {
  if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
    return "Open this page from your computer's LAN IP or deploy to HTTPS for phone camera access.";
  }

  return location.href;
}

function isMirroredCamera() {
  return currentFacingMode === "user";
}

function updateConnectionHint() {
  if (isSecureEnough()) {
    setConnectionHint("On phones, camera access works best from HTTPS. If you open this over a local IP, it can still view the scene, but full camera permission usually needs a secure host such as GitHub Pages.");
    return;
  }

  setConnectionHint("This page can open on a phone over Wi-Fi, but camera permission usually needs HTTPS. Use GitHub Pages or another secure host for the full experience.");
}

function getCameraPlacement(width, height) {
  if (!videoReady || camera.videoWidth === 0 || camera.videoHeight === 0) {
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

function getCanvasPointFromRaw(point, width, height, placement = cameraPlacement) {
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

function drawCameraFrame(targetCtx, width, height) {
  const placement = getCameraPlacement(width, height);
  cameraPlacement = placement;

  targetCtx.save();
  targetCtx.clearRect(0, 0, width, height);

  if (!placement) {
    targetCtx.restore();
    return null;
  }

  if (isMirroredCamera()) {
    targetCtx.translate(width, 0);
    targetCtx.scale(-1, 1);
  }

  targetCtx.drawImage(
    camera,
    placement.offsetX,
    placement.offsetY,
    placement.drawWidth,
    placement.drawHeight,
  );
  targetCtx.restore();
  return placement;
}

function drawBackground(width, height) {
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, demoMode ? "rgba(35, 39, 44, 0.98)" : "rgba(5, 10, 20, 0.025)");
  gradient.addColorStop(1, demoMode ? "rgba(12, 15, 20, 0.98)" : "rgba(4, 8, 16, 0.06)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function updateTextureSource(texture) {
  texture?.source?.update?.();
}

function getDisplaySize() {
  return {
    width: Math.max(1, canvas.clientWidth),
    height: Math.max(1, canvas.clientHeight),
  };
}

function drawPixiBackground(backgroundCtx, width, height) {
  backgroundCtx.clearRect(0, 0, width, height);
  const gradient = backgroundCtx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, demoMode ? "rgba(26, 31, 38, 1)" : "rgba(4, 8, 16, 1)");
  gradient.addColorStop(1, demoMode ? "rgba(10, 13, 18, 1)" : "rgba(3, 6, 14, 1)");
  backgroundCtx.fillStyle = gradient;
  backgroundCtx.fillRect(0, 0, width, height);

  const bloom = backgroundCtx.createRadialGradient(width * 0.22, height * 0.12, 0, width * 0.22, height * 0.12, width * 0.46);
  bloom.addColorStop(0, demoMode ? "rgba(90, 112, 145, 0.22)" : "rgba(32, 70, 112, 0.18)");
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

function pushTrailPoint(trail, x, y, strength = 1) {
  const lastPoint = trail.points[trail.points.length - 1];
  const now = performance.now();
  const nextPoint = { x, y, strength, createdAt: now };
  if (lastPoint) {
    const dx = x - lastPoint.x;
    const dy = y - lastPoint.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 2.5) {
      return;
    }
  }

  trail.points.push(nextPoint);
  if (trail.points.length > 22) {
    trail.points.shift();
  }
  trail.lastPoint = nextPoint;

  if (lastPoint) {
    const wakeDistance = trail.lastWakePoint ? getPointDistance(nextPoint, trail.lastWakePoint) : Infinity;
    if (wakeDistance > 74 && now - trail.lastWakeAt > 140) {
      const directionLength = Math.max(1, getPointDistance(nextPoint, lastPoint));
      trail.wakes.push({
        x,
        y,
        directionX: (x - lastPoint.x) / directionLength,
        directionY: (y - lastPoint.y) / directionLength,
        strength,
        createdAt: now,
      });
      if (trail.wakes.length > 6) {
        trail.wakes.shift();
      }
      trail.lastWakePoint = nextPoint;
      trail.lastWakeAt = now;
    }
  }
}

function traceSmoothPath(context, points) {
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    context.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
  }
  const last = points[points.length - 1];
  context.lineTo(last.x, last.y);
}

function scaleRibbonPoints(points, widthScale = 1, strengthBoost = 1) {
  return points.map((point, index) => {
    const tailFade = 1 - index / Math.max(1, points.length - 1);
    return {
      ...point,
      strength: point.strength * strengthBoost * (0.72 + tailFade * widthScale * 0.42),
    };
  });
}

function buildRibbonOutline(points, options = {}) {
  if (points.length < 2) {
    return null;
  }

  const {
    baseWidth = 10,
    tailWidth = 13,
    strengthWidth = 7,
    flutterStrength = 1.1,
    flutterFrequency = 0.42,
    noiseOffset = 0,
    time = performance.now() * 0.001,
  } = options;
  const leftEdge = [];
  const rightEdge = [];
  const lastIndex = points.length - 1;

  points.forEach((point, index) => {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(lastIndex, index + 1)];
    const directionX = next.x - previous.x;
    const directionY = next.y - previous.y;
    const directionLength = Math.hypot(directionX, directionY) || 1;
    const tangentX = directionX / directionLength;
    const tangentY = directionY / directionLength;
    const normalX = -tangentY;
    const normalY = tangentX;
    const tailFade = 1 - index / Math.max(1, lastIndex);
    const width = baseWidth + tailFade * tailWidth + point.strength * strengthWidth;
    const noiseValue = smoothNoise1D(index * flutterFrequency + time * 0.75 + noiseOffset)
      + smoothNoise1D(index * flutterFrequency * 2.1 + time * 0.43 + noiseOffset * 1.7) * 0.45;
    const flutter = noiseValue * flutterStrength * (0.55 + tailFade * 1.2);
    const halfWidth = width + flutter;

    leftEdge.push({
      x: point.x + normalX * halfWidth,
      y: point.y + normalY * halfWidth,
    });
    rightEdge.push({
      x: point.x - normalX * halfWidth,
      y: point.y - normalY * halfWidth,
    });
  });

  return {
    leftEdge,
    rightEdge: rightEdge.reverse(),
  };
}

function traceRibbonShape(context, points, options = {}) {
  const outline = buildRibbonOutline(points, options);
  if (!outline) {
    return false;
  }

  context.beginPath();
  context.moveTo(outline.leftEdge[0].x, outline.leftEdge[0].y);

  for (let index = 1; index < outline.leftEdge.length; index += 1) {
    const point = outline.leftEdge[index];
    const next = outline.leftEdge[Math.min(outline.leftEdge.length - 1, index + 1)];
    context.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
  }

  for (let index = 0; index < outline.rightEdge.length; index += 1) {
    const point = outline.rightEdge[index];
    const next = outline.rightEdge[Math.min(outline.rightEdge.length - 1, index + 1)];
    context.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
  }

  context.closePath();
  return true;
}

function updateRefractionFrame(width, height) {
  if (!videoReady || camera.readyState < 2) {
    return false;
  }

  if (refractionCanvas.width !== Math.ceil(width) || refractionCanvas.height !== Math.ceil(height)) {
    refractionCanvas.width = Math.ceil(width);
    refractionCanvas.height = Math.ceil(height);
  }

  drawCameraFrame(refractionCtx, width, height);
  return Boolean(cameraPlacement);
}

function drawRefractionLayer(targetCtx, sourceCanvas, drawLayer) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (liquidCanvas.width !== Math.ceil(width) || liquidCanvas.height !== Math.ceil(height)) {
    liquidCanvas.width = Math.ceil(width);
    liquidCanvas.height = Math.ceil(height);
  }

  liquidCtx.setTransform(1, 0, 0, 1, 0, 0);
  liquidCtx.clearRect(0, 0, width, height);
  drawLayer.mask(liquidCtx);

  if (sourceCanvas) {
    liquidCtx.filter = `blur(${drawLayer.blur ?? 0}px)`;
    liquidCtx.globalCompositeOperation = "source-in";
    liquidCtx.globalAlpha = drawLayer.alpha ?? 1;
    liquidCtx.drawImage(
      sourceCanvas,
      drawLayer.shiftX ?? 0,
      drawLayer.shiftY ?? 0,
      width + (drawLayer.expandX ?? 0),
      height + (drawLayer.expandY ?? 0),
    );
    liquidCtx.filter = "none";
  } else if (drawLayer.fallback) {
    liquidCtx.globalCompositeOperation = "source-in";
    drawLayer.fallback(liquidCtx, width, height);
  }

  liquidCtx.globalAlpha = 1;
  liquidCtx.globalCompositeOperation = "source-over";
  targetCtx.save();
  targetCtx.globalCompositeOperation = drawLayer.composite ?? "source-over";
  targetCtx.globalAlpha = drawLayer.layerAlpha ?? 1;
  targetCtx.drawImage(liquidCanvas, 0, 0);
  targetCtx.restore();
}

function ensureDisplacementSize(width, height) {
  if (!pixiRenderer) {
    return;
  }

  const mapWidth = Math.max(64, Math.ceil(width));
  const mapHeight = Math.max(64, Math.ceil(height));
  if (pixiRenderer.displacementCanvas.width !== mapWidth || pixiRenderer.displacementCanvas.height !== mapHeight) {
    pixiRenderer.displacementCanvas.width = mapWidth;
    pixiRenderer.displacementCanvas.height = mapHeight;
  }

  if (pixiRenderer.backgroundCanvas.width !== Math.ceil(width) || pixiRenderer.backgroundCanvas.height !== Math.ceil(height)) {
    pixiRenderer.backgroundCanvas.width = Math.ceil(width);
    pixiRenderer.backgroundCanvas.height = Math.ceil(height);
  }
}

function drawDisplacementBlob(displacementCtx, x, y, radius, shiftX, shiftY, alpha, angle = 0, stretch = 1.5) {
  const red = clamp(Math.round(128 + shiftX), 0, 255);
  const green = clamp(Math.round(128 + shiftY), 0, 255);
  displacementCtx.save();
  displacementCtx.translate(x, y);
  displacementCtx.rotate(angle);
  displacementCtx.scale(stretch, 1);
  displacementCtx.fillStyle = `rgba(${red}, ${green}, 255, ${alpha})`;
  displacementCtx.beginPath();
  displacementCtx.arc(0, 0, radius, 0, Math.PI * 2);
  displacementCtx.fill();
  displacementCtx.restore();
}

function renderDisplacementMap(width, height, now) {
  if (!pixiRenderer) {
    return;
  }

  ensureDisplacementSize(width, height);
  const displacementCtx = pixiRenderer.displacementCtx;
  const mapWidth = pixiRenderer.displacementCanvas.width;
  const mapHeight = pixiRenderer.displacementCanvas.height;

  displacementCtx.save();
  displacementCtx.setTransform(1, 0, 0, 1, 0, 0);
  displacementCtx.globalCompositeOperation = "source-over";
  displacementCtx.fillStyle = "rgba(128, 128, 255, 0.18)";
  displacementCtx.fillRect(0, 0, mapWidth, mapHeight);
  displacementCtx.globalCompositeOperation = "lighter";
  displacementCtx.filter = "blur(8px)";

  for (const trail of trails.values()) {
    const livePoints = trail.points.filter((point) => now - point.createdAt < 1200);
    if (livePoints.length < 2) {
      continue;
    }

    for (let index = 0; index < livePoints.length; index += 1) {
      const point = livePoints[index];
      const previous = livePoints[Math.max(0, index - 1)];
      const next = livePoints[Math.min(livePoints.length - 1, index + 1)];
      const tangentX = next.x - previous.x;
      const tangentY = next.y - previous.y;
      const tangentLength = Math.hypot(tangentX, tangentY) || 1;
      const dirX = tangentX / tangentLength;
      const dirY = tangentY / tangentLength;
      const normalX = -dirY;
      const normalY = dirX;
      const tailFade = 1 - index / Math.max(1, livePoints.length - 1);
      const speed = clamp(tangentLength / 18, 0, 1.4);
      const radius = 16 + tailFade * 11 + point.strength * 8 + speed * 8;
      const dragX = clamp(normalX * 34 * point.strength + dirX * 14 * speed, -52, 52);
      const dragY = clamp(normalY * 34 * point.strength + dirY * 14 * speed, -52, 52);
      const angle = Math.atan2(dirY, dirX);
      const x = point.x;
      const y = point.y;

      drawDisplacementBlob(displacementCtx, x, y, radius, dragX, dragY, 0.08 + tailFade * 0.08, angle, 1.55 + speed * 0.2);
      drawDisplacementBlob(displacementCtx, x, y, radius * 0.56, -dragX * 0.36, -dragY * 0.36, 0.05 + tailFade * 0.04, angle + Math.PI / 2, 1.15);
    }

    for (const wake of trail.wakes) {
      const age = now - wake.createdAt;
      if (age > 1500) {
        continue;
      }
      const progress = clamp(age / 1500, 0, 1);
      const waveX = wake.x + wake.directionX * (14 + progress * 36);
      const waveY = wake.y + wake.directionY * (14 + progress * 36);
      const radius = 10 + progress * 26;
      const alpha = Math.sin(progress * Math.PI) * 0.1;
      const dragX = clamp(wake.directionY * 18, -28, 28);
      const dragY = clamp(-wake.directionX * 18, -28, 28);
      const angle = Math.atan2(wake.directionY, wake.directionX);
      drawDisplacementBlob(displacementCtx, waveX, waveY, radius, dragX, dragY, alpha, angle, 2.1);
    }
  }

  displacementCtx.restore();
  updateTextureSource(pixiRenderer.displacementTexture);
}

function syncPixiVideoSprite(width, height) {
  if (!pixiRenderer) {
    return;
  }

  const { videoSprite } = pixiRenderer;
  if (!videoReady || camera.readyState < 2) {
    videoSprite.visible = false;
    return;
  }

  const placement = getCameraPlacement(width, height);
  if (!placement) {
    videoSprite.visible = false;
    return;
  }

  if (!pixiRenderer.videoTexture) {
    pixiRenderer.videoTexture = pixiRenderer.modules.Texture.from(camera);
    videoSprite.texture = pixiRenderer.videoTexture;
  }

  updateTextureSource(pixiRenderer.videoTexture);
  videoSprite.visible = true;
  videoSprite.height = placement.drawHeight;
  videoSprite.width = placement.drawWidth;
  videoSprite.y = placement.offsetY;
  if (isMirroredCamera()) {
    videoSprite.scale.x = -1;
    videoSprite.x = placement.offsetX + placement.drawWidth;
  } else {
    videoSprite.scale.x = 1;
    videoSprite.x = placement.offsetX;
  }
}

function renderPixiScene(now) {
  if (!pixiAvailable || !pixiRenderer) {
    return false;
  }

  const { width, height } = getDisplaySize();
  ensureDisplacementSize(width, height);
  drawPixiBackground(pixiRenderer.backgroundCtx, width, height);
  updateTextureSource(pixiRenderer.backgroundTexture);
  pixiRenderer.backgroundSprite.width = width;
  pixiRenderer.backgroundSprite.height = height;
  pixiRenderer.highlightSprite.width = width;
  pixiRenderer.highlightSprite.height = height;
  syncPixiVideoSprite(width, height);
  renderDisplacementMap(width, height, now);

  let activeEnergy = 0;
  for (const trail of trails.values()) {
    activeEnergy += trail.points.length + trail.wakes.length * 1.5;
  }
  const filterScale = clamp((demoMode ? 26 : 18) + activeEnergy * 0.26, 18, demoMode ? 52 : 42);
  pixiRenderer.displacementFilter.scale.x = filterScale;
  pixiRenderer.displacementFilter.scale.y = filterScale * 0.82;
  pixiRenderer.highlightSprite.alpha = clamp(0.12 + activeEnergy * 0.003, 0.12, 0.24);
  return true;
}

async function initPixiRenderer() {
  if (pixiInitStarted || pixiAvailable) {
    return;
  }

  pixiInitStarted = true;
  try {
    const modules = await import(pixiModuleUrl);
    const app = new modules.Application();
    await app.init({
      canvas: pixiCanvas,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      preference: "webgl",
      resizeTo: document.querySelector(".app"),
      resolution: window.devicePixelRatio || 1,
    });

    const scene = new modules.Container();
    const backgroundCanvas = document.createElement("canvas");
    const backgroundCtx = backgroundCanvas.getContext("2d");
    const backgroundTexture = modules.Texture.from(backgroundCanvas);
    const backgroundSprite = new modules.Sprite(backgroundTexture);
    const videoSprite = new modules.Sprite();
    scene.addChild(backgroundSprite);
    scene.addChild(videoSprite);

    const displacementCanvas = document.createElement("canvas");
    const displacementCtx = displacementCanvas.getContext("2d");
    const displacementTexture = modules.Texture.from(displacementCanvas);
    const displacementSprite = new modules.Sprite(displacementTexture);
    displacementSprite.visible = false;
    const highlightSprite = new modules.Sprite(displacementTexture);
    highlightSprite.alpha = 0.16;
    highlightSprite.blendMode = "add";
    app.stage.addChild(scene);
    app.stage.addChild(displacementSprite);
    app.stage.addChild(highlightSprite);

    const displacementFilter = new modules.DisplacementFilter(displacementSprite);
    displacementFilter.scale.x = 24;
    displacementFilter.scale.y = 20;
    scene.filters = [displacementFilter];

    pixiRenderer = {
      app,
      modules,
      scene,
      backgroundCanvas,
      backgroundCtx,
      backgroundTexture,
      backgroundSprite,
      videoSprite,
      videoTexture: null,
      displacementCanvas,
      displacementCtx,
      displacementTexture,
      displacementSprite,
      highlightSprite,
      displacementFilter,
    };

    pixiAvailable = true;
    camera.classList.add("pixi-hidden");
  } catch (error) {
    console.warn("Pixi renderer unavailable, keeping 2D fallback.", error);
    pixiAvailable = false;
    pixiInitStarted = false;
    camera.classList.remove("pixi-hidden");
  }
}

function traceWakeFront(context, wake, age, scale = 1) {
  const progress = clamp(age / 1650, 0, 1);
  const perpendicularX = -wake.directionY;
  const perpendicularY = wake.directionX;
  const travel = (8 + progress * 24) * scale;
  const length = (18 + progress * 88) * scale;
  const width = (10 + progress * 36) * scale;
  const headX = wake.x + wake.directionX * travel;
  const headY = wake.y + wake.directionY * travel;
  const tailX = headX - wake.directionX * length;
  const tailY = headY - wake.directionY * length;
  const offsetX = perpendicularX * width;
  const offsetY = perpendicularY * width;

  context.beginPath();
  context.moveTo(tailX + offsetX, tailY + offsetY);
  context.quadraticCurveTo(
    headX - wake.directionX * length * 0.28 + offsetX * 0.46,
    headY - wake.directionY * length * 0.28 + offsetY * 0.46,
    headX,
    headY,
  );
  context.quadraticCurveTo(
    headX - wake.directionX * length * 0.28 - offsetX * 0.46,
    headY - wake.directionY * length * 0.28 - offsetY * 0.46,
    tailX - offsetX,
    tailY - offsetY,
  );
}

function renderTrailBody(trail, hasCameraFrame) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const points = trail.points;
  if (points.length < 2) {
    return;
  }

  const now = performance.now();
  const livePoints = points.filter((point) => now - point.createdAt < 1150);
  if (livePoints.length < 2) {
    return;
  }

  const head = livePoints[livePoints.length - 1];
  const previous = livePoints[livePoints.length - 2];
  const motion = Math.max(1, getPointDistance(head, previous));
  const speed = clamp(motion / 18, 0, 1);
  const bodyWidth = 22 + head.strength * 8 + speed * 15;
  const time = performance.now() * 0.001;
  const renderRibbon = (layer) => drawRefractionLayer(ctx, hasCameraFrame ? refractionCanvas : null, {
    composite: layer.composite,
    layerAlpha: layer.layerAlpha,
    alpha: layer.alpha,
    blur: layer.blur,
    shiftX: (head.x - previous.x) * layer.shiftScale,
    shiftY: (head.y - previous.y) * layer.shiftScale,
    mask: (maskCtx) => {
      maskCtx.save();
      maskCtx.fillStyle = "#fff";
      const scaledPoints = scaleRibbonPoints(livePoints, layer.widthScale, layer.strengthBoost);
      if (traceRibbonShape(maskCtx, scaledPoints, {
        baseWidth: layer.baseWidth,
        tailWidth: layer.tailWidth,
        strengthWidth: layer.strengthWidth,
        flutterStrength: layer.flutterStrength,
        flutterFrequency: layer.flutterFrequency,
        noiseOffset: layer.noiseOffset,
        time,
      })) {
        maskCtx.fill();
      }
      maskCtx.beginPath();
      maskCtx.arc(head.x, head.y, bodyWidth * layer.headScale, 0, Math.PI * 2);
      maskCtx.fill();
      maskCtx.restore();
    },
    fallback: (maskCtx) => {
      const fill = maskCtx.createLinearGradient(head.x - 72, head.y - 72, head.x + 92, head.y + 92);
      fill.addColorStop(0, layer.fallbackStart);
      fill.addColorStop(0.52, layer.fallbackMid);
      fill.addColorStop(1, layer.fallbackEnd);
      maskCtx.fillStyle = fill;
      maskCtx.fillRect(0, 0, width, height);
    },
  });

  renderRibbon({
    composite: "multiply",
    layerAlpha: 0.62,
    alpha: 0.96,
    blur: 1.6,
    shiftScale: -0.16,
    widthScale: 1.12,
    strengthBoost: 1.18,
    baseWidth: 12,
    tailWidth: 16,
    strengthWidth: 8.5,
    flutterStrength: 0.78,
    flutterFrequency: 0.36,
    noiseOffset: 1.8,
    headScale: 0.34,
    fallbackStart: "rgba(10, 18, 28, 0.24)",
    fallbackMid: "rgba(20, 34, 48, 0.42)",
    fallbackEnd: "rgba(8, 14, 22, 0.2)",
  });
  renderRibbon({
    composite: "screen",
    layerAlpha: 0.52,
    alpha: 0.34,
    blur: 0.45,
    shiftScale: 0.18,
    widthScale: 0.92,
    strengthBoost: 0.92,
    baseWidth: 8,
    tailWidth: 11,
    strengthWidth: 5.8,
    flutterStrength: 0.42,
    flutterFrequency: 0.4,
    noiseOffset: 8.4,
    headScale: 0.21,
    fallbackStart: "rgba(255, 255, 255, 0.08)",
    fallbackMid: "rgba(190, 214, 228, 0.18)",
    fallbackEnd: "rgba(255, 255, 255, 0.04)",
  });

  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = "rgba(8, 18, 30, 0.2)";
  if (traceRibbonShape(ctx, scaleRibbonPoints(livePoints, 1.04, 1.05), {
    baseWidth: 11,
    tailWidth: 15,
    strengthWidth: 8,
    flutterStrength: 0.52,
    flutterFrequency: 0.38,
    noiseOffset: 4.2,
    time,
  })) {
    ctx.fill();
  }
  ctx.restore();

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.strokeStyle = "rgba(238, 247, 255, 0.32)";
  ctx.lineWidth = Math.max(0.8, bodyWidth * 0.065);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  traceSmoothPath(ctx, livePoints);
  ctx.stroke();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  ctx.lineWidth = Math.max(1.2, bodyWidth * 0.12);
  ctx.filter = "blur(2px)";
  traceSmoothPath(ctx, livePoints);
  ctx.stroke();
  ctx.filter = "none";

  ctx.fillStyle = "rgba(246, 250, 255, 0.22)";
  ctx.beginPath();
  ctx.arc(head.x, head.y, bodyWidth * 0.18, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function renderTrailWake(trail, now, hasCameraFrame) {
  const wakes = trail.wakes.filter((wake) => now - wake.createdAt < 1650);
  trail.wakes = wakes;
  const visibleWakes = wakes.slice(-2);
  if (visibleWakes.length === 0) {
    return;
  }

  const renderShell = (layer) => {
    drawRefractionLayer(ctx, hasCameraFrame ? refractionCanvas : null, {
      composite: layer.composite,
      layerAlpha: layer.layerAlpha,
      alpha: layer.alpha,
      blur: layer.blur,
      shiftX: layer.shiftX,
      shiftY: layer.shiftY,
      mask: (maskCtx) => {
        maskCtx.save();
        maskCtx.strokeStyle = "#fff";
        maskCtx.lineCap = "round";
        maskCtx.lineJoin = "round";
        for (const wake of visibleWakes) {
          const age = now - wake.createdAt;
          const progress = clamp(age / 1650, 0, 1);
          maskCtx.globalAlpha = Math.sin(progress * Math.PI) * layer.fade;
          maskCtx.lineWidth = (layer.lineWidth - progress * layer.lineDecay) * layer.scale;
          traceWakeFront(maskCtx, wake, age, layer.scale);
          maskCtx.stroke();
        }
        maskCtx.restore();
      },
      fallback: (maskCtx, width, height) => {
        const fill = maskCtx.createLinearGradient(0, 0, width, height);
        fill.addColorStop(0, layer.fallbackStart);
        fill.addColorStop(0.48, layer.fallbackMid);
        fill.addColorStop(1, layer.fallbackEnd);
        maskCtx.fillStyle = fill;
        maskCtx.fillRect(0, 0, width, height);
      },
    });
  };

  renderShell({
    composite: "multiply",
    layerAlpha: 0.3,
    alpha: 0.72,
    blur: 1.8,
    shiftX: -2,
    shiftY: 1,
    scale: 1.08,
    fade: 0.18,
    lineWidth: 13,
    lineDecay: 8,
    fallbackStart: "rgba(14, 22, 34, 0.18)",
    fallbackMid: "rgba(24, 34, 46, 0.28)",
    fallbackEnd: "rgba(10, 16, 24, 0.12)",
  });
  renderShell({
    composite: "screen",
    layerAlpha: 0.16,
    alpha: 0.28,
    blur: 0.9,
    shiftX: 1,
    shiftY: -1,
    scale: 1,
    fade: 0.11,
    lineWidth: 8,
    lineDecay: 5.5,
    fallbackStart: "rgba(215, 230, 240, 0.08)",
    fallbackMid: "rgba(255, 255, 255, 0.18)",
    fallbackEnd: "rgba(190, 214, 228, 0.06)",
  });

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const wake of visibleWakes) {
    const age = now - wake.createdAt;
    const progress = clamp(age / 1650, 0, 1);
    ctx.globalAlpha = Math.sin(progress * Math.PI) * 0.06;
    ctx.strokeStyle = "rgba(240, 248, 255, 0.78)";
    ctx.lineWidth = Math.max(0.5, 1.1 - progress * 0.7);
    traceWakeFront(ctx, wake, age, 1);
    ctx.stroke();
  }
  ctx.restore();
}

function animateRipples() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const now = performance.now();
  const usingPixi = renderPixiScene(now);
  ctx.clearRect(0, 0, width, height);
  if (!usingPixi) {
    drawBackground(width, height);
  }

  for (const [id, trail] of trails) {
    const segments = trail.points.length - 1;
    if (segments <= 0 && trail.wakes.length === 0) {
      if (!trail.active) {
        trail.idleFrames += 1;
        if (trail.idleFrames > 36) {
          trails.delete(id);
        }
      }
      continue;
    }

    trail.points = trail.points.filter((point) => now - point.createdAt < 1100);
    if (trail.active) {
      trail.idleFrames = 0;
    } else {
      trail.idleFrames += 1;
      if (trail.idleFrames > 140 && trail.wakes.length === 0) {
        trails.delete(id);
      }
    }
  }
  requestAnimationFrame(animateRipples);
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

function bindDemoInput() {
  const getPoint = (event) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };

  const emitTrail = (event, strength = 1) => {
    const point = getPoint(event);
    const demoTrail = trails.get("demo") || createTrail("demo");
    trails.set("demo", demoTrail);
    pushTrailPoint(demoTrail, point.x, point.y, strength);
    demoTrail.active = true;
    demoTrail.idleFrames = 0;
  };

  window.addEventListener("pointerdown", (event) => {
    pointerDown = true;
    emitTrail(event, 1.2);
  });

  window.addEventListener("pointermove", (event) => {
    if (!pointerDown && event.pointerType !== "mouse") {
      return;
    }
    emitTrail(event, pointerDown ? 1.2 : 1);
  });

  window.addEventListener("pointerup", () => {
    pointerDown = false;
  });

  window.addEventListener("pointercancel", () => {
    pointerDown = false;
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
  if (hands) {
    return hands;
  }

  await loadScript(handLandmarksUrl);

  hands = new window.Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });

  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6,
  });

  hands.onResults((results) => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const palm = results.multiHandLandmarks?.[0];
    const handedness = results.multiHandedness?.[0]?.label?.toLowerCase() || "right";

    if (palm) {
      const activeFingers = getActiveFingers(palm, handedness);

      if (activeFingers.length === 0) {
        trails.clear();
        setStatus("Fist detected. Keep your hand open to draw water.");
        return;
      }

      activeFingers.forEach((finger) => {
        const trail = trails.get(finger.id) || createTrail(finger.id);
        trails.set(finger.id, trail);
        const point = getCanvasPointFromRaw(palm[finger.tip], width, height);
        pushTrailPoint(trail, point.x, point.y, finger.id === "thumb" ? 1.08 : 1);
        trail.active = true;
        trail.idleFrames = 0;
      });

      for (const [id, trail] of trails) {
        if (!activeFingers.some((finger) => finger.id === id)) {
          trail.active = false;
        }
      }

      setStatus(`Tracking ${activeFingers.length} finger${activeFingers.length > 1 ? "s" : ""}.`);
    } else if (videoReady) {
      setStatus("Camera is live. Put one hand in frame.");
    }
  });

  return hands;
}

async function startCamera() {
  try {
    setStatus("Starting camera...");
    if (!isSecureEnough()) {
      throw new Error("Camera needs HTTPS on phones. Deploy this page to GitHub Pages or another secure host.");
    }
    const hasCamera = navigator.mediaDevices?.getUserMedia;
    if (!hasCamera) {
      throw new Error("Camera access is not supported in this browser.");
    }

    await ensureHands();
    resizeCanvas();

    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }

    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: currentFacingMode,
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    camera.srcObject = stream;
    camera.classList.toggle("mirrored", isMirroredCamera());
    await camera.play();
    demoMode = false;
    trails.clear();
    cameraPlacement = null;
    videoReady = true;
    switchBtn.disabled = false;
    trackLoopRunning = true;

    const sendFrame = async () => {
      if (!trackLoopRunning) {
        return;
      }
      if (camera.readyState >= 2 && !processingFrame) {
        processingFrame = true;
        try {
          await hands.send({ image: camera });
        } finally {
          processingFrame = false;
        }
      }
      requestAnimationFrame(sendFrame);
    };

    requestAnimationFrame(sendFrame);
    setStatus("Camera ready. Move your fingers to create ripples.");
  } catch (error) {
    console.error(error);
    demoMode = true;
    videoReady = false;
    switchBtn.disabled = true;
    trails.clear();
    setStatus("Demo mode: move or drag the mouse to draw water trails.");
  }
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

function switchCamera() {
  currentFacingMode = currentFacingMode === "user" ? "environment" : "user";
  trackLoopRunning = false;
  startCamera();
}

window.addEventListener("resize", resizeCanvas);
startBtn.addEventListener("click", startCamera);
switchBtn.addEventListener("click", switchCamera);
copyUrlBtn.addEventListener("click", copyPhoneLink);
bindDemoInput();

resizeCanvas();
initPixiRenderer();
animateRipples();
setStatus("Demo mode: move or drag the mouse to draw water trails.");
updateConnectionHint();
registerServiceWorker();
