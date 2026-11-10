import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Доступ через туннели ngrok: точка в начале разрешает любой поддомен (адрес ngrok меняется при перезапуске)
const tunnels = ['.ngrok-free.dev', '.ngrok-free.app', '.ngrok.app', '.ngrok.io']

export default defineConfig({
  plugins: [react()],
  server: { allowedHosts: tunnels },
  preview: { allowedHosts: tunnels },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
