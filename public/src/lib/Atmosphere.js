// /src/lib/Atmosphere.js
//
// Soft-focus atmospheric lighting that swirls behind the main column.
// Each route (and its ink hue) nudges a new gradient arrangement so the
// whole experience feels theatrical without breaking the Courier aesthetic.

const Stage = {
  node: null,
  ensure() {
    if (this.node && this.node.isConnected) return this.node;
    const stage = document.createElement("div");
    stage.className = "ambient-stage";
    stage.innerHTML = `
      <div class="ambient-stage__halo ambient-stage__halo--one"></div>
      <div class="ambient-stage__halo ambient-stage__halo--two"></div>
      <div class="ambient-stage__halo ambient-stage__halo--three"></div>
      <div class="ambient-stage__grid"></div>
      <div class="ambient-stage__sheen"></div>
    `;
    document.body.prepend(stage);
    this.node = stage;
    return stage;
  },
  update(props = {}) {
    const stage = this.ensure();
    const docEl = document.documentElement;
    const computed = getComputedStyle(docEl);
    const styleHue = parseFloat(docEl.style.getPropertyValue("--ink-h")) || NaN;
    const computedHue = parseFloat(computed.getPropertyValue("--ink-h")) || NaN;
    const baseHue = Number.isFinite(styleHue) ? styleHue
      : Number.isFinite(computedHue) ? computedHue
      : 210;

    stage.style.setProperty("--stage-base-h", String(normalizeHue(baseHue)));

    const warm = rotate(baseHue, randomBetween(-26, 26));
    const cool = rotate(baseHue, randomBetween(120, 200));
    const dusk = rotate(baseHue, randomBetween(-170, -110));

    stage.style.setProperty("--stage-halo-1", `hsla(${warm}, 88%, ${randomBetween(78, 90)}%, 0.46)`);
    stage.style.setProperty("--stage-halo-2", `hsla(${cool}, 84%, ${randomBetween(76, 88)}%, 0.34)`);
    stage.style.setProperty("--stage-halo-3", `hsla(${dusk}, 82%, ${randomBetween(74, 86)}%, 0.42)`);
    stage.style.setProperty("--stage-duration-1", `${randomBetween(42, 60).toFixed(1)}s`);
    stage.style.setProperty("--stage-duration-2", `${randomBetween(56, 74).toFixed(1)}s`);
    stage.style.setProperty("--stage-duration-3", `${randomBetween(68, 88).toFixed(1)}s`);
    stage.style.setProperty("--stage-tilt", `${randomBetween(-16, 18).toFixed(1)}deg`);
    stage.style.setProperty("--stage-zoom", randomBetween(0.8, 1.35).toFixed(2));
    stage.style.setProperty("--stage-shift-x", `${randomBetween(-14, 14).toFixed(1)}%`);
    stage.style.setProperty("--stage-shift-y", `${randomBetween(-8, 12).toFixed(1)}%`);
    stage.style.setProperty("--stage-sheen-angle", `${randomBetween(8, 26).toFixed(1)}deg`);
    stage.style.setProperty("--stage-grid-h", String(normalizeHue(rotate(baseHue, randomBetween(10, 48)))));

    if (props.route) stage.dataset.route = props.route;
  },
};

function normalizeHue(value) {
  let h = value % 360;
  if (h < 0) h += 360;
  return Math.round(h);
}

function rotate(base, delta) {
  return normalizeHue(base + delta);
}

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

export function ensure() {
  Stage.ensure();
}

export function touch(props) {
  Stage.update(props);
}

export default { ensure, touch };
