// The motion system's JavaScript half. The CSS half — tokens, keyframes and
// every rule that animates on its own — is @bmp/ui's styles/motion.css.
//
// Three rules hold everywhere:
//   * Nothing waits for an animation. Every animation here is decoration on
//     top of a change that has already happened in the DOM: the control is
//     there, clickable and typed-into from the first frame.
//   * Only transform and opacity move (clip-path / stroke-dashoffset for
//     drawing). Never width, height, top or left.
//   * prefers-reduced-motion: reduce switches all of it off. CSS animations
//     are stopped by motion.css; the script animations below check
//     motionAllowed() before they start, because CSS cannot stop them.

// Mirrors the tokens at the top of motion.css, for the script animations.
export const MOTION = {
  fast: 140,
  normal: 200,
  enter: 340,
  page: 320,
  slide: 300,
  stagger: 32,
  ease: "cubic-bezier(0.22, 1, 0.36, 1)",
  easeIn: "cubic-bezier(0.55, 0, 1, 0.45)",
  spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
};

// False when the person has asked their device for less motion (or the
// browser cannot tell us — then we assume motion is fine, as CSS does).
export const motionAllowed = () => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
};

// A Web Animations call that is a no-op where motion is off or unsupported,
// and never throws: a missing animation must never break the screen.
export const play = (node, keyframes, options) => {
  if (!node || typeof node.animate !== "function" || !motionAllowed()) {
    return null;
  }

  try {
    return node.animate(keyframes, { easing: MOTION.ease, ...options });
  } catch {
    return null;
  }
};

// The refused-input shake (a wrong PIN, a refused sign-in): a few small,
// fast, decaying side-to-side moves. Says "no" without moving the layout.
const SHAKE_FRAMES = [
  { transform: "none" },
  { transform: "translateX(-7px)" },
  { transform: "translateX(6px)" },
  { transform: "translateX(-4px)" },
  { transform: "translateX(3px)" },
  { transform: "translateX(-1px)" },
  { transform: "none" },
];

export const shake = (node) => play(node, SHAKE_FRAMES, { duration: 380, easing: "cubic-bezier(0.36, 0.07, 0.19, 0.97)" });

// A dialog's dimmed, blurred backdrop, left behind for a moment after the
// dialog itself has gone, fading out. It is an empty layer: no text, no
// role, no clicks (pointer-events: none), hidden from assistive technology —
// so the page underneath is usable at once, and no test or screen reader
// can find a second copy of anything.
//
// Returns a function that removes it at once (used to take back the one left
// by React's development-only rehearsal unmount, see Modal.jsx).
export const leaveBackdrop = (className = "") => {
  if (!motionAllowed() || typeof document === "undefined") {
    return () => {};
  }

  const ghost = document.createElement("div");
  ghost.className = `motion-backdrop-ghost ${className}`.trim();
  ghost.setAttribute("aria-hidden", "true");
  document.body.appendChild(ghost);

  let removed = false;
  const remove = () => {
    if (!removed) {
      removed = true;
      ghost.remove();
    }
  };

  ghost.addEventListener("animationend", remove);
  // Belt and braces: a background tab does not run animations.
  window.setTimeout(remove, 1000);
  return remove;
};
