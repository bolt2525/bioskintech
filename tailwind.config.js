/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        // Fuentes globales del proyecto — NO MODIFICAR sin actualizar también src/index.css
        sans: ['Poppins', 'sans-serif'],
        serif: ['Playfair Display', 'serif'],
      },
      colors: {
        // Design token principal: gold BIOSKIN — ver también src/constants/theme.ts
        gold: '#deb887',
        'gold-dark': '#d4a574',
      },
    },
  },
  plugins: [],
};
