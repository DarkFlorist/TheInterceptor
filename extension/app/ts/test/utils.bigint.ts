import { bigintToRoundedPrettyDecimalString } from '../utils/bigint.js'
import { runTestCases } from './runTestCases.js'

export function main() {
	return runTestCases('utils.bigint', [
		[ () => bigintToRoundedPrettyDecimalString(10n ** 18n, 18n, 4n), '1', 'Displays 1 ETH' ],
		[ () => bigintToRoundedPrettyDecimalString(2n ** 10n ** 17n, 18n, 4n), '0.2', 'Displays 0.2 ETH' ],
		[ () => bigintToRoundedPrettyDecimalString(10n ** 10n, 18n, 4n), '0.00000001', 'Displays 0.00000001 ETH' ],
		[ () => bigintToRoundedPrettyDecimalString(10n ** 26n, 18n, 4n), '100M', 'Displays 100M ETH' ],
		[ () => bigintToRoundedPrettyDecimalString(234567n * 10n ** 16n, 18n, 4n), '2.345k', 'Displays 2.345k ETH' ],
		[ () => bigintToRoundedPrettyDecimalString(-234567n * 10n ** 16n, 18n, 4n), '-2.345k', 'Displays -2.345k ETH' ],
		[ () => bigintToRoundedPrettyDecimalString(-234567n * 10n ** 12n, 18n, 4n), '-0.2345', 'Displays -0.2345 ETH' ],
	])
}

if (require.main === module) {
	try {
		main()
	} catch (error) {
		console.dir(error, { colors: true, depth: null })
		process.exit(1)
	}
}
