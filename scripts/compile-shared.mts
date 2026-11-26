import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileTypeScriptProject } from './compile-typescript.mjs'

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
process.exitCode = compileTypeScriptProject(path.join(projectRoot, 'tsconfig-shared.json'))
