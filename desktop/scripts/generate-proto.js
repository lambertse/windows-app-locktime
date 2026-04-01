/**
 * generate-proto.js
 *
 * Two tasks:
 *
 * 1. Copies the shared locktime.proto into desktop/resources/ so it is
 *    bundled as an Electron extraResource and can be loaded at runtime by
 *    protobufjs in the main process.
 *
 * 2. Generates dist/generated/proto.js inside @lambertse/ibridger from the
 *    ibridger wire-protocol proto files.  The published npm package omits this
 *    generated file, so we must produce it locally after every `npm install`.
 *
 * Run via: npm run generate-proto
 */

const fs   = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

// ── Task 1: copy locktime.proto for runtime loading ──────────────────────────

const SRC  = path.resolve(__dirname, '..', '..', 'proto', 'locktime', 'locktime.proto')
const DEST = path.resolve(__dirname, '..', 'resources', 'proto', 'locktime', 'locktime.proto')

fs.mkdirSync(path.dirname(DEST), { recursive: true })
fs.copyFileSync(SRC, DEST)
console.log(`[generate-proto] Copied locktime.proto → ${DEST}`)

// ── Task 2: generate ibridger wire-protocol types ─────────────────────────────

const IBRIDGER_PROTO_DIR = path.resolve(
  __dirname, '..', '..', 'backend', 'build', '_deps', 'ibridger-src', 'proto', 'ibridger'
)
const IBRIDGER_OUT_DIR = path.resolve(
  __dirname, '..', 'node_modules', '@lambertse', 'ibridger', 'dist', 'generated'
)
const PROTO_FILES = ['constants.proto', 'envelope.proto', 'rpc.proto'].map(
  (f) => path.join(IBRIDGER_PROTO_DIR, f)
)

const pbjs = path.resolve(__dirname, '..', 'node_modules', '.bin', 'pbjs')
const pbts = path.resolve(__dirname, '..', 'node_modules', '.bin', 'pbts')

if (!fs.existsSync(pbjs)) {
  console.warn('[generate-proto] pbjs not found — skipping ibridger proto generation.')
  console.warn('  Run: npm install --no-save protobufjs-cli')
  process.exit(0)
}

const missingProto = PROTO_FILES.find((f) => !fs.existsSync(f))
if (missingProto) {
  console.warn(`[generate-proto] ibridger proto file not found: ${missingProto}`)
  console.warn('  Run cmake to fetch ibridger before generating protos.')
  process.exit(0)
}

fs.mkdirSync(IBRIDGER_OUT_DIR, { recursive: true })

const outJs = path.join(IBRIDGER_OUT_DIR, 'proto.js')
execFileSync(pbjs, ['-t', 'static-module', '-w', 'commonjs', '-o', outJs, ...PROTO_FILES])
console.log(`[generate-proto] Generated ibridger proto.js → ${outJs}`)

const outDts = path.join(IBRIDGER_OUT_DIR, 'proto.d.ts')
execFileSync(pbts, ['-o', outDts, outJs])
console.log(`[generate-proto] Generated ibridger proto.d.ts → ${outDts}`)
