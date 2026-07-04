const camera = document.getElementById("camera");
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

const handLandmarksUrl = "https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js";

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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

function buildRibbonOutline(points) {
  if (points.length < 2) {
    return null;
  }

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
    const width = 10 + tailFade * 13 + point.strength * 7;
    const flutter = Math.sin(index * 0.9) * (1.2 + tailFade * 1.6);
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

function traceRibbonShape(context, points) {
  const outline = buildRibbonOutline(points);
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
  targetCtx.drawImage(liquidCanvas, 0, 0);
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

  const renderRibbon = (alpha, widthScale, shiftScale, blurAmount) => drawRefractionLayer(ctx, hasCameraFrame ? refractionCanvas : null, {
    alpha,
    blur: blurAmount,
    shiftX: (head.x - previous.x) * shiftScale,
    shiftY: (head.y - previous.y) * shiftScale,
    mask: (maskCtx) => {
      maskCtx.save();
      maskCtx.fillStyle = "#fff";
      const scaledPoints = livePoints.map((point, index) => {
        const tailFade = 1 - index / Math.max(1, livePoints.length - 1);
        return {
          ...point,
          strength: point.strength * widthScale * (0.7 + tailFade * 0.55),
        };
      });
      if (traceRibbonShape(maskCtx, scaledPoints)) {
        maskCtx.fill();
      }
      maskCtx.beginPath();
      maskCtx.arc(head.x, head.y, bodyWidth * 0.42 * widthScale, 0, Math.PI * 2);
      maskCtx.fill();
      maskCtx.restore();
    },
    fallback: (maskCtx) => {
      const fill = maskCtx.createLinearGradient(head.x - 72, head.y - 72, head.x + 92, head.y + 92);
      fill.addColorStop(0, `rgba(255, 255, 255, ${0.12 * alpha})`);
      fill.addColorStop(0.48, `rgba(188, 214, 228, ${0.28 * alpha})`);
      fill.addColorStop(1, `rgba(255, 255, 255, ${0.08 * alpha})`);
      maskCtx.fillStyle = fill;
      maskCtx.fillRect(0, 0, width, height);
    },
  });

  renderRibbon(0.48, 1.0, 0.28, 0.2);
  renderRibbon(0.24, 1.22, -0.1, 1.1);
  renderRibbon(0.12, 1.46, 0.05, 2.2);

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
  if (traceRibbonShape(ctx, livePoints)) {
    ctx.fill();
  }
  ctx.strokeStyle = "rgba(235, 246, 252, 0.24)";
  ctx.lineWidth = Math.max(0.8, bodyWidth * 0.08);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  traceSmoothPath(ctx, livePoints);
  ctx.stroke();
  ctx.fillStyle = "rgba(255, 242, 234, 0.28)";
  ctx.beginPath();
  ctx.arc(head.x, head.y, bodyWidth * 0.22, 0, Math.PI * 2);
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

  const renderShell = (alpha, scale, blurAmount, shiftX, shiftY) => {
    drawRefractionLayer(ctx, hasCameraFrame ? refractionCanvas : null, {
      alpha,
      blur: blurAmount,
      shiftX,
      shiftY,
      mask: (maskCtx) => {
        maskCtx.save();
        maskCtx.strokeStyle = "#fff";
        maskCtx.lineCap = "round";
        maskCtx.lineJoin = "round";
        for (const wake of visibleWakes) {
          const age = now - wake.createdAt;
          const progress = clamp(age / 1650, 0, 1);
          maskCtx.globalAlpha = Math.sin(progress * Math.PI) * 0.18;
          maskCtx.lineWidth = (11 - progress * 7) * scale;
          traceWakeFront(maskCtx, wake, age, scale);
          maskCtx.stroke();
        }
        maskCtx.restore();
      },
      fallback: (maskCtx, width, height) => {
        const fill = maskCtx.createLinearGradient(0, 0, width, height);
        fill.addColorStop(0, "rgba(170, 202, 220, 0.2)");
        fill.addColorStop(0.48, "rgba(255, 255, 255, 0.42)");
        fill.addColorStop(1, "rgba(126, 162, 185, 0.18)");
        maskCtx.fillStyle = fill;
        maskCtx.fillRect(0, 0, width, height);
      },
    });
  };

  renderShell(0.12, 1, 0.4, 2, 1);
  renderShell(0.06, 1.03, 1.2, -1, -1);

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const wake of visibleWakes) {
    const age = now - wake.createdAt;
    const progress = clamp(age / 1650, 0, 1);
    ctx.globalAlpha = Math.sin(progress * Math.PI) * 0.08;
    ctx.strokeStyle = "rgba(235, 247, 255, 0.72)";
    ctx.lineWidth = Math.max(0.6, 1.5 - progress * 0.9);
    traceWakeFront(ctx, wake, age, 1);
    ctx.stroke();
  }
  ctx.restore();
}

function animateRipples() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  ctx.clearRect(0, 0, width, height);
  drawBackground(width, height);

  const hasCameraFrame = updateRefractionFrame(width, height);
  ctx.save();
  ctx.globalCompositeOperation = "screen";

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

    const now = performance.now();
    renderTrailBody(trail, hasCameraFrame);
    renderTrailWake(trail, now, hasCameraFrame);
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

  ctx.restore();
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
animateRipples();
setStatus("Demo mode: move or drag the mouse to draw water trails.");
updateConnectionHint();
registerServiceWorker();
