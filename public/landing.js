const portraitOutline = "M181 533 C169 514 170 482 173 453 C177 404 177 355 195 318 Q205 296 229 282 Q238 271 256 269 C247 253 239 240 235 218 C228 197 229 181 231 156 Q226 144 233 125 C230 108 236 91 242 84 Q249 72 262 66 Q279 56 298 56 Q310 51 318 47 Q333 42 344 49 Q353 50 361 55 Q374 58 381 69 Q386 83 380 96 Q386 114 383 134 L383 154 Q398 147 397 166 Q395 183 389 193 Q408 211 406 241 L419 241 Q444 251 459 277 Q473 288 479 311 C501 329 515 351 537 384 C563 424 573 479 593 533 Z";
const balloonOutline = "M188 27 C121 28 79 72 71 128 C65 170 76 211 100 246 C121 277 153 306 182 318 L183 322 Q180 326 179 330 L190 329 L197 332 L195 325 Q208 327 211 332 L219 329 L220 324 L214 317 L203 317 L198 321 L192 320 C224 314 255 285 278 251 C304 215 318 168 315 122 C310 65 266 27 207 26 Z";
const balloonPlacement = "translate(141 5) scale(.94)";
const viewBox = "26 24 578 509";

const contours = `<svg class="landing-contours" viewBox="0 0 1440 850" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
  <path fill="#e7e8df" d="M0 0H282C335 69 252 134 290 216c41 91-80 152-168 132L0 308ZM0 567c130 12 132-75 237-50 103 24 136 91 87 186-34 66-4 107-43 147H0ZM1440 255c-123 36-194-49-255-22-62 27-47 115-84 167-54 73 67 125 177 83 54-21 89-19 162 6Z"/>
  <g fill="none" stroke="#dedfd3" stroke-width="1.5">
    <path d="M68-16C126 100 275 3 309 97S230 223 284 301c53 77 162 6 239-27 118-50 241-74 246 18 7 128-209 95-247 193-29 75 84 147 169 126 113-29 123-194 213-179 118 20 120 204 241 230 139 31 278-77 320-23"/>
    <path d="M129-18c94 128 264 19 374 28 72 6 102 96 48 157-57 64-81 96-23 147 74 65 204 16 277-65 71-79 144-111 211-37 96 105-36 262 7 348s167 80 228-22c101-169 60-197 210-251"/>
    <path d="M-29 435c153 10 286 50 328 144 57 127-230 93-194 228 16 61 122 89 239 49 136-47 105-190 236-215 123-24 178 146 283 126 123-23 102-127 237-106 113 18 244 118 357 42"/>
    <path d="M-52 223c117-14 144 39 150 101 4 53-98 96-105 140-13 85 188 96 180 200-8 76-103 102-144 161m967-851c-64 159 81 205 177 141 108-71 174 32 130 116-40 76-4 115 158 114"/>
    <path d="M595-32c47 67 154 97 213 22m477-16c-14 99 84 149 185 128M747 865c-20-48 25-86 85-83 71 4 68 57 124 83"/>
  </g>
</svg>`;

export function portraitScene() {
  return `<figure class="landing-hero" id="landing-hero">
    ${contours}
    <svg class="landing-pointer-field" viewBox="0 0 1440 850" preserveAspectRatio="none" aria-hidden="true">
      <path class="landing-field-trail" fill="#c5cdef"/>
    </svg>
    <svg class="landing-portrait" viewBox="${viewBox}" role="img" aria-label="Лидия Перовская" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <path id="landing-balloon-shape" d="${balloonOutline}"/>
        <clipPath id="landing-portrait-clip"><path d="${portraitOutline}"/></clipPath>
        <clipPath id="landing-balloon-clip"><use href="#landing-balloon-shape"/></clipPath>
        <mask id="landing-ink" maskUnits="userSpaceOnUse" x="0" y="0" width="800" height="533">
          <rect class="landing-full-mask" width="800" height="533" fill="white" opacity="0"/>
          <path class="landing-trail" fill="white"/>
        </mask>
      </defs>
      <image href="/assets/lidia-perovskaya.jpg" width="800" height="533" clip-path="url(#landing-portrait-clip)"/>
      <g class="landing-balloon-guide" transform="${balloonPlacement}" fill="none" aria-hidden="true">
        <use href="#landing-balloon-shape"/>
        <path d="M192 28C115 79 114 236 192 318m0-290c86 49 88 200 0 290M82 103c38 24 171 38 221 4M75 176c55 18 182 26 233 0m-207 71c67 18 126 13 176 0"/>
      </g>
      <g class="landing-balloon" mask="url(#landing-ink)" aria-hidden="true">
        <g transform="${balloonPlacement}">
          <image href="/assets/neerc-balloon.png" width="379" height="419" clip-path="url(#landing-balloon-clip)"/>
          <path d="M188 328q-2 16-10 38t-6 53" fill="none" stroke="#16538f" stroke-width="2"/>
        </g>
      </g>
    </svg>
    <a class="landing-scroll-link" href="#about-event">О проекте <span aria-hidden="true">↓</span></a>
    <figcaption><a href="https://news.itmo.ru/ru/university_live/achievements/news/9862/" target="_blank" rel="noopener noreferrer">Фото · ИТМО</a></figcaption>
    <button type="button" class="landing-balloon-toggle" aria-pressed="false">Показать шар</button>
  </figure>`;
}

const trailLifetime = 1050;
const sampleSpacing = 5;
const pointText = point => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`;

function brushRibbon(points, now, width = 30, lifetime = trailLifetime) {
  const left = [];
  const right = [];
  const caps = [];
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const magnitude = Math.hypot(dx, dy) || 1;
    const remaining = Math.max(0, 1 - (now - point.time) / lifetime);
    const radius = (width * (1 + Math.sin(index * 1.23) / 6)) * Math.sqrt(remaining);
    left.push({x: point.x - dy / magnitude * radius, y: point.y + dx / magnitude * radius});
    right.push({x: point.x + dy / magnitude * radius, y: point.y - dx / magnitude * radius});
    if (index === 0 || index === points.length - 1) {
      caps.push(`M${(point.x - radius).toFixed(1)} ${point.y.toFixed(1)}
        a${radius.toFixed(1)} ${radius.toFixed(1)} 0 1 0 ${(radius * 2).toFixed(1)} 0
        a${radius.toFixed(1)} ${radius.toFixed(1)} 0 1 0 ${(-radius * 2).toFixed(1)} 0Z`);
    }
  }
  const outline = left.concat(right.reverse()).map(pointText).join("L");
  return `M${outline}Z ${caps.join(" ")}`;
}

export function bindPortraitScene(hero) {
  const scene = hero.querySelector(".landing-portrait");
  const trail = hero.querySelector(".landing-trail");
  const fullMask = hero.querySelector(".landing-full-mask");
  const toggle = hero.querySelector(".landing-balloon-toggle");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let points = [];
  let frame = 0;
  let stroke = 0;
  let pinned = false;
  let touch = null;

  function draw(now) {
    frame = 0;
    if (!hero.isConnected) return;
    points = points.filter(point => now - point.time < trailLifetime);
    const paths = [];
    for (const point of points) {
      if (paths.at(-1)?.[0].stroke !== point.stroke) paths.push([]);
      paths.at(-1).push(point);
    }
    trail.setAttribute("d", paths.map(path => brushRibbon(path, now)).join(" "));
    if (points.length) frame = requestAnimationFrame(draw);
  }

  function paint(event) {
    if (pinned || reducedMotion.matches) return;
    const transform = scene.getScreenCTM();
    if (!transform) return;
    const {x, y} = new DOMPoint(event.clientX, event.clientY).matrixTransform(transform.inverse());
    const now = performance.now();
    const last = points.at(-1);
    if (last && last.stroke === stroke && now - last.time < 140 && Math.hypot(x - last.x, y - last.y) < sampleSpacing) return;
    if (last && now - last.time > 140) stroke++;
    points.push({x, y, time: now, stroke});
    if (points.length > 85) points.shift();
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function setPinned(value) {
    pinned = value;
    points = [];
    trail.setAttribute("d", "");
    fullMask.setAttribute("opacity", value ? "1" : "0");
    toggle.setAttribute("aria-pressed", String(value));
    toggle.textContent = value ? "Скрыть шар" : "Показать шар";
  }

  scene.addEventListener("pointerenter", event => {
    if (event.pointerType !== "touch") paint(event);
  });
  scene.addEventListener("pointermove", event => {
    if (event.pointerType !== "touch") paint(event);
    else if (touch?.id === event.pointerId && Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 5) {
      touch.moved = true;
      paint(event);
    }
  });
  scene.addEventListener("pointerleave", () => { stroke++; });
  scene.addEventListener("pointerdown", event => {
    if (event.pointerType !== "touch" || touch) return;
    touch = {id: event.pointerId, x: event.clientX, y: event.clientY, moved: false};
    scene.setPointerCapture(event.pointerId);
  });
  scene.addEventListener("pointerup", event => {
    if (touch?.id !== event.pointerId) return;
    if (!touch.moved) setPinned(!pinned);
    touch = null;
    stroke++;
  });
  scene.addEventListener("pointercancel", event => {
    if (touch?.id === event.pointerId) touch = null;
  });
  toggle.addEventListener("click", () => setPinned(!pinned));
  hero.addEventListener("keydown", event => {
    if (event.key === "Escape" && pinned) setPinned(false);
  });
}

export function bindHeroField(hero) {
  const controller = new AbortController();
  const {signal} = controller;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const contours = hero.querySelector(".landing-contours");
  const portrait = hero.querySelector(".landing-portrait");
  const field = hero.querySelector(".landing-field-trail");
  const lifetime = 1650;
  const target = {x: 0, y: 0};
  const current = {x: 0, y: 0};
  let points = [];
  let stroke = 0;
  let frame = 0;

  function draw(now) {
    frame = 0;
    current.x += (target.x - current.x) * .15;
    current.y += (target.y - current.y) * .15;
    contours.style.translate = `${current.x * -51}px ${current.y * -38}px`;
    portrait.style.translate = `${current.x * 12}px ${current.y * 6}px`;
    points = points.filter(point => now - point.time < lifetime);
    const paths = [];
    for (const point of points) {
      if (paths.at(-1)?.[0].stroke !== point.stroke) paths.push([]);
      paths.at(-1).push(point);
    }
    field.setAttribute("d", paths.map(path => brushRibbon(path, now, 83, lifetime)).join(" "));
    const moving = Math.abs(target.x - current.x) + Math.abs(target.y - current.y) > .003;
    if (points.length || moving) frame = requestAnimationFrame(draw);
  }

  function schedule() {
    if (!frame && !reduced.matches) frame = requestAnimationFrame(draw);
  }

  hero.addEventListener("pointermove", event => {
    if (reduced.matches) return;
    const bounds = hero.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    target.x = x * 2 - 1;
    target.y = y * 2 - 1;
    const px = x * 1440;
    const py = y * 850;
    const time = performance.now();
    const previous = points.at(-1);
    if (previous && time - previous.time > 170) stroke++;
    if (!previous || previous.stroke !== stroke || Math.hypot(px - previous.x, py - previous.y) > 13) {
      points.push({x: px, y: py, time, stroke});
      if (points.length > 72) points.shift();
    }
    schedule();
  }, {signal});

  hero.addEventListener("pointerleave", () => {
    stroke++;
    target.x = target.y = 0;
    schedule();
  }, {signal});

  reduced.addEventListener("change", () => {
    if (!reduced.matches) return;
    cancelAnimationFrame(frame);
    frame = 0;
    points = [];
    field.setAttribute("d", "");
    contours.style.removeProperty("translate");
    portrait.style.removeProperty("translate");
  }, {signal});

  return () => {
    controller.abort();
    cancelAnimationFrame(frame);
  };
}
