// The landing page's orb (src/components/Hero.astro): a particle orb ported from the Caitlyn app's PulsingOrbBackground
// (its shaders, in plain WebGL rather than three.js). An amber disc, inner particles whose density follows the design
// system's approved amber orb artwork (so at rest it settles into that familiar stipple), and an outer ring flowing
// inward. On load it slides in from the right, moves for a moment and slows to a faint drift; a pointer near it wakes
// it, and its recent path gently pushes and turns the particles (never at the rim). Reduced motion draws one still frame; with no WebGL the
// approved artwork stays as it is. A new orb treatment, art-directed by the product owner (Nov 2026), not a redrawing
// of the approved asset.

const hero = document.querySelector<HTMLElement>('[data-orb]');
const box = hero?.querySelector<HTMLElement>('.caitlyn-hero-orb');
const art = box?.querySelector<HTMLImageElement>('img');
const canvas = document.createElement('canvas');
const gl = hero && box && art ? canvas.getContext('webgl', { antialias: false, alpha: true, premultipliedAlpha: true }) : null;
if (hero && box && art && gl) start(hero, box, art, gl);

function start(hero: HTMLElement, box: HTMLElement, art: HTMLImageElement, gl: WebGLRenderingContext) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  canvas.className = 'caitlyn-hero-orb-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  hero.prepend(canvas);
  let running = false;
  let innerBufs: Record<string, [WebGLBuffer, number]> | null = null;
  const hexRgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  // Tuned with the product owner in the prototype (Nov 2026): amber-primary disc, amber-mark ring, the inner particles between them
  const S = {
    bg: hexRgb('#ffbb26'), inner: hexRgb('#ffca4b'), outer: hexRgb('#ffd970'),
    slide: 2, // seconds the slide in from the right takes, on cubic-bezier(0, 0.65, 0.1, 1)
    hold: 3, // seconds it moves after loading
    settle: 3, // seconds it takes to slow to its faint resting drift
    speed: 0.65,
    near: 0.3, // a pointer within this much of the orb's width of its edge wakes it
    fluid: 0.009, swirl: 0.7, reach: 0.085, // the pointer's push: heavily damped
    size: 1.3, distort: 0.1,
  };

  // ---------------------------------------------------------------- shaders (ported from the app's PulsingOrbBackground)
  const COMMON = `
    precision highp float;
    uniform vec2 uCenter; uniform float uDiameter; uniform vec2 uRes;
    vec4 toClip(vec2 p) {
      vec2 px = uCenter + vec2(p.x, -p.y) * uDiameter;
      return vec4(px.x / uRes.x * 2.0 - 1.0, 1.0 - px.y / uRes.y * 2.0, 0.0, 1.0);
    }`;
  const FLUID = `
    uniform vec4 uTrail[12]; uniform float uAge[12];
    uniform float uFluid; uniform float uSwirl; uniform float uReach;
    // The cursor's recent path pushes particles along its motion and turns them around it, fading as the path ages
    vec2 fluid(vec2 p) {
      vec2 d = vec2(0.0);
      for (int i = 0; i < 12; i++) {
        vec2 r = p - uTrail[i].xy;
        vec2 v = uTrail[i].zw;
        float g = exp(-dot(r, r) / (uReach * uReach)) * exp(-uAge[i] * 1.1);
        d += (v * uFluid + vec2(-r.y, r.x) * length(v) * uSwirl * uFluid) * g;
      }
      float m = length(d);
      d = m > 0.035 ? d / m * 0.035 : d;
      // Nothing at the rim: the push fades out toward the edge, so it never opens gaps in it
      return d * (1.0 - smoothstep(0.38, 0.48, length(p)));
    }`;
  const CLIP = `
    uniform vec2 uCenter; uniform float uDiameter; uniform vec2 uRes;
    // How much of this pixel is inside the orb: a clean, anti-aliased edge however the particles straddle it
    float inside() {
      vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
      return clamp((0.5 - length((px - uCenter) / uDiameter)) * uDiameter + 0.5, 0.0, 1.0);
    }`;
  const DISC_VS = COMMON + `
    attribute vec2 aPos; varying vec2 vUnit;
    void main() { vUnit = aPos; gl_Position = toClip(aPos); }`;
  const DISC_FS = `
    precision highp float; uniform vec3 uColor; varying vec2 vUnit;` + CLIP + `
    void main() { float a = inside(); if (a <= 0.0) discard; gl_FragColor = vec4(uColor * a, a); }`;
  const INNER_VS = COMMON + FLUID + `
    attribute vec2 aPos; attribute vec4 aWiggle; attribute vec2 aPhase;
    uniform float uTime; uniform float uEnergy; uniform float uEntry; uniform float uSize; uniform float uDistort; uniform float uSeed;
    varying vec2 vUnit;
    float random(vec2 st) { return fract(sin(dot(st, vec2(12.9898, 78.233))) * 43758.5453123); }
    float noise(vec2 st) {
      vec2 i = floor(st); vec2 f = fract(st);
      float a = random(i), b = random(i + vec2(1.0, 0.0)), c = random(i + vec2(0.0, 1.0)), d = random(i + vec2(1.0, 1.0));
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
    }
    float fbm(vec2 st) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(st); st *= 2.0; a *= 0.5; } return v; }
    void main() {
      // The app's water-like distortion, in its own space (the orb eight units across), scaled by how awake the orb is
      vec2 b = aPos * 8.0;
      float ts = uTime * 1.39;
      vec2 warp = vec2(fbm(b * 0.2 + vec2(ts + uSeed, 0.37 * uSeed)), fbm(b * 0.18 + vec2(-0.61 * uSeed, ts)));
      warp = (warp - 0.5) * 1.5;
      float field = fbm(b * 0.2 + warp + vec2(1.7, -3.1));
      float fdx = fbm((b + vec2(0.02, 0.0)) * 0.2 + warp), fdy = fbm((b + vec2(0.0, 0.02)) * 0.2 + warp);
      vec2 flow = vec2(fdy - field, -(fdx - field)) / 0.02;
      float r = length(b);
      vec2 radial = r > 1e-4 ? b / r : vec2(1.0, 0.0);
      vec2 ripple = radial * sin(r * 6.28318 / 1.85 - ts * 2.25) * 1.26;
      vec2 off = (flow * 0.04 + ripple) * uDistort * uEnergy;
      vec2 wig = vec2(sin(uTime * aWiggle.x * 2.0 + aPhase.x) * aWiggle.z, cos(uTime * aWiggle.y * 2.0 + aPhase.y) * aWiggle.w) * 0.0625 * uEnergy;
      vec2 p = (b + off) / 8.0 + wig;
      p += fluid(p);
      vUnit = p;
      gl_PointSize = uSize * uEntry;
      gl_Position = toClip(p);
    }`;
  const OUTER_VS = COMMON + FLUID + `
    attribute vec2 aPos; attribute vec4 aWiggle; attribute vec2 aPhase; attribute vec2 aProgress;
    uniform float uTime; uniform float uEnergy; uniform float uEntry; uniform float uSize; uniform float uSeed;
    varying vec2 vUnit;
    void main() {
      // The app's outer ring: points start at the rim and ease in toward the centre, fading as they arrive
      vec2 dir = normalize(aPos);
      vec2 s = aPos * 8.0;
      float fx = sin((s.y + uSeed * 0.37) * 0.8 + uTime * 1.45 + uSeed * 0.11);
      float fy = -cos((s.x - uSeed * 0.19) * 0.8 - uTime * 1.45 + uSeed * 0.07);
      float flowD = 0.225 * 0.4 * (fx * dir.x + fy * dir.y);
      float progress = mod(uTime * 0.15 + aProgress.x, 1.0);
      float eased = pow(clamp(progress + flowD, 0.0, 1.0), 4.1);
      vec2 inner = mix(aPos, vec2(0.0), aProgress.y);
      vec2 wig = vec2(sin(uTime * aWiggle.x + aPhase.x) * aWiggle.z, cos(uTime * aWiggle.y + aPhase.y) * aWiggle.w) * 0.0625 * uEnergy;
      vec2 p = mix(aPos, inner, eased) + wig;
      p += fluid(p);
      float fade = clamp((progress - 0.93) / 0.07, 0.0, 1.0);
      vUnit = p;
      gl_PointSize = uSize * uEntry * max(0.0, 1.0 - fade * fade);
      gl_Position = toClip(p);
    }`;
  const POINT_FS = `
    precision highp float; uniform vec3 uColor; varying vec2 vUnit;` + CLIP + `
    void main() {
      if (length(gl_PointCoord - 0.5) > 0.5) discard;
      float a = inside(); if (a <= 0.0) discard;
      gl_FragColor = vec4(uColor * a, a);
    }`;

  const compile = (type: number, src: string) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const program = (vs: string, fs: string) => {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u: Record<string, WebGLUniformLocation | null> = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, ''); u[name] = gl.getUniformLocation(p, name); }
    const a: Record<string, number> = {}; const m = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
    for (let i = 0; i < m; i++) { const name = gl.getActiveAttrib(p, i).name; a[name] = gl.getAttribLocation(p, name); }
    return { p, u, a };
  };
  const disc = program(DISC_VS, DISC_FS);
  const inner = program(INNER_VS, POINT_FS);
  const outer = program(OUTER_VS, POINT_FS);
  const buffer = (data: Float32Array) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; };
  const discBuf = buffer(new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]));

  // ---------------------------------------------------------------- particles
  const small = innerWidth < 700;
  const N_INNER = small ? 14000 : 26000;
  const N_OUTER = small ? 14000 : 26000;
  const rnd = Math.random;
  const wiggles = (n: number) => {
    const w = new Float32Array(n * 4), ph = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      w[i * 4] = 0.3 + rnd() * 0.4; w[i * 4 + 1] = 0.2 + rnd() * 0.6; w[i * 4 + 2] = 0.05 + rnd() * 0.1; w[i * 4 + 3] = 0.03 + rnd() * 0.12;
      ph[i * 2] = rnd() * 6.2832; ph[i * 2 + 1] = rnd() * 6.2832;
    }
    return { w, ph };
  };
  // The outer ring: evenly round the rim, each with its own place in the inward cycle and how far in it travels
  const oPos = new Float32Array(N_OUTER * 2), oProg = new Float32Array(N_OUTER * 2);
  for (let i = 0; i < N_OUTER; i++) {
    const a = (i / N_OUTER) * 6.2832;
    oPos[i * 2] = Math.cos(a) * 0.494; oPos[i * 2 + 1] = Math.sin(a) * 0.494; // just inside the rim, so the mask keeps them
    oProg[i * 2] = rnd(); oProg[i * 2 + 1] = Math.max(0, (1.52 + (rnd() * 2 - 1) * 0.28) / 6);
  }
  const ow = wiggles(N_OUTER);
  const outerBufs = { aPos: [buffer(oPos), 2], aProgress: [buffer(oProg), 2], aWiggle: [buffer(ow.w), 4], aPhase: [buffer(ow.ph), 2] };

  // The inner particles: weighted by how much lighter each spot of the approved artwork is than its amber ground
  const sample = () => {
    const G = 192, c = document.createElement('canvas'); c.width = c.height = G;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(art, 0, 0, G, G);
    const d = x.getImageData(0, 0, G, G).data;
    const cells = [], cdf = []; let total = 0;
    const base = 0.2126 * 245 + 0.7152 * 175 + 0.0722 * 59;
    for (let y = 0; y < G; y++) for (let xx = 0; xx < G; xx++) {
      const ux = (xx + 0.5) / G - 0.5, uy = 0.5 - (y + 0.5) / G;
      if (ux * ux + uy * uy > 0.25) continue;
      const k = (y * G + xx) * 4, L = 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2];
      total += Math.max(0, L - base) + 6; cells.push([ux, uy]); cdf.push(total);
    }
    const pick = () => { const n = rnd() * total; let lo = 0, hi = cdf.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < n) lo = m + 1; else hi = m; } return cells[lo]; };
    const pos = new Float32Array(N_INNER * 2);
    for (let i = 0; i < N_INNER; i++) { const [ux, uy] = pick(); pos[i * 2] = ux + (rnd() - 0.5) / G; pos[i * 2 + 1] = uy + (rnd() - 0.5) / G; }
    const iw = wiggles(N_INNER);
    innerBufs = { aPos: [buffer(pos), 2], aWiggle: [buffer(iw.w), 4], aPhase: [buffer(iw.ph), 2] };
    replay();
  };


  // ---------------------------------------------------------------- layout: the site's Edge crop, or its corner variant on a phone
  // The orb sits where the hero's CSS puts its artwork (.caitlyn-hero-orb: the Edge crop, or its corner variant on a
  // phone); the canvas covers the hero and draws it there
  let W = 0, H = 0, dpr = 1, cx = 0, cy = 0, D = 0;
  const layout = () => {
    const r = hero.getBoundingClientRect(), b = box.getBoundingClientRect();
    dpr = Math.min(devicePixelRatio || 1, 2);
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    D = b.width; cx = b.left - r.left + b.width / 2; cy = b.top - r.top + b.height / 2;
    wake();
  };
  

  // ---------------------------------------------------------------- motion state
  let clock = 0, energy = 0, entry = 0, revealAt = performance.now(), last = performance.now();
  const trail = []; let lastPt = null, vel = [0, 0], near = false;
  function replay() { revealAt = performance.now(); entry = reduced ? 1 : 0; energy = reduced ? 0 : 1; wake(); }

  addEventListener('pointermove', (e) => {
    if (reduced) return;
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const ux = (px - cx) / D, uy = -(py - cy) / D;
    const dist = Math.hypot(ux, uy);
    near = dist < 0.5 + S.near;
    const now = performance.now();
    if (lastPt) {
      const dt = Math.max(0.008, (now - lastPt[2]) / 1000);
      const vx = (ux - lastPt[0]) / dt, vy = (uy - lastPt[1]) / dt;
      vel = [vel[0] * 0.85 + vx * 0.15, vel[1] * 0.85 + vy * 0.15];
    }
    lastPt = [ux, uy, now];
    if (dist < 0.75) { trail.push([ux, uy, vel[0], vel[1], now]); if (trail.length > 12) trail.shift(); }
    if (near || trail.length) wake();
  }, { passive: true });
  document.addEventListener('pointerleave', () => { near = false; });

  function wake() { if (!running && innerBufs) { running = true; last = performance.now(); requestAnimationFrame(frame); } }

  const bind = (prog, bufs) => {
    for (const [name, [b, size]] of Object.entries(bufs)) {
      const loc = prog.a[name]; if (loc === undefined || loc < 0) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    }
  };
  const unbind = (prog) => { for (const loc of Object.values(prog.a)) if (loc >= 0) gl.disableVertexAttribArray(loc); };
  const trailU = new Float32Array(48), ageU = new Float32Array(12);
  const common = (prog) => {
    const slideX = (1 - entry) * D * 0.7;
    gl.uniform2f(prog.u.uCenter, (cx + slideX) * dpr, cy * dpr); gl.uniform1f(prog.u.uDiameter, D * dpr); gl.uniform2f(prog.u.uRes, canvas.width, canvas.height);
  };
  const points = (prog, bufs, n, color) => {
    gl.useProgram(prog.p); common(prog); bind(prog, bufs);
    gl.uniform1f(prog.u.uTime, clock); gl.uniform1f(prog.u.uEnergy, Math.max(energy, IDLE.amplitude)); gl.uniform1f(prog.u.uEntry, 1);
    gl.uniform1f(prog.u.uSize, 0.00375 * D * dpr * S.size); gl.uniform1f(prog.u.uSeed, 0.73);
    if (prog.u.uDistort) gl.uniform1f(prog.u.uDistort, S.distort);
    gl.uniform4fv(prog.u.uTrail, trailU); gl.uniform1fv(prog.u.uAge, ageU);
    gl.uniform1f(prog.u.uFluid, S.fluid); gl.uniform1f(prog.u.uSwirl, S.swirl); gl.uniform1f(prog.u.uReach, S.reach);
    gl.uniform3fv(prog.u.uColor, color);
    gl.drawArrays(gl.POINTS, 0, n); unbind(prog);
  };

  // The slide's easing: cubic-bezier(0, 0.65, 0.1, 1), solved for x as CSS does: a steep rise, then a long flattening top
  const bez = (a: number, b: number, u: number) => 3 * a * u * (1 - u) * (1 - u) + 3 * b * u * u * (1 - u) + u * u * u;
  const ease = (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0, hi = 1, u = x;
    for (let i = 0; i < 24; i++) { u = (lo + hi) / 2; if (bez(0, 0.1, u) < x) lo = u; else hi = u; }
    return bez(0.65, 1, u);
  };
  // At rest it never quite stops: a faint drift at a few percent of its speed, drawn at a quarter of the frame rate
  const IDLE = { speed: 0.03, amplitude: 0.3 };
  let tick = 0, visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) wake(); }).observe(canvas);

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    // Entry: the points grow in over a second. Energy: full while the reveal holds, then settles to zero; a nearby
    // pointer wakes it again, and it settles once the pointer moves off
    // Reveal: the orb slides in from the right, quickly at first and then ever more slowly (an ease-out)
    const sinceReveal = (now - revealAt) / 1000;
    const t = reduced ? 1 : Math.min(1, sinceReveal / S.slide);
    entry = ease(t);
    const target = reduced ? 0 : (sinceReveal < S.hold || near) ? 1 : 0;
    const tau = target > energy ? 0.35 : S.settle / 3;
    energy += (target - energy) * (1 - Math.exp(-dt / tau));
    if (energy < 0.001 && target === 0) energy = 0;
    clock += dt * S.speed * Math.max(energy, IDLE.speed);
    const idle = energy < 0.05 && t >= 1 && !trail.length;
    if (!visible) { running = false; return; }
    if (idle && tick++ % 4 !== 0) { requestAnimationFrame(frame); return; }
    while (trail.length && (now - trail[0][4]) / 1000 > 2.5) trail.shift();
    for (let i = 0; i < 12; i++) {
      const t = trail[i];
      if (t) { trailU.set([t[0], t[1], t[2], t[3]], i * 4); ageU[i] = (now - t[4]) / 1000; }
      else { trailU.set([9, 9, 0, 0], i * 4); ageU[i] = 99; }
    }

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(disc.p); common(disc); bind(disc, { aPos: [discBuf, 2] });
    gl.uniform3fv(disc.u.uColor, S.bg);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); unbind(disc);
    points(inner, innerBufs, N_INNER, S.inner);
    points(outer, outerBufs, N_OUTER, S.outer);
    hero.setAttribute('data-orb-live', '');

    requestAnimationFrame(frame);
  }

  layout();
  new ResizeObserver(layout).observe(hero);
  // Last, once everything it starts is declared: the artwork is often loaded already, so sampling runs at once
  if (art.complete && art.naturalWidth) sample();
  else art.addEventListener('load', sample, { once: true });
}
