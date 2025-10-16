// /src/views/Rejoin.js
//
// Rejoin hub — lets either player jump back into an in-progress game or manually
// choose a phase. Supports automatic rejoin when the URL originated from
// /questions, /marking, or /award.

import { ensureAuth, db } from "../lib/firebase.js";
import { doc, getDoc } from "firebase/firestore";

import {
  clampCode,
  getHashParams,
  getStoredRole,
  setStoredRole,
  getLastRoomCode,
  getLastRole,
} from "../lib/util.js";

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

function describeState(state, round) {
  const r = Number.isFinite(round) && round > 0 ? round : 1;
  switch (String(state || "").toLowerCase()) {
    case "countdown":
      return `Countdown • Round ${r}`;
    case "questions":
      return `Questions • Round ${r}`;
    case "marking":
      return `Marking • Round ${r}`;
    case "award":
      return `Award • Round ${r}`;
    case "maths":
      return "Jemima’s Maths";
    case "final":
      return "Final";
    case "coderoom":
      return "Code Room";
    case "keyroom":
    case "seeding":
      return "Key Room";
    case "lobby":
      return "Lobby";
    default:
      return "Watcher";
  }
}

function routeForState(state, code, round, role) {
  const safeCode = clampCode(code);
  const phase = String(state || "").toLowerCase();
  const safeRound = Number.isFinite(round) && round > 0 ? round : 1;
  const myRole = role === "host" || role === "guest" ? role : "guest";

  if (phase === "lobby") {
    return myRole === "host" ? `#/keyroom?code=${safeCode}` : `#/lobby?code=${safeCode}`;
  }
  if (phase === "keyroom" || phase === "seeding") {
    return myRole === "host" ? `#/keyroom?code=${safeCode}` : `#/watcher?code=${safeCode}`;
  }
  if (phase === "coderoom") {
    return myRole === "host" ? `#/coderoom?code=${safeCode}` : `#/watcher?code=${safeCode}`;
  }
  if (phase === "countdown" || phase === "questions" || phase === "marking" || phase === "award") {
    return `#/${phase}?code=${safeCode}&round=${safeRound}`;
  }
  if (phase === "interlude") {
    return `#/questions?code=${safeCode}&round=${safeRound}`;
  }
  if (phase === "maths") {
    return `#/maths?code=${safeCode}`;
  }
  if (phase === "final") {
    return `#/final?code=${safeCode}`;
  }
  return `#/watcher?code=${safeCode}`;
}

const PHASE_LABEL = {
  questions: "Questions",
  marking: "Marking",
  award: "Award",
};

export default {
  async mount(container) {
    const me = await ensureAuth();

    const params = getHashParams();
    const autoPhase = String(params.get("auto") || "").toLowerCase();
    const incomingCode = clampCode(params.get("code") || "");
    const initialCode = clampCode(incomingCode || getLastRoomCode() || "");

    const storedRole = getStoredRole(initialCode);
    const fallbackRole = getLastRole();
    const initialRole = storedRole || fallbackRole || "host";

    document.documentElement.style.setProperty("--ink-h", String(Math.floor(Math.random() * 360)));

    container.innerHTML = "";
    const view = el("div", { class: "view view-rejoin" });
    const card = el("div", { class: "card rejoin-card" });

    const title = el("h1", { class: "title" }, "Rejoin a game");
    card.appendChild(title);

    const codeLabel = el("label", { class: "mono", style: "display:block;font-weight:700;margin-bottom:4px;" }, "Room code");
    const codeInput = el("input", {
      type: "text",
      class: "input rejoin-code-input",
      value: initialCode,
      maxlength: "5",
      autocapitalize: "characters",
      autocomplete: "off",
      oninput: (e) => {
        e.target.value = clampCode(e.target.value);
      },
    });
    const joinButton = el("button", { class: "btn primary rejoin-join-btn", type: "button" }, "Join");
    const status = el("div", { class: "mono rejoin-status" }, "");

    card.appendChild(codeLabel);
    card.appendChild(codeInput);
    card.appendChild(joinButton);
    card.appendChild(status);

    const divider = el("hr", { class: "rejoin-divider" });
    card.appendChild(divider);

    const manualTitle = el("div", { class: "mono", style: "font-weight:700;margin-top:4px;margin-bottom:10px;" }, "Manual Rejoin");
    card.appendChild(manualTitle);

    const roleWrap = el("div", { class: "rejoin-role-wrap" });
    const roleDaniel = el("label", { class: "mono rejoin-role" }, [
      el("input", { type: "radio", name: "rejoin-role", value: "host", checked: initialRole !== "guest" }),
      " Daniel",
    ]);
    const roleJaime = el("label", { class: "mono rejoin-role" }, [
      el("input", { type: "radio", name: "rejoin-role", value: "guest", checked: initialRole === "guest" }),
      " Jaime",
    ]);
    roleWrap.appendChild(roleDaniel);
    roleWrap.appendChild(roleJaime);
    card.appendChild(roleWrap);

    const manualRoundLabel = el("label", { class: "mono", style: "display:block;margin-top:12px;" }, "Round");
    const manualRound = el("select", { class: "select rejoin-round" },
      Array.from({ length: 5 }, (_, idx) => {
        const value = String(idx + 1);
        return el("option", { value }, `Round ${value}`);
      })
    );
    card.appendChild(manualRoundLabel);
    card.appendChild(manualRound);

    const manualPhaseLabel = el("label", { class: "mono", style: "display:block;margin-top:12px;" }, "Room");
    const manualPhase = el("select", { class: "select rejoin-phase" }, [
      el("option", { value: "questions" }, "Questions"),
      el("option", { value: "marking" }, "Marking"),
      el("option", { value: "award" }, "Award"),
    ]);
    card.appendChild(manualPhaseLabel);
    card.appendChild(manualPhase);

    const manualBtn = el("button", { class: "btn outline rejoin-manual-btn", type: "button" }, "Enter manually");
    card.appendChild(manualBtn);

    view.appendChild(card);
    container.appendChild(view);

    const roleInputs = Array.from(roleWrap.querySelectorAll('input[name="rejoin-role"]'));

    const setStatus = (msg) => {
      status.textContent = msg || "";
    };

    const inferRole = (code, roomData) => {
      const { hostUid, guestUid } = roomData?.meta || {};
      if (hostUid && hostUid === me.uid) return "host";
      if (guestUid && guestUid === me.uid) return "guest";
      const stored = getStoredRole(code);
      if (stored === "host" || stored === "guest") return stored;
      return roleInputs.find((input) => input.checked)?.value || "guest";
    };

    const applyRoleSelection = (role) => {
      roleInputs.forEach((input) => {
        input.checked = input.value === role;
      });
    };

    applyRoleSelection(initialRole === "guest" ? "guest" : "host");
    const requestedRound = parseInt(params.get("round") || "", 10);
    if (Number.isFinite(requestedRound) && requestedRound >= 1 && requestedRound <= 5) {
      manualRound.value = String(requestedRound);
    }
    if (autoPhase && manualPhase.querySelector(`option[value="${autoPhase}"]`)) {
      manualPhase.value = autoPhase;
    }

    const performJoin = async () => {
      const code = clampCode(codeInput.value || "");
      if (!code) {
        setStatus("Enter a room code.");
        return;
      }

      setStatus("Checking room…");
      let snap;
      try {
        snap = await getDoc(roomRef(code));
      } catch (err) {
        console.warn("[rejoin] getDoc failed", err);
        setStatus("Couldn’t reach the room. Try again.");
        return;
      }

      if (!snap.exists()) {
        setStatus("Room not found.");
        return;
      }

      const data = snap.data() || {};
      const round = Number(data.round) || 1;
      const state = String(data.state || "").toLowerCase();
      const role = inferRole(code, data);

      setStoredRole(code, role);
      applyRoleSelection(role);

      const target = routeForState(state, code, round, role);
      const summary = describeState(state, round);
      setStatus(`Sending you to ${summary}…`);
      location.hash = target;
    };

    const performManual = () => {
      const code = clampCode(codeInput.value || "");
      if (!code) {
        setStatus("Enter a room code before manual rejoin.");
        return;
      }
      const role = roleInputs.find((input) => input.checked)?.value === "host" ? "host" : "guest";
      const round = parseInt(manualRound.value, 10) || 1;
      const phase = manualPhase.value;
      const label = PHASE_LABEL[phase] || "Game";

      setStoredRole(code, role);
      applyRoleSelection(role);

      setStatus(`Opening ${label} • Round ${round}…`);
      if (phase === "questions" || phase === "marking" || phase === "award") {
        location.hash = `#/${phase}?code=${code}&round=${round}`;
      }
    };

    joinButton.addEventListener("click", performJoin);
    manualBtn.addEventListener("click", performManual);

    if (autoPhase && (!codeInput.value || codeInput.value.length < 3)) {
      const storedCode = clampCode(getLastRoomCode() || "");
      if (storedCode) codeInput.value = storedCode;
    }

    if (autoPhase) {
      setStatus("Rejoining your last game…");
      performJoin();
    }
  },

  async unmount() {},
};
