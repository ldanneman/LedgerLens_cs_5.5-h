import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Relative base so the production build also works when opened from any sub-path.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { chunkSizeWarningLimit: 900 },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.{js,jsx}'],
    css: false,
    testTimeout: 30000,
  },
});
