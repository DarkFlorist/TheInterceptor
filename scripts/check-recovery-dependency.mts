import { dirname, join } from 'node:path'
import { realpath } from 'node:fs/promises'
// This environment-neutral adapter self-checks both invalid-point outcomes on import, including in the shipped extension.
import '../app/ts/utils/ethereumRecoveryBackend.js'
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
const vendorCurveDirectory = join(projectRoot, 'node_modules', '@noble', 'curves')
const vendorCurve = await readManifest(vendorCurveDirectory)
const [recoveryCurvePath, vendorCurvePath] = await Promise.all([realpath(curveDirectory), realpath(vendorCurveDirectory)])
if (!isRecord(dependencies) || getRecordProperty(dependencies, 'micro-eth-signer') !== microVersion) throw new Error('Recovery must resolve the pinned micro-eth-signer version')
if (getRecordProperty(dependencies, '@noble/curves') !== curveVersion || getRecordProperty(vendorCurve, 'version') !== curveVersion || recoveryCurvePath !== vendorCurvePath) throw new Error('Vendor and recovery must use the same directly pinned Noble package')
const patch = isRecord(patches) && typeof curveVersion === 'string' ? getRecordProperty(patches, `@noble/curves@${ curveVersion }`) : undefined
if (typeof patch !== 'string' || !await Bun.file(join(projectRoot, patch)).exists()) throw new Error('The Noble copy resolved by micro-eth-signer must have a version-pinned patch')

console.log(`Verified recovery and vendor dependency: micro-eth-signer ${ microVersion }, patched Noble ${ curveVersion }`)
