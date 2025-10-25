// /src/lib/NavigationGuard.js
//
// Simple singleton navigation guard controller. Views can register a guard that
// intercepts hash navigation and provides custom confirmation flows.
// Guard object shape:
//   {
//     shouldBlock({ route, qs, hash }) => boolean,
//     confirm(target, proceed, stay) => void
//   }
// `proceed` optionally accepts an override hash string to navigate elsewhere.

let activeGuard = null;

function setGuard(guard) {
  activeGuard = guard || null;
}

function clearGuard(guard) {
  if (!guard || guard === activeGuard) {
    activeGuard = null;
  }
}

function getGuard() {
  return activeGuard;
}

export { setGuard, clearGuard, getGuard };
export default { setGuard, clearGuard, getGuard };
