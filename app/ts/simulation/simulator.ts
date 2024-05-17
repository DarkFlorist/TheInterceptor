import { EthereumClientService } from './services/EthereumClientService.js'
import { selfTokenOops } from './protectors/selfTokenOops.js'
import { EthereumBlockHeader, EthereumData } from '../types/wire-types.js'
import { bytes32String } from '../utils/bigint.js'
import { feeOops } from './protectors/feeOops.js'
import { commonTokenOops } from './protectors/commonTokenOops.js'
import { eoaApproval } from './protectors/eoaApproval.js'
import { eoaCalldata } from './protectors/eoaCalldata.js'
import { tokenToContract } from './protectors/tokenToContract.js'
import { WebsiteCreatedEthereumUnsignedTransaction, SimulationState, TokenVisualizerResult, EnrichedEthereumEvent, ParsedEvent, ParsedEnsEvent } from '../types/visualizer-types.js'
import { EthereumJSONRpcRequestHandler } from './services/EthereumJSONRpcRequestHandler.js'
import { APPROVAL_LOG, DEPOSIT_LOG, ENS_ADDRESS_CHANGED, ENS_ADDR_CHANGED, ENS_CONTENT_HASH_CHANGED, ENS_ETHEREUM_NAME_SERVICE, ENS_ETH_REGISTRAR_CONTROLLER, ENS_NAME_RENEWED, ENS_NEW_OWNER, ENS_NEW_RESOLVER, ENS_PUBLIC_RESOLVER, ENS_PUBLIC_RESOLVER_2, ENS_REGISTRAR_NAME_RENEWED, ENS_REGISTRY_WITH_FALLBACK, ENS_TEXT_CHANGED, ENS_TEXT_CHANGED_KEY_VALUE, ENS_TRANSFER, ERC1155_TRANSFERBATCH_LOG, ERC1155_TRANSFERSINGLE_LOG, ERC721_APPROVAL_FOR_ALL_LOG, TRANSFER_LOG, WITHDRAWAL_LOG } from '../utils/constants.js'
import { handleApprovalLog, handleDepositLog, handleERC1155TransferBatch, handleERC1155TransferSingle, handleERC20TransferLog, handleEnsAddrChanged, handleEnsAddressChanged, handleEnsContentHashChanged, handleEnsNewOwner, handleEnsNewResolver, handleEnsRegistrarNameRenewed, handleEnsTextChanged, handleEnsTextChangedKeyValue, handleEnsTransfer, handleErc721ApprovalForAllLog, handleNameRenewed, handleWithdrawalLog } from './logHandlers.js'
import { RpcEntry } from '../types/rpc.js'
import { AddressBookEntryCategory } from '../types/addressBookTypes.js'
import { parseEventIfPossible } from './services/SimulationModeEthereumClientService.js'
import { Interface } from 'ethers'
import { extractAbi, extractFunctionArgumentTypes, removeTextBetweenBrackets } from '../utils/abi.js'
import { SolidityType } from '../types/solidityType.js'
import { parseSolidityValueByTypePure } from '../utils/solidityTypes.js'
import { identifyAddress } from '../background/metadataUtils.js'
import { sendToNonContact } from './protectors/sendToNonContactAddress.js'
import { assertNever } from '../utils/typescript.js'
import { EthereumEvent } from '../types/ethSimulate-types.js'
import { chainIdMismatch } from './protectors/chainIdMismatch.js'

const PROTECTORS = [
	selfTokenOops,
	commonTokenOops,
	feeOops,
	eoaApproval,
	eoaCalldata,
	tokenToContract,
	sendToNonContact,
	chainIdMismatch,
]

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

const ensEventHandler = (parsedEvent: ParsedEvent): ParsedEnsEvent | undefined => {
	if (parsedEvent.topics[0] !== undefined) {
		const logSignature = bytes32String(parsedEvent.topics[0])
		if (parsedEvent.loggersAddressBookEntry.address === ENS_PUBLIC_RESOLVER || parsedEvent.loggersAddressBookEntry.address === ENS_PUBLIC_RESOLVER_2) {
			if (logSignature === ENS_ADDRESS_CHANGED) return { logInformation: handleEnsAddressChanged(parsedEvent), type: 'ENSAddressChanged' as const }
			if (logSignature === ENS_ADDR_CHANGED) return { logInformation: handleEnsAddrChanged(parsedEvent), type: 'ENSAddrChanged' as const }
			if (logSignature === ENS_TEXT_CHANGED) return { logInformation: handleEnsTextChanged(parsedEvent), type: 'ENSTextChanged' as const }
			if (logSignature === ENS_TEXT_CHANGED_KEY_VALUE) return { logInformation: handleEnsTextChangedKeyValue(parsedEvent), type: 'ENSTextChangedKeyValue' as const }
			if (logSignature === ENS_CONTENT_HASH_CHANGED) return { logInformation: handleEnsContentHashChanged(parsedEvent), type: 'ENSContentHashChanged' as const }
		}
		else if (parsedEvent.loggersAddressBookEntry.address === ENS_ETH_REGISTRAR_CONTROLLER) {
			if (logSignature === ENS_REGISTRAR_NAME_RENEWED) return { logInformation: handleEnsRegistrarNameRenewed(parsedEvent), type: 'ENSRegistrarNameRenewed' as const }
		}
		else if(parsedEvent.loggersAddressBookEntry.address === ENS_ETHEREUM_NAME_SERVICE) {
			if (logSignature === ENS_NAME_RENEWED) return { logInformation: handleNameRenewed(parsedEvent), type: 'ENSNameRenewed' as const }
		}
		else if(parsedEvent.loggersAddressBookEntry.address === ENS_REGISTRY_WITH_FALLBACK) {
			if (logSignature === ENS_TRANSFER) return { logInformation: handleEnsTransfer(parsedEvent), type: 'ENSTransfer' as const }
			if (logSignature === ENS_NEW_OWNER) return { logInformation: handleEnsNewOwner(parsedEvent), type: 'ENSNewOwner' as const }
			if (logSignature === ENS_NEW_RESOLVER) return { logInformation: handleEnsNewResolver(parsedEvent), type: 'ENSNewResolver' as const }
		}
	}
	return undefined
}

export const parseEvents = async (events: readonly EthereumEvent[], ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined): Promise<readonly EnrichedEthereumEvent[]> => {
	const parsedEvents = await Promise.all(events.map(async (event) => {
		// todo, we should do this parsing earlier, to be able to add possible addresses to addressMetaData set
		const loggersAddressBookEntry = await identifyAddress(ethereumClientService, requestAbortController, event.address)
		const abi = extractAbi(loggersAddressBookEntry, event.address)
		const nonParsed = { ...event, isParsed: 'NonParsed' as const, loggersAddressBookEntry }
		if (!abi) return nonParsed
		const parsed = parseEventIfPossible(new Interface(abi), event)
		if (parsed === null) return nonParsed
		const argTypes = extractFunctionArgumentTypes(parsed.signature)
		if (argTypes === undefined) return nonParsed
		if (parsed.args.length !== argTypes.length) return nonParsed
		const valuesWithTypes = parsed.args.map((value, index) => {
			const solidityType = argTypes[index]
			const paramName = parsed.fragment.inputs[index]?.name
			if (paramName === undefined) throw new Error('missing parameter name')
			if (solidityType === undefined) throw new Error(`unknown solidity type: ${ solidityType }`)
			const isArray = solidityType.includes('[')
			const verifiedSolidityType = SolidityType.safeParse(removeTextBetweenBrackets(solidityType))
			if (verifiedSolidityType.success === false) throw new Error(`unknown solidity type: ${ solidityType }`)
			if (typeof value === 'object' && value !== null && 'hash' in value) {
				// this field is stored as a hash instead as an original object
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
	}))
	
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

export const runProtectorsForTransaction = async (simulationState: SimulationState, transaction: WebsiteCreatedEthereumUnsignedTransaction, ethereum: EthereumClientService, requestAbortController: AbortController | undefined) => {
	const reasonPromises = PROTECTORS.map(async (protectorMethod) => await protectorMethod(transaction.transaction, ethereum, requestAbortController, simulationState))
	const reasons: (string | undefined)[] = await Promise.all(reasonPromises)
	const filteredReasons = reasons.filter((reason): reason is string => reason !== undefined)
	return {
		quarantine: filteredReasons.length > 0,
		quarantineReasons: Array.from(new Set<string>(filteredReasons)),
	}
}

type NewBlockCallBack = (blockHeader: EthereumBlockHeader, ethereumClientService: EthereumClientService, isNewBlock: boolean, simulator: Simulator) => Promise<void>
export class Simulator {
	public ethereum: EthereumClientService
	private newBlockAttemptCallback: NewBlockCallBack
	public constructor(rpcNetwork: RpcEntry, newBlockAttemptCallback: NewBlockCallBack, onErrorBlockCallback: (ethereumClientService: EthereumClientService) => Promise<void>) {
		this.newBlockAttemptCallback = newBlockAttemptCallback
		this.ethereum = new EthereumClientService(
			new EthereumJSONRpcRequestHandler(rpcNetwork, true),
			async (blockHeader: EthereumBlockHeader, ethereumClientService: EthereumClientService, isNewBlock: boolean) => await newBlockAttemptCallback(blockHeader, ethereumClientService, isNewBlock, this),
			onErrorBlockCallback
		)
	}

	public cleanup = () => this.ethereum.cleanup()

	public reset = (rpcNetwork: RpcEntry) => {
		this.cleanup()
		this.ethereum = new EthereumClientService(
			new EthereumJSONRpcRequestHandler(rpcNetwork, true),
			async (blockHeader: EthereumBlockHeader, ethereumClientService: EthereumClientService, isNewBlock: boolean) => await this.newBlockAttemptCallback(blockHeader, ethereumClientService, isNewBlock, this),
			this.ethereum.getOnErrorBlockCallback()
		)
	}
}
