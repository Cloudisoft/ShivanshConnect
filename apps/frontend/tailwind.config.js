/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        gold: {
          DEFAULT: '#F0BE42',
          50: '#FEFBF2',
          100: '#FCF3DB',
          200: '#F9E7B3',
          300: '#F6D986',
          400: '#F3CB5C',
          500: '#F0BE42',
          600: '#D9A226',
          700: '#B37F1B',
          800: '#8C6215',
          900: '#6B4A10',
        },
        ink: {
          50: '#F7F8FA',
          100: '#EEF0F3',
          200: '#DFE3E8',
          300: '#C6CCD4',
          400: '#9AA3B0',
          500: '#6B7383',
          600: '#4B5563',
          700: '#343B47',
          800: '#20242C',
          900: '#121417',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
};
