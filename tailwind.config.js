/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        /* Design Tokens — 鲸落于海 + 春野信风（环境学院主题），见 DESIGN.md */
        'lake-deep': 'var(--lake-deep)',
        'lake-mid': 'var(--lake-mid)',
        'lake-soft': 'var(--lake-soft)',
        'lake-pale': 'var(--lake-pale)',
        'lake-mist': 'var(--lake-mist)',
        mint: 'var(--mint)',
        'mint-deep': 'var(--mint-deep)',
        ink: 'var(--ink)',
        'ink-soft': 'var(--ink-soft)',
        'ink-faint': 'var(--ink-faint)',
        hairline: 'var(--hairline)',
      },
    },
  },
  plugins: [],
};
