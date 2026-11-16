import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import { getErrorMessage } from '../utils/errors.js'
import { updateContentScriptInjectionSitesAndReloadTabsIfChanged } from './contentScriptInjectionStrategy.js'
import { withWebsiteAccessRollback } from './settingsTransactions.js'
import { updateWebsiteApprovalAccesses } from './accessManagement.js'
import { getSettings } from './settings.js'
import { reloadConnectedTabs } from './reloadConnectedTabs.js'
import type { WebsiteAccessMutation } from './websiteAccessMutations.js'

// The canonical persistence/rollback and injection composition. Return partial outcomes so the workflow can reconcile saved or rolled-back permissions even when refresh/error reporting fails.
export async function updateWebsiteAccessAndContentScriptInjectionStrategy(websiteTabConnections: WebsiteTabConnections, update: WebsiteAccessMutation) {
	let saved = false
	const outcome = await updateContentScriptInjectionSitesAndReloadTabsIfChanged(websiteTabConnections, update, async (mutation, refresh) => await withWebsiteAccessRollback(mutation, async (websiteAccess) => {
		saved = true
		await refresh(websiteAccess)
	}))
	return { ...outcome, saved }
}

type WebsiteAccessFollowUpStep = { readonly name: string, readonly run: () => Promise<void> }
type StepFailure = { readonly name: string, readonly error: unknown }
type ConnectedTabsReloadPolicy = 'alsoWhenInjectionUnchanged' | 'whenInjectionChanges'

const reloadConnectedTabsStep = (websiteTabConnections: WebsiteTabConnections): WebsiteAccessFollowUpStep => ({
	name: 'reloading connected tabs',
	run: async () => await reloadConnectedTabs(websiteTabConnections),
})

// The message names every failure because reports keep only the outer message, e.g. "Reloading connected tabs failed (a) and reconciling website approvals failed (b)".
function describeStepFailures(failures: readonly StepFailure[]) {
	const sentence = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(failures.map(({ name, error }) => `${ name } failed (${ getErrorMessage(error) ?? 'unknown error' })`))
	return `${ sentence.charAt(0).toUpperCase() }${ sentence.slice(1) }`
}

// Call this once a website-access change is saved. Steps run in order and a failing step does not stop the later ones, so the saved change always reaches open connections. Reload before reconciling so outgoing pages drop their connections before reconciliation can re-prompt them. One failure is rethrown as is; several are thrown together in step order so none hides another.
async function runStepsThenReconcileApprovals(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, stepsBeforeReconciliation: readonly WebsiteAccessFollowUpStep[], failures: StepFailure[] = []) {
	const reconcileApprovalsStep: WebsiteAccessFollowUpStep = {
		name: 'reconciling website approvals',
		run: async () => { await updateWebsiteApprovalAccesses(simulationServicesOwner, websiteTabConnections, await getSettings(), true) },
	}
	for (const step of [...stepsBeforeReconciliation, reconcileApprovalsStep]) {
		try {
			await step.run()
		} catch (error) {
			failures.push({ name: step.name, error })
		}
	}
	const [firstFailure, ...laterFailures] = failures
	if (firstFailure === undefined) return
	if (laterFailures.length === 0) throw firstFailure.error
	throw new AggregateError(failures.map(({ error }) => error), describeStepFailures(failures))
}

// Registration changes retain main's serialized refresh and rollback. Reconcile against storage even if a post-save step fails or rolls back; a failed initial write has no authority change to reconcile.
export async function applyWebsiteAccessUpdate(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, reloadPolicy: ConnectedTabsReloadPolicy, mutation: WebsiteAccessMutation) {
	const outcome = await updateWebsiteAccessAndContentScriptInjectionStrategy(websiteTabConnections, mutation)
	if (outcome.status === 'failed' && !outcome.saved) throw outcome.error
	const failures: StepFailure[] = outcome.status === 'failed' ? [{ name: 'updating website access and content script injection', error: outcome.error }] : []
	// The injection owner reports whether it already handled the reload, including failed attempts. Only an unchanged configuration may need an additional reload.
	const steps = reloadPolicy === 'alsoWhenInjectionUnchanged' && outcome.reload === 'not-needed' ? [reloadConnectedTabsStep(websiteTabConnections)] : []
	await runStepsThenReconcileApprovals(simulationServicesOwner, websiteTabConnections, steps, failures)
}
