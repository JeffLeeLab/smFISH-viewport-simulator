import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the static build works from any sub-path (GitHub Pages, Netlify).
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
  worker: {
    format: 'es',
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
