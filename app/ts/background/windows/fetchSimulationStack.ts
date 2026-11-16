import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../../utils/constants.js'
import type { FetchSimulationStackRequestConfirmation } from '../../types/interceptor-messages.js'
import type { PendingFetchSimulationStackRequestPromise, WebsiteTabConnections } from '../../types/user-interface-types.js'
import { getHtmlFile, sendPopupMessageToOpenWindows, websiteSocketToString } from '../backgroundUtils.js'
import { getSimulationInputHash } from '../../utils/simulationFingerprint.js'
import { clearFetchSimulationStackRequestPromiseIfOwnedBy, getFetchSimulationStackRequestPromise, setFetchSimulationStackRequestPromise } from '../storageVariables.js'
import { type InterceptedRequest, type UniqueRequestIdentifier, type WebsiteSocket, doesUniqueRequestIdentifiersMatch } from '../../utils/requests.js'
import { replyToInterceptedRequest } from '../messageSending.js'
import type { GetSimulationStack, SimulationStackVersion } from '../../types/JsonRpc-types.js'
import type { PopupOrTabId, Website } from '../../types/websiteAccessTypes.js'
import type { ResolvedSimulationInput, ResolvedSimulationState } from '../../types/visualizer-types.js'
import { getSimulatedStackV1, getSimulatedStackV2 } from '../../simulation/SimulationStackExtraction.js'
import { assertNever } from '../../utils/typescript.js'
import { type PendingDialogReply, createPendingDialogReply } from './pendingDialogReply.js'
import { type PopupOrTab, addWindowTabListeners, closePopupOrTabById, getPopupOrTabById, openPopupOrTab, removeWindowTabListeners } from '../../utils/popupOrTab.js'

export type SimulationStackSnapshot = {
	simulationInput: ResolvedSimulationInput
	simulationState: ResolvedSimulationState
	// Read with the simulation input, so 1.0.x replies name the address that the simulation made rich.
	activeAddressMadeRich: bigint | undefined
}

type FetchSimulationStackReply = {
	confirmation: FetchSimulationStackRequestConfirmation
	// The stack at confirmation time. A rejection sends no stack, so it has none and is remembered for the stack the dialog opened with.
	snapshot: SimulationStackSnapshot | undefined
}

// Only this background instance's waiter: the stored request is the copy that survives a restart and feeds the dialog page, and openedDialog is the window, not the request
let pendForUserReply: PendingDialogReply<FetchSimulationStackReply> | undefined

let fetchSimulationStackResolutionInProgress = false

let openedDialog: PopupOrTab | undefined 
const MAX_DECISION_CACHE = 100
let simulationStackDecisions: { identifier: string, hash: string, accept: boolean }[] = []

export async function updateFetchSimulationStackRequestWithPendingRequest() {
	const promise = await getFetchSimulationStackRequestPromise()
	if (promise) await sendPopupMessageToOpenWindows({ method: 'popup_fetchSimulationStackRequest', data: promise })
	return
}

export function getSimulationStack(snapshot: SimulationStackSnapshot, version: SimulationStackVersion) {
	switch (version) {
		case '2.0.0': return { version, payload: getSimulatedStackV2(snapshot.simulationState) } as const
		case '1.0.0':
		case '1.0.1': return { version, payload: getSimulatedStackV1(snapshot.simulationState, snapshot.activeAddressMadeRich, version) } as const
		default: assertNever(version)
	}
}

export async function resolveFetchSimulationStackRequest(snapshot: SimulationStackSnapshot, websiteTabConnections: WebsiteTabConnections, confirmation: FetchSimulationStackRequestConfirmation) {
	if (pendForUserReply !== undefined) {
		// A confirmation waits for its snapshot, so it can arrive after its dialog closed and a newer request started waiting
		pendForUserReply.tryResolve(confirmation.data.uniqueRequestIdentifier, { confirmation, snapshot })
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

// The reply is prepared first so a failed extraction leaves the request stored and retryable. The clear precedes the close so a request arriving while the dialog closes finds the slot free instead of being refused
async function resolveStoredRequest(snapshot: SimulationStackSnapshot | undefined, websiteTabConnections: WebsiteTabConnections, confirmation: FetchSimulationStackRequestConfirmation, storedRequest: PendingFetchSimulationStackRequestPromise) {
	const { uniqueRequestIdentifier, simulationStackVersion, popupOrTabId } = storedRequest
	if (confirmation.data.accept && snapshot === undefined) throw new Error('Missing simulation snapshot for an accepted stack request')
	const reply: FetchSimulationStackRequestResult = confirmation.data.accept && snapshot !== undefined
		? { type: 'result', method: 'interceptor_getSimulationStack', result: await getSimulationStack(snapshot, simulationStackVersion) }
		: { type: 'result', method: 'interceptor_getSimulationStack', error: userDeniedChange.error }
	// Preparing the reply can wait on storage, so a newer request may hold the slot by now. It only got there because openFetchSimulationStackDialog found this request's dialog gone, which makes the close below a no-op in that case
	await clearFetchSimulationStackRequestPromiseIfOwnedBy(uniqueRequestIdentifier)
	replyToInterceptedRequest(websiteTabConnections, { ...reply, uniqueRequestIdentifier })
	// Do not reset openedDialog here: it never refers to this restarted request's dialog, and a new request may have opened its own dialog while this one closes
	await closePopupOrTabById(popupOrTabId)
}

// Needs neither a network read nor a simulation, so a website gets its rejection whatever state the stack or the network is in.
export async function rejectFetchSimulationStackRequest(websiteTabConnections: WebsiteTabConnections, confirmation: FetchSimulationStackRequestConfirmation) {
	if (pendForUserReply !== undefined) {
		// Like an approval, a rejection only answers the request it names, never a newer request now waiting in the same dialog slot
		pendForUserReply.tryResolve(confirmation.data.uniqueRequestIdentifier, { confirmation, snapshot: undefined })
		return
	}
	await runExclusiveFetchSimulationStackResolution(async () => {
		const storedRequest = await getFetchSimulationStackRequestPromise()
		if (storedRequest === undefined || !doesUniqueRequestIdentifiersMatch(confirmation.data.uniqueRequestIdentifier, storedRequest.uniqueRequestIdentifier)) throw new Error('Unique request identifier mismatch in change chain')
		await resolveStoredRequest(undefined, websiteTabConnections, confirmation, storedRequest)
	})
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

	const pendingReply = createPendingDialogReply<FetchSimulationStackReply>(uniqueRequestIdentifier)
	pendForUserReply = pendingReply
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
		const reply = await pendingReply.reply
		await setFetchSimulationStackRequestPromise(undefined)
		const replySnapshot = reply.snapshot ?? initialSnapshot
		if (reply.confirmation.data.accept) {
			return {
				outcome: 'accepted',
				result: getSimulationStack(replySnapshot, params.params[0]),
				simulationStackHash: getSimulationStackHash(replySnapshot.simulationInput),
			}
		}
		return getRejectedDialogResult(replySnapshot)
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
		if (previousDecision.accept) return { type: 'result', method: params.method, result: getSimulationStack(initialSnapshot, params.params[0]) }
		return { type: 'result', method: params.method, error: userDeniedChange.error }
	}
	const result = await openFetchSimulationStackDialog(initialSnapshot, simulationOverlayEnabled, websiteTabConnections, request.uniqueRequestIdentifier, params, website)
	simulationStackDecisions = simulationStackDecisions.filter((x) => x.identifier !== identifier)
	simulationStackDecisions.push({ identifier, hash: result.simulationStackHash, accept: result.outcome === 'accepted' })
	if (simulationStackDecisions.length > MAX_DECISION_CACHE) simulationStackDecisions.shift()
	if (result.outcome === 'rejected') return { type: 'result', method: params.method, error: result.error }
	return { type: 'result', method: params.method, result: result.result }
}
