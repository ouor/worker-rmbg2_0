import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
//
// Vite's default port (5173) sits inside Windows' Hyper-V reserved
// TCP range on many machines, which makes it unbindable
// (`EACCES: permission denied`). 5500 is outside the reserved
// ranges in stock Win10/11 setups, so pin it here.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5500,
    strictPort: false,
  },
})
