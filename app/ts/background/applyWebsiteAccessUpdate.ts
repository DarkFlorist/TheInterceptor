import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import { createWorkflowStepsError, type WorkflowStepFailure } from '../utils/errors.js'
import { updateWebsiteApprovalAccesses } from './accessManagement.js'
import { getSettings } from './settings.js'
import { getConnectedTabIdsToReload, reloadTabs } from './reloadConnectedTabs.js'
import type { WebsiteAccessMutation } from './websiteAccessMutations.js'
import { tryUpdateWebsiteAccessAndContentScriptInjectionStrategy } from './websiteAccessUpdating.js'

// Handler-level workflow: persist access, refresh pages, and reconcile live connections against the resulting stored authority.
type WebsiteAccessFollowUpStep = { readonly code: string, readonly run: () => Promise<void> }
type ConnectedTabsReloadPolicy = 'alsoWhenInjectionUnchanged' | 'whenInjectionChanges'

const reloadConnectedTabsStep = (websiteTabConnections: WebsiteTabConnections): WebsiteAccessFollowUpStep => ({
	code: 'website_access_connected_tabs_reload_failed',
	run: async () => {
		let tabIds: readonly number[]
		try {
			tabIds = await getConnectedTabIdsToReload(websiteTabConnections)
		} catch (error) {
			// After saving permissions, still reload known connections, then let the workflow reconcile approvals and propagate the lookup failure to its caller.
			try {
				await reloadTabs([...websiteTabConnections.keys()])
			} catch (reloadError) {
				throw createWorkflowStepsError([{ code: 'connected_tab_lookup_failed', error }, { code: 'connected_tab_reload_failed', error: reloadError }])
			}
			throw error
		}
		await reloadTabs(tabIds)
	},
})

// Call this once a website-access change is saved. Steps run in order and a failing step does not stop the later ones, so the saved change always reaches open connections. Reload before reconciling so outgoing pages drop their connections before reconciliation can re-prompt them. One failure is rethrown as is; several are thrown together in step order so none hides another.
async function runStepsThenReconcileApprovals(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, stepsBeforeReconciliation: readonly WebsiteAccessFollowUpStep[], failures: WorkflowStepFailure[] = []) {
	const reconcileApprovalsStep: WebsiteAccessFollowUpStep = {
		code: 'website_access_approval_reconciliation_failed',
		run: async () => { await updateWebsiteApprovalAccesses(simulationServicesOwner, websiteTabConnections, await getSettings(), true) },
	}
	for (const step of [...stepsBeforeReconciliation, reconcileApprovalsStep]) {
		try {
			await step.run()
		} catch (error) {
			failures.push({ code: step.code, error })
		}
	}
	const [firstFailure, ...laterFailures] = failures
	if (firstFailure === undefined) return
	if (laterFailures.length === 0) throw firstFailure.error
	throw createWorkflowStepsError(failures)
}

// Reconcile against saved permissions even when registration or reload fails. A rejected initial write has no authority change to reconcile.
export async function applyWebsiteAccessUpdate(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, reloadPolicy: ConnectedTabsReloadPolicy, mutation: WebsiteAccessMutation) {
	const outcome = await tryUpdateWebsiteAccessAndContentScriptInjectionStrategy(websiteTabConnections, mutation)
	if (outcome.status === 'failed' && outcome.storage === 'not-written') throw outcome.error
	const failures: WorkflowStepFailure[] = outcome.status === 'failed' ? [{ code: 'website_access_injection_update_failed', error: outcome.error }] : []
	// The injection owner reports whether it already handled the reload, including failed attempts. Only an unchanged configuration may need an additional reload.
	const steps = reloadPolicy === 'alsoWhenInjectionUnchanged' && outcome.reload === 'not-needed' ? [reloadConnectedTabsStep(websiteTabConnections)] : []
	await runStepsThenReconcileApprovals(simulationServicesOwner, websiteTabConnections, steps, failures)
}
