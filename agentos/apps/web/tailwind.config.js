/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          900: '#0f1117',
          800: '#1a1b23',
          700: '#252630',
          600: '#2e2f3a',
        },
        accent: {
          blue: '#3b82f6',
          green: '#22c55e',
          red: '#ef4444',
          yellow: '#eab308',
          purple: '#a855f7',
        },
      },
    },
  },
  plugins: [],
};
