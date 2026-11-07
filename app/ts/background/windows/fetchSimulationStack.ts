import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import { Future } from '../../utils/future.js'
import type { FetchSimulationStackRequestConfirmation } from '../../types/interceptor-messages.js'
import type { PendingFetchSimulationStackRequestPromise, WebsiteTabConnections } from '../../types/user-interface-types.js'
import { getHtmlFile, sendPopupMessageToOpenWindows, websiteSocketToString } from '../backgroundUtils.js'
import { getSimulationInputHash } from '../../utils/simulationFingerprint.js'
import { getFetchSimulationStackRequestPromise, setFetchSimulationStackRequestPromise } from '../storageVariables.js'
import { type InterceptedRequest, type UniqueRequestIdentifier, type WebsiteSocket, doesUniqueRequestIdentifiersMatch } from '../../utils/requests.js'
import { replyToInterceptedRequest } from '../messageSending.js'
import type { GetSimulationStack, SimulationStackVersion } from '../../types/JsonRpc-types.js'
import type { PopupOrTabId, Website } from '../../types/websiteAccessTypes.js'
import type { ResolvedSimulationInput, ResolvedSimulationState } from '../../types/visualizer-types.js'
import { getSimulatedStackV1, getSimulatedStackV2 } from '../../simulation/SimulationStackExtraction.js'
import { getAddressToMakeRich } from '../../simulation/services/SimulationModeEthereumClientService.js'
import { assertNever } from '../../utils/typescript.js'
import { type PopupOrTab, addWindowTabListeners, closePopupOrTabById, getPopupOrTabById, openPopupOrTab, removeWindowTabListeners } from '../../utils/popupOrTab.js'

export type SimulationStackSnapshot = {
	simulationInput: ResolvedSimulationInput
	simulationState: ResolvedSimulationState
}

type FetchSimulationStackReply = {
	confirmation: FetchSimulationStackRequestConfirmation
	snapshot: SimulationStackSnapshot
}

let pendForUserReply: Future<FetchSimulationStackReply> | undefined

let fetchSimulationStackResolutionInProgress = false

let openedDialog: PopupOrTab | undefined 
const MAX_DECISION_CACHE = 100
let simulationStackDecisions: { identifier: string, hash: string, accept: boolean }[] = []

export async function updateFetchSimulationStackRequestWithPendingRequest() {
	const promise = await getFetchSimulationStackRequestPromise()
	if (promise) await sendPopupMessageToOpenWindows({ method: 'popup_fetchSimulationStackRequest', data: promise })
	return
}

export async function getSimulationStack(simulationState: ResolvedSimulationState, version: SimulationStackVersion) {
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

export async function resolveFetchSimulationStackRequest(snapshot: SimulationStackSnapshot, websiteTabConnections: WebsiteTabConnections, confirmation: FetchSimulationStackRequestConfirmation) {
	if (pendForUserReply !== undefined) {
		pendForUserReply.resolve({ confirmation, snapshot })
		return
	}
	// No in-memory waiter (e.g. the background restarted while the dialog was open): answer the website from the stored request
	await runExclusiveFetchSimulationStackResolution(async () => {
		const storedRequest = await getFetchSimulationStackRequestPromise()
		if (storedRequest === undefined || !doesUniqueRequestIdentifiersMatch(confirmation.data.uniqueRequestIdentifier, storedRequest.uniqueRequestIdentifier)) throw new Error('Unique request identifier mismatch in change chain')
		await resolveStoredRequest(snapshot, websiteTabConnections, confirmation, storedRequest)
	})
}

// Stops a repeated confirmation from answering the website twice. New requests deliberately ignore this guard, unlike openChangeChainDialog: a request may take the slot once resolveStoredRequest has cleared it, and refusing it would cache a rejection the user never made
async function runExclusiveFetchSimulationStackResolution(resolution: () => Promise<void>) {
	if (fetchSimulationStackResolutionInProgress) return
	fetchSimulationStackResolutionInProgress = true
	try {
		await resolution()
	} finally {
		fetchSimulationStackResolutionInProgress = false
	}
}

// The clear has to come first: closing the dialog can store a new request, which a later clear would wipe
async function resolveStoredRequest(snapshot: SimulationStackSnapshot, websiteTabConnections: WebsiteTabConnections, confirmation: FetchSimulationStackRequestConfirmation, storedRequest: PendingFetchSimulationStackRequestPromise) {
	await setFetchSimulationStackRequestPromise(undefined)
	const { uniqueRequestIdentifier, simulationStackVersion, popupOrTabId } = storedRequest
	if (confirmation.data.accept) {
		const result = await getSimulationStack(snapshot.simulationState, simulationStackVersion)
		replyToInterceptedRequest(websiteTabConnections, { type: 'result', method: 'interceptor_getSimulationStack', result, uniqueRequestIdentifier })
	} else {
		replyToInterceptedRequest(websiteTabConnections, { type: 'result', method: 'interceptor_getSimulationStack', error: userDeniedChange.error, uniqueRequestIdentifier })
	}
	// Do not reset openedDialog here: it never refers to this restarted request's dialog, and a new request may have opened its own dialog while this one closes
	await closePopupOrTabById(popupOrTabId)
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

type FetchSimulationStackDialogResult =
	| {
		outcome: 'accepted'
		result: Awaited<ReturnType<typeof getSimulationStack>>
		simulationStackHash: string
	}
	| {
		outcome: 'rejected'
		error: typeof userDeniedChange.error
		simulationStackHash: string
	}

type FetchSimulationStackRequestResult = {
	type: 'result'
	method: GetSimulationStack['method']
} & (
	| { result: Awaited<ReturnType<typeof getSimulationStack>> }
	| { error: typeof userDeniedChange.error }
)

const getRejectedDialogResult = (snapshot: SimulationStackSnapshot): FetchSimulationStackDialogResult => ({
	outcome: 'rejected',
	error: userDeniedChange.error,
	simulationStackHash: getSimulationStackHash(snapshot.simulationInput),
})

export const openFetchSimulationStackDialog = async (
	initialSnapshot: SimulationStackSnapshot,
	simulationOverlayEnabled: boolean,
	websiteTabConnections: WebsiteTabConnections,
	uniqueRequestIdentifier: UniqueRequestIdentifier,
	params: GetSimulationStack,
	website: Website,
): Promise<FetchSimulationStackDialogResult> => {
	if (openedDialog !== undefined || pendForUserReply) return getRejectedDialogResult(initialSnapshot)

	const replyFuture = new Future<FetchSimulationStackReply>()
	pendForUserReply = replyFuture
	const rejectMessage = getRejectMessage(uniqueRequestIdentifier, params.params[0])
	const onCloseWindowOrTab = async (popupOrTab: PopupOrTabId) => { // check if user has closed the window on their own, if so, reject signature
		if (openedDialog === undefined || openedDialog.id !== popupOrTab.id || openedDialog.type !== popupOrTab.type) return
		openedDialog = undefined
		if (pendForUserReply === undefined) return
		resolveFetchSimulationStackRequest(initialSnapshot, websiteTabConnections, rejectMessage)
	}
	const onCloseWindow = async (id: number) => onCloseWindowOrTab({ type: 'popup' as const, id })
	const onCloseTab = async (id: number) => onCloseWindowOrTab({ type: 'tab' as const, id })

	try {
		const oldPromise = await getFetchSimulationStackRequestPromise()
		if (oldPromise !== undefined) {
			if (await getPopupOrTabById(oldPromise.popupOrTabId) !== undefined) return getRejectedDialogResult(initialSnapshot)
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
				simulationOverlayEnabled,
				simulationStackVersion: params.params[0],
				uniqueRequestIdentifier: uniqueRequestIdentifier,
			})
		} else {
			await resolveFetchSimulationStackRequest(initialSnapshot, websiteTabConnections, rejectMessage)
		}
		const reply = await replyFuture
		await setFetchSimulationStackRequestPromise(undefined)
		if (reply.confirmation.data.accept) {
			return {
				outcome: 'accepted',
				result: await getSimulationStack(reply.snapshot.simulationState, params.params[0]),
				simulationStackHash: getSimulationStackHash(reply.snapshot.simulationInput),
			}
		}
		return getRejectedDialogResult(reply.snapshot)
	} finally {
		removeWindowTabListeners(onCloseWindow, onCloseTab)
		pendForUserReply = undefined
		if (openedDialog) await closePopupOrTabById(openedDialog)
		openedDialog = undefined
	}
}

export const getSimulationStackHash = (simulationState: ResolvedSimulationInput) => {
	if (simulationState.kind === 'passthrough') return 'passthrough'
	return getSimulationInputHash(simulationState.value)
}

export async function openFetchSimulationStackDialogOrGetCachedResult(initialSnapshot: SimulationStackSnapshot, simulationOverlayEnabled: boolean, websiteTabConnections: WebsiteTabConnections, params: GetSimulationStack, website: Website, request: InterceptedRequest, socket: WebsiteSocket): Promise<FetchSimulationStackRequestResult> {
	const identifier = websiteSocketToString(socket)
	const newHash = getSimulationStackHash(initialSnapshot.simulationInput)
	const previousDecision = simulationStackDecisions.find((x) => x.identifier === identifier)
	if (previousDecision !== undefined && previousDecision.hash === newHash) {
		if (previousDecision.accept) return { type: 'result', method: params.method, result: await getSimulationStack(initialSnapshot.simulationState, params.params[0]) }
		return { type: 'result', method: params.method, error: userDeniedChange.error }
	}
	const result = await openFetchSimulationStackDialog(initialSnapshot, simulationOverlayEnabled, websiteTabConnections, request.uniqueRequestIdentifier, params, website)
	simulationStackDecisions = simulationStackDecisions.filter((x) => x.identifier !== identifier)
	simulationStackDecisions.push({ identifier, hash: result.simulationStackHash, accept: result.outcome === 'accepted' })
	if (simulationStackDecisions.length > MAX_DECISION_CACHE) simulationStackDecisions.shift()
	if (result.outcome === 'rejected') return { type: 'result', method: params.method, error: result.error }
	return { type: 'result', method: params.method, result: result.result }
}
