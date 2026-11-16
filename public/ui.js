export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const paths = {
  grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  list:'M9 6h12 M9 12h12 M9 18h12 M3 6h.01 M3 12h.01 M3 18h.01',
  check:'M5 12l4 4L19 6',
  message:'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z',
  users:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  hall:'M3 21h18 M5 21V5l7-3 7 3v16 M9 8h.01 M15 8h.01 M9 12h.01 M15 12h.01 M10 21v-5h4v5',
  settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z M3 12l2-2-.2-3 3-.2L10 4l2 1 2-1 2.2 2.8 3 .2-.2 3 2 2-2 2 .2 3-3 .2L14 20l-2-1-2 1-2.2-2.8-3-.2.2-3-2-2Z',
  plus:'M12 5v14 M5 12h14',
  search:'M21 21l-4.3-4.3 M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  clock:'M12 8v4l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  alert:'M12 8v4 M12 16h.01 M10.3 3.9 1.8 18.6A1.6 1.6 0 0 0 3.2 21h17.6a1.6 1.6 0 0 0 1.4-2.4L13.7 3.9a2 2 0 0 0-3.4 0Z',
  close:'M6 6l12 12 M6 18 18 6',
  arrow:'M7 17 17 7 M7 7h10v10',
  logout:'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
  menu:'M3 6h18 M3 12h18 M3 18h18',
  send:'m22 2-7 20-4-9-9-4L22 2Z M22 2 11 13',
  lock:'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
  refresh:'M20 7v5h-5 M4 17v-5h5 M6.1 7a7 7 0 0 1 11.55-2L20 8 M4 16l2.35 3A7 7 0 0 0 17.9 17',
  tag:'M20.6 13.6 13.6 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8Z M7 7h.01',
  inbox:'M4 4h16l2 12v4H2v-4L4 4Z M2 16h6l2 3h4l2-3h6',
  bell:'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4',
  bolt:'m13 2-9 12h7l-1 8 10-12h-7l1-8Z',
};
export const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.list}"/></svg>`;

export const brand = `<span class="brand">
  <span class="signal-mark" aria-hidden="true"><i></i><i></i><i></i></span>
  <span>связь?</span>
</span>`;
