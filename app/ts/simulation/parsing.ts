import type { EthereumClientService } from './services/EthereumClientService.js'
import { type EthereumAddress, EthereumData, type EthereumQuantity } from '../types/wire-types.js'
import { bytes32String } from '../utils/bigint.js'
import { APPROVAL_LOG, DEPOSIT_LOG, ENS_ADDRESS_CHANGED, ENS_ADDR_CHANGED, ENS_CONTENT_HASH_CHANGED, ENS_ETHEREUM_NAME_SERVICE, ENS_ETH_REGISTRAR_CONTROLLER, ENS_EXPIRY_EXTENDED, ENS_FUSES_SET, ENS_NAME_CHANGED, ENS_CONTROLLER_NAME_REGISTERED, ENS_BASE_REGISTRAR_NAME_RENEWED, ENS_NAME_UNWRAPPED, ENS_NEW_OWNER, ENS_NEW_RESOLVER, ENS_NEW_TTL, ENS_PUBLIC_RESOLVER, ENS_PUBLIC_RESOLVER_2, ENS_CONTROLLER_NAME_RENEWED, ENS_REGISTRY_WITH_FALLBACK, ENS_REVERSE_CLAIMED, ENS_REVERSE_REGISTRAR, ENS_TEXT_CHANGED, ENS_TEXT_CHANGED_KEY_VALUE, ENS_TOKEN_WRAPPER, ENS_TRANSFER, ERC1155_TRANSFERBATCH_LOG, ERC1155_TRANSFERSINGLE_LOG, ERC721_APPROVAL_FOR_ALL_LOG, TRANSFER_LOG, WITHDRAWAL_LOG, ENS_BASE_REGISTRAR_NAME_REGISTERED, ENS_NAME_WRAPPED } from '../utils/constants.js'
import { handleApprovalLog, handleDepositLog, handleERC1155TransferBatch, handleERC1155TransferSingle, handleERC20TransferLog, handleEnsAddrChanged, handleEnsAddressChanged, handleEnsContentHashChanged, handleEnsExpiryExtended, handleEnsFusesSet, handleEnsNameChanged, handleEnsNameUnWrapped, handleEnsNewOwner, handleEnsNewResolver, handleEnsNewTtl, handleEnsControllerNameRenewed, handleEnsReverseClaimed, handleEnsTextChanged, handleEnsTextChangedKeyValue, handleEnsTransfer, handleErc721ApprovalForAllLog, handleControllerNameRegistered, handleBaseRegistrarNameRenewed, handleWithdrawalLog, handleBaseRegistrarNameRegistered, handleNameWrapped } from './logHandlers.js'
import type { AddressBookEntryCategory } from '../types/addressBookTypes.js'
import { parseEventIfPossible, parseTransactionInputIfPossible } from './services/SimulationModeEthereumClientService.js'
import { getAbi, extractFunctionArgumentTypes, removeTextBetweenBrackets } from '../utils/abi.js'
import { SolidityType } from '../types/solidityType.js'
import { parseSolidityValueByTypePure } from '../utils/solidityTypes.js'
import { identifyAddress } from '../background/metadataUtils.js'
import { assertNever } from '../utils/typescript.js'
import type { EthereumEvent } from '../types/ethSimulate-types.js'
import type { EnrichedEthereumEvent, EnrichedEthereumInputData, ParsedEvent, TokenVisualizerResult } from '../types/EnrichedEthereumData.js'
import { promiseAllMapAbortSafe } from '../utils/requests.js'
import { reportLocalRecoveryBestEffort } from '../utils/errors.js'

type TokenLogHandler = (event: EthereumEvent) => TokenVisualizerResult[]

const getTokenEventHandler = (type: AddressBookEntryCategory, logSignature: string) => {
	const erc20LogHanders = new Map<string, TokenLogHandler>([
		[TRANSFER_LOG, handleERC20TransferLog],
		[APPROVAL_LOG, handleApprovalLog],
		[DEPOSIT_LOG, handleDepositLog],
		[WITHDRAWAL_LOG, handleWithdrawalLog],
	])
	const erc721LogHanders = new Map<string, TokenLogHandler>([
		[TRANSFER_LOG, handleERC20TransferLog],
		[APPROVAL_LOG, handleApprovalLog],
		[ERC721_APPROVAL_FOR_ALL_LOG, handleErc721ApprovalForAllLog],
	])
	const erc1155LogHanders = new Map<string, TokenLogHandler>([
		[ERC721_APPROVAL_FOR_ALL_LOG, handleErc721ApprovalForAllLog],
		[ERC1155_TRANSFERBATCH_LOG, handleERC1155TransferBatch],
		[ERC1155_TRANSFERSINGLE_LOG, handleERC1155TransferSingle],
	])

	switch (type) {
		case 'ERC1155': return erc1155LogHanders.get(logSignature)
		case 'ERC20': return erc20LogHanders.get(logSignature)
		case 'ERC721': return erc721LogHanders.get(logSignature)
		case 'activeAddress':
		case 'contact':
		case 'contract': return undefined
		default: assertNever(type)
	}
}

const ensEventHandler = (parsedEvent: ParsedEvent) => {
	if (parsedEvent.topics[0] !== undefined) {
		const logSignature = bytes32String(parsedEvent.topics[0])
		if (parsedEvent.loggersAddressBookEntry.address === ENS_PUBLIC_RESOLVER || parsedEvent.loggersAddressBookEntry.address === ENS_PUBLIC_RESOLVER_2) {
			if (logSignature === ENS_ADDRESS_CHANGED) return { logInformation: handleEnsAddressChanged(parsedEvent), type: 'ENS' as const, subType: 'ENSAddressChanged' as const }
			if (logSignature === ENS_ADDR_CHANGED) return { logInformation: handleEnsAddrChanged(parsedEvent), type: 'ENS' as const, subType: 'ENSAddrChanged' as const }
			if (logSignature === ENS_TEXT_CHANGED) return { logInformation: handleEnsTextChanged(parsedEvent), type: 'ENS' as const, subType: 'ENSTextChanged' as const }
			if (logSignature === ENS_TEXT_CHANGED_KEY_VALUE) return { logInformation: handleEnsTextChangedKeyValue(parsedEvent), type: 'ENS' as const, subType: 'ENSTextChangedKeyValue' as const }
			if (logSignature === ENS_CONTENT_HASH_CHANGED) return { logInformation: handleEnsContentHashChanged(parsedEvent), type: 'ENS' as const, subType: 'ENSContentHashChanged' as const }
			if (logSignature === ENS_NAME_CHANGED) return { logInformation: handleEnsNameChanged(parsedEvent), type: 'ENS' as const, subType: 'ENSNameChanged' as const }
		}
		if (parsedEvent.loggersAddressBookEntry.address === ENS_TOKEN_WRAPPER) {
			if (logSignature === ENS_FUSES_SET) return { logInformation: handleEnsFusesSet(parsedEvent), type: 'ENS' as const, subType: 'ENSFusesSet' as const }
			if (logSignature === ENS_NAME_UNWRAPPED) return { logInformation: handleEnsNameUnWrapped(parsedEvent), type: 'ENS' as const, subType: 'ENSNameUnwrapped' as const }
			if (logSignature === ENS_NAME_WRAPPED) return { logInformation: handleNameWrapped(parsedEvent), type: 'ENS' as const, subType: 'ENSNameWrapped' as const }
			if (logSignature === ENS_EXPIRY_EXTENDED) return { logInformation: handleEnsExpiryExtended(parsedEvent), type: 'ENS' as const, subType: 'ENSExpiryExtended' as const }
		}
		else if (parsedEvent.loggersAddressBookEntry.address === ENS_ETH_REGISTRAR_CONTROLLER) {
			if (logSignature === ENS_CONTROLLER_NAME_REGISTERED) return { logInformation: handleControllerNameRegistered(parsedEvent), type: 'ENS' as const, subType: 'ENSControllerNameRegistered' as const }
			if (logSignature === ENS_CONTROLLER_NAME_RENEWED) return { logInformation: handleEnsControllerNameRenewed(parsedEvent), type: 'ENS' as const, subType: 'ENSControllerNameRenewed' as const }
		}
		else if (parsedEvent.loggersAddressBookEntry.address === ENS_ETHEREUM_NAME_SERVICE) {
			if (logSignature === ENS_BASE_REGISTRAR_NAME_RENEWED) return { logInformation: handleBaseRegistrarNameRenewed(parsedEvent), type: 'ENS' as const, subType: 'ENSBaseRegistrarNameRenewed' as const }
			if (logSignature === ENS_BASE_REGISTRAR_NAME_REGISTERED) return { logInformation: handleBaseRegistrarNameRegistered(parsedEvent), type: 'ENS' as const, subType: 'ENSBaseRegistrarNameRegistered' as const }
		}
		else if (parsedEvent.loggersAddressBookEntry.address === ENS_REGISTRY_WITH_FALLBACK) {
			if (logSignature === ENS_TRANSFER) return { logInformation: handleEnsTransfer(parsedEvent), type: 'ENS' as const, subType: 'ENSTransfer' as const }
			if (logSignature === ENS_NEW_OWNER) return { logInformation: handleEnsNewOwner(parsedEvent), type: 'ENS' as const, subType: 'ENSNewOwner' as const }
			if (logSignature === ENS_NEW_RESOLVER) return { logInformation: handleEnsNewResolver(parsedEvent), type: 'ENS' as const, subType: 'ENSNewResolver' as const }
			if (logSignature === ENS_NEW_TTL) return { logInformation: handleEnsNewTtl(parsedEvent), type: 'ENS' as const, subType: 'ENSNewTTL' as const }
			if (logSignature === ENS_EXPIRY_EXTENDED) return { logInformation: handleEnsExpiryExtended(parsedEvent), type: 'ENS' as const, subType: 'ENSExpiryExtended' as const }
		}
		else if (parsedEvent.loggersAddressBookEntry.address === ENS_REVERSE_REGISTRAR) {
			if (logSignature === ENS_REVERSE_CLAIMED) return { logInformation: handleEnsReverseClaimed(parsedEvent), type: 'ENS' as const, subType: 'ENSReverseClaimed' as const }
		}
	}
	return undefined
}

export const parseInputData = async (transaction: { to: EthereumAddress | undefined | null, value: EthereumQuantity, input: EthereumData }, ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined): Promise<EnrichedEthereumInputData> => {
	const nonParsed = { input: transaction.input, type: 'NonParsed' as const }
	if (transaction.to === undefined || transaction.to === null) return nonParsed
	const addressBookEntry = await identifyAddress(ethereumClientService, requestAbortController, transaction.to)
	const abi = getAbi(addressBookEntry)
	if (!abi) return nonParsed
	const parsed = parseTransactionInputIfPossible(abi, transaction.input, transaction.value)
	if (parsed === undefined) return nonParsed
	if (parsed.fragment.type !== 'function') return nonParsed
	const functionFragment = parsed.fragment
	const argTypes = extractFunctionArgumentTypes(parsed.signature)
	if (argTypes === undefined) return nonParsed
	if (parsed.args.length !== argTypes.length) return nonParsed
	try {
		const valuesWithTypes = parsed.args.map((value, index) => {
			const solidityType = argTypes[index]
			const paramName = functionFragment.inputs[index]?.name
			if (paramName === undefined) throw new Error('missing parameter name')
			if (solidityType === undefined) throw new Error(`unknown solidity type: ${ solidityType }`)
			const isArray = solidityType.includes('[')
			const verifiedSolidityType = SolidityType.safeParse(removeTextBetweenBrackets(solidityType))
			if (verifiedSolidityType.success === false) throw new Error(`unknown solidity type: ${ solidityType }`)
			if (typeof value === 'object' && value !== null && 'hash' in value) {
				return { paramName, typeValue: { type: 'fixedBytes' as const, value: EthereumData.parse(value.hash) } }
			}
			return { paramName, typeValue: parseSolidityValueByTypePure(verifiedSolidityType.value, value, isArray) }
		})
		return {
			input: transaction.input,
			type: 'Parsed' as const,
			name: parsed.name,
			args: valuesWithTypes,
		}
	} catch (e: unknown) {
		reportLocalRecoveryBestEffort(e, {
			code: 'transaction_input_parse_failed',
			message: 'Falling back to showing unparsed calldata.',
			details: { transaction },
		})
		return nonParsed
	}
}

export const parseEvents = async (events: readonly EthereumEvent[], ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined): Promise<readonly EnrichedEthereumEvent[]> => {
	const parsedEvents = await promiseAllMapAbortSafe(events, async (event) => {
		const loggersAddressBookEntry = await identifyAddress(ethereumClientService, requestAbortController, event.address)
		const abi = getAbi(loggersAddressBookEntry)
		const nonParsed = { ...event, isParsed: 'NonParsed' as const, loggersAddressBookEntry }
		if (!abi) return nonParsed
		const parsed = parseEventIfPossible(abi, event)
		if (parsed === undefined) return nonParsed
		if (parsed.fragment.type !== 'event') return nonParsed
		const eventFragment = parsed.fragment
		const argTypes = extractFunctionArgumentTypes(parsed.signature)
		if (argTypes === undefined) return nonParsed
		if (parsed.args.length !== argTypes.length) return nonParsed
		const valuesWithTypes = parsed.args.map((value, index) => {
			const solidityType = argTypes[index]
			const paramName = eventFragment.inputs[index]?.name
			if (paramName === undefined) throw new Error('missing parameter name')
			if (solidityType === undefined) throw new Error(`unknown solidity type: ${ solidityType }`)
			const isArray = solidityType.includes('[')
			const verifiedSolidityType = SolidityType.safeParse(removeTextBetweenBrackets(solidityType))
			if (verifiedSolidityType.success === false) throw new Error(`unknown solidity type: ${ solidityType }`)
			if (typeof value === 'object' && value !== null && 'hash' in value) {
				return { paramName, typeValue: { type: 'fixedBytes' as const, value: EthereumData.parse(value.hash) } }
			}
			return { paramName, typeValue: parseSolidityValueByTypePure(verifiedSolidityType.value, value, isArray) }
		})
		return {
			...event,
			isParsed: 'Parsed' as const,
			name: parsed.name,
			signature: parsed.signature,
			args: valuesWithTypes,
			loggersAddressBookEntry,
		}
	})

	const maybeParsedEvents: EnrichedEthereumEvent[][] = parsedEvents.map((parsedEvent) => {
		if (parsedEvent.isParsed === 'NonParsed') return [{ ...parsedEvent, type: 'NonParsed' }]
		const logSignature = parsedEvent.topics[0]
		if (logSignature === undefined) return [{ ...parsedEvent, type: 'Parsed' }]
		const tokenEventhandler = getTokenEventHandler(parsedEvent.loggersAddressBookEntry.type, bytes32String(logSignature))
		if (tokenEventhandler !== undefined) return tokenEventhandler(parsedEvent).map((logInformation) => ({ ...parsedEvent, type: 'TokenEvent', logInformation }))

		const handledEnsEvent = ensEventHandler(parsedEvent)
		if (handledEnsEvent !== undefined) return [{ ...parsedEvent, ...handledEnsEvent }]
		return [{ ...parsedEvent, type: 'Parsed' }]
	})
	return maybeParsedEvents.flat()
}
