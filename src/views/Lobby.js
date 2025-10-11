// /src/views/Lobby.js
// Guest-only join screen (clean layout, no card box).
// - NEVER creates rooms, NEVER routes to KeyRoom.
// - If code doesn’t exist → inline “Room not found” (stay here).
// - If room exists → (optionally) claim guest slot if free, then ALWAYS route to `#/watcher?code=XYZ`.
// - Big monospace prompt + input; SVG arrow that fills + throbs when ready.

import {
  initFirebase, ensureAuth,
  roomRef, getDoc, updateDoc, serverTimestamp
} from "../lib/firebase.js";
import { clampCode as clampCodeShared, setStoredRole } from "../lib/util.js";

function el(tag, attrs = {}, kids = []) {
  const n = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (k === "class") n.className = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach(c =>
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c)
  );
  return n;
}

const clampCode = (v) => clampCodeShared(v || "");

function ArrowSVG({ filled }) {
  // Right arrow head + shaft; stroke/ fill tied to currentColor
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 48 24");
  svg.setAttribute("width", "48");
  svg.setAttribute("height", "24");
  svg.style.display = "block";

  const shaft = document.createElementNS(svg.namespaceURI, "rect");
  shaft.setAttribute("x", "4");
  shaft.setAttribute("y", "10");
  shaft.setAttribute("width", "28");
  shaft.setAttribute("height", "4");
  shaft.setAttribute("fill", filled ? "currentColor" : "transparent");
  shaft.setAttribute("stroke", "currentColor");
  shaft.setAttribute("stroke-width", "2");

  const head = document.createElementNS(svg.namespaceURI, "polygon");
  head.setAttribute("points", "28,4 44,12 28,20");
  head.setAttribute("fill", filled ? "currentColor" : "transparent");
  head.setAttribute("stroke", "currentColor");
  head.setAttribute("stroke-width", "2");
  head.setAttribute("stroke-linejoin", "round");

  svg.appendChild(shaft);
  svg.appendChild(head);
  return svg;
}

export default {
  async mount(container) {
    await initFirebase();
    await ensureAuth();

    // Theme (random ink hue)
    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));
    document.documentElement.style.setProperty("--ink-s", "70%");
    document.documentElement.style.setProperty("--ink-l", "18%");

    // Layout (no card wrapper)
    container.innerHTML = "";
    const view = el("div", { class: "view view-lobby", style: "text-align:center;" });
    view.appendChild(el("h1", { class: "title" }, "Jemima’s Asking"));
    container.appendChild(view);

    const prompt = el("div", {
      class: "h2",
      style: "margin: 4px 0 10px 0; font-family: 'Courier New', Courier, monospace; font-weight: 900; font-size: 26px;"
    }, "Jaime, what’s the code?");
    view.appendChild(prompt);

    const row = el("div", { class: "row", style: "gap:10px; justify-content:center; align-items:center;" });

    const input = el("input", {
      type: "text",
      autocomplete: "off",
      autocapitalize: "characters",
      maxlength: "3",
      placeholder: "C A T",
      class: "code-input",
      style: `
        width: 240px;
        text-align: center;
        letter-spacing: .42em;
        font-family: 'Courier New', Courier, monospace;
        font-size: 22px;
        padding: 10px 12px;
      `,
      oninput: (e) => { e.target.value = clampCode(e.target.value); reflect(); },
      onkeydown: (e) => { if (e.key === "Enter") join(); }
    });

    const arrowBtn = el("button", {
      class: "btn btn-arrow",
      title: "Join",
      onclick: join,
      disabled: true,
      style: `
        padding: 8px 12px;
        border: 2px solid currentColor;
        background: transparent;
        border-radius: 12px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      `
    });

    // Insert initial hollow SVG
    let arrowIcon = ArrowSVG({ filled: false });
    arrowBtn.appendChild(arrowIcon);

    row.appendChild(input);
    row.appendChild(arrowBtn);
    view.appendChild(row);

    // Inline error/status line
    const status = el("div", {
      class: "status-bar",
      style: "min-height: 18px; margin-top: 10px; font-size: 13px;"
    }, "");
    view.appendChild(status);

    // Host link (host-only path)
    const hostLink = el("a", {
      href: "#/keyroom",
      style: "display:inline-block;margin-top:12px;text-decoration:underline;"
    }, "Daniel’s entrance");
    view.appendChild(hostLink);

    function setStatus(msg) { status.textContent = msg || ""; }

    function reflect() {
      const ok = input.value.length === 3;
      arrowBtn.disabled = !ok;
      arrowBtn.classList.toggle("ready", ok);
      arrowBtn.classList.toggle("throb", ok);
      // Swap the SVG fill state
      arrowBtn.removeChild(arrowIcon);
      arrowIcon = ArrowSVG({ filled: ok });
      arrowBtn.appendChild(arrowIcon);
    }

    async function join() {
      setStatus("");
      const code = clampCode(input.value);
      if (code.length !== 3) return;

      try {
        const rRef = roomRef(code);
        const snap = await getDoc(rRef);

        if (!snap.exists()) {
          setStatus("Room not found. Check the 3-letter code.");
          console.warn(`[lobby] join code=${code} | room not found`);
          return;
        }

        const data = snap.data() || {};
        setStoredRole(code, "guest");

        if (data.state === "keyroom") {
          const startAt = Date.now() + 7_000;
          const round = Number(data.round) || 1;
          try {
            await updateDoc(rRef, {
              state: "countdown",
              round,
              "countdown.startAt": startAt,
              "timestamps.updatedAt": serverTimestamp(),
            });
            console.log(`[lobby] auto-armed countdown for room ${code}`);
          } catch (err) {
            console.warn("[lobby] failed to arm countdown:", err);
          }
        }

        const target = `#/watcher?code=${code}`;
        if (location.hash !== target) {
          location.hash = target;
        } else {
          setTimeout(() => window.dispatchEvent(new HashChangeEvent("hashchange")), 0);
        }
      } catch (e) {
        console.error("[lobby] join failed:", e);
        setStatus("Couldn’t join right now. Please try again.");
      }
    }

    // First paint
    reflect();
  },

  async unmount() {}
};
