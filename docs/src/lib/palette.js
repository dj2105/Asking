export function applyPastelTheme(scope = document.documentElement) {
  const target = scope || document.documentElement;
  const trackedKeys = [
    "--ink-h",
    "--ink-s",
    "--ink-l",
    "--qa-accent",
    "--qa-accent-text",
    "--qa-accent-soft",
    "--qa-outline",
    "--qa-outline-strong",
    "--qa-chip-fill",
    "--qa-chip-active",
    "--qa-chip-done",
    "--qa-submit-fill",
    "--qa-hover",
    "--qa-chip-shadow",
    "--qa-panel-bg",
    "--qa-dotted",
    "--qa-panel-shadow",
  ];

  const previous = {};
  trackedKeys.forEach((key) => {
    previous[key] = target.style.getPropertyValue(key);
  });

  const hue = Math.floor(Math.random() * 360);
  const baseSat = 28 + Math.random() * 12;
  const accentSat = Math.min(baseSat + 16, 58);
  const accent = `hsl(${hue}, ${accentSat}%, 28%)`;
  const textColor = `hsl(${hue}, ${Math.min(baseSat + 18, 60)}%, 26%)`;
  const fillSat = Math.max(baseSat - 8, 20);
  const fillColor = `hsl(${hue}, ${fillSat}%, 94%)`;
  const fillActive = `hsl(${hue}, ${fillSat + 4}%, 88%)`;
  const fillDone = `hsl(${hue}, ${fillSat + 2}%, 92%)`;
  const submitFill = `hsl(${hue}, ${fillSat + 4}%, 82%)`;
  const outlineSat = Math.min(baseSat + 8, 52);
  const outline = `hsla(${hue}, ${outlineSat}%, 58%, 0.65)`;
  const outlineStrong = `hsla(${hue}, ${outlineSat}%, 48%, 0.9)`;
  const hover = `hsla(${hue}, ${Math.min(baseSat + 12, 60)}%, 32%, 0.16)`;
  const shadow = `0 16px 36px hsla(${hue}, ${Math.min(baseSat + 10, 54)}%, 32%, 0.24)`;
  const panelBg = `hsla(${hue}, ${fillSat}%, 98%, 0.92)`;
  const dotted = `hsla(${hue}, ${Math.min(baseSat + 6, 54)}%, 48%, 0.5)`;
  const panelShadow = `0 22px 44px hsla(${hue}, ${Math.min(baseSat + 8, 50)}%, 28%, 0.22)`;

  target.style.setProperty("--ink-h", String(hue));
  target.style.setProperty("--ink-s", `${Math.round(baseSat + 14)}%`);
  target.style.setProperty("--ink-l", "26%");
  target.style.setProperty("--qa-accent", accent);
  target.style.setProperty("--qa-accent-text", textColor);
  target.style.setProperty("--qa-accent-soft", fillColor);
  target.style.setProperty("--qa-outline", outline);
  target.style.setProperty("--qa-outline-strong", outlineStrong);
  target.style.setProperty("--qa-chip-fill", fillColor);
  target.style.setProperty("--qa-chip-active", fillActive);
  target.style.setProperty("--qa-chip-done", fillDone);
  target.style.setProperty("--qa-submit-fill", submitFill);
  target.style.setProperty("--qa-hover", hover);
  target.style.setProperty("--qa-chip-shadow", shadow);
  target.style.setProperty("--qa-panel-bg", panelBg);
  target.style.setProperty("--qa-dotted", dotted);
  target.style.setProperty("--qa-panel-shadow", panelShadow);

  return () => {
    trackedKeys.forEach((key) => {
      const previousValue = previous[key];
      if (previousValue) {
        target.style.setProperty(key, previousValue);
      } else {
        target.style.removeProperty(key);
      }
    });
  };
}
