import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

const alias = { '@contracts': resolve(__dirname, 'contracts') }

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          inspect: resolve(__dirname, 'tools/inspect/main.ts')
        }
      }
    }
  },
  preload: {
    resolve: { alias },
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias },
    base: './', // loadFile() from file:// needs relative asset URLs
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } }
  }
})
