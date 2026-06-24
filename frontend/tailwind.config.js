/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 主题红/暗红色板,后续组件可直接用 tailwind 类
        red: { brand: '#C20C0C', bright: '#E63329', deep: '#3A1820' },
        ink: '#14060a',
      },
    },
  },
  plugins: [],
}
