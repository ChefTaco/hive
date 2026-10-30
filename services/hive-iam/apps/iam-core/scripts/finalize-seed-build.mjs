// The seed (prisma/seed.ts) imports the generated Prisma client from
// ../src/db/generated. The build ships that client at dist/db/generated, so
// point the compiled seed (dist/prisma/seed.js) at it. Fails the build if the
// import is not found exactly once.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const seedPath = fileURLToPath(new URL('../dist/prisma/seed.js', import.meta.url))
const from = "from '../src/db/generated/index.js'"
const to = "from '../db/generated/index.js'"
const source = readFileSync(seedPath, 'utf8')
const occurrences = source.split(from).length - 1
if (occurrences !== 1) {
  console.error(`finalize-seed-build: expected one "${from}" in ${seedPath}, found ${occurrences}`)
  process.exit(1)
}
writeFileSync(seedPath, source.replace(from, to))
