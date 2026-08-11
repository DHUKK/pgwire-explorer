import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so the built site works from any URL prefix --
  // GitHub Pages project sites live under /<repo>/, not at the domain root.
  base: './',
  build: { outDir: 'dist', sourcemap: true },
})
