import { useEffect, useLayoutEffect } from "react";
import { motionAllowed } from "../../../components/motion";

// The home page's motion, under the app's rules (components/motion.js): only
// transform and opacity move, nothing waits for an animation before it can be
// clicked, and with prefers-reduced-motion: reduce none of it runs, so the
// page is all there and still from the first frame.

const finePointer = () => typeof window.matchMedia === "function" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;

// Blocks marked data-reveal rise in as they come into view, once. Content
// that arrives later (the business types, once the price list has come) is
// picked up as it is added.
export function useReveal(rootRef) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const reveal = (node) => node.classList.add("is-revealed");
    const marked = () => root.querySelectorAll("[data-reveal]:not(.is-revealed)");

    if (!motionAllowed() || typeof IntersectionObserver === "undefined" || typeof MutationObserver === "undefined") {
      marked().forEach(reveal);
      const late = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => marked().forEach(reveal));
      late?.observe(root, { childList: true, subtree: true });
      return () => late?.disconnect();
    }

    root.classList.add("has-reveal");
    const watcher = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        reveal(entry.target);
        watcher.unobserve(entry.target);
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
    const watch = () => marked().forEach((node) => watcher.observe(node));
    const added = new MutationObserver(watch);

    watch();
    added.observe(root, { childList: true, subtree: true });

    return () => {
      added.disconnect();
      watcher.disconnect();
      root.classList.remove("has-reveal");
    };
  }, [rootRef]);
}

// Cards in a [data-spotlight-area] catch a soft light where the pointer is:
// each [data-spotlight] inside gets --spot-x and --spot-y, its own position
// of the pointer, once a frame. Mouse and trackpad only.
export function useSpotlight(rootRef) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !motionAllowed() || !finePointer()) return undefined;
    let frame = 0;
    let last = null;

    const paint = () => {
      frame = 0;
      const area = last?.target instanceof Element ? last.target.closest("[data-spotlight-area]") : null;
      if (!area) return;
      for (const card of area.querySelectorAll("[data-spotlight]")) {
        const box = card.getBoundingClientRect();
        card.style.setProperty("--spot-x", `${Math.round(last.clientX - box.left)}px`);
        card.style.setProperty("--spot-y", `${Math.round(last.clientY - box.top)}px`);
      }
    };
    const move = (event) => {
      last = event;
      if (!frame) frame = window.requestAnimationFrame(paint);
    };

    root.addEventListener("pointermove", move, { passive: true });
    return () => {
      root.removeEventListener("pointermove", move);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [rootRef]);
}

// The hero's window leans towards the pointer: --tilt-x and --tilt-y on the
// stage, a few degrees either way, back to rest when the pointer leaves.
export function useTilt(ref) {
  useEffect(() => {
    const node = ref.current;
    if (!node || !motionAllowed() || !finePointer()) return undefined;
    let frame = 0;

    const move = (event) => {
      const box = node.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width - 0.5;
      const y = (event.clientY - box.top) / box.height - 0.5;
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        node.style.setProperty("--tilt-x", `${(-y * 7).toFixed(2)}deg`);
        node.style.setProperty("--tilt-y", `${(x * 9).toFixed(2)}deg`);
      });
    };
    const leave = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      node.style.removeProperty("--tilt-x");
      node.style.removeProperty("--tilt-y");
    };

    node.addEventListener("pointermove", move, { passive: true });
    node.addEventListener("pointerleave", leave);
    return () => {
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerleave", leave);
      leave();
    };
  }, [ref]);
}

// A band whose light moves by itself rests while it is off screen:
// .is-offscreen pauses every animation inside it (welcome.css).
export function usePauseOffscreen(ref) {
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return undefined;
    const watcher = new IntersectionObserver(([entry]) => node.classList.toggle("is-offscreen", !entry.isIntersecting));
    watcher.observe(node);
    return () => {
      watcher.disconnect();
      node.classList.remove("is-offscreen");
    };
  }, [ref]);
}
