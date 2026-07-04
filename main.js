const camera = document.getElementById("camera");
const canvas = document.getElementById("output");
const ctx = canvas.getContext("2d");
const startBtn = document.getElementById("startBtn");
const switchBtn = document.getElementById("switchBtn");
const statusEl = document.getElementById("status");

let stream = null;
let currentFacingMode = "user";
let hands = null;
let videoReady = false;
let trackLoopRunning = false;
let processingFrame = false;
let ripples = [];

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

function addRipple(x, y, strength = 1) {
  ripples.push({
    x,
    y,
    radius: 4,
    maxRadius: 72 + strength * 34,
    alpha: 0.5 + strength * 0.18,
    hue: 190 + Math.random() * 40,
    life: 0,
  });
}

function drawBackground(width, height) {
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "rgba(6, 11, 24, 0.08)");
  gradient.addColorStop(1, "rgba(5, 8, 22, 0.18)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function drawRipple(ripple) {
  const { x, y, radius, maxRadius, alpha, hue } = ripple;
  const fade = 1 - radius / maxRadius;
  const outerAlpha = Math.max(0, alpha * fade);
  const innerAlpha = Math.max(0, alpha * fade * 0.6);

  const inner = ctx.createRadialGradient(x, y, Math.max(0.5, radius * 0.15), x, y, radius);
  inner.addColorStop(0, `hsla(${hue}, 100%, 92%, ${innerAlpha})`);
  inner.addColorStop(0.45, `hsla(${hue}, 100%, 78%, ${innerAlpha * 0.75})`);
  inner.addColorStop(1, `hsla(${hue}, 100%, 65%, 0)`);

  ctx.fillStyle = inner;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = `hsla(${hue}, 100%, 85%, ${outerAlpha})`;
  ctx.lineWidth = Math.max(1.5, 5 - radius * 0.025);
  ctx.beginPath();
  ctx.arc(x, y, radius * 0.75, 0, Math.PI * 2);
  ctx.stroke();
}

function animateRipples() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  ctx.clearRect(0, 0, width, height);
  drawBackground(width, height);

  ripples = ripples.filter((ripple) => ripple.radius < ripple.maxRadius && ripple.alpha > 0.01);
  for (const ripple of ripples) {
    ripple.radius += 1.8 + ripple.life * 0.04;
    ripple.alpha *= 0.98;
    ripple.life += 1;
    drawRipple(ripple);
  }

  requestAnimationFrame(animateRipples);
}

function getHandPoints(landmarks, width, height) {
  const fingerTips = [4, 8, 12, 16, 20];
  return fingerTips.map((index) => ({
    x: (1 - landmarks[index].x) * width,
    y: landmarks[index].y * height,
  }));
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
      const tips = getHandPoints(palm, width, height);
      tips.forEach((point, index) => {
        addRipple(point.x, point.y, index === 0 ? 1.15 : 1);
      });
      setStatus("Finger motion detected. Move your hand inside the camera.");
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
    setStatus(error.message || "Could not start the camera.");
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

resizeCanvas();
animateRipples();
registerServiceWorker();
