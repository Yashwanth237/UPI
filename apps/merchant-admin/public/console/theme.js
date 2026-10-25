// Applies the saved theme before first paint (no flash). External file so the CSP needs no 'unsafe-inline'.
(function () {
  try {
    var t = localStorage.getItem('youpi-console-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked: follow the OS */ }
})();
