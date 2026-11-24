import { DEFAULT_ACTIVE_ADDRESSES } from '../config/defaults.js'
import type { RichAccountBalance, RichModeState } from '../types/richMode.js'
import { MAKE_YOU_RICH_TRANSACTION } from '../utils/constants.js'
import { richTokenLayout } from '../utils/richModeDerivation.js'
import { normalizeRichAccountBalances } from '../utils/richTokens.js'
import { browserStorageLocalSafeParse } from '../utils/storageUtils.js'
import { getStoredActiveSimulationAddress } from './settings.js'
import { getUserAddressBookEntries } from './addressBookStorage.js'
import { emptyRichModeState, richModeStateStorageWrite } from './richModeSettings.js'
import { runSettingsStorageTransaction } from './settingsStorageTransaction.js'

const legacyKeys = ['makeCurrentAddressRich', 'fixedAddressRichList', 'richNativeAmount', 'richTokens', 'richAccountBalances'] as const
type LegacyRichModeValues = Partial<Record<typeof legacyKeys[number], unknown>>

// Every address that can be made rich without first being added somewhere: the fixed rich list, the active simulation address and the address book's active addresses. Legacy token amounts applied to whichever of them was rich, so each gets them, rich now or not.
async function getLegacyFundingCandidateAddresses(fixedAddresses: readonly bigint[]) {
	const activeAddress = await getStoredActiveSimulationAddress() ?? DEFAULT_ACTIVE_ADDRESSES[0]?.address
	const addressBookActiveAddresses = (await getUserAddressBookEntries()).filter((entry) => entry.useAsActiveAddress === true).map((entry) => entry.address)
	return [...new Set([...fixedAddresses, ...(activeAddress === undefined ? [] : [activeAddress]), ...addressBookActiveAddresses])]
}

// Converts the legacy keys into canonical funding state. Legacy per-account profiles are kept as they are; legacy global token amounts become per-account balances of every candidate address on the token's chain.
async function getMigratedRichModeState(rawLegacyValues: LegacyRichModeValues): Promise<RichModeState> {
	const fixedAddressRichList = browserStorageLocalSafeParse({ fixedAddressRichList: rawLegacyValues.fixedAddressRichList })?.fixedAddressRichList ?? []
	const tokens = browserStorageLocalSafeParse({ richTokens: rawLegacyValues.richTokens })?.richTokens ?? []
	const defaultNativeAmount = browserStorageLocalSafeParse({ richNativeAmount: rawLegacyValues.richNativeAmount })?.richNativeAmount ?? MAKE_YOU_RICH_TRANSACTION.transaction.value
	const legacyProfiles = rawLegacyValues.richAccountBalances === undefined ? undefined : browserStorageLocalSafeParse({ richAccountBalances: rawLegacyValues.richAccountBalances })?.richAccountBalances ?? []
	const candidateAddresses = await getLegacyFundingCandidateAddresses(fixedAddressRichList.map((entry) => entry.address))
	const tokenChains = [...new Set(tokens.map((token) => token.chainId))]
	const accountBalances = legacyProfiles !== undefined
		? normalizeRichAccountBalances(legacyProfiles)
		: tokenChains.flatMap((chainId) => candidateAddresses.map((address): RichAccountBalance => ({
			chainId,
			address,
			nativeAmount: defaultNativeAmount,
			tokenBalances: tokens.filter((token) => token.chainId === chainId).map((token) => ({ tokenAddress: token.tokenAddress, tokenId: token.tokenId, amount: token.amount })),
		})))
	return {
		makeCurrentAddressRich: browserStorageLocalSafeParse({ makeCurrentAddressRich: rawLegacyValues.makeCurrentAddressRich })?.makeCurrentAddressRich ?? false,
		fixedAddressRichList,
		defaultNativeAmount,
		tokenLayouts: tokens.map(richTokenLayout),
		accountBalances,
	}
}

// One-time startup migration of rich-mode funding. It writes canonical state from the legacy keys when no canonical state exists, resets a corrupt canonical value, and removes the legacy keys only after the canonical write has landed.
export async function migrateRichMode() {
	await runSettingsStorageTransaction(async () => {
		const { richModeState: rawState } = await browser.storage.local.get('richModeState')
		if (rawState !== undefined) {
			if (browserStorageLocalSafeParse({ richModeState: rawState })?.richModeState !== undefined) return { writes: [], result: undefined }
			console.warn('richModeState was corrupt; resetting rich-mode funding.')
			return { writes: [richModeStateStorageWrite(emptyRichModeState)], result: undefined }
		}
		const rawLegacyValues: LegacyRichModeValues = await browser.storage.local.get([...legacyKeys])
		if (legacyKeys.every((key) => rawLegacyValues[key] === undefined)) return { writes: [], result: undefined }
		return { writes: [richModeStateStorageWrite(await getMigratedRichModeState(rawLegacyValues))], result: undefined }
	})
	await browser.storage.local.remove([...legacyKeys])
}
