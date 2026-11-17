import { $, esc, icon } from "./ui.js";

// Each viewBox crops one pictogram from the original full-colour logo.
const logoCrops = {
  cloud: [66, 75, 86, 75],
  bulb: [153, 50, 79, 95],
  balloon: [241, 10, 78, 135],
};
const logoPlacements = [
  ["cloud", 64, 77, 104, -18], ["balloon", 285, 52, 103, 17],
  ["bulb", 494, 82, 97, -13], ["cloud", 633, 157, 107, 12],
  ["bulb", 137, 202, 74, 15], ["balloon", 453, 223, 121, -18],
  ["balloon", 25, 323, 122, -15], ["cloud", 189, 336, 109, 12],
  ["bulb", 562, 347, 112, 19], ["cloud", 465, 459, 79, -17],
  ["bulb", 100, 510, 109, -18], ["balloon", 617, 554, 137, 15],
  ["cloud", 225, 639, 103, 13], ["bulb", 404, 596, 81, 12],
  ["balloon", 490, 692, 114, -12], ["cloud", 31, 698, 89, -12],
];

function loginBackdrop() {
  const pictograms = Object.entries(logoCrops).map(([name, [x, y, width, height]]) => `
    <clipPath id="login-crop-${name}"><rect x="${x}" y="${y}" width="${width}" height="${height}"/></clipPath>
    <symbol id="login-logo-${name}" viewBox="${x} ${y} ${width} ${height}">
      <use href="#login-logo-art" clip-path="url(#login-crop-${name})"/>
    </symbol>`
  ).join("");
  const placements = logoPlacements.map(([name, x, y, size, angle]) =>
    `<use href="#login-logo-${name}" x="${-size / 2}" y="${-size / 2}" width="${size}" height="${size}" transform="translate(${x} ${y}) rotate(${angle})"/>`
  ).join("");
  return `<svg class="login-backdrop" aria-hidden="true">
    <defs>
      <image id="login-logo-art" href="/assets/nerc-logo.svg" x="58" y="10" width="270" height="144"/>
      ${pictograms}
      <pattern id="login-logo-pattern" width="640" height="720" patternUnits="userSpaceOnUse">
        ${placements}
      </pattern>
    </defs>
    <rect width="100%" height="100%" fill="url(#login-logo-pattern)"/>
  </svg>`;
}

export function renderLoginScreen(error) {
  $("#app").innerHTML = `<main class="login-screen" aria-labelledby="login-title">
    ${loginBackdrop()}
    <form id="login-form" class="sign-in-form form-stack">
      <img class="login-emblem" src="/assets/nerc-logo.svg" alt="NEERC / ICPC" width="270" height="144">
      <h1 id="login-title">Вход</h1>
      <label class="field">Логин <input name="login" autocomplete="username" required></label>
      <label class="field">Пароль <input name="password" type="password" autocomplete="current-password" required></label>
      <button class="button primary" type="submit">Войти ${icon("arrow")}</button>
      ${error ? `<div class="inline-error" role="alert">${esc(error)}</div>` : ""}
      <p>Веб-доступ выдаёт администратор. Волонтёры работают через Telegram.</p>
    </form>
  </main>`;
}
