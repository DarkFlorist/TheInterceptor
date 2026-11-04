import type { PendingSafeProposalStore, PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { SimulationStackChange } from '../types/visualizer-types.js'
import type { SimulationServices } from '../simulation/serviceLifecycle.js'
import { EthereumBytes32 } from '../types/wire-types.js'
import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../utils/constants.js'
import { getErrorMessage, JsonRpcResponseError, reportLocalRecovery, reportUnexpectedError } from '../utils/errors.js'
import { isAbiDataDecodeError } from '../utils/ethereumPrimitives.js'
import { type UniqueRequestIdentifier, doesUniqueRequestIdentifiersMatch, getUniqueRequestIdentifierString } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { modifyObject } from '../utils/typescript.js'
import { getSafePendingFlow } from '../safe/safePendingFlow.js'
import { resolveSafeSignerReply } from './safeConfirmationPersistence.js'
import { createSafeSignerErrorStatus } from './safeSignerErrors.js'
import { deferSignatureUnlessAnswered, getPendingSafeProposalStores, getPendingTransactionOrMessage, getPendingTransactionsAndMessages, movePendingSafeProposalToOutbox, removePendingSafeProposalStore, removePendingTransactionOrMessage, updatePendingTransactionOrMessage } from './storageVariables.js'
import { getPendingTerminalReplies } from './pendingTerminalReplies.js'
import { attemptQueuedTerminalReplyDelivery, deliverOwnQueuedTerminalReply, deliverQueuedTerminalReplyOnce, queueSafeProposalReplyAndMoveToOutbox, queueTerminalReplyUnlessDeferred } from './terminalReplyDelivery.js'
import { runEachIndependently, surfaceIndependentFailures } from './terminalStateRecovery.js'

// The confirmation window work the lifecycle asks for. The lifecycle never imports the confirmation window or popup code: windows/confirmTransaction.ts supplies these callbacks, and tests can supply stubs. The website's answer never waits on view work, so each view callback reports its own failures instead of throwing.
export type SafeSignerReplyConfirmationWindow = {
	// claimed -> answered: validates and stores a claimed signature with services for its network and answers the website, as the confirmation window settles a signerIncluded decision. Called only by the lifecycle owner, inside a lifecycle step; its failures are lifecycle failures and are thrown.
	readonly settleClaimedSignature: (services: SimulationServices, websiteTabConnections: WebsiteTabConnections, uniqueRequestIdentifier: UniqueRequestIdentifier, signerReply: string) => Promise<unknown>
	// Updates the window once a request left the queue it shows (removed, or hidden as claimed): it moves to the next request or closes.
	readonly updateAfterRequestLeftQueue: (pending: PendingTransactionOrSignableMessage, services: SimulationServices | undefined) => Promise<void>
	// Republishes the confirmation queue after a request's approval state changed.
	readonly refresh: (services: SimulationServices | undefined) => Promise<void>
	// Shows how storing an outbox proposal changed the simulation stack.
	readonly showSimulationStackChange: (services: SimulationServices, simulationStack: SimulationStackChange) => Promise<void>
}

// Gnosis Safe signer-reply lifecycle. Its single owner is advanceSafeSignerReply, which only runs inside runSafeSignerReplyLifecycle (one lock for every request) and re-reads the request before each transition. Every entry point goes through it: a signature from the signer or a popup's signerIncluded (resolveSafeSignature), popup close, no-response and Reject (resolvePendingRequestAsNoResponse), recovery at startup, on every services installation and on new blocks while work is outstanding (recoverSafeSignerReplies, advanceSafeSignerRepliesOnNewBlock), and the retry of a failed step.
// 1) States of a pending request:
// - waiting-for-signer: no deferredSafeSignerReply and no websiteReplyQueued (as is every request outside these Safe flows).
// - claimed(signature, chain): deferredSafeSignerReply with its chainId; hidden from the confirmation window.
// - answered: websiteReplyQueued, written together with its queued website reply; it wins over a claim stored beside it.
// - settled: the request is gone: stored (Safe stack or proposal outbox) with its success reply, rejected, or answered and cleaned up.
// 2) Allowed transitions:
// - waiting-for-signer -> claimed: a string signature for a request with a recorded signing network (a request without one fails closed back to waiting-for-signer with an error).
// - waiting-for-signer -> answered -> settled: Reject or no-response queues the rejection, delivers it and removes the request.
// - claimed -> answered: services for its network validate and store the signature; its success reply is queued with the claim cleared in one write.
// - claimed -> waiting-for-signer: the signature fails validation (discarded with an error the user sees).
// - claimed proposal -> settled: without services for its network the success reply is queued and the proposal moved to the outbox in one write; the outbox stores it once services for its network are installed.
// - claimed co-signature -> claimed: without services for its network it waits for them.
// - answered -> settled: only the reply queued when it was answered is delivered (if still queued) and the request removed; nothing is validated, stored or queued again.
// - claims written by earlier builds: a proposal claim whose reply was already queued (terminalReplyQueued) -> settled through the outbox without a second reply (dropped visibly without a network), and a claim without its network -> waiting-for-signer with an error.
// 3) An unexpected failure keeps the stored state, so the request stays recoverable: a failed step is retried a bounded number of times (a claim with the signature it carries, any other step as an advance), then recovery advances every claimed or answered request, and an unsaved claim moves to a retryable signer error; spent retries are reported visibly.
type SafeSignerReplyState = 'gone' | 'waiting-for-signer' | 'claimed' | 'settled'

export type SafeSignerReplyContext = {
	// The services captured with the entry point; they also update the confirmation window.
	readonly services: SimulationServices | undefined
	// Reads the services installed now, for a signature whose network the captured services are not for.
	readonly getInstalledServices: () => Promise<SimulationServices | undefined>
	readonly websiteTabConnections: WebsiteTabConnections
	readonly confirmationWindow: SafeSignerReplyConfirmationWindow
}

const safeSignerReplyLifecycleSemaphore = new Semaphore(1)
const safeSignerReplyRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
// Bounded: once these retries are spent, the step runs again only through recovery (startup, every services installation, and every new block while work is outstanding).
const SAFE_SIGNER_REPLY_RETRY_DELAYS_MS = [50, 250, 1000]

// A failed claim is retried as itself, so the retry still carries the signature it was claiming; any other failed step is retried as an advance of the request, which never rejects it (a failed rejection is retried by its own caller). Claims and advances of one request are retried independently of each other.
type SafeSignerReplyStep<Result> = {
	readonly name: 'claim' | 'advance'
	readonly run: () => Promise<Result>
	// Retried in place of `run`; defaults to it.
	readonly retry?: () => Promise<unknown>
	// The transition taken, as a lifecycle step of its own, once the bounded retries are spent.
	readonly afterRetriesSpent?: () => Promise<void>
}

// Transitions whose run after spent retries failed as well; the advance on every new block runs them again.
const pendingRetriesSpentTransitions = new Map<string, () => Promise<void>>()
// Spent retries are reported visibly once per request and step, not on every later advance that fails again.
const reportedSpentSafeSignerReplyRetries = new Set<string>()

function removeDeferredSafeSignerReply(pending: PendingTransactionOrSignableMessage): PendingTransactionOrSignableMessage {
	const { deferredSafeSignerReply: _deferredSafeSignerReply, ...remaining } = pending
	return remaining
}

// Discards a Safe signature that failed validation, so the request returns to waiting-for-signer with the approval status the user sees.
export async function discardSafeSignature(uniqueRequestIdentifier: UniqueRequestIdentifier, approvalStatus: PendingTransactionOrSignableMessage['approvalStatus']) {
	await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => modifyObject(removeDeferredSafeSignerReply(pending), { approvalStatus }))
}

function createDeferredSafeProposalReply(pending: PendingTransactionOrSignableMessage, safeTxHash: bigint) {
	if (pending.originalRequestParameters.method !== 'eth_sendTransaction' && pending.originalRequestParameters.method !== 'eth_sendRawTransaction') {
		throw new Error('A Gnosis Safe proposal must originate from a transaction request.')
	}
	const terminalReply = {
		...pending.originalRequestParameters,
		type: 'result' as const,
		result: EthereumBytes32.parse(EthereumBytes32.serialize(safeTxHash)),
		uniqueRequestIdentifier: pending.uniqueRequestIdentifier,
	}
	return terminalReply
}

// The Gnosis Safe flows whose signer reply is a Safe signature settled through this lifecycle.
function getSafeSignerReplyFlow(pending: PendingTransactionOrSignableMessage) {
	if (pending.simulationMode) return undefined
	const flow = getSafePendingFlow(pending)
	return flow?.kind === 'proposal' || flow?.kind === 'messageCoSign' ? flow : undefined
}

// Requests whose signatures, Reject and cleanup only this lifecycle may settle.
export function isOwnedBySafeSignerReplyLifecycle(pending: PendingTransactionOrSignableMessage) {
	return getSafeSignerReplyFlow(pending) !== undefined || pending.deferredSafeSignerReply !== undefined
}

// A Safe signature that cannot be bound to the network it was signed for fails closed: it is not kept, and the request asks the user to sign again.
async function failSafeSignatureWithoutChain(uniqueRequestIdentifier: UniqueRequestIdentifier) {
	await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (current) => modifyObject(removeDeferredSafeSignerReply(current), {
		approvalStatus: createSafeSignerErrorStatus('The Gnosis Safe signature could not be matched to its network while the RPC configuration is unavailable. Sign it again once it is restored.'),
	}))
}

async function removeSettledPendingRequest(pending: PendingTransactionOrSignableMessage, context: SafeSignerReplyContext) {
	await removePendingTransactionOrMessage(pending.uniqueRequestIdentifier)
	await context.confirmationWindow.updateAfterRequestLeftQueue(pending, context.services)
}

async function runSafeSignerReplyLifecycle<Result>(uniqueRequestIdentifier: UniqueRequestIdentifier, step: SafeSignerReplyStep<Result>, retryAttempt = 0): Promise<Result> {
	try {
		return await safeSignerReplyLifecycleSemaphore.execute(step.run)
	} catch (error: unknown) {
		scheduleSafeSignerReplyRetry(uniqueRequestIdentifier, step, retryAttempt)
		throw error
	}
}

// The retry has no caller to report to, so its failures are reported here: as a local recovery while retries remain, and visibly once they are spent.
function scheduleSafeSignerReplyRetry<Result>(uniqueRequestIdentifier: UniqueRequestIdentifier, step: SafeSignerReplyStep<Result>, attempt: number) {
	const delay = SAFE_SIGNER_REPLY_RETRY_DELAYS_MS[attempt]
	const retryIdentifier = `${ getUniqueRequestIdentifierString(uniqueRequestIdentifier) } ${ step.name }`
	if (delay === undefined || safeSignerReplyRetryTimers.has(retryIdentifier)) return
	const retriedStep = { ...step, run: step.retry ?? step.run, retry: undefined }
	safeSignerReplyRetryTimers.set(retryIdentifier, setTimeout(() => {
		safeSignerReplyRetryTimers.delete(retryIdentifier)
		void (async () => {
			try {
				await runSafeSignerReplyLifecycle(uniqueRequestIdentifier, retriedStep, attempt + 1)
			} catch (error: unknown) {
				if (SAFE_SIGNER_REPLY_RETRY_DELAYS_MS[attempt + 1] !== undefined) {
					await reportLocalRecovery(error, { code: 'safe_signer_reply_retry_failed', message: 'Retrying a Gnosis Safe signature step after a transient failure.' })
					return
				}
				await finishSpentSafeSignerReplyRetries(error, uniqueRequestIdentifier, retryIdentifier, step)
			}
		})()
	}, delay))
}

async function finishSpentSafeSignerReplyRetries<Result>(error: unknown, uniqueRequestIdentifier: UniqueRequestIdentifier, retryIdentifier: string, step: SafeSignerReplyStep<Result>) {
	if (!reportedSpentSafeSignerReplyRetries.has(retryIdentifier)) {
		reportedSpentSafeSignerReplyRetries.add(retryIdentifier)
		await reportSafeSignerReplyRetriesExhausted(error, uniqueRequestIdentifier, step.name)
	}
	const transition = step.afterRetriesSpent
	if (transition === undefined) return
	try {
		await safeSignerReplyLifecycleSemaphore.execute(transition)
	} catch (transitionError: unknown) {
		pendingRetriesSpentTransitions.set(retryIdentifier, transition)
		await reportLocalRecovery(transitionError, { code: 'safe_signer_reply_spent_retries_transition_failed', message: 'Keeping a Gnosis Safe request\'s transition after spent retries for the next new block.' })
	}
}

// Shown even for connectivity errors: the user has signed and the website is still waiting. The message says whether the signature is kept for recovery, as far as storage can still tell.
async function reportSafeSignerReplyRetriesExhausted(error: unknown, uniqueRequestIdentifier: UniqueRequestIdentifier, stepName: SafeSignerReplyStep<unknown>['name']) {
	await reportUnexpectedError(error, {
		code: 'safe_signer_reply_retries_exhausted',
		displayMessage: await describeSpentSafeSignerReplyRetries(uniqueRequestIdentifier, stepName),
		suppressExpectedHandledErrors: false,
	})
}

async function describeSpentSafeSignerReplyRetries(uniqueRequestIdentifier: UniqueRequestIdentifier, stepName: SafeSignerReplyStep<unknown>['name']) {
	const unfinished = 'A Gnosis Safe confirmation could not be finished after repeated failures. It is finished once the RPC connection works again or the extension restarts.'
	let pending: PendingTransactionOrSignableMessage | undefined
	try {
		pending = await getPendingTransactionOrMessage(uniqueRequestIdentifier)
	} catch (readError: unknown) {
		await reportLocalRecovery(readError, { code: 'safe_signer_reply_state_unreadable', message: 'Describing spent Gnosis Safe signature retries without the stored request.' })
		return unfinished
	}
	if (pending?.deferredSafeSignerReply !== undefined) return 'A Gnosis Safe signature could not be settled after repeated failures. It is kept and settled once the RPC connection works again.'
	if (stepName === 'claim' && pending !== undefined && pending.websiteReplyQueued !== true) return 'A Gnosis Safe signature could not be saved after repeated failures. Sign the request again.'
	return unfinished
}

// Claim retries spent with the signature never saved: waiting-for-signer moves to a retryable signer error, so signing is available again and the window shows it. A claim or answer written meanwhile, or any other approval state, is kept.
async function failUnsavedSafeSignature(uniqueRequestIdentifier: UniqueRequestIdentifier, context: SafeSignerReplyContext) {
	let failed = false
	await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (current) => {
		if (current.deferredSafeSignerReply !== undefined || current.websiteReplyQueued === true || current.approvalStatus.status !== 'WaitingForSigner') return current
		failed = true
		return modifyObject(current, { approvalStatus: createSafeSignerErrorStatus('The Gnosis Safe signature could not be saved after repeated failures. Sign the request again.') })
	})
	if (!failed) return
	await context.confirmationWindow.refresh(context.services)
}

// A signature is bound to the network it was signed for: it is settled only with services for that network, the captured ones or else the ones installed now.
async function getServicesForChain(context: SafeSignerReplyContext, chainId: bigint) {
	if (context.services !== undefined && context.services.ethereum.getChainId() === chainId) return context.services
	const installedServices = await context.getInstalledServices()
	if (installedServices === undefined || installedServices.ethereum.getChainId() !== chainId) return undefined
	return installedServices
}

// Takes the one transition the request's stored state allows; must run inside runSafeSignerReplyLifecycle.
async function advanceSafeSignerReply(uniqueRequestIdentifier: UniqueRequestIdentifier, context: SafeSignerReplyContext): Promise<SafeSignerReplyState> {
	const pending = await getPendingTransactionOrMessage(uniqueRequestIdentifier)
	if (pending === undefined) return 'gone'
	if (pending.websiteReplyQueued === true) {
		await deliverQueuedTerminalReplyOnce(context.websiteTabConnections, uniqueRequestIdentifier)
		await removeSettledPendingRequest(pending, context)
		return 'settled'
	}
	const claim = pending.deferredSafeSignerReply
	if (claim === undefined) return 'waiting-for-signer'
	const flow = getSafePendingFlow(pending)
	if (flow?.kind === 'proposal' && claim.terminalReplyQueued === true) {
		await settleAcknowledgedSafeProposal(pending, flow.pending.safeTransaction.safeTxHash, claim.signerReply, claim.chainId, context)
		return 'settled'
	}
	if (claim.chainId === undefined) {
		await failSafeSignatureWithoutChain(uniqueRequestIdentifier)
		return 'waiting-for-signer'
	}
	const services = await getServicesForChain(context, claim.chainId)
	if (services !== undefined) {
		await context.confirmationWindow.settleClaimedSignature(services, context.websiteTabConnections, uniqueRequestIdentifier, claim.signerReply)
		const validated = await getPendingTransactionOrMessage(uniqueRequestIdentifier)
		if (validated === undefined) return 'settled'
		if (validated.websiteReplyQueued === true) return await advanceSafeSignerReply(uniqueRequestIdentifier, context)
		return validated.deferredSafeSignerReply === undefined ? 'waiting-for-signer' : 'claimed'
	}
	if (flow?.kind === 'proposal') {
		await moveSignedSafeProposalToOutbox(pending, flow.pending.safeTransaction.safeTxHash, { signerReply: claim.signerReply, chainId: claim.chainId }, context, false)
		return 'settled'
	}
	return 'claimed'
}

// waiting-for-signer -> claimed, advanced at once in the same lifecycle step, so no other entry point sees the claim before its first transition. A claim already stored for the request is advanced rather than replaced, so a retried claim never overwrites a newer one. Returns whether the request was settled (undefined when it was already gone).
async function claimSafeSignature(uniqueRequestIdentifier: UniqueRequestIdentifier, signerReply: string, context: SafeSignerReplyContext) {
	const claim = await runSafeSignerReplyLifecycle(uniqueRequestIdentifier, { name: 'claim', afterRetriesSpent: async () => await failUnsavedSafeSignature(uniqueRequestIdentifier, context), run: async () => {
		const pending = await getPendingTransactionOrMessage(uniqueRequestIdentifier)
		if (pending === undefined) return { pending, state: 'gone' as const }
		if (pending.deferredSafeSignerReply === undefined && pending.websiteReplyQueued !== true) {
			const chainId = pending.signerRequestChainId
			// Without the network the signer signed for, the signature could be validated or stored on another network, so it is not kept.
			if (chainId === undefined) {
				await failSafeSignatureWithoutChain(uniqueRequestIdentifier)
				return { pending, state: 'waiting-for-signer' as const }
			}
			// An answered request (its window close or Reject won) refuses the claim and keeps its own answer, which this step then finishes.
			if (await deferSignatureUnlessAnswered(uniqueRequestIdentifier, { signerReply, chainId }) === 'gone') return { pending, state: 'gone' as const }
		}
		return { pending, state: await advanceSafeSignerReply(uniqueRequestIdentifier, context) }
	} })
	// The waiting co-signature left the queue its window shows, so the window moves on to the next request or closes.
	if (claim.state === 'claimed' && claim.pending !== undefined) await context.confirmationWindow.updateAfterRequestLeftQueue(claim.pending, context.services)
	if (claim.state === 'gone') return undefined
	return claim.state === 'settled'
}

// Every Safe signature, from the signer reply or a popup's signerIncluded, enters the lifecycle here.
export async function resolveSafeSignature(uniqueRequestIdentifier: UniqueRequestIdentifier, signerReply: unknown, context: SafeSignerReplyContext) {
	if (typeof signerReply !== 'string') {
		await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (current) => modifyObject(current, {
			approvalStatus: createSafeSignerErrorStatus('The signer returned a non-string Gnosis Safe signature.'),
		}))
		return false
	}
	return await claimSafeSignature(uniqueRequestIdentifier, signerReply, context)
}

// Single owner of the no-response outcome (popup report, Reject of a Safe signer-reply request, or a confirmation window that disappeared), run as one step of the lifecycle: the request is first advanced, so a claimed signature is settled as signed rather than rejected (with services for its network; otherwise it stays pending) and an answered request only finishes its own answer. A request waiting for its signer is rejected, which needs no RPC services.
export async function resolvePendingRequestAsNoResponse(uniqueRequestIdentifier: UniqueRequestIdentifier, context: SafeSignerReplyContext): Promise<boolean | undefined> {
	const advance = async () => await advanceSafeSignerReply(uniqueRequestIdentifier, context)
	return await runSafeSignerReplyLifecycle(uniqueRequestIdentifier, { name: 'advance', retry: advance, run: async () => {
		const state = await advance()
		if (state === 'settled') return true
		if (state !== 'waiting-for-signer') return undefined
		const pending = await getPendingTransactionOrMessage(uniqueRequestIdentifier)
		if (pending === undefined) return undefined
		const rejection = {
			...pending.originalRequestParameters,
			type: 'result' as const,
			error: { code: METAMASK_ERROR_USER_REJECTED_REQUEST, message: 'User denied transaction signature' },
			uniqueRequestIdentifier,
		}
		// Claims are only written inside a lifecycle step, so this request is still unclaimed; the storage check refuses the rejection should it not be.
		const rejectionOutcome = await queueTerminalReplyUnlessDeferred(rejection)
		if (rejectionOutcome === 'gone' || rejectionOutcome === 'deferred') return undefined
		const delivery = await deliverOwnQueuedTerminalReply(context.websiteTabConnections, rejection, rejectionOutcome)
		await removeSettledPendingRequest(pending, context)
		return delivery
	} })
}

// Recovery of the lifecycle, run at startup, whenever services are installed for a network and on new blocks while work is outstanding (advanceSafeSignerRepliesOnNewBlock): every claimed or answered request is advanced (a claim settled with these services when they are for its network, an answered request finished whatever its window), then outbox proposals for that network are added to the Safe stack.
export async function recoverSafeSignerReplies(services: SimulationServices, websiteTabConnections: WebsiteTabConnections, confirmationWindow: SafeSignerReplyConfirmationWindow) {
	const context: SafeSignerReplyContext = { services, getInstalledServices: async () => services, websiteTabConnections, confirmationWindow }
	const outstandingRequests = (await getPendingTransactionsAndMessages()).filter((pending) => pending.deferredSafeSignerReply !== undefined || pending.websiteReplyQueued === true)
	const requestFailures = await runEachIndependently(outstandingRequests, async (pending) => await runSafeSignerReplyLifecycle(pending.uniqueRequestIdentifier, { name: 'advance', run: async () => await advanceSafeSignerReply(pending.uniqueRequestIdentifier, context) }))
	const outboxFailures = await storeSafeProposalsFromOutbox(services, confirmationWindow)
	await surfaceIndependentFailures([...requestFailures, ...outboxFailures])
}

// At most one advance on new blocks runs at a time; a block arriving meanwhile skips it.
const safeSignerReplyAdvancesOnNewBlock = new Set<Promise<void>>()

// Runs on every new block with the installed services: lifecycle work left after its bounded retries (a claim, an answered request, an outbox proposal for these services' network, or a transition after spent retries) is advanced even when the RPC connection status never went down, for example when only signature validation failed. Nothing runs when nothing is outstanding.
export async function advanceSafeSignerRepliesOnNewBlock(services: SimulationServices, websiteTabConnections: WebsiteTabConnections, confirmationWindow: SafeSignerReplyConfirmationWindow) {
	if (safeSignerReplyAdvancesOnNewBlock.size > 0) return
	const advance = (async () => {
		const failures = await runEachIndependently([...pendingRetriesSpentTransitions], async ([retryIdentifier, transition]) => {
			await safeSignerReplyLifecycleSemaphore.execute(transition)
			pendingRetriesSpentTransitions.delete(retryIdentifier)
		})
		if (await hasOutstandingSafeSignerReplyWork(services)) {
			try {
				await recoverSafeSignerReplies(services, websiteTabConnections, confirmationWindow)
			} catch (passFailure: unknown) {
				failures.push(passFailure)
			}
		}
		await surfaceIndependentFailures(failures)
	})()
	safeSignerReplyAdvancesOnNewBlock.add(advance)
	try {
		await advance
	} finally {
		safeSignerReplyAdvancesOnNewBlock.delete(advance)
	}
}

async function hasOutstandingSafeSignerReplyWork(services: SimulationServices) {
	if ((await getPendingTransactionsAndMessages()).some((pending) => pending.deferredSafeSignerReply !== undefined || pending.websiteReplyQueued === true)) return true
	return (await getPendingSafeProposalStores()).some((entry) => entry.chainId === services.ethereum.getChainId())
}

// Adds every outbox proposal signed for the installed services' network to its Safe stack once, each entry as its own lifecycle step; proposals for other networks stay. Proposals of one Safe may hold consecutive nonces, each stored on top of the one before, so they are stored in nonce order and a transient failure stops only their Safe's group: its later proposals stay untouched for the next pass instead of failing the nonce check, and other Safes go on. The website already has its reply, so a proposal that cannot be stored is dropped with a visible failure and nothing more is sent to the website.
async function storeSafeProposalsFromOutbox(services: SimulationServices, confirmationWindow: SafeSignerReplyConfirmationWindow) {
	const entriesForNetwork = (await getPendingSafeProposalStores()).filter((entry) => entry.chainId === services.ethereum.getChainId())
	return await runEachIndependently(groupOutboxProposalsBySafeInNonceOrder(entriesForNetwork), async (safeGroup) => {
		for (const entry of safeGroup) await safeSignerReplyLifecycleSemaphore.execute(async () => await storeSafeProposalFromOutbox(services, entry, confirmationWindow))
	})
}

function groupOutboxProposalsBySafeInNonceOrder(entries: readonly PendingSafeProposalStore[]) {
	const groups = new Map<string, { readonly nonce: bigint, readonly entry: PendingSafeProposalStore }[]>()
	for (const entry of entries) {
		const flow = getSafePendingFlow(entry.proposal)
		const safeTransaction = flow?.kind === 'proposal' ? flow.pending.safeTransaction : undefined
		const groupKey = safeTransaction === undefined ? `request ${ getUniqueRequestIdentifierString(entry.proposal.uniqueRequestIdentifier) }` : `${ entry.chainId.toString() } ${ safeTransaction.safeAddress.toString() }`
		groups.set(groupKey, [...groups.get(groupKey) ?? [], { nonce: safeTransaction?.safeTx.message.nonce ?? 0n, entry }])
	}
	return [...groups.values()].map((group) => [...group].sort((first, second) => first.nonce < second.nonce ? -1 : first.nonce > second.nonce ? 1 : 0).map(({ entry }) => entry))
}

async function storeSafeProposalFromOutbox(services: SimulationServices, entry: PendingSafeProposalStore, confirmationWindow: SafeSignerReplyConfirmationWindow) {
	// Read again inside the step: a concurrent pass may already have stored it.
	if (!(await getPendingSafeProposalStores()).some((current) => doesUniqueRequestIdentifiersMatch(current.proposal.uniqueRequestIdentifier, entry.proposal.uniqueRequestIdentifier))) return
	const stored = await storeOutboxProposal(services, entry)
	await removePendingSafeProposalStore(entry.proposal.uniqueRequestIdentifier)
	if (stored.status === 'failed-permanently') {
		await reportSafeProposalNotStored(stored.reason)
		return
	}
	if (stored.status === 'success') {
		await confirmationWindow.showSimulationStackChange(services, stored.simulationStack)
		return
	}
	await reportSafeProposalNotStored(stored.status === 'error' ? stored.approvalStatus.message : 'It is no longer a Gnosis Safe proposal.')
}

// A Safe whose contract answers with a revert or with data that does not decode fails the same way on every attempt (for example after its implementation changed while the proposal waited), so its entry is dropped like one that fails validation. Transport failures and other errors may pass, so they are thrown and the entry stays for the next pass.
const isPermanentSafeProposalStoreFailure = (error: unknown) => isAbiDataDecodeError(error) || error instanceof JsonRpcResponseError && (error.code === 3 || /revert/iu.test(error.message))

async function storeOutboxProposal(services: SimulationServices, entry: PendingSafeProposalStore) {
	try {
		return await resolveSafeSignerReply(services.ethereum, entry.proposal, entry.signerReply)
	} catch (error: unknown) {
		if (!isPermanentSafeProposalStoreFailure(error)) throw error
		return { status: 'failed-permanently' as const, reason: `Its Gnosis Safe could not be read: ${ getErrorMessage(error) ?? 'the contract call failed.' }` }
	}
}

// The failure is a validation result rather than a thrown error, so its reason is the reported value (as for errors reported from popup windows) and the popup shows it.
async function reportSafeProposalNotStored(reason: string) {
	await reportUnexpectedError(reason, {
		source: 'safe_proposal_outbox',
		code: 'safe_proposal_not_stored',
		displayMessage: `A signed Gnosis Safe proposal could not be added to the Safe stack, and the website already received its proposal hash. ${ reason }`,
		suppressExpectedHandledErrors: false,
	})
}

// Settles a pending Safe proposal whose signer already returned its signature: the website is told the proposal hash unless it already was, the request is settled like any other completed request, and the signed proposal waits in the outbox for services for its network.
async function moveSignedSafeProposalToOutbox(
	pending: PendingTransactionOrSignableMessage,
	safeTxHash: bigint,
	signedProposal: { readonly signerReply: string, readonly chainId: bigint },
	context: SafeSignerReplyContext,
	websiteHasItsReply: boolean,
) {
	const createStore = (proposal: PendingTransactionOrSignableMessage) => ({ ...signedProposal, proposal: removeDeferredSafeSignerReply(proposal) })
	try {
		if (websiteHasItsReply) {
			await movePendingSafeProposalToOutbox(pending.uniqueRequestIdentifier, createStore, getPendingTerminalReplies)
			return true
		}
		const terminalReply = createDeferredSafeProposalReply(pending, safeTxHash)
		if (await queueSafeProposalReplyAndMoveToOutbox(pending.uniqueRequestIdentifier, createStore, terminalReply) !== 'moved') return false
		return await attemptQueuedTerminalReplyDelivery(context.websiteTabConnections, terminalReply)
	} finally {
		await context.confirmationWindow.updateAfterRequestLeftQueue(pending, context.services)
	}
}

// Earlier builds kept a Safe proposal pending, claimed, after its website reply was queued (`terminalReplyQueued`). It leaves the pending queue for the outbox without a second reply, or, when its signing network was not recorded, is dropped with a visible failure (re-signing through the completed request is impossible).
async function settleAcknowledgedSafeProposal(pending: PendingTransactionOrSignableMessage, safeTxHash: bigint, signerReply: string, chainId: bigint | undefined, context: SafeSignerReplyContext) {
	if (chainId !== undefined) {
		await moveSignedSafeProposalToOutbox(pending, safeTxHash, { signerReply, chainId }, context, true)
		return
	}
	await removeSettledPendingRequest(pending, context)
	await reportSafeProposalNotStored('Its network was not recorded.')
}
