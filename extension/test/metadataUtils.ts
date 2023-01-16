import { getAddressMetaData } from '../app/ts/background/metadataUtils.js'
import { runIfRoot, runTestCases } from './runTestCases.js'

export async function main() {
	return runTestCases('getAddressMetaData', [
		[ () => getAddressMetaData(0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48n, undefined).name, 'USD Coin', 'USD Coin can be found in the metadata' ]
	])
}

await runIfRoot(main, import.meta)
