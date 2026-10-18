const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const backendDirectory = __dirname
const frontendDirectory = path.resolve(__dirname, '../frontend')
const viteEntry = path.join(frontendDirectory, 'node_modules/vite/bin/vite.js')

if (!fs.existsSync(viteEntry)) {
  console.error('Frontend packages are missing. Run `npm ci` in the frontend directory first.')
  process.exit(1)
}

const children = [
  spawn(process.execPath, ['index.js'], { cwd: backendDirectory, stdio: 'inherit' }),
  spawn(process.execPath, [viteEntry, '--host', '127.0.0.1', '--port', '3001', '--strictPort'], { cwd: frontendDirectory, stdio: 'inherit' }),
]
let stopping = false
const stop = (code = 0) => {
  if (stopping) return
  stopping = true
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
  process.exitCode = code
}
for (const child of children) child.on('exit', (code) => { if (!stopping) stop(code || 0) })
process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))
console.log('UniTracker frontend: http://localhost:3001 (API proxied to backend :3002)')
