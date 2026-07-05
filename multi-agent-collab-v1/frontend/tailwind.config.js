/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        agent: {
          codex: '#6366f1',
          kimi: '#10b981',
          mimo: '#f59e0b',
          open: '#ec4899',
          reasonix: '#8b5cf6',
        }
      }
    },
  },
  plugins: [],
}
