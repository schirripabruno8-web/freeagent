// electron-builder fails halfway (EPERM) and empties release/win-unpacked if the exe is running, so refuse to start.
import { execSync } from 'node:child_process'

const out = execSync('tasklist /FI "IMAGENAME eq FreeAgent.exe" /NH', { encoding: 'utf8' })
if (out.includes('FreeAgent.exe')) {
  console.error('FreeAgent e\' aperto: chiudilo (la X della finestra) e rilancia npm run pack. Non ho toccato nulla.')
  process.exit(1)
}
execSync('npx electron-vite build && npx electron-builder --dir', { stdio: 'inherit' })
