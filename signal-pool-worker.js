/* Liquid signal field — OffscreenCanvas worker */
/* Version must match the tags in index.html: the worker fetches this file
   under its own cache key, so a mismatch downloads the core twice and can
   run a different build here than on the main thread. */
importScripts("signal-pool-core.js?v=3");

let pool = null;
let running = false;
let frameHandle = 0;
let cssWidth = 1;
let cssHeight = 1;
let dpr = 1;

const scheduleFrame = typeof requestAnimationFrame === "function"
  ? requestAnimationFrame.bind(self)
  : (callback) => setTimeout(() => callback(performance.now()), 16);

const cancelFrame = typeof cancelAnimationFrame === "function"
  ? cancelAnimationFrame.bind(self)
  : clearTimeout.bind(self);

function loop() {
  if (!running || !pool) return;
  const active = pool.frame();
  if (active) {
    frameHandle = scheduleFrame(loop);
  } else {
    running = false;
    frameHandle = 0;
  }
}

function wake() {
  if (running || !pool) return;
  running = true;
  frameHandle = scheduleFrame(loop);
}

function stop() {
  running = false;
  if (frameHandle) cancelFrame(frameHandle);
  frameHandle = 0;
}

self.onmessage = (event) => {
  const message = event.data || {};

  if (message.type === "init") {
    cssWidth = message.width || 1;
    cssHeight = message.height || 1;
    dpr = message.dpr || 1;
    let gl = null;

    try {
      gl = message.canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: "high-performance"
      });
      pool = gl && typeof createSignalPool === "function"
        ? createSignalPool(gl, message.options || {})
        : null;
    } catch (_) {
      pool = null;
    }

    if (!pool) {
      self.postMessage({ type: "fail" });
      return;
    }

    /* Context loss is routine — GPU driver resets, Android backgrounding,
       the process recycling under memory pressure. The context is created
       with alpha:false, so a lost drawing buffer composites as OPAQUE BLACK
       across this fixed full-viewport canvas. Without this handler the main
       thread never learns, keeps the "live" badge up, and the page shows a
       black slab for the rest of the session. preventDefault() is what makes
       the context restorable at all. */
    try {
      message.canvas.addEventListener("webglcontextlost", function (event) {
        event.preventDefault();
        stop();
        /* Null the pool too: the `if (!pool) return` gate below is what stops
           incoming drops/resizes from calling into a dead GL context and
           waking the loop again. */
        pool = null;
        self.postMessage({ type: "lost" });
      });
      message.canvas.addEventListener("webglcontextrestored", function () {
        try {
          var restored = message.canvas.getContext("webgl2", {
            alpha: false, antialias: false, depth: false, stencil: false,
            powerPreference: "high-performance"
          });
          pool = restored && typeof createSignalPool === "function"
            ? createSignalPool(restored, message.options || {})
            : null;
        } catch (_) {
          pool = null;
        }
        if (!pool) { self.postMessage({ type: "fail" }); return; }
        pool.resize(cssWidth, cssHeight, dpr);
        wake();
        self.postMessage({ type: "ready" });
      });
    } catch (_) { /* an engine without listener support still gets the fail path */ }

    pool.resize(cssWidth, cssHeight, dpr);
    pool.splat(0.68, 0.72, 0.26);
    wake();
    self.postMessage({ type: "ready" });
    return;
  }

  if (!pool) return;

  if (message.type === "resize") {
    cssWidth = message.width || cssWidth;
    cssHeight = message.height || cssHeight;
    dpr = message.dpr || dpr;
    pool.resize(cssWidth, cssHeight, dpr);
    wake();
  } else if (message.type === "drops" && Array.isArray(message.drops)) {
    message.drops.forEach((drop) => pool.splat(drop[0], drop[1], drop[2]));
    wake();
  } else if (message.type === "fling") {
    pool.fling(message.x, message.y, message.vx, message.vy);
    wake();
  } else if (message.type === "pause") {
    stop();
  } else if (message.type === "resume") {
    wake();
  }
};
