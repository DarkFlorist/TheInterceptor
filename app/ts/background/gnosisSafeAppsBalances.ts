import * as funtypes from 'funtypes'
import { addressString } from '../utils/bigint.js'
import { requestGnosisSafeAppsGateway, gnosisSafeAppsServiceError } from './gnosisSafeAppsGateway.js'
import { JsonValue } from '../types/gnosisSafeApps.js'

const GnosisSafeBalances = funtypes.ReadonlyObject({
	fiatTotal: funtypes.String,
	items: funtypes.ReadonlyArray(funtypes.ReadonlyObject({
		tokenInfo: funtypes.ReadonlyObject({
			type: funtypes.String,
			address: funtypes.String,
			name: funtypes.String,
			symbol: funtypes.String,
			logoUri: funtypes.Union(funtypes.String, funtypes.Null),
		}).And(funtypes.ReadonlyPartial({ decimals: funtypes.Union(funtypes.Number.withConstraint(Number.isSafeInteger), funtypes.Null) })),
		balance: funtypes.String,
		fiatBalance: funtypes.String,
		fiatConversion: funtypes.String,
	})),
})

// The SDK expects indexed token balances and fiat values from the Safe gateway, not only the native RPC balance.
export async function fetchGnosisSafeAppsBalances(chainId: bigint, safeAddress: bigint, currency: string) {
	const result = await requestGnosisSafeAppsGateway(`chains/${ chainId.toString() }/safes/${ addressString(safeAddress) }/balances/${ encodeURIComponent(currency) }`, 'balance')
	const balances = GnosisSafeBalances.safeParse(result)
	if (!balances.success) throw gnosisSafeAppsServiceError('The Gnosis Safe balance service returned an invalid balance response.')
	return JsonValue.parse(balances.value)
}
