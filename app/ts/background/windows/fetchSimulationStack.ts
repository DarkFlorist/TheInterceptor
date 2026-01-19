import { PopupOrTab, addWindowTabListeners, closePopupOrTabById, getPopupOrTabById, openPopupOrTab, removeWindowTabListeners } from '../../components/ui-utils.js'
import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
import { FetchSimulationStackRequestConfirmation } from '../../types/interceptor-messages.js'
import { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { getHtmlFile, sendPopupMessageToOpenWindows, websiteSocketToString } from '../backgroundUtils.js'
import { getFetchSimulationStackRequestPromise, setFetchSimulationStackRequestPromise } from '../storageVariables.js'
import { InterceptedRequest, UniqueRequestIdentifier, WebsiteSocket, doesUniqueRequestIdentifiersMatch } from '../../utils/requests.js'
import { replyToInterceptedRequest } from '../messageSending.js'
import { GetSimulationStack, SimulationStackVersion } from '../../types/JsonRpc-types.js'
import { PopupOrTabId, Website } from '../../types/websiteAccessTypes.js'
import { SimulationState, SimulationStateInput } from '../../types/visualizer-types.js'
import { getSimulatedStackV1, getSimulatedStackV2 } from '../../simulation/SimulationStackExtraction.js'
import { getAddressToMakeRich } from '../../simulation/services/SimulationModeEthereumClientService.js'
import { assertNever } from '../../utils/typescript.js'
import { stringifyJSONWithBigInts } from '../../utils/bigint.js'
import { keccak256, toUtf8Bytes } from 'ethers'
import { getCurrentSimulationInput } from '../simulationUpdating.js'

let pendForUserReply: Future<FetchSimulationStackRequestConfirmation> | undefined = undefined

let openedDialog: PopupOrTab | undefined = undefined
const MAX_DECISION_CACHE = 100
let simulationStackDecisions: { identifier: string, hash: string, accept: boolean }[] = []

export async function updateFetchSimulationStackRequestWithPendingRequest() {
	const promise = await getFetchSimulationStackRequestPromise()
	if (promise) await sendPopupMessageToOpenWindows({ method: 'popup_fetchSimulationStackRequest', data: promise })
	return
}

export async function getSimulationStack(simulationState: SimulationState | undefined, version: SimulationStackVersion) {
	switch (version) {
		case '2.0.0': return { version, payload: getSimulatedStackV2(simulationState) } as const
		case '1.0.0':
		case '1.0.1': {
			const addressToMakeRich = await getAddressToMakeRich()
			return { version, payload: getSimulatedStackV1(simulationState, addressToMakeRich, version) } as const
		}
		default: assertNever(version)
	}
}

export async function resolveFetchSimulationStackRequest(simulationState: SimulationState | undefined, websiteTabConnections: WebsiteTabConnections, confirmation: FetchSimulationStackRequestConfirmation) {
	if (pendForUserReply !== undefined) {
		pendForUserReply.resolve(confirmation)
		return
	}
	const data = await getFetchSimulationStackRequestPromise()
	if (data === undefined || !doesUniqueRequestIdentifiersMatch(confirmation.data.uniqueRequestIdentifier, data.uniqueRequestIdentifier)) throw new Error('Unique request identifier mismatch in change chain')
	const resolved = await getSimulationStack(simulationState, data.simulationStackVersion)
	replyToInterceptedRequest(websiteTabConnections, { type: 'result', method: 'interceptor_getSimulationStack' as const, result: resolved, uniqueRequestIdentifier: data.uniqueRequestIdentifier })
	if (openedDialog) await closePopupOrTabById(openedDialog)
	openedDialog = undefined
}

function getRejectMessage(uniqueRequestIdentifier: UniqueRequestIdentifier, simulationStackVersion: SimulationStackVersion) {
	return {
		method: 'popup_fetchSimulationStackRequestConfirmation',
		data: {
			uniqueRequestIdentifier,
			accept: false,
			simulationStackVersion,
		},
	} as const
}

const userDeniedChange = {
	error: {
		code: METAMASK_ERROR_USER_REJECTED_REQUEST,
		message: 'User denied the request.',
	}
} as const

export const openFetchSimulationStackDialog = async (
	simulationState: SimulationState | undefined,
	websiteTabConnections: WebsiteTabConnections,
	uniqueRequestIdentifier: UniqueRequestIdentifier,
	params: GetSimulationStack,
	website: Website,
) => {
	if (openedDialog !== undefined || pendForUserReply) return userDeniedChange

	pendForUserReply = new Future<FetchSimulationStackRequestConfirmation>()
	const rejectMessage = getRejectMessage(uniqueRequestIdentifier, params.params[0])
	const onCloseWindowOrTab = async (popupOrTab: PopupOrTabId) => { // check if user has closed the window on their own, if so, reject signature
		if (openedDialog === undefined || openedDialog.id !== popupOrTab.id || openedDialog.type !== popupOrTab.type) return
		openedDialog = undefined
		if (pendForUserReply === undefined) return
		resolveFetchSimulationStackRequest(simulationState, websiteTabConnections, rejectMessage)
	}
	const onCloseWindow = async (id: number) => onCloseWindowOrTab({ type: 'popup' as const, id })
	const onCloseTab = async (id: number) => onCloseWindowOrTab({ type: 'tab' as const, id })

	try {
		const oldPromise = await getFetchSimulationStackRequestPromise()
		if (oldPromise !== undefined) {
			if (await getPopupOrTabById(oldPromise.popupOrTabId) !== undefined) return userDeniedChange
			await setFetchSimulationStackRequestPromise(undefined)
		}
		openedDialog = await openPopupOrTab({
			url: getHtmlFile('fetchSimulationStack'),
			type: 'popup',
			height: 800,
			width: 600,
		})

		if (openedDialog !== undefined) {
			addWindowTabListeners(onCloseWindow, onCloseTab)
			await setFetchSimulationStackRequestPromise({
				website: website,
				popupOrTabId: openedDialog,
				simulationStackVersion: params.params[0],
				uniqueRequestIdentifier: uniqueRequestIdentifier,
			})
		} else {
			await resolveFetchSimulationStackRequest(simulationState, websiteTabConnections, rejectMessage)
		}
		const reply = await pendForUserReply
		await setFetchSimulationStackRequestPromise(undefined)
		if (reply.data.accept) {
			return { result: await getSimulationStack(simulationState, params.params[0]) }
		}
		return userDeniedChange
	} finally {
		removeWindowTabListeners(onCloseWindow, onCloseTab)
		pendForUserReply = undefined
		if (openedDialog) await closePopupOrTabById(openedDialog)
		openedDialog = undefined
	}
}

export const getSimulationStackHash = (simulationState: SimulationStateInput | undefined) => {
	if (simulationState === undefined) return 'undefined'
	const messages = stringifyJSONWithBigInts(simulationState.map((x) => x.signedMessages.map((x) => x.originalRequestParameters)))
	const overrides = stringifyJSONWithBigInts(simulationState.map((x) => x.stateOverrides))
	const transactions = stringifyJSONWithBigInts(simulationState.map((x) => x.transactions.map((x) => x.originalRequestParameters)))
	const blockTime = stringifyJSONWithBigInts(simulationState.map((x) => x.blockTimeManipulation))
	const baseFee = stringifyJSONWithBigInts(simulationState.map((x) => x.simulateWithZeroBaseFee))
	return keccak256(toUtf8Bytes(JSON.stringify([messages, overrides, transactions, blockTime, baseFee])))
}

export async function openFetchSimulationStackDialogOrGetCachedResult(simulationState: SimulationState | undefined, websiteTabConnections: WebsiteTabConnections, params: GetSimulationStack, website: Website, request: InterceptedRequest, socket: WebsiteSocket) {
	const input = await getCurrentSimulationInput()
	const identifier = websiteSocketToString(socket)
	const newHash = getSimulationStackHash(input)
	const previousDecision = simulationStackDecisions.find((x) => x.identifier === identifier)
	if (previousDecision?.hash === newHash) {
		if (previousDecision.accept) return { result: await getSimulationStack(simulationState, params.params[0]) }
		return { type: 'result' as const, method: params.method, error: userDeniedChange.error }
	}
	const result = await openFetchSimulationStackDialog(simulationState, websiteTabConnections, request.uniqueRequestIdentifier, params, website)
	simulationStackDecisions = simulationStackDecisions.filter((x) => x.identifier !== identifier)
	simulationStackDecisions.push({ identifier, hash: newHash, accept: !('error' in result) })
	if (simulationStackDecisions.length > MAX_DECISION_CACHE) simulationStackDecisions.shift()
	if ('error' in result) return { type: 'result' as const, method: params.method, error: result.error }
	return { type: 'result' as const, method: params.method, ...result }
}
