import { RED, RESET } from './runTestCases.js'
import { main as testUtilsBigint } from './utils.bigint.js'

function main() {
	return [
		testUtilsBigint()
	].every(item => item)
}

if (require.main === module) {
	try {
		if (!main()) {
			console.log(`${ RED }TESTS FAILED!${ RESET }`)
			process.exit(1);
		}
	} catch (error) {
		console.dir(error, { colors: true, depth: null })
		process.exit(1)
	}
}

