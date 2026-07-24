/* ============================================================
   JOE CURRY — Liquid signal field controller
   Worker-first rendering with a fresh-canvas WebGL fallback.
   Touch creates a short local wake, then the field returns to rest.
   ============================================================ */
(function () {
  "use strict";

  var root = document.documentElement;
  var field = document.querySelector(".field");
  var motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

  if (!field || motionQuery.matches) {
    root.classList.remove("has-field");
    return;
  }

  var OPTIONS = {
    dprCap: 1.5,
    life: 1.45,
    maxRipples: 12
  };
  var TOUCH_SPACING = 14;
  var TOUCH_MAX_DROPS = 6;
  var FLING_THRESHOLD = 0.4;
  var FLING_CAP = 1.7;

  var driver = null;
  var observer = null;
  var resizeFrame = 0;
  var controlsBound = false;
  var resizeBound = false;
  var staticFallback = false;

  function measurements(canvas) {
    var rect = canvas.getBoundingClientRect();
    return {
      width: Math.max(1, rect.width || window.innerWidth || root.clientWidth || 1),
      height: Math.max(1, rect.height || window.innerHeight || root.clientHeight || 1),
      dpr: Math.max(1, window.devicePixelRatio || 1)
    };
  }

  function pointFromClient(clientX, clientY) {
    var rect = field.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: Math.max(-0.1, Math.min(1.1, (clientX - rect.left) / rect.width)),
      y: Math.max(-0.1, Math.min(1.1, (clientY - rect.top) / rect.height)),
      clientX: clientX,
      clientY: clientY
    };
  }

  function eventTime(event) {
    var stamp = Number(event.timeStamp);
    return isFinite(stamp) && stamp > 0 ? stamp : performance.now();
  }

  function emitDrops(drops) {
    if (!driver || document.hidden || !drops.length) return;
    driver.drops(drops);
  }

  function emitFling(x, y, vx, vy) {
    if (!driver || document.hidden) return;
    driver.fling(x, y, vx, vy);
  }

  function resizeNow() {
    resizeFrame = 0;
    if (!driver || document.hidden || staticFallback) return;
    var size = measurements(field);
    driver.resize(size.width, size.height, size.dpr);
  }

  function scheduleResize() {
    if (resizeFrame || staticFallback) return;
    resizeFrame = requestAnimationFrame(resizeNow);
  }

  function observeField() {
    if (observer) observer.disconnect();
    if ("ResizeObserver" in window) {
      observer = new ResizeObserver(scheduleResize);
      observer.observe(field);
    }

    if (!resizeBound) {
      resizeBound = true;
      window.addEventListener("resize", scheduleResize, { passive: true });
      if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", scheduleResize, { passive: true });
      }
    }
  }

  function findTouch(list, identifier) {
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].identifier === identifier) return list[i];
    }
    return null;
  }

  function bindControls() {
    if (controlsBound) return;
    controlsBound = true;

    var touchState = null;
    var finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    var lastPointer = null;
    var lastPointerWake = 0;

    function sampleTouch(touch, event) {
      var point = pointFromClient(touch.clientX, touch.clientY);
      if (!point) return null;
      point.time = eventTime(event);
      return point;
    }

    function rememberSample(sample) {
      touchState.samples.push(sample);
      var cutoff = sample.time - 120;
      while (touchState.samples.length > 2 && touchState.samples[0].time < cutoff) {
        touchState.samples.shift();
      }
    }

    window.addEventListener("touchstart", function (event) {
      if (touchState || !event.changedTouches.length) return;
      var touch = event.changedTouches[0];
      var sample = sampleTouch(touch, event);
      if (!sample) return;

      touchState = {
        identifier: touch.identifier,
        previous: sample,
        vx: 0,
        vy: 0,
        samples: [sample]
      };
      emitDrops([[sample.x, sample.y, 0.19]]);
    }, { passive: true });

    window.addEventListener("touchmove", function (event) {
      if (!touchState) return;
      var touch = findTouch(event.touches, touchState.identifier);
      if (!touch) return;
      var sample = sampleTouch(touch, event);
      if (!sample) return;

      var previous = touchState.previous;
      var dxPixels = sample.clientX - previous.clientX;
      var dyPixels = sample.clientY - previous.clientY;
      var distance = Math.hypot(dxPixels, dyPixels);
      var deltaSeconds = Math.max(0.008, (sample.time - previous.time) / 1000);
      var rawVx = (sample.x - previous.x) / deltaSeconds;
      var rawVy = (sample.y - previous.y) / deltaSeconds;

      touchState.vx = touchState.vx * 0.6 + rawVx * 0.4;
      touchState.vy = touchState.vy * 0.6 + rawVy * 0.4;
      touchState.previous = sample;
      rememberSample(sample);

      if (distance < 4) return;
      var count = Math.min(
        TOUCH_MAX_DROPS,
        Math.max(1, Math.ceil(distance / TOUCH_SPACING))
      );
      var drops = [];
      for (var i = 1; i <= count; i += 1) {
        var progress = i / count;
        drops.push([
          previous.x + (sample.x - previous.x) * progress,
          previous.y + (sample.y - previous.y) * progress,
          0.035
        ]);
      }
      emitDrops(drops);
    }, { passive: true });

    window.addEventListener("touchend", function (event) {
      if (!touchState) return;
      var touch = findTouch(event.changedTouches, touchState.identifier);
      if (!touch) return;
      var end = sampleTouch(touch, event) || touchState.previous;
      rememberSample(end);

      var samples = touchState.samples;
      var anchor = samples[0];
      for (var i = samples.length - 2; i >= 0; i -= 1) {
        if (end.time - samples[i].time <= 110) anchor = samples[i];
        else break;
      }

      var deltaSeconds = Math.max(0.016, (end.time - anchor.time) / 1000);
      var recentVx = (end.x - anchor.x) / deltaSeconds;
      var recentVy = (end.y - anchor.y) / deltaSeconds;
      var vx = recentVx * 0.72 + touchState.vx * 0.28;
      var vy = recentVy * 0.72 + touchState.vy * 0.28;
      var speed = Math.hypot(vx, vy);

      if (speed >= FLING_THRESHOLD) {
        var capScale = Math.min(1, FLING_CAP / speed);
        emitFling(end.x, end.y, vx * capScale, vy * capScale);
      }
      touchState = null;
    }, { passive: true });

    window.addEventListener("touchcancel", function (event) {
      if (!touchState) return;
      if (findTouch(event.changedTouches, touchState.identifier)) touchState = null;
    }, { passive: true });

    if (finePointer) {
      window.addEventListener("pointermove", function (event) {
        if (event.pointerType === "touch") return;
        var now = performance.now();
        var point = pointFromClient(event.clientX, event.clientY);
        if (!point) return;
        var moved = lastPointer
          ? Math.hypot(point.clientX - lastPointer.clientX, point.clientY - lastPointer.clientY)
          : Infinity;
        lastPointer = point;
        if (now - lastPointerWake < 46 || moved < 9) return;
        lastPointerWake = now;
        emitDrops([[point.x, point.y, 0.028]]);
      }, { passive: true });

      window.addEventListener("pointerdown", function (event) {
        if (event.pointerType === "touch") return;
        var point = pointFromClient(event.clientX, event.clientY);
        if (point) emitDrops([[point.x, point.y, 0.15]]);
      }, { passive: true });
    }

    document.addEventListener("visibilitychange", function () {
      if (!driver) return;
      if (document.hidden) {
        driver.pause();
      } else {
        scheduleResize();
        driver.resume();
      }
    });

    window.addEventListener("pagehide", function () {
      if (driver) driver.pause();
    }, { passive: true });

    window.addEventListener("pageshow", function () {
      if (!driver || document.hidden) return;
      scheduleResize();
      driver.resume();
    }, { passive: true });
  }

  function markReady() {
    staticFallback = false;
    field.style.removeProperty("display");
    root.classList.add("has-field");
    observeField();
    bindControls();
    scheduleResize();
  }

  function makeStatic() {
    staticFallback = true;
    if (driver) driver.pause();
    driver = null;
    root.classList.remove("has-field");
    if (observer) observer.disconnect();
    field.style.display = "none";
  }

  function freshCanvas(canvas) {
    var replacement = canvas.cloneNode(false);
    replacement.removeAttribute("width");
    replacement.removeAttribute("height");
    replacement.style.removeProperty("display");
    if (!canvas.parentNode) return canvas;
    canvas.parentNode.replaceChild(replacement, canvas);
    field = replacement;
    return replacement;
  }

  function startMainThread(canvas) {
    if (typeof window.createSignalPool !== "function") return false;

    var gl = null;
    var pool = null;
    try {
      gl = canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: "high-performance"
      });
      pool = gl && window.createSignalPool(gl, OPTIONS);
    } catch (_) {
      pool = null;
    }
    if (!pool) return false;

    var frameHandle = 0;
    var paused = false;

    function loop() {
      frameHandle = 0;
      if (paused) return;
      if (pool.frame()) frameHandle = requestAnimationFrame(loop);
    }

    function wake() {
      if (paused || frameHandle) return;
      frameHandle = requestAnimationFrame(loop);
    }

    driver = {
      resize: function (width, height, dpr) {
        pool.resize(width, height, dpr);
        wake();
      },
      drops: function (drops) {
        for (var i = 0; i < drops.length; i += 1) {
          pool.splat(drops[i][0], drops[i][1], drops[i][2]);
        }
        wake();
      },
      fling: function (x, y, vx, vy) {
        pool.fling(x, y, vx, vy);
        wake();
      },
      pause: function () {
        paused = true;
        if (frameHandle) cancelAnimationFrame(frameHandle);
        frameHandle = 0;
      },
      resume: function () {
        paused = false;
        wake();
      }
    };

    canvas.addEventListener("webglcontextlost", function (event) {
      event.preventDefault();
      makeStatic();
    }, false);

    var size = measurements(canvas);
    pool.resize(size.width, size.height, size.dpr);
    pool.splat(0.68, 0.72, 0.26);
    wake();
    markReady();
    return true;
  }

  function startWorker(canvas) {
    var supportsOffscreen =
      typeof Worker === "function" &&
      typeof canvas.transferControlToOffscreen === "function";
    if (!supportsOffscreen) return false;

    var worker = null;
    var offscreen = null;
    try {
      worker = new Worker("signal-pool-worker.js?v=1");
      offscreen = canvas.transferControlToOffscreen();
    } catch (_) {
      if (worker) worker.terminate();
      return false;
    }

    var failed = false;
    var ready = false;
    var readyTimer = 0;
    var workerDriver = {
      resize: function (width, height, dpr) {
        worker.postMessage({ type: "resize", width: width, height: height, dpr: dpr });
      },
      drops: function (drops) {
        worker.postMessage({ type: "drops", drops: drops });
      },
      fling: function (x, y, vx, vy) {
        worker.postMessage({ type: "fling", x: x, y: y, vx: vx, vy: vy });
      },
      pause: function () {
        worker.postMessage({ type: "pause" });
      },
      resume: function () {
        worker.postMessage({ type: "resume" });
      }
    };

    function fallBack() {
      if (failed) return;
      failed = true;
      clearTimeout(readyTimer);
      worker.terminate();
      if (driver === workerDriver) driver = null;
      root.classList.remove("has-field");
      var replacement = freshCanvas(canvas);
      if (!startMainThread(replacement)) makeStatic();
    }

    worker.onmessage = function (event) {
      var message = event.data || {};
      if (message.type === "ready" && !failed) {
        ready = true;
        clearTimeout(readyTimer);
        driver = workerDriver;
        markReady();
      } else if (message.type === "fail") {
        fallBack();
      }
    };

    worker.onerror = function (event) {
      event.preventDefault();
      fallBack();
    };

    var size = measurements(canvas);
    try {
      worker.postMessage({
        type: "init",
        canvas: offscreen,
        width: size.width,
        height: size.height,
        dpr: size.dpr,
        options: OPTIONS
      }, [offscreen]);
    } catch (_) {
      fallBack();
      return true;
    }

    readyTimer = window.setTimeout(function () {
      if (!ready) fallBack();
    }, 3500);
    return true;
  }

  if (!startWorker(field) && !startMainThread(field)) makeStatic();
})();
