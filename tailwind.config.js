/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        /* Design Tokens — 书房纸墨体系，见 DESIGN.md */
        paper: 'var(--paper)',
        'paper-deep': 'var(--paper-deep)',
        ink: 'var(--ink)',
        'ink-soft': 'var(--ink-soft)',
        'ink-faint': 'var(--ink-faint)',
        vermilion: 'var(--vermilion)',
        'vermilion-deep': 'var(--vermilion-deep)',
        hairline: 'var(--hairline)',
        'dark-ink': 'var(--dark-ink)',
      },
    },
  },
  plugins: [],
};
