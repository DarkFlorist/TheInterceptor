import { importAirGapAccounts } from './airgapEthereum.js'
import { createAirGapUrDecoder } from './airgapUr.js'

/** Lock the format on the first frame; never mix fragments from different account registries. */
export function createAirGapAccountImporter() {
	let session: { type: 'crypto-account' | 'crypto-hdkey', decoder: ReturnType<typeof createAirGapUrDecoder> } | undefined
	return (frame: string) => {
		if (session === undefined) {
			const type = /^ur:(crypto-account|crypto-hdkey)\//iu.exec(frame)?.[1]?.toLowerCase()
			if (type !== 'crypto-account' && type !== 'crypto-hdkey') throw new Error('Scan an Ethereum public-account export (crypto-hdkey or crypto-account)')
			session = { type, decoder: createAirGapUrDecoder(type) }
		}
		const result = session.decoder.receive(frame)
		return { ...result, accounts: result.payload === undefined ? undefined : importAirGapAccounts(session.type, result.payload) }
	}
}
