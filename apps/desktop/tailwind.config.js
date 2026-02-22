/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['JetBrains Mono', 'monospace'],
        display: ['Orbitron', 'monospace']
      },
      animation: {
        'spin-slow': 'spin 2s linear infinite'
      }
    }
  },
  plugins: []
}
