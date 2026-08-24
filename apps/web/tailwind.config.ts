import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        surface: {
          DEFAULT: "var(--surface)",
          subtle: "var(--surface-subtle)",
          sunk: "var(--surface-sunk)",
        },
        ink: {
          DEFAULT: "var(--ink)",
          soft: "var(--ink-soft)",
          faint: "var(--ink-faint)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          2: "var(--muted-2)",
        },
        line: {
          DEFAULT: "var(--line)",
          strong: "var(--line-strong)",
        },
        success: {
          DEFAULT: "var(--success)",
          soft: "var(--success-soft)",
        },
        danger: {
          DEFAULT: "var(--danger)",
          soft: "var(--danger-soft)",
        },
        warning: {
          DEFAULT: "var(--warning)",
          soft: "var(--warning-soft)",
        },
        purple: {
          DEFAULT: "var(--purple)",
          soft: "var(--purple-soft)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          soft: "var(--accent-soft)",
        },
        // Decorative gold for the recommended-model
        // star; not a status color. -soft is the pale wash for the pill.
        "accent-amber": "var(--accent-amber)",
        "accent-amber-soft": "var(--accent-amber-soft)",
        // Interactive states
        hover: "var(--hover)",
        active: "var(--active)",
        // Onboarding dark theme tokens
        onboard: {
          bg: "var(--onboard-bg)",
          surface: "var(--onboard-surface)",
          text: "var(--onboard-text)",
          muted: "var(--onboard-muted)",
          border: "var(--onboard-border)",
          input: "var(--onboard-input-bg)",
        },
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "-apple-system", "sans-serif"],
        mono: ["var(--font-geist-mono)", "monospace"],
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
      },
      keyframes: {
        "skeleton-shimmer": {
          "0%": { backgroundPosition: "100% 50%" },
          "100%": { backgroundPosition: "0 50%" },
        },
        chipPulse: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.55" },
        },
      },
      animation: {
        skeleton: "skeleton-shimmer 1.4s ease infinite",
        "chip-pulse": "chipPulse 2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
