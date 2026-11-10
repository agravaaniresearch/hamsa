// Parshva's theme button for extension pages: Auto -> Light -> Dark, with the same icons.
const svg = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICONS = {
  auto: svg('<circle cx="12" cy="12" r="8"/><path d="M12 4v16"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>'),
  light: svg('<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>'),
  dark: svg('<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>'),
};
export const THEME_NEXT = { auto: "light", light: "dark", dark: "auto" };
export const THEME_LABEL = { auto: "Auto (follows your system)", light: "Light", dark: "Dark" };

// Icons are fixed strings from this file, parsed as SVG and adopted, so no page content is ever parsed.
function setIcon(btn, name) {
  const doc = new DOMParser().parseFromString(ICONS[name], "image/svg+xml");
  btn.replaceChildren(document.importNode(doc.documentElement, true));
}

export function themeButton(btn, initial, onChange) {
  let theme = initial || "auto";
  const draw = () => {
    setIcon(btn, theme);
    btn.title = `Theme: ${THEME_LABEL[theme]}. Click to change.`;
    btn.setAttribute("aria-label", btn.title);
  };
  btn.addEventListener("click", () => { theme = THEME_NEXT[theme]; draw(); onChange(theme); });
  draw();
  return { set: (t) => { theme = t || "auto"; draw(); } };
}
