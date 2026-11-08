// Runs before first paint so a forced Light or Dark theme does not flash.
try {
  var t = localStorage.getItem("hamsa-theme");
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
} catch (e) {}
