// /src/views/Rejoin.js
// Rejoin utility screen. Lets Daniel or Jaime hop back into an existing room.

import { ensureAuth, db } from "../lib/firebase.js";
import { doc, getDoc } from "firebase/firestore";
import {
  clampCode,
  getHashParams,
  getStoredRole,
  setStoredRole,
  getLastRoomCode,
  setLastRoomCode,
} from "../lib/util.js";
import { applyStageTheme } from "../lib/theme.js";

const roomRef = (code) => doc(db, "rooms", code);

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

function computeRound(room = {}) {
  const top = Number(room.round);
  if (Number.isFinite(top) && top > 0) return top;
  const metaRound = Number(room.meta?.round);
  if (Number.isFinite(metaRound) && metaRound > 0) return metaRound;
  return 1;
}

function resolveRouteForState(stateRaw, code, round, role) {
  const state = String(stateRaw || "").toLowerCase();
  const r = Number.isFinite(round) && round > 0 ? round : 1;
  if (!code) return null;
  switch (state) {
    case "lobby":
      return "#/lobby";
    case "keyroom":
      return role === "host" ? `#/keyroom?code=${code}` : `#/watcher?code=${code}`;
    case "coderoom":
      return role === "host" ? `#/coderoom?code=${code}` : `#/watcher?code=${code}`;
    case "seeding":
      return `#/watcher?code=${code}`;
    case "countdown":
      return `#/countdown?code=${code}&round=${r}`;
    case "questions":
      return `#/questions?code=${code}&round=${r}`;
    case "marking":
      return `#/marking?code=${code}&round=${r}`;
    case "award":
      return `#/award?code=${code}&round=${r}`;
    case "maths":
      return `#/maths?code=${code}`;
    case "final":
      return `#/final?code=${code}`;
    default:
      return `#/watcher?code=${code}`;
  }
}

export default {
  async mount(container) {
    const user = await ensureAuth();

    const params = getHashParams();
    const queryCode = clampCode(params.get("code") || "");
    const storedCode = getLastRoomCode();
    const initialCode = queryCode || storedCode;
    const auto = params.get("auto") === "1";
    const requestedStep = (params.get("step") || "").toLowerCase();
    const requestedRound = parseInt(params.get("round") || "", 10);
    const roleParamRaw = (params.get("role") || "").toLowerCase();
    const queryRole = roleParamRaw === "host" || roleParamRaw === "guest" ? roleParamRaw : "";

    applyStageTheme("lobby", 1);
    document.documentElement.style.setProperty("--ink-s", "72%");

    container.innerHTML = "";
    const view = el("div", { class: "view view-rejoin" });
    const card = el("div", { class: "card" });
    view.appendChild(card);
    container.appendChild(view);

    card.appendChild(el("h1", { class: "title" }, "Rejoin a Room"));

    const codeInput = el("input", {
      type: "text",
      class: "input",
      maxlength: "3",
      autocapitalize: "characters",
      autocomplete: "off",
      value: initialCode,
      placeholder: "Room code (e.g. CAT)",
      oninput: (e) => {
        e.target.value = clampCode(e.target.value);
      },
    });
    card.appendChild(codeInput);

    const joinBtn = el("button", { class: "btn primary", type: "button" }, "Join");
    card.appendChild(joinBtn);

    const statusLine = el("div", { class: "mono small", style: "margin-top:10px;min-height:18px;" }, "");
    card.appendChild(statusLine);

    card.appendChild(el("div", {
      style: "margin:18px 0 12px 0;border-top:1px solid rgba(0,0,0,0.18);",
    }));

    card.appendChild(el("div", { class: "mono", style: "font-weight:700;margin-bottom:6px;" }, "Manual Rejoin"));

    const roleWrap = el("div", { class: "mono", style: "display:flex;gap:14px;margin-bottom:10px;" });
    const roleOptions = [
      { value: "host", label: "Daniel" },
      { value: "guest", label: "Jaime" },
    ];
    let currentRole = "";
    const storedRole = initialCode ? getStoredRole(initialCode) : "";
    if (queryRole) currentRole = queryRole;
    else if (storedRole === "host" || storedRole === "guest") currentRole = storedRole;

    roleOptions.forEach(({ value, label }) => {
      const id = `rejoin-role-${value}`;
      const radio = el("input", {
        type: "radio",
        name: "rejoin-role",
        id,
        value,
        onchange: () => {
          currentRole = value;
        },
      });
      if (currentRole === value) radio.checked = true;
      const wrap = el("label", { class: "mono", for: id, style: "display:flex;align-items:center;gap:6px;" }, [radio, label]);
      roleWrap.appendChild(wrap);
    });
    card.appendChild(roleWrap);

    const roundSelect = el("select", { class: "input", style: "margin-bottom:10px;" });
    for (let r = 1; r <= 5; r += 1) {
      const opt = el("option", { value: String(r) }, `Round ${r}`);
      roundSelect.appendChild(opt);
    }
    if (Number.isFinite(requestedRound) && requestedRound >= 1 && requestedRound <= 5) {
      roundSelect.value = String(requestedRound);
    }
    card.appendChild(roundSelect);

    const phaseSelect = el("select", { class: "input", style: "margin-bottom:12px;" });
    [
      { value: "questions", label: "Questions" },
      { value: "marking", label: "Marking" },
      { value: "award", label: "Award" },
    ].forEach(({ value, label }) => {
      const opt = el("option", { value }, label);
      phaseSelect.appendChild(opt);
    });
    if (requestedStep === "questions" || requestedStep === "marking" || requestedStep === "award") {
      phaseSelect.value = requestedStep;
    }
    card.appendChild(phaseSelect);

    const manualBtn = el("button", { class: "btn", type: "button" }, "Manual enter");
    card.appendChild(manualBtn);

    let joinInFlight = false;

    const setStatus = (msg) => {
      statusLine.textContent = msg || "";
    };

    const setJoining = (busy) => {
      joinInFlight = busy;
      joinBtn.disabled = busy;
      joinBtn.classList.toggle("throb", !busy);
    };

    setJoining(false);

    const attemptJoin = async (autoMode = false) => {
      const code = clampCode(codeInput.value);
      if (!code) {
        setStatus("Enter a room code to rejoin.");
        return;
      }
      if (joinInFlight) return;
      setJoining(true);
      setStatus("Connecting to room…");
      try {
        setLastRoomCode(code);
        const snap = await getDoc(roomRef(code));
        if (!snap.exists()) {
          setStatus("Room not found.");
          return;
        }
        const room = snap.data() || {};
        const round = computeRound(room);
        const { hostUid, guestUid } = room.meta || {};
        if (queryRole) {
          setStoredRole(code, queryRole);
        }
        let role = getStoredRole(code);
        if (queryRole) role = queryRole;
        if (role !== "host" && role !== "guest") {
          if (user?.uid && hostUid && user.uid === hostUid) role = "host";
          else if (user?.uid && guestUid && user.uid === guestUid) role = "guest";
        }
        if (role !== "host" && role !== "guest") {
          if (autoMode) {
            setStatus("Couldn’t identify your role. Choose Daniel or Jaime below.");
          } else {
            setStatus("Choose Daniel or Jaime before joining.");
          }
          return;
        }
        setStoredRole(code, role);
        currentRole = role;
        card.querySelectorAll('input[name="rejoin-role"]').forEach((radio) => {
          radio.checked = radio.value === role;
        });
        const readableName = role === "host" ? "Daniel" : "Jaime";
        const target = resolveRouteForState(room.state, code, round, role);
        setStatus(`Rejoining as ${readableName}…`);
        setTimeout(() => {
          location.hash = target;
        }, 120);
      } catch (err) {
        console.warn("[rejoin] join failed", err);
        setStatus("Couldn’t rejoin right now. Try again.");
      } finally {
        setJoining(false);
      }
    };

    joinBtn.addEventListener("click", () => attemptJoin(false));

    manualBtn.addEventListener("click", () => {
      const code = clampCode(codeInput.value);
      if (!code) {
        setStatus("Enter a room code to rejoin.");
        return;
      }
      const selectedRole = (() => {
        const radios = card.querySelectorAll('input[name="rejoin-role"]');
        for (const radio of radios) {
          if (radio.checked) return radio.value;
        }
        return currentRole;
      })();
      if (selectedRole !== "host" && selectedRole !== "guest") {
        setStatus("Choose Daniel or Jaime to continue.");
        return;
      }
      const round = parseInt(roundSelect.value || "1", 10) || 1;
      const phase = phaseSelect.value;
      setStoredRole(code, selectedRole);
      currentRole = selectedRole;
      const readableName = selectedRole === "host" ? "Daniel" : "Jaime";
      const target = phase === "marking"
        ? `#/marking?code=${code}&round=${round}`
        : phase === "award"
          ? `#/award?code=${code}&round=${round}`
          : `#/questions?code=${code}&round=${round}`;
      setStatus(`Manual jump as ${readableName}…`);
      setTimeout(() => {
        location.hash = target;
      }, 120);
    });

    if (auto && initialCode) {
      setTimeout(() => {
        attemptJoin(true);
      }, 80);
    } else if (auto) {
      setStatus("No recent room code found. Enter one above.");
    }
  },

  async unmount() {},
};
