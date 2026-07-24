/* ============================================================
   JOE CURRY — Felt signal field renderer
   An original analytic WebGL signal surface. Quiet at rest;
   local input produces a brief refractive response, then clears.
   ============================================================ */
(function (root) {
  "use strict";

  function createSignalPool(gl, options) {
    const O = Object.assign({
      dprCap: 1.5,
      life: 1.45,
      maxRipples: 12
    }, options || {});

    const MAX_RIPPLES = 24;
    const rippleLife = Math.min(1.5, Math.max(1.2, Number(O.life) || 1.45));
    const rippleLimit = Math.min(12, MAX_RIPPLES, Math.max(1, Number(O.maxRipples) || 12));
    const VERT = `#version 300 es
      in vec2 p;
      out vec2 uv;
      void main() {
        uv = p * 0.5 + 0.5;
        gl_Position = vec4(p, 0.0, 1.0);
      }`;

    const FRAG = `#version 300 es
      precision highp float;
      #define MAX_RIPPLES 24

      in vec2 uv;
      out vec4 outColor;
      uniform vec4 u_ripples[MAX_RIPPLES];
      uniform int u_count;
      uniform vec2 u_resolution;

      void main() {
        float aspect = u_resolution.x / max(u_resolution.y, 1.0);
        float heightField = 0.0;
        vec2 gradient = vec2(0.0);

        for (int i = 0; i < MAX_RIPPLES; i++) {
          if (i >= u_count) break;
          vec4 ripple = u_ripples[i];
          vec2 delta = uv - ripple.xy;
          delta.x *= aspect;
          float distanceToDrop = max(length(delta), 0.0001);
          float age = ripple.z;
          float strength = ripple.w;
          float travel = age * 0.22;

          /* A compact moving wavefront with a quickly resolving wake. */
          float ahead = distanceToDrop - travel;
          float frontGate = 1.0 - smoothstep(0.018, 0.064, ahead);
          float trailing = exp(-max(travel - distanceToDrop, 0.0) * 8.0);
          float lifetime = 1.0 - smoothstep(0.88, 1.45, age);
          float temporal = exp(-age * 2.85);
          float envelope = frontGate * trailing * lifetime * temporal;
          float phase = (distanceToDrop - travel) * 96.0;
          float wave = sin(phase);

          heightField += wave * envelope * strength * 1.65;
          float radialSlope = (96.0 * cos(phase) - 8.0 * wave) * envelope * strength * 1.35;
          gradient += (delta / distanceToDrop) * radialSlope;
        }

        vec3 base = vec3(0.031, 0.184, 0.133);
        vec3 deep = vec3(0.016, 0.110, 0.078);
        vec3 lifted = vec3(0.078, 0.314, 0.227);
        vec3 brass = vec3(0.635, 0.529, 0.333);
        vec3 paper = vec3(0.890, 0.867, 0.796);

        float lift = tanh(heightField * 2.0);
        vec3 color = mix(base, lifted, max(lift, 0.0));
        color = mix(color, deep, max(-lift, 0.0) * 0.92);

        vec3 normal = normalize(vec3(-gradient * 0.016, 1.0));
        vec3 lightDir = normalize(vec3(-0.42, 0.54, 0.86));
        vec3 halfDir = normalize(lightDir + vec3(0.0, 0.0, 1.0));
        float surfaceEnergy = smoothstep(0.012, 0.24, length(normal.xy));
        float crest = smoothstep(0.020, 0.11, heightField);
        float specular = pow(max(dot(normal, halfDir), 0.0), 76.0) * surfaceEnergy * crest;
        float pinLight = pow(max(dot(normal, halfDir), 0.0), 190.0) * surfaceEnergy * crest;
        float fresnel = pow(1.0 - clamp(normal.z, 0.0, 1.0), 3.0);

        color += brass * specular * 0.24;
        color += paper * pinLight * 0.08;
        color += lifted * fresnel * 0.14;

        /* Barely perceptible depth when still; never a decorative gradient. */
        color *= mix(0.955, 1.025, uv.y);
        float vignette = 1.0 - smoothstep(0.34, 0.88, length(uv - 0.5));
        color *= 0.975 + vignette * 0.025;

        outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
      }`;

    function compile(type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader) || "Unknown shader error";
        gl.deleteShader(shader);
        throw new Error(message);
      }
      return shader;
    }

    const program = gl.createProgram();
    const vertex = compile(gl.VERTEX_SHADER, VERT);
    const fragment = compile(gl.FRAGMENT_SHADER, FRAG);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.bindAttribLocation(program, 0, "p");
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "Unable to link signal field");
    }

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const rippleLocation = gl.getUniformLocation(program, "u_ripples[0]");
    const countLocation = gl.getUniformLocation(program, "u_count");
    const resolutionLocation = gl.getUniformLocation(program, "u_resolution");
    const packed = new Float32Array(MAX_RIPPLES * 4);

    let cssWidth = 1;
    let cssHeight = 1;
    let ripples = [];
    let flings = [];
    let previousTime = 0;

    function splat(x, y, strength) {
      const now = performance.now() / 1000;
      ripples.push({
        x: Math.max(-0.1, Math.min(1.1, x)),
        y: 1 - Math.max(-0.1, Math.min(1.1, y)),
        born: now,
        strength: Math.max(0.015, Math.min(0.72, strength || 0.1))
      });
      while (ripples.length > rippleLimit) ripples.shift();
    }

    function fling(x, y, vx, vy) {
      flings.push({
        x, y, vx, vy,
        emission: 0,
        tau: 0.21
      });
      while (flings.length > 8) flings.shift();
    }

    function resize(width, height, dpr) {
      cssWidth = Math.max(1, width || 1);
      cssHeight = Math.max(1, height || 1);
      const scale = Math.min(dpr || 1, Number(O.dprCap) || 1.5, 1.5);
      const pixelWidth = Math.max(1, Math.round(cssWidth * scale));
      const pixelHeight = Math.max(1, Math.round(cssHeight * scale));
      if (gl.canvas.width !== pixelWidth || gl.canvas.height !== pixelHeight) {
        gl.canvas.width = pixelWidth;
        gl.canvas.height = pixelHeight;
      }
      gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
      draw(performance.now() / 1000);
    }

    function updateFlings(delta) {
      for (let i = flings.length - 1; i >= 0; i--) {
        const flingState = flings[i];
        flingState.x += flingState.vx * delta;
        flingState.y += flingState.vy * delta;
        const decay = Math.exp(-delta / flingState.tau);
        flingState.vx *= decay;
        flingState.vy *= decay;
        flingState.emission -= delta;
        const speed = Math.hypot(flingState.vx, flingState.vy);

        if (flingState.emission <= 0) {
          flingState.emission = 0.045;
          splat(flingState.x, flingState.y, Math.min(0.13, speed * 0.07));
        }

        if (
          speed < 0.1 ||
          flingState.x < -0.2 || flingState.x > 1.2 ||
          flingState.y < -0.2 || flingState.y > 1.2
        ) {
          flings.splice(i, 1);
        }
      }
    }

    function draw(now) {
      packed.fill(0);
      for (let i = 0; i < ripples.length; i++) {
        const ripple = ripples[i];
        const offset = i * 4;
        packed[offset] = ripple.x;
        packed[offset + 1] = ripple.y;
        packed[offset + 2] = Math.max(0, now - ripple.born);
        packed[offset + 3] = ripple.strength;
      }

      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.uniform4fv(rippleLocation, packed);
      gl.uniform1i(countLocation, ripples.length);
      gl.uniform2f(resolutionLocation, cssWidth, cssHeight);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function frame() {
      const now = performance.now() / 1000;
      const delta = previousTime ? Math.min(now - previousTime, 0.05) : 0.016;
      previousTime = now;
      updateFlings(delta);
      ripples = ripples.filter((ripple) => now - ripple.born < rippleLife);
      draw(now);
      return ripples.length > 0 || flings.length > 0;
    }

    function hasActivity() {
      return ripples.length > 0 || flings.length > 0;
    }

    draw(performance.now() / 1000);
    return { resize, splat, fling, frame, hasActivity };
  }

  root.createSignalPool = createSignalPool;
})(typeof self !== "undefined" ? self : window);
