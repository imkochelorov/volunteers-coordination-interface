import { icon } from "./ui.js";

const sections = [
  ["landing-hero", "Главная"],
  ["about-event", "О проекте"],
  ["contest-roles", "Команда"],
  ["contest-gallery", "Галерея"],
];

const directionLine = "РЕГИСТРАЦИЯ / ХОЛЛЫ / ТРАНСЛЯЦИЯ / ПРЕССА / ЦЕРЕМОНИЯ /";
const eventSource = "https://news.itmo.ru/ru/news/14646/";
const photos = [
  ["/assets/nerc-contest.jpg", "Студенческие команды ICPC", "Финал Северной Евразии · NERCNews", eventSource],
  ["/assets/neerc-balloon.png", "Синий шарик Northern Eurasia", "Northern Eurasia"],
  ["/assets/nerc-team.jpg", "Участники финала Северной Евразии", "Финал Северной Евразии · NERCNews", eventSource],
  ["/assets/lidia-perovskaya.jpg", "Лидия Перовская", "Лидия Перовская · ИТМО", "https://news.itmo.ru/ru/university_live/achievements/news/9862/"],
];

function galleryCard([source, alt, caption, credit]) {
  return `<li class="landing-gallery-card">
    <figure><img src="${source}" alt="${alt}" decoding="async" loading="lazy">
      <figcaption>${credit ? `<a href="${credit}">${caption}</a>` : caption}</figcaption>
    </figure>
  </li>`;
}

export function landingMenu() {
  return `<dialog class="landing-menu" id="landing-menu" aria-labelledby="landing-menu-title">
    <div class="landing-menu-inner">
      <button type="button" class="landing-menu-close" aria-label="Закрыть меню">${icon("close")}</button>
      <h2 id="landing-menu-title">связь?</h2>
      <img src="/assets/nerc-logo.svg" alt="NEERC / ICPC">
      <nav aria-label="Разделы лендинга">
        ${sections.map(([id, label]) => `<a href="#${id}">${label} ${icon("arrow")}</a>`).join("")}
      </nav>
      <button type="button" class="landing-cta" data-landing-login>Войти ${icon("arrow")}</button>
    </div>
  </dialog>`;
}

export function landingContent() {
  return `
    <section class="landing-story-band landing-section" id="about-event" data-landing-section>
      <div class="landing-story-frame">
        <img src="/assets/nerc-contest.jpg" alt="" loading="lazy" decoding="async">
        <div class="landing-type-track" aria-hidden="true"><span>NEERC / ICPC / NEERC / ICPC</span><span>СВЯЗЬ? / СВЯЗЬ? / СВЯЗЬ?</span></div>
        <svg class="landing-signal-line" viewBox="0 0 780 320" aria-hidden="true">
          <path pathLength="1" d="M14 237C163 171 296 258 384 178S466 55 543 24L414 267 585 130 554 214C598 191 621 148 637 115L622 209 756 164"/>
        </svg>
        <div class="landing-story-copy" data-enter>
          <h1>Команда вне контеста</h1>
          <p>«связь?» помогает организаторам и волонтёрам координировать задачи по холлам, назначения и вопросы на NEERC / ICPC.</p>
        </div>
      </div>
    </section>

    <section class="landing-roles landing-section" id="contest-roles" data-landing-section aria-labelledby="contest-roles-title">
      <h2 class="landing-section-title" id="contest-roles-title" data-enter>Одна команда.</h2>
      <div class="landing-role-pair">
        <article class="landing-role" data-enter>
          <div class="landing-role-media"><img src="/assets/nerc-team.jpg" alt="" loading="lazy" decoding="async"></div>
          <h3>Организаторам</h3>
          <p>Публикуйте задачи, распределяйте работу по холлам и отвечайте на вопросы в общей очереди.</p>
          <button type="button" class="landing-cta" data-landing-login>Открыть доску ${icon("arrow")}</button>
        </article>
        <article class="landing-role" data-enter>
          <div class="landing-role-media"><img src="/assets/neerc-balloon.png" alt="" loading="lazy" decoding="async"></div>
          <h3>Волонтёрам</h3>
          <p>Получайте назначения в Telegram. Персональную ссылку на подключение выдаёт менеджер.</p>
          <a class="landing-cta" href="https://nerc.icpc.global/information/">О соревнованиях ${icon("arrow")}</a>
        </article>
      </div>
    </section>

    <section class="landing-gallery landing-section" id="contest-gallery" data-landing-section aria-labelledby="contest-gallery-title">
      <div class="landing-gallery-head">
        <h2 class="landing-section-title" id="contest-gallery-title" data-enter>Кадры ICPC</h2>
        <div class="landing-gallery-nav">
          <button type="button" data-gallery-step="-1" aria-label="Предыдущий кадр">←</button>
          <button type="button" data-gallery-step="1" aria-label="Следующий кадр">→</button>
        </div>
      </div>
      <ul class="landing-gallery-track" tabindex="0" aria-label="Фотогалерея">${photos.map(galleryCard).join("")}</ul>
    </section>

    <footer class="landing-footer landing-section" data-landing-section>
      <div class="landing-ticker" aria-hidden="true"><div>${Array.from({length: 4}, () => `<span>${directionLine}</span>`).join("")}</div></div>
      <div class="landing-footer-copy" data-enter>
        <span class="landing-footer-word">связь?</span>
        <button type="button" class="landing-cta" data-landing-login>Войти в рабочую зону ${icon("arrow")}</button>
        <a href="https://nerc.icpc.global/information/">Сайт NEERC / ICPC</a>
        <button type="button" class="landing-motion-pause" aria-pressed="false">Пауза фоновой анимации</button>
      </div>
    </footer>`;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function bindLandingContent(root) {
  root.classList.add("landing-enhanced");
  const events = new AbortController();
  const {signal} = events;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const header = root.querySelector(".landing-header");
  const access = root.querySelector(".login-access");
  const trigger = root.querySelector(".landing-menu-trigger");
  const menu = root.querySelector(".landing-menu");
  const gallery = root.querySelector(".landing-gallery-track");
  const galleryButtons = [...root.querySelectorAll("[data-gallery-step]")];
  const bands = [...root.querySelectorAll("[data-landing-section]")];
  const story = root.querySelector(".landing-story-band");
  const pause = root.querySelector(".landing-motion-pause");
  const type = root.querySelector(".landing-type-track");
  const signalLine = root.querySelector(".landing-signal-line path");
  const roleImages = [...root.querySelectorAll(".landing-role-media img")];
  let frame = 0;

  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("entered");
      observer.unobserve(entry.target);
    }
  }, {threshold: .15});
  root.querySelectorAll("[data-enter]").forEach(element => observer.observe(element));

  function drawScroll() {
    frame = 0;
    const screen = window.innerHeight;
    const top = story.getBoundingClientRect().top;
    const progress = clamp((screen - top) / (screen * 1.5), 0, 1);
    root.classList.toggle("landing-scrolled", window.scrollY > 24);
    const active = bands.find(band => {
      const bounds = band.getBoundingClientRect();
      return bounds.top <= 65 && bounds.bottom > 65;
    });
    header.classList.toggle("landing-header-dark", active === story || Boolean(active?.classList.contains("landing-footer")));
    if (reduced.matches) {
      type.style.removeProperty("transform");
      signalLine.style.removeProperty("stroke-dashoffset");
      roleImages.forEach(image => image.style.removeProperty("translate"));
      return;
    }
    type.style.transform = `translateX(${-13 + progress * 26}%)`;
    signalLine.style.strokeDashoffset = String(1 - clamp((progress - .25) * 2.65, 0, 1));
    for (const image of roleImages) {
      const media = image.parentElement.getBoundingClientRect();
      const offset = clamp((media.top + media.height / 2) / screen - .5, -.55, .55);
      image.style.translate = "0 " + (offset * 28).toFixed(1) + "px";
    }
  }

  function scheduleScroll() {
    if (!frame) frame = requestAnimationFrame(drawScroll);
  }

  window.addEventListener("scroll", scheduleScroll, {passive: true, signal});
  window.addEventListener("resize", scheduleScroll, {signal});
  reduced.addEventListener("change", scheduleScroll, {signal});
  scheduleScroll();

  pause.addEventListener("click", () => {
    const paused = root.classList.toggle("landing-paused");
    pause.setAttribute("aria-pressed", String(paused));
    pause.textContent = paused ? "Продолжить фоновую анимацию" : "Пауза фоновой анимации";
  }, {signal});

  trigger.addEventListener("click", () => {
    access.open = false;
    menu.showModal();
    trigger.setAttribute("aria-expanded", "true");
  }, {signal});

  menu.querySelector(".landing-menu-close").addEventListener("click", () => menu.close(), {signal});
  menu.addEventListener("close", () => {
    trigger.setAttribute("aria-expanded", "false");
  }, {signal});
  menu.querySelectorAll("nav a").forEach(link => link.addEventListener("click", () => menu.close(), {signal}));

  root.querySelectorAll("[data-landing-login]").forEach(button => button.addEventListener("click", () => {
    if (menu.open) menu.close();
    access.open = true;
    access.querySelector("input").focus({preventScroll: true});
  }, {signal}));

  function updateGalleryButtons() {
    const end = Math.max(0, gallery.scrollWidth - gallery.clientWidth);
    galleryButtons[0].disabled = gallery.scrollLeft <= 2;
    galleryButtons[1].disabled = gallery.scrollLeft >= end - 2;
  }

  for (const button of galleryButtons) {
    button.addEventListener("click", () => {
      const card = gallery.firstElementChild;
      const gap = Number.parseFloat(getComputedStyle(gallery).columnGap) || 0;
      gallery.scrollBy({
        left: (card.getBoundingClientRect().width + gap) * Number(button.dataset.galleryStep),
        behavior: reduced.matches ? "instant" : "smooth",
      });
    }, {signal});
  }
  gallery.addEventListener("scroll", updateGalleryButtons, {passive: true, signal});
  const resize = new ResizeObserver(updateGalleryButtons);
  resize.observe(gallery);
  updateGalleryButtons();

  return () => {
    events.abort();
    observer.disconnect();
    resize.disconnect();
    cancelAnimationFrame(frame);
    if (menu.open) menu.close();
  };
}
