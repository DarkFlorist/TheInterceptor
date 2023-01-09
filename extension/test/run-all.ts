import { GREEN, RED, RESET, runIfRoot } from './runTestCases.js'
import { main as testUtilsBigint } from './utils.bigint.js'
import { main as testMetadataUtils } from './metadataUtils.js'

async function main() {
	const result = [
		await testUtilsBigint(),
		await testMetadataUtils(),
	].every(item => item === true)

	if (!result) {
		console.error(`${ RED }TESTS FAILED!${ RESET }`)
		process.exit(1);
	}
	console.log(`${ GREEN }TESTS SUCCEEDED!${ RESET }`)
	process.exit(0);
}

await runIfRoot(main, import.meta)
