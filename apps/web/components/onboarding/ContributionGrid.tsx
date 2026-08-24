"use client";

import { useEffect, useRef, useState } from "react";

import { useMeasuredSize } from "@/lib/use-measured-size";

// Two moods of the same canvas. "calm" is the signed-out backdrop (sign-in):
// slow ragged ripples restarting from the left. Retuned 2026-07-30 (the product owner):
// roughly half the original drift speed, longer gaps between ripples, and a
// dimmer trail, so far less of the field is lit at any moment. "wave" is the
// signed-in evolution (onboarding kickoff): one slow coherent front sweeping
// the whole grid, with a staggered, per-square random edge and a slight
// swell as it passes. No hue is introduced in either mode; the grid stays
// monochrome against its surface.
type GridMode = "calm" | "wave";

// Wave-mode tuning. The backdrop should read as occasional, unhurried
// breathing behind the content, not a metronome crossing the screen: each
// pass is a SHORT drift over part of the grid, then the field rests for
// several seconds. Speed, span, start and rest are all re-rolled per pass, so
// no two passes look alike and none of it lands on a beat. Speed is
// time-based (columns per second) so pace is display-independent, and the
// per-cell noise still staggers when each square catches the front and how
// fast it rises, so the edge reads organic rather than ruled.
const WAVE_SPEED_MIN_COLS_PER_SEC = 4;
const WAVE_SPEED_MAX_COLS_PER_SEC = 6.5;
const WAVE_REST_MIN_MS = 6000;
const WAVE_REST_MAX_MS = 11000;
// Fraction of the grid one pass drifts across before it fades and rests. Kept
// short on purpose: with the speeds above a pass drifts for roughly 2-5 seconds
// and its fade takes another two, then the field is genuinely still for 6-11,
// so the backdrop is at rest about two thirds of the time (measured).
const WAVE_SPAN_MIN_FRACTION = 0.06;
const WAVE_SPAN_MAX_FRACTION = 0.12;
const WAVE_WIDTH = 14;
const WAVE_SWELL_PX = 1.5;
const WAVE_STAGGER_COLS = 11;
const MAX_FRAME_MS = 64;

/** Deterministic per-cell fraction in [0, 1) for stagger, rise, and the static field. */
function cellNoise(i: number): number {
  const v = Math.sin(i * 12.9898) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * The level a cell rests at between passes. Wave passes now cover only part of
 * the grid, so without a resting field the columns a pass never crossed would
 * read as missing canvas rather than as a quiet grid.
 */
function cellRestLevel(i: number): number {
  const noise = cellNoise(i * 31 + 3);
  return noise < 0.1 ? 2 : noise < 0.32 ? 1 : 0;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) {
      return;
    }
    setReduced(media.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function ContributionGrid({
  className,
  dark,
  mode = "calm"
}: {
  className?: string;
  dark?: boolean;
  mode?: GridMode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { ref: containerRef, size } = useMeasuredSize<HTMLDivElement>();
  const animationRef = useRef<number>(0);
  const cellStates = useRef<number[]>([]);
  const cellTargets = useRef<number[]>([]);
  const lastWaveTimeRef = useRef(0);
  const waveCenterRef = useRef(-20);
  const restUntilRef = useRef(0);
  // Re-rolled every pass: where this drift starts, where it ends, how fast.
  const wavePassRef = useRef({ endCol: 0, speed: 0, rolled: false });
  const lastFrameRef = useRef(0);
  const waveResetKeyRef = useRef<string | null>(null);
  const gridDims = useRef({ cols: 0, rows: 0 });
  const reducedMotion = useReducedMotion();
  // One derivation feeds both the sizing and the draw effect, so the canvas
  // backing store and the painted cell pitch can never disagree.
  const cellSize = dark ? 7 : 8;
  const gap = dark ? 1 : 3;

  // Re-derive the grid and the canvas backing store whenever the measured
  // container changes; the animation loop below reads these refs each frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size) return;

    const cols = Math.floor(size.width / (cellSize + gap));
    const rows = Math.floor(size.height / (cellSize + gap));
    // Small size changes usually leave the cell grid identical; skip the
    // reset then, since reassigning canvas.width blanks the bitmap and
    // zeroing the cell arrays visibly restarts the wave.
    if (cols === gridDims.current.cols && rows === gridDims.current.rows) return;
    gridDims.current = { cols, rows };
    canvas.width = cols * (cellSize + gap);
    canvas.height = rows * (cellSize + gap);
    const total = cols * rows;
    cellStates.current = new Array(total).fill(0);
    cellTargets.current = new Array(total).fill(0);
  }, [size, dark, cellSize, gap]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const colors = dark
      ? [
          "rgba(0,0,0,0.02)",
          "rgba(0,0,0,0.06)",
          "rgba(0,0,0,0.11)",
          "rgba(0,0,0,0.17)",
          "rgba(0,0,0,0.24)",
        ]
      : [
          "rgba(255,255,255,0.03)",
          "rgba(255,255,255,0.08)",
          "rgba(255,255,255,0.16)",
          "rgba(255,255,255,0.28)",
          "rgba(255,255,255,0.42)",
        ];

    const waveWidth = 14;

    function drawCells(swellByState: boolean) {
      if (!ctx) return;
      const { cols, rows } = gridDims.current;
      const canvasW = cols * (cellSize + gap);
      const canvasH = rows * (cellSize + gap);
      ctx.clearRect(0, 0, canvasW, canvasH);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          const state = cellStates.current[idx];
          const level = Math.min(4, Math.max(0, Math.floor(state)));
          const swell = swellByState
            ? WAVE_SWELL_PX * Math.min(1, Math.max(0, state / 4))
            : 0;
          const drawSize = cellSize + swell;
          const x = c * (cellSize + gap) - swell / 2;
          const y = r * (cellSize + gap) - swell / 2;
          ctx.fillStyle = colors[level];
          ctx.beginPath();
          ctx.roundRect(x, y, drawSize, drawSize, dark ? 1 : 2);
          ctx.fill();
        }
      }
    }

    // Reduced motion: one static, deterministic field instead of a loop.
    if (reducedMotion) {
      const { cols, rows } = gridDims.current;
      const total = cols * rows;
      for (let i = 0; i < total; i++) {
        const noise = cellNoise(i);
        cellStates.current[i] = noise < 0.06 ? 3 : noise < 0.16 ? 2 : noise < 0.38 ? 1 : 0;
      }
      drawCells(false);
      return;
    }

    // The auth-page ripples: ragged fronts restarting from the left. The
    // clock, drift speed, and fill are deliberately gentler than the
    // original (see the mode note at the top of this file).
    function animateCalm(time: number) {
      if (!ctx) return;
      const { cols, rows } = gridDims.current;
      if (cols === 0 || rows === 0) {
        animationRef.current = requestAnimationFrame(animateCalm);
        return;
      }

      if (time - lastWaveTimeRef.current > 3600 + Math.sin(time * 0.001) * 1000) {
        lastWaveTimeRef.current = time;
        waveCenterRef.current = -waveWidth;
      }
      waveCenterRef.current += 0.18;

      const total = cols * rows;
      for (let i = 0; i < total; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const distFromWave = Math.abs(col - waveCenterRef.current);
        const rowOffset = Math.sin(row * 0.9 + col * 0.3) * 2;
        const effectiveDist = Math.abs(distFromWave + rowOffset);

        if (effectiveDist < waveWidth) {
          const intensity = 1 - effectiveDist / waveWidth;
          const jitter = (Math.sin(i * 7.3 + time * 0.002) + 1) * 0.2;
          const targetLevel = Math.min(4, Math.floor((intensity + jitter) * 2.4));
          if (targetLevel > cellTargets.current[i]) {
            cellTargets.current[i] = targetLevel;
          }
        } else if (waveCenterRef.current > col + waveWidth + 5) {
          // Faster fade than the original: the slower front would otherwise
          // leave most of the grid glowing behind it.
          cellTargets.current[i] = Math.max(0, cellTargets.current[i] - 0.016);
        }

        const current = cellStates.current[i];
        const target = cellTargets.current[i];
        if (current < target) {
          cellStates.current[i] = Math.min(target, current + 0.05);
        } else if (current > target) {
          cellStates.current[i] = Math.max(target, current - 0.014);
        }
      }

      drawCells(false);
      animationRef.current = requestAnimationFrame(animateCalm);
    }

    /** Roll one pass: a random start, a short random span, a gentle speed. */
    function rollWavePass(cols: number) {
      const span = Math.round(
        cols * (WAVE_SPAN_MIN_FRACTION + Math.random() * (WAVE_SPAN_MAX_FRACTION - WAVE_SPAN_MIN_FRACTION))
      );
      // Start anywhere the span still fits on the grid, offset so the front
      // enters from off-canvas rather than popping into view mid-field.
      const start = Math.round(Math.random() * Math.max(1, cols - span)) - WAVE_WIDTH;
      waveCenterRef.current = start;
      wavePassRef.current = {
        endCol: start + span + WAVE_WIDTH / 2,
        speed:
          WAVE_SPEED_MIN_COLS_PER_SEC +
          Math.random() * (WAVE_SPEED_MAX_COLS_PER_SEC - WAVE_SPEED_MIN_COLS_PER_SEC),
        rolled: true
      };
    }

    // The onboarding backdrop: a short, slow drift over part of the grid, then
    // a long rest. Edge staggered per square (each cell catches the front a
    // little early or late), each square rising at its own pace, with a slight
    // swell at full glow. Start, span, speed and rest are re-rolled per pass.
    function animateWave(time: number) {
      if (!ctx) return;
      const { cols, rows } = gridDims.current;
      if (cols === 0 || rows === 0) {
        animationRef.current = requestAnimationFrame(animateWave);
        return;
      }

      const dt = Math.min(MAX_FRAME_MS, time - (lastFrameRef.current || time)) / 1000;
      lastFrameRef.current = time;

      if (!wavePassRef.current.rolled) {
        rollWavePass(cols);
      }
      // At rest the front is parked, but it is parked ON the grid: without this
      // the cells still within WAVE_WIDTH of it keep taking time-varying jitter
      // targets, so the "rest" shimmered indefinitely and the backdrop never
      // actually stopped.
      const resting = restUntilRef.current !== 0;
      if (waveCenterRef.current > wavePassRef.current.endCol) {
        if (restUntilRef.current === 0) {
          restUntilRef.current =
            time + WAVE_REST_MIN_MS + Math.random() * (WAVE_REST_MAX_MS - WAVE_REST_MIN_MS);
        } else if (time >= restUntilRef.current) {
          restUntilRef.current = 0;
          rollWavePass(cols);
        }
      } else {
        waveCenterRef.current += wavePassRef.current.speed * dt;
      }

      const total = cols * rows;
      for (let i = 0; i < total; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        // Per-square stagger: each cell meets the front offset by its own
        // noise, so the edge arrives scattered instead of ruled.
        const stagger = (cellNoise(i) - 0.5) * WAVE_STAGGER_COLS;
        const arc = Math.sin(row * 0.12) * 3;
        const effectiveDist = Math.abs(Math.abs(col - waveCenterRef.current + stagger) + arc);

        if (!resting && effectiveDist < WAVE_WIDTH) {
          const intensity = 1 - effectiveDist / WAVE_WIDTH;
          const jitter = (Math.sin(i * 7.3 + time * 0.0006) + 1) * 0.28;
          const targetLevel = Math.min(4, Math.floor((intensity + jitter) * 3));
          if (targetLevel > cellTargets.current[i]) {
            cellTargets.current[i] = targetLevel;
          }
        } else {
          const rest = cellRestLevel(i);
          if (cellTargets.current[i] > rest) {
            cellTargets.current[i] = Math.max(rest, cellTargets.current[i] - 1.8 * dt);
          } else if (cellTargets.current[i] < rest) {
            cellTargets.current[i] = rest;
          }
        }

        // Each square rises and settles at its own pace (another noise
        // channel, decoupled from the stagger).
        const paceNoise = cellNoise(i * 13 + 7);
        const rise = (0.7 + paceNoise * 0.9) * dt;
        const decay = (1.5 + paceNoise * 0.8) * dt;
        const current = cellStates.current[i];
        const target = cellTargets.current[i];
        if (current < target) {
          cellStates.current[i] = Math.min(target, current + rise);
        } else if (current > target) {
          cellStates.current[i] = Math.max(target, current - decay);
        }
      }

      drawCells(true);
      animationRef.current = requestAnimationFrame(animateWave);
    }

    lastFrameRef.current = 0;
    // Wave position survives re-runs caused by `size` (the original behavior:
    // a window resize must not snap the ripple back to the left edge); it
    // resets only when the animation itself changes shape.
    const resetKey = `${mode}:${reducedMotion}`;
    if (waveResetKeyRef.current !== resetKey) {
      waveResetKeyRef.current = resetKey;
      restUntilRef.current = 0;
      waveCenterRef.current = mode === "wave" ? -WAVE_WIDTH - WAVE_STAGGER_COLS : -20;
      wavePassRef.current = { endCol: 0, speed: 0, rolled: false };
      lastWaveTimeRef.current = 0;
      if (mode === "wave") {
        const { cols, rows } = gridDims.current;
        for (let i = 0; i < cols * rows; i++) {
          const rest = cellRestLevel(i);
          cellStates.current[i] = rest;
          cellTargets.current[i] = rest;
        }
      }
    }
    animationRef.current = requestAnimationFrame(mode === "wave" ? animateWave : animateCalm);
    return () => cancelAnimationFrame(animationRef.current);
    // `size` re-runs the effect after the sizing pass above rebuilds the grid,
    // which is what repaints the static reduced-motion field on resize.
  }, [dark, cellSize, gap, mode, reducedMotion, size]);

  return (
    <div ref={containerRef} className={`${className || ""} overflow-hidden`}>
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}
