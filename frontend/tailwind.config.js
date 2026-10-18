/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        board: {
          950: "#0b0d12",
          900: "#10131a",
          850: "#151923",
          800: "#1b202c",
          700: "#262d3d",
          600: "#343d52",
          500: "#4a556f",
        },
        ink: {
          100: "#eef1f6",
          200: "#d3d9e4",
          300: "#aab3c4",
          400: "#7f8aa0",
        },
        person: "#5b9cf5",
        evidence: "#e3b341",
        contra: "#f05252",
        event: "#9aa3b2",
        hyp: "#a78bfa",
        statement: "#2dd4bf",
        location: "#64748b",
        action: "#34d399",
        observation: "#f0abfc",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
        serif: ["Fraunces", "Georgia", "serif"],
      },
      keyframes: {
        flash: {
          "0%": { boxShadow: "0 0 0 0 rgba(227,179,65,0.7)" },
          "100%": { boxShadow: "0 0 0 12px rgba(227,179,65,0)" },
        },
        pulseDot: { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.3" } },
        slideIn: { "0%": { opacity: "0", transform: "translateY(4px)" }, "100%": { opacity: "1", transform: "none" } },
      },
      animation: {
        flash: "flash 1.2s ease-out 2",
        pulseDot: "pulseDot 1s ease-in-out infinite",
        slideIn: "slideIn 0.25s ease-out",
      },
    },
  },
  plugins: [],
};
