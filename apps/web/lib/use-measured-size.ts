"use client";

import { useCallback, useState } from "react";

export type MeasuredSize = {
  width: number;
  height: number;
};

/**
 * Observes an element's size and reports it in whole CSS pixels.
 *
 * Returns a callback ref to attach to the element plus its latest measured
 * size (null until first attach). The element is measured synchronously on
 * attach so the first paint already has real dimensions, then tracked with a
 * ResizeObserver. Values are rounded and unchanged sizes are not re-committed,
 * so sub-pixel observer chatter during window drags does not re-render
 * consumers. A 0×0 measurement (element inside a hidden or not-yet-laid-out
 * ancestor) is never committed, so `size === null` reliably means "no real
 * layout yet" and consumers can gate rendering on it; the observer fires again
 * with the real size once the element becomes visible. Assumes the element has
 * no padding or border (content-box and border-box sizes match).
 */
export function useMeasuredSize<T extends HTMLElement>(): {
  ref: (node: T) => () => void;
  size: MeasuredSize | null;
} {
  const [size, setSize] = useState<MeasuredSize | null>(null);

  const ref = useCallback((node: T) => {
    const commit = (width: number, height: number) => {
      const next = { width: Math.round(width), height: Math.round(height) };
      if (next.width === 0 && next.height === 0) {
        return;
      }
      setSize((prev) => (prev && prev.width === next.width && prev.height === next.height ? prev : next));
    };
    const rect = node.getBoundingClientRect();
    commit(rect.width, rect.height);
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      commit(width, height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, size };
}
