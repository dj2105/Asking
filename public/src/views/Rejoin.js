// /src/views/Rejoin.js
// Rejoin hub — lets Daniel or Jaime jump back into the latest room or
// manually pick a stage.

import { ensureAuth, db } from "../lib/firebase.js";
import { doc, getDoc } from "firebase/firestore";

import { clampCode, getStoredRole, setStoredRole } from "../lib/util.js";
import {
  recordSession,
  getLastSession,
  getPreferredRole,
  setPreferredRole,
} from "../lib/sessionStore.js";

const STAGE_OPTIONS = [
  { value: "questions", label: "Questions" },
  { value: "marking", label: "Marking" },
  { value: "award", label: "Award" },
];

function el(tag, attrs = {}, kids = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach((child) =>
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child)
  );
  return node;
}

const roomRef = (code) => doc(db, "rooms", code);

const resolveRole = (value) => {
  const v = String(value || "").toLowerCase();
  if (v === "host" || v === "guest") return v;
  return "";
};

function computeRouteForState(stateRaw, code, roundRaw, role) {
  const state = String(stateRaw || "").toLowerCase();
  const round = Number(roundRaw) || 1;
  if (!code) return null;
  switch (state) {
    case "countdown":
      return `#/countdown?code=${code}&round=${round}`;
    case "questions":
    case "interlude":
      return `#/questions?code=${code}&round=${round}`;
    case "marking":
      return `#/marking?code=${code}&round=${round}`;
    case "award":
      return `#/award?code=${code}&round=${round}`;
    case "maths":
      return `#/maths?code=${code}`;
    case "final":
      return `#/final?code=${code}`;
    case "coderoom":
      return role === "host" ? `#/coderoom?code=${code}` : `#/watcher?code=${code}`;
    case "keyroom":
      return role === "host" ? `#/keyroom?code=${code}` : `#/lobby?code=${code}`;
    case "seeding":
      return `#/watcher?code=${code}`;
    case "lobby":
      return `#/lobby?code=${code}`;
    default:
      return `#/watcher?code=${code}`;
  }
}

export default {
  async mount(container, params = {}) {
    await ensureAuth();

    const qs = new URLSearchParams(Object.entries(params || {}));
    const fromHash = new URLSearchParams((location.hash.split("?")[1] || ""));
    const auto = fromHash.get("auto") || qs.get("auto") || "";

    const lastSession = getLastSession();
    const hintedCode = clampCode(qs.get("code") || fromHash.get("code") || lastSession?.code || "");
    const storedRole = hintedCode ? resolveRole(getStoredRole(hintedCode)) : "";
    const hintedRole = resolveRole(qs.get("role") || fromHash.get("role") || storedRole || lastSession?.role || getPreferredRole());

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const root = el("div", { class: "view view-rejoin" });
    const card = el("div", { class: "card" });
    root.appendChild(card);
    container.appendChild(root);

    card.appendChild(el("h1", { class: "title" }, "Rejoin"));

    const codeInput = el("input", {
      type: "text",
      class: "input",
      autocapitalize: "characters",
      maxlength: "5",
      value: hintedCode,
      placeholder: "Room code",
      oninput: (e) => {
        e.target.value = clampCode(e.target.value);
      },
      onkeydown: (e) => { if (e.key === "Enter") joinLatest(); },
    });
    card.appendChild(codeInput);

    const joinBtn = el("button", { class: "btn primary", style: "margin-top:12px;" }, "Join");
    card.appendChild(joinBtn);

    const status = el("div", { class: "mono", style: "min-height:20px;margin-top:10px;" }, "");
    card.appendChild(status);

    card.appendChild(el("hr", { style: "margin:24px 0 18px 0;border:none;border-top:1px solid rgba(0,0,0,0.15);" }));

    card.appendChild(el("div", { class: "mono", style: "font-weight:700;margin-bottom:10px;text-transform:uppercase;font-size:13px;letter-spacing:1px;" }, "Manual Rejoin"));

    const radioWrap = el("div", { class: "mono", style: "display:flex;gap:16px;" });
    const radioHost = el("label", { class: "mono" }, [
      el("input", {
        type: "radio",
        name: "rejoin-role",
        value: "host",
        onchange: () => setPreferredRole("host"),
      }),
      " Daniel",
    ]);
    const radioGuest = el("label", { class: "mono" }, [
      el("input", {
        type: "radio",
        name: "rejoin-role",
        value: "guest",
        onchange: () => setPreferredRole("guest"),
      }),
      " Jaime",
    ]);
    radioWrap.appendChild(radioHost);
    radioWrap.appendChild(radioGuest);
    card.appendChild(radioWrap);

    const roundSelect = el("select", { class: "input", style: "margin-top:12px;" });
    for (let i = 1; i <= 5; i += 1) {
      roundSelect.appendChild(el("option", { value: String(i) }, `Round ${i}`));
    }
    card.appendChild(roundSelect);

    const stageSelect = el("select", { class: "input", style: "margin-top:12px;" });
    STAGE_OPTIONS.forEach((opt) => {
      stageSelect.appendChild(el("option", { value: opt.value }, opt.label));
    });
    card.appendChild(stageSelect);

    const manualBtn = el("button", { class: "btn outline", style: "margin-top:12px;" }, "Go");
    card.appendChild(manualBtn);

    if (Number.isFinite(Number(lastSession?.round))) {
      const candidate = Math.min(5, Math.max(1, Number(lastSession.round) || 1));
      roundSelect.value = String(candidate);
    }
    const lastStage = String(lastSession?.state || "").toLowerCase();
    if (STAGE_OPTIONS.some((opt) => opt.value === lastStage)) {
      stageSelect.value = lastStage;
    }

    const setStatus = (msg) => { status.textContent = msg || ""; };

    const getSelectedRole = () => {
      const nodes = card.querySelectorAll('input[name="rejoin-role"]');
      for (const node of nodes) {
        if (node.checked) return resolveRole(node.value);
      }
      return "";
    };

    const setRoleSelection = (role) => {
      const target = resolveRole(role);
      const nodes = card.querySelectorAll('input[name="rejoin-role"]');
      nodes.forEach((node) => {
        node.checked = node.value === target;
      });
    };

    setRoleSelection(hintedRole);

    const joinLatest = async (silent = false) => {
      const code = clampCode(codeInput.value || "");
      if (!code) {
        if (!silent) setStatus("Enter a room code.");
        return;
      }

      const stored = resolveRole(getStoredRole(code));
      const chosen = getSelectedRole();
      const fallback = hintedRole;
      const pref = getPreferredRole();
      const role = stored || chosen || fallback || pref;
      if (!role) {
        if (!silent) setStatus("Select Daniel or Jaime below.");
        return;
      }

      try {
        setStatus("Linking…");
        const snap = await getDoc(roomRef(code));
        if (!snap.exists()) {
          setStatus("Room not found.");
          return;
        }
        const data = snap.data() || {};
        const route = computeRouteForState(data.state, code, data.round, role);
        if (!route) {
          setStatus("Room isn’t active yet. Try the lobby.");
          return;
        }
        setStoredRole(code, role);
        setPreferredRole(role);
        recordSession({ code, role, state: data.state || "", round: data.round || null });
        setStatus("");
        location.hash = route;
      } catch (err) {
        console.warn("[rejoin] joinLatest failed", err);
        setStatus("Couldn’t rejoin right now. Try again.");
      }
    };

    const joinManual = () => {
      const code = clampCode(codeInput.value || "");
      if (!code) {
        setStatus("Enter a room code.");
        return;
      }
      const role = getSelectedRole();
      if (!role) {
        setStatus("Select Daniel or Jaime.");
        return;
      }
      const round = parseInt(roundSelect.value || "1", 10) || 1;
      const stage = stageSelect.value || "questions";
      let target = null;
      if (stage === "questions") target = `#/questions?code=${code}&round=${round}`;
      else if (stage === "marking") target = `#/marking?code=${code}&round=${round}`;
      else if (stage === "award") target = `#/award?code=${code}&round=${round}`;
      if (!target) {
        setStatus("Pick a stage to rejoin.");
        return;
      }
      setStoredRole(code, role);
      setPreferredRole(role);
      recordSession({ code, role, state: stage, round });
      setStatus("");
      location.hash = target;
    };

    joinBtn.addEventListener("click", () => joinLatest(false));
    manualBtn.addEventListener("click", joinManual);

    if (auto) {
      setTimeout(() => { joinLatest(true).catch(() => {}); }, 60);
    }
  },

  async unmount() {},
};
