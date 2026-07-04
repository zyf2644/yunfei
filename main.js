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

function updateConnectionHint() {
  if (isSecureEnough()) {
    setConnectionHint("On phones, camera access works best from HTTPS. If you open this over a local IP, it can still view the scene, but full camera permission usually needs a secure host such as GitHub Pages.");
    return;
  }

  setConnectionHint("This page can open on a phone over Wi-Fi, but camera permission usually needs HTTPS. Use GitHub Pages or another secure host for the full experience.");
}

function getCanvasPoint(point, width, height) {
  return {
    x: (1 - point.x) * width,
    y: point.y * height,
  };
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
    active: false,
    lastPoint: null,
    idleFrames: 0,
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
  if (trail.points.length > 36) {
    trail.points.shift();
  }
  trail.lastPoint = nextPoint;
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

function updateRefractionFrame(width, height) {
  if (!videoReady || camera.readyState < 2) {
    return false;
  }

  if (refractionCanvas.width !== Math.ceil(width) || refractionCanvas.height !== Math.ceil(height)) {
    refractionCanvas.width = Math.ceil(width);
    refractionCanvas.height = Math.ceil(height);
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

  refractionCtx.save();
  refractionCtx.clearRect(0, 0, width, height);
  refractionCtx.translate(width, 0);
  refractionCtx.scale(-1, 1);
  refractionCtx.drawImage(camera, offsetX, offsetY, drawWidth, drawHeight);
  refractionCtx.restore();
  return true;
}

function drawWake(trail, now) {
  const points = trail.points;
  if (points.length < 2) {
    return;
  }

  const livePoints = points.filter((point) => now - point.createdAt < 1450);
  if (livePoints.length < 2) {
    return;
  }

  const head = livePoints[livePoints.length - 1];
  const previous = livePoints[livePoints.length - 2];
  const motionLength = Math.max(1, Math.hypot(head.x - previous.x, head.y - previous.y));
  const speed = Math.min(1, motionLength / 20);
  const bodyWidth = 25 + head.strength * 9 + speed * 8;
  const hasCameraFrame = updateRefractionFrame(canvas.clientWidth, canvas.clientHeight);

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (liquidCanvas.width !== Math.ceil(width) || liquidCanvas.height !== Math.ceil(height)) {
    liquidCanvas.width = Math.ceil(width);
    liquidCanvas.height = Math.ceil(height);
  }
  liquidCtx.clearRect(0, 0, width, height);
  if (hasCameraFrame) {
    const bulge = 6 + speed * 5;
    liquidCtx.globalAlpha = 0.96;
    liquidCtx.drawImage(refractionCanvas, -bulge, -bulge, width + bulge * 2, height + bulge * 2);
  } else {
    const liquidFill = liquidCtx.createLinearGradient(head.x - 80, head.y - 80, head.x + 80, head.y + 80);
    liquidFill.addColorStop(0, "rgba(255, 255, 255, 0.06)");
    liquidFill.addColorStop(0.45, "rgba(190, 205, 214, 0.2)");
    liquidFill.addColorStop(1, "rgba(255, 255, 255, 0.035)");
    liquidCtx.fillStyle = liquidFill;
    liquidCtx.fillRect(0, 0, width, height);
  }
  liquidCtx.globalAlpha = 1;
  liquidCtx.globalCompositeOperation = "destination-in";
  liquidCtx.lineCap = "round";
  liquidCtx.lineJoin = "round";
  liquidCtx.strokeStyle = "#fff";
  liquidCtx.lineWidth = bodyWidth;
  traceSmoothPath(liquidCtx, livePoints);
  liquidCtx.stroke();
  liquidCtx.globalCompositeOperation = "source-over";
  ctx.drawImage(liquidCanvas, 0, 0);

  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
  ctx.shadowBlur = 8;
  ctx.strokeStyle = "rgba(12, 16, 20, 0.48)";
  ctx.lineWidth = bodyWidth + 7;
  traceSmoothPath(ctx, livePoints);
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.drawImage(liquidCanvas, 0, 0);

  const upperEdge = [];
  const lowerEdge = [];
  for (let index = 0; index < livePoints.length; index += 1) {
    const before = livePoints[Math.max(0, index - 1)];
    const after = livePoints[Math.min(livePoints.length - 1, index + 1)];
    const tangentX = after.x - before.x;
    const tangentY = after.y - before.y;
    const tangentLength = Math.max(1, Math.hypot(tangentX, tangentY));
    const edgeX = (-tangentY / tangentLength) * bodyWidth * 0.5;
    const edgeY = (tangentX / tangentLength) * bodyWidth * 0.5;
    upperEdge.push({ x: livePoints[index].x + edgeX, y: livePoints[index].y + edgeY });
    lowerEdge.push({ x: livePoints[index].x - edgeX, y: livePoints[index].y - edgeY });
  }

  ctx.shadowColor = "rgba(255, 255, 255, 0.45)";
  ctx.shadowBlur = 3;
  ctx.strokeStyle = "rgba(250, 253, 255, 0.72)";
  ctx.lineWidth = 1.5;
  traceSmoothPath(ctx, upperEdge);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(205, 220, 228, 0.42)";
  ctx.lineWidth = 1.1;
  traceSmoothPath(ctx, lowerEdge);
  ctx.stroke();
  ctx.restore();

  const dropletRadius = bodyWidth * 0.62;
  const droplet = ctx.createRadialGradient(
    head.x - dropletRadius * 0.32,
    head.y - dropletRadius * 0.4,
    1,
    head.x,
    head.y,
    dropletRadius,
  );
  droplet.addColorStop(0, "rgba(255, 255, 255, 0.52)");
  droplet.addColorStop(0.18, "rgba(255, 255, 255, 0.05)");
  droplet.addColorStop(0.72, "rgba(120, 140, 150, 0.025)");
  droplet.addColorStop(0.9, "rgba(255, 255, 255, 0.04)");
  droplet.addColorStop(1, "rgba(255, 255, 255, 0.42)");
  ctx.fillStyle = droplet;
  ctx.beginPath();
  ctx.arc(head.x, head.y, dropletRadius, 0, Math.PI * 2);
  ctx.fill();
}

function animateRipples() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  ctx.clearRect(0, 0, width, height);
  drawBackground(width, height);

  ctx.save();
  ctx.globalCompositeOperation = "screen";

  for (const [id, trail] of trails) {
    const segments = trail.points.length - 1;
    if (segments <= 0) {
      if (!trail.active) {
        trail.idleFrames += 1;
        if (trail.idleFrames > 36) {
          trails.delete(id);
        }
      }
      continue;
    }

    const now = performance.now();
    drawWake(trail, now);
    trail.points = trail.points.filter((point) => now - point.createdAt < 1450);
    if (trail.active) {
      trail.idleFrames = 0;
    } else {
      trail.idleFrames += 1;
      if (trail.idleFrames > 36) {
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
  const tipToPip = Math.abs(tip.y - pip.y);
  const pipToMcp = Math.abs(pip.y - mcp.y);
  return tip.y < pip.y - 0.015 && tipToPip > pipToMcp * 0.35;
}

function getActiveFingers(landmarks) {
  const fingerMap = [
    { id: "thumb", tip: 4, pip: 3, mcp: 2 },
    { id: "index", tip: 8, pip: 6, mcp: 5 },
    { id: "middle", tip: 12, pip: 10, mcp: 9 },
    { id: "ring", tip: 16, pip: 14, mcp: 13 },
    { id: "pinky", tip: 20, pip: 18, mcp: 17 },
  ];

  return fingerMap.filter((finger) => isFingerExtended(landmarks, finger.tip, finger.pip, finger.mcp));
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

    if (palm) {
      const activeFingers = getActiveFingers(palm);

      if (activeFingers.length === 0) {
        trails.clear();
        setStatus("Fist detected. Keep your hand open to draw water.");
        return;
      }

      activeFingers.forEach((finger) => {
        const trail = trails.get(finger.id) || createTrail(finger.id);
        trails.set(finger.id, trail);
        const point = getCanvasPoint(palm[finger.tip], width, height);
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
    await camera.play();
    demoMode = false;
    trails.clear();
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
