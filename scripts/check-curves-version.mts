import process from 'node:process'

// ethereumRecovery.ts checks signatures on the direct @noble/curves and recovers them through micro-eth-signer's copy, so the direct pin must equal micro-eth-signer's own dependency and bun.lock must install @noble/curves exactly once, under any parent path.
// @noble/hashes is not held to one copy: the app's own @noble/hashes never feeds curve code, which uses the curves package's own utilities, so separate hashes copies only hash and encode bytes.
type CurvesVersionCoupling = { readonly pinnedVersion: string | undefined, readonly requiredVersion: string | undefined, readonly lockfile: string }

export function getCurvesVersionCouplingErrors({ pinnedVersion, requiredVersion, lockfile }: CurvesVersionCoupling) {
	const errors: string[] = []
	if (requiredVersion === undefined) errors.push('micro-eth-signer no longer depends on @noble/curves: revisit ethereumRecovery.ts and the direct @noble/curves dependency.')
	else if (pinnedVersion !== requiredVersion) errors.push(`package.json pins @noble/curves ${ pinnedVersion ?? '(missing)' }, but micro-eth-signer depends on ${ requiredVersion }: set exactly ${ requiredVersion } so ethereumRecovery.ts and recoverAddress run on one copy of the library.`)
	const curvesInstallations = [...lockfile.matchAll(/"([^"]+)": \["@noble\/curves@([^"]+)"/gu)].map(([, installPath, version]) => `${ installPath } (${ version })`)
	if (curvesInstallations.length > 1) errors.push(`bun.lock installs @noble/curves more than once: ${ curvesInstallations.join(', ') }. Align the versions and reinstall.`)
	return errors
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const readCurvesDependency = async (packageJsonPath: string) => {
	const packageJson: unknown = await Bun.file(packageJsonPath).json()
	if (!isRecord(packageJson) || !isRecord(packageJson.dependencies)) return undefined
	const version = packageJson.dependencies['@noble/curves']
	return typeof version === 'string' ? version : undefined
}

if (import.meta.main) {
	const errors = getCurvesVersionCouplingErrors({
		pinnedVersion: await readCurvesDependency('package.json'),
		requiredVersion: await readCurvesDependency('node_modules/micro-eth-signer/package.json'),
		lockfile: await Bun.file('bun.lock').text(),
	})
	if (errors.length > 0) {
		for (const error of errors) console.error(error)
		process.exit(1)
	}
}
