/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Only the pure processing helpers are unit-tested; they take plain
  // typed arrays, so no DOM environment is needed.
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
