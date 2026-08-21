/** Build config for the precompiled frontend/tailwind.css (we deliberately do
 * NOT use the Tailwind Play CDN at runtime: its JIT compiler re-scans the DOM
 * on every mutation, which is a constant CPU/memory tax while the agent
 * streams chat rows). Rebuild after adding new utility classes:
 *
 *   cd frontend
 *   npx tailwindcss@3 -c tailwind.config.js -i tailwind.input.css -o tailwind.css --minify
 */
module.exports = {
  content: ['./index.html', './app.js', './workflow_view.js', './workflow_library.js', './device_view.js'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['IBM Plex Sans Var', 'ui-sans-serif', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', 'sans-serif'],
        serif: ['ui-serif', 'Georgia', 'Cambria', '"Times New Roman"', 'serif'],
        mono: ['"Cascadia Code"', '"JetBrains Mono"', 'Consolas', 'ui-monospace', 'monospace'],
      },
      // Every palette slot resolves to a CSS variable (defined in index.html)
      // so the light/dark switch only flips variables. NOTE: `cyan` is the
      // primary accent slot (now Claude terracotta) — it keeps its historical
      // name so existing class usage keeps working.
      colors: {
        term: {
          bg: 'rgb(var(--term-bg) / <alpha-value>)',
          panel: 'rgb(var(--term-panel) / <alpha-value>)',
          raised: 'rgb(var(--term-raised) / <alpha-value>)',
          line: 'rgb(var(--term-line) / <alpha-value>)',
          muted: 'rgb(var(--term-muted) / <alpha-value>)',
          green: 'rgb(var(--term-green) / <alpha-value>)',
          magenta: 'rgb(var(--term-magenta) / <alpha-value>)',
          orange: 'rgb(var(--term-orange) / <alpha-value>)',
          cyan: 'rgb(var(--term-cyan) / <alpha-value>)',
          red: 'rgb(var(--term-red) / <alpha-value>)',
          gray: 'rgb(var(--term-gray) / <alpha-value>)',
          text: 'rgb(var(--term-text) / <alpha-value>)',
        },
      },
    },
  },
};
