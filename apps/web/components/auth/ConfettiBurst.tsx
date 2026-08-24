"use client";

import { useEffect, useRef } from "react";

// One brief, dependency-free celebration for the login modal's success step:
// a single burst of small rects falling under gravity, ~1.1s, then gone.
// Palette stays on the app tokens' hues (brand green first).
const COLORS = ["#168a49", "#f5a623", "#7850c8", "#0a0a0a", "#22a050"];
const PARTICLE_COUNT = 48;
const DURATION_MS = 1100;

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  rotation: number;
  spin: number;
  color: string;
};

/**
 * Fills its nearest positioned ancestor (the modal card) with a one-shot
 * confetti burst from the top center. Renders nothing under
 * prefers-reduced-motion.
 */
export function ConfettiBurst() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    // matchMedia is absent in jsdom; treat that as "no stated preference".
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return;
    }
    const scale = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * scale;
    canvas.height = height * scale;
    context.scale(scale, scale);

    const particles: Particle[] = Array.from({ length: PARTICLE_COUNT }, (_, index) => {
      const angle = Math.PI * (0.15 + 0.7 * Math.random()); // fan, mostly upward
      const speed = 2.2 + Math.random() * 3.2;
      return {
        x: width / 2 + (Math.random() - 0.5) * 40,
        y: height * 0.3,
        vx: Math.cos(angle) * speed * (Math.random() > 0.5 ? 1 : -1),
        vy: -Math.sin(angle) * speed,
        size: 3 + Math.random() * 4,
        rotation: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 0.3,
        color: COLORS[index % COLORS.length]
      };
    });

    let frame = 0;
    const start = performance.now();
    const draw = (now: number) => {
      const elapsed = now - start;
      context.clearRect(0, 0, width, height);
      if (elapsed >= DURATION_MS) {
        return;
      }
      // Fade the whole burst out over the final third.
      context.globalAlpha = Math.min(1, (3 * (DURATION_MS - elapsed)) / DURATION_MS);
      for (const particle of particles) {
        particle.vy += 0.12; // gravity
        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.rotation += particle.spin;
        context.save();
        context.translate(particle.x, particle.y);
        context.rotate(particle.rotation);
        context.fillStyle = particle.color;
        context.fillRect(-particle.size / 2, -particle.size / 2, particle.size, particle.size * 0.6);
        context.restore();
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <canvas
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
      data-testid="confetti-burst"
      ref={canvasRef}
    />
  );
}
