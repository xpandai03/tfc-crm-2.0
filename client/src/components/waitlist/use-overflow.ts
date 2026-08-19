import { useEffect, useRef, useState } from "react";

/**
 * Tracks whether a scroll container's content is wider than the container.
 *
 * Drives the waitlist table's overflow mode. The distinction matters because a
 * non-overflowing table must look EXACTLY as it did before this feature: the
 * sticky-column treatment trades the glassmorphic translucency for opaque rows
 * (a sticky cell must be opaque or scrolled content shows through it), and
 * paying that cost when nothing is scrolling would be a visual regression for
 * every user who never enables extra columns.
 *
 * Re-measures on container resize AND on content resize, so toggling a column
 * flips the mode without waiting for a window resize.
 */
export function useHorizontalOverflow<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      // 1px tolerance: sub-pixel layout rounding otherwise reports a phantom
      // overflow on exactly-fitting tables and flickers the mode.
      setIsOverflowing(el.scrollWidth - el.clientWidth > 1);
    };

    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // The <table> itself grows when columns are added; observing only the
    // container would miss that.
    const table = el.querySelector("table");
    if (table) ro.observe(table);
    return () => ro.disconnect();
  });

  return { ref, isOverflowing };
}
