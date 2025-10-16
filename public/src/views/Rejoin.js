// /src/views/Rejoin.js
// Assisted rejoin flow for players to hop back into their latest game state.

import { ensureAuth, db } from "../lib/firebase.js";
import { doc, getDoc } from "firebase/firestore";

import {
  clampCode,
  getHashParams,
  getStoredRole,
  setStoredRole,
  getLastSession,
  setLastSession,
} from "../lib/util.js";

const roomRef = (code) => doc(db, "rooms", code);

function el(tag, attrs = {}, kids = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach((child) => {
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  });
  return node;
}

function targetForState(state, code, round, role) {
  const safeCode = clampCode(code || "");
  if (!safeCode) return null;
  const r = Number.isFinite(round) && round > 0 ? Math.floor(round) : 1;
  const s = String(state || "").toLowerCase();

  switch (s) {
    case "keyroom":
    case "coderoom":
    case "seeding":
      return role === "host"
        ? `#/keyroom?code=${safeCode}`
        : `#/watcher?code=${safeCode}`;
    case "lobby":
      return `#/lobby?code=${safeCode}`;
    case "countdown":
      return `#/countdown?code=${safeCode}&round=${r}`;
    case "questions":
      return `#/questions?code=${safeCode}&round=${r}`;
    case "marking":
      return `#/marking?code=${safeCode}&round=${r}`;
    case "award":
      return `#/award?code=${safeCode}&round=${r}`;
    case "maths":
      return `#/maths?code=${safeCode}`;
    case "final":
      return `#/final?code=${safeCode}`;
    default:
      return `#/watcher?code=${safeCode}`;
  }
}

export default {
  async mount(container) {
    const me = await ensureAuth();

    const params = getHashParams();
    const intent = String(params.get("intent") || "").toLowerCase();
    const last = getLastSession();
    const hintedCode = clampCode(params.get("code") || last?.code || "");

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));
    document.documentElement.style.setProperty("--ink-s", "68%");
    document.documentElement.style.setProperty("--ink-l", "18%");

    container.innerHTML = "";
    const view = el("div", { class: "view view-rejoin" });
    const card = el("div", { class: "card" });

    const title = el("h1", { class: "mono", style: "font-weight:700;margin-bottom:10px;text-align:center;" }, "Rejoin a game");
    card.appendChild(title);

    const codeLabel = el("label", { class: "mono", style: "display:block;font-weight:700;margin-bottom:6px;" }, "Room code");
    card.appendChild(codeLabel);

    const codeInput = el("input", {
      type: "text",
      class: "mono",
      maxlength: "5",
      value: hintedCode,
      style: "width:100%;padding:8px 10px;border:1px solid rgba(0,0,0,0.2);border-radius:8px;text-align:center;font-size:18px;text-transform:uppercase;letter-spacing:2px;",
      oninput: (event) => {
        event.target.value = clampCode(event.target.value);
      },
    });
    card.appendChild(codeInput);

    const joinBtn = el("button", {
      class: "btn primary",
      type: "button",
      style: "margin-top:12px;width:100%;",
    }, "Join latest state");
    card.appendChild(joinBtn);

    const status = el("div", { class: "mono small", style: "min-height:18px;margin-top:8px;text-align:center;opacity:.8;" }, "");
    card.appendChild(status);

    const divider = el("div", {
      style: "border-top:1px solid rgba(0,0,0,0.12);margin:18px 0;",
    });
    card.appendChild(divider);

    const manualTitle = el("div", { class: "mono", style: "font-weight:700;margin-bottom:8px;text-align:center;" }, "Manual Rejoin");
    card.appendChild(manualTitle);

    const roleWrap = el("div", { class: "mono", style: "display:flex;gap:12px;justify-content:center;margin-bottom:10px;" });
    const hostId = "rejoinRoleHost";
    const guestId = "rejoinRoleGuest";
    const hostRadio = el("input", { type: "radio", name: "rejoinRole", id: hostId, value: "host" });
    const guestRadio = el("input", { type: "radio", name: "rejoinRole", id: guestId, value: "guest" });

    if (last?.role === "host") hostRadio.checked = true;
    else if (last?.role === "guest") guestRadio.checked = true;

    roleWrap.appendChild(hostRadio);
    roleWrap.appendChild(el("label", { for: hostId, style: "cursor:pointer;" }, "Daniel"));
    roleWrap.appendChild(guestRadio);
    roleWrap.appendChild(el("label", { for: guestId, style: "cursor:pointer;" }, "Jaime"));
    card.appendChild(roleWrap);

    const roundSelect = el("select", {
      class: "mono",
      style: "width:100%;padding:8px 10px;border:1px solid rgba(0,0,0,0.2);border-radius:8px;margin-bottom:10px;",
    });
    for (let r = 1; r <= 5; r += 1) {
      const option = el("option", { value: String(r) }, `Round ${r}`);
      if (Number(last?.round) === r) option.selected = true;
      roundSelect.appendChild(option);
    }
    card.appendChild(roundSelect);

    const phaseSelect = el("select", {
      class: "mono",
      style: "width:100%;padding:8px 10px;border:1px solid rgba(0,0,0,0.2);border-radius:8px;margin-bottom:12px;",
    });
    const phases = [
      { value: "questions", label: "Questions" },
      { value: "marking", label: "Marking" },
      { value: "award", label: "Award" },
    ];
    phases.forEach(({ value, label }) => {
      const option = el("option", { value }, label);
      if (last?.state === value) option.selected = true;
      phaseSelect.appendChild(option);
    });
    card.appendChild(phaseSelect);

    const manualBtn = el("button", {
      class: "btn outline",
      type: "button",
      style: "width:100%;",
    }, "Manual join");
    card.appendChild(manualBtn);

    view.appendChild(card);
    container.appendChild(view);

    let joining = false;

    const setStatus = (msg) => {
      status.textContent = msg || "";
    };

    const resolveRole = (code) => {
      const stored = getStoredRole(code);
      if (stored === "host" || stored === "guest") return stored;
      if (hostRadio.checked) return "host";
      if (guestRadio.checked) return "guest";
      if (last?.code === code && (last.role === "host" || last.role === "guest")) {
        return last.role;
      }
      return "";
    };

    const autoJoin = async (autoHint = intent) => {
      if (joining) return;
      const code = clampCode(codeInput.value);
      if (!code) {
        setStatus("Enter a room code first.");
        return;
      }
      joining = true;
      joinBtn.disabled = true;
      setStatus("Checking room…");
      try {
        const snap = await getDoc(roomRef(code));
        if (!snap.exists()) {
          setStatus("Room not found.");
          return;
        }
        const room = snap.data() || {};
        const round = Number(room.round) || 1;
        const state = String(room.state || "").toLowerCase();
        let role = resolveRole(code);
        if (!role && me?.uid) {
          const { hostUid, guestUid } = room.meta || {};
          if (hostUid === me.uid) role = "host";
          else if (guestUid === me.uid) role = "guest";
        }
        if (!role) {
          setStatus("Choose Daniel or Jaime below first.");
          return;
        }
        setStoredRole(code, role);
        const effectiveState = state || autoHint || "";
        const target = targetForState(effectiveState, code, round, role);
        if (!target) {
          setStatus("Room isn’t ready yet. Try again shortly.");
          return;
        }
        setLastSession({ code, role, state: effectiveState || state || "", round });
        setStatus("Joining…");
        location.hash = target;
      } catch (err) {
        console.warn("[rejoin] join failed", err);
        setStatus("Couldn’t reach the room. Try again.");
      } finally {
        joining = false;
        joinBtn.disabled = false;
      }
    };

    const manualJoin = () => {
      if (joining) return;
      const code = clampCode(codeInput.value);
      if (!code) {
        setStatus("Enter a room code first.");
        return;
      }
      const role = hostRadio.checked ? "host" : guestRadio.checked ? "guest" : "";
      if (!role) {
        setStatus("Select whether you’re Daniel or Jaime.");
        return;
      }
      const round = parseInt(phaseSelect.value === "maths" ? "5" : roundSelect.value, 10) || 1;
      const phase = phaseSelect.value;
      const target = targetForState(phase, code, round, role);
      if (!target) {
        setStatus("Pick a destination to continue.");
        return;
      }
      setStoredRole(code, role);
      setLastSession({ code, role, state: phase, round });
      setStatus("Joining…");
      location.hash = target;
    };

    joinBtn.addEventListener("click", () => autoJoin());
    manualBtn.addEventListener("click", manualJoin);

    if (intent && hintedCode) {
      setTimeout(() => {
        autoJoin(intent);
      }, 120);
    }
  },

  async unmount() {},
};
