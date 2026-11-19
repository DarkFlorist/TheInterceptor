import { dirname, join } from 'node:path'
import { recoverEthereumPublicKey } from '../app/ts/utils/ethereumRecoveryBackend.js'
import { getRecordProperty, isRecord } from '../app/ts/utils/runtimeTypeGuards.js'

const projectRoot = join(import.meta.dir, '..')
const readManifest = async (directory: string) => {
	const value: unknown = await Bun.file(join(directory, 'package.json')).json()
	if (!isRecord(value)) throw new Error(`Invalid package manifest: ${ directory }`)
	return value
}
const project = await readManifest(projectRoot)
const backendDirectory = dirname(Bun.resolveSync('../app/ts/utils/ethereumRecoveryBackend.js', import.meta.dir))
const microDirectory = dirname(Bun.resolveSync('micro-eth-signer', backendDirectory))
const curveDirectory = dirname(Bun.resolveSync('@noble/curves/secp256k1.js', microDirectory))
const micro = await readManifest(microDirectory)
const curve = await readManifest(curveDirectory)
const dependencies = getRecordProperty(project, 'dependencies')
const patches = getRecordProperty(project, 'patchedDependencies')
const microVersion = getRecordProperty(micro, 'version')
const curveVersion = getRecordProperty(curve, 'version')
if (!isRecord(dependencies) || getRecordProperty(dependencies, 'micro-eth-signer') !== microVersion) throw new Error('Recovery must resolve the pinned micro-eth-signer version')
const patch = isRecord(patches) && typeof curveVersion === 'string' ? getRecordProperty(patches, `@noble/curves@${ curveVersion }`) : undefined
if (typeof patch !== 'string' || !await Bun.file(join(projectRoot, patch)).exists()) throw new Error('The Noble copy resolved by micro-eth-signer must have a version-pinned patch')

// Probe the same adapter application signing uses, so resolution or patch drift fails before tests or extension compilation.
const digest = new Uint8Array(32)
digest[31] = 1
for (const r of [5n, 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n]) {
	if (recoverEthereumPublicKey(digest, { r, s: 1n, yParity: 0 }).success) throw new Error('Recovery dependency must skip both tagged invalid-point outcomes')
}
console.log(`Verified recovery dependency: micro-eth-signer ${ microVersion }, patched Noble ${ curveVersion }`)
