import { ContentScriptHostingSettings } from '../types/contentScriptSettings.js'
import { recoverStoredSafeAppsHostOrigins } from '../types/safeAppsHosting.js'
import { getSafeAppsHostMatchPatterns } from '../utils/safeAppsHosting.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { SAFE_APPS_HOST_SCRIPTS } from '../config/injectedScripts.js'
import { sameContentScript, type FixedContentScript } from './contentScriptDefinition.js'

type HostingConfiguration = { readonly matches: string[], readonly origins: readonly string[] } | { readonly error: Error }
type HostingPlan = { readonly hosting: HostingConfiguration | undefined, readonly hostScript: FixedContentScript | undefined }
export type HostRegistrationOutcome = 'configuration-applied' | 'hosting-failed'

function getHostingConfiguration(storedItems: unknown): HostingConfiguration | undefined {
	const compatibility = ContentScriptHostingSettings.pick('safeAppsCompatibilityMode').safeParse(storedItems)
	if (!compatibility.success) return { error: new Error(compatibility.message) }
	if (compatibility.value.safeAppsCompatibilityMode !== true) return undefined
	const origins = recoverStoredSafeAppsHostOrigins(storedItems)
	if (origins === undefined) return { error: new Error('Stored Safe Apps host origins are not a list.') }
	return { matches: getSafeAppsHostMatchPatterns(origins), origins }
}

async function removeSafeAppsHostScript() {
	const scripts = await browser.scripting.getRegisteredContentScripts()
	if (scripts.some(({ id }) => id === 'safe-apps-host')) await browser.scripting.unregisterContentScripts({ ids: ['safe-apps-host'] })
}

async function reconcileSafeAppsHost(plan: HostingPlan, baseInpageScript: FixedContentScript, baseWasReconciled: boolean) {
	const { hosting, hostScript } = plan
	if (hosting === undefined) return
	if ('error' in hosting) throw hosting.error
	if (hostScript === undefined) {
		await removeSafeAppsHostScript()
		if (!baseWasReconciled) await browser.scripting.updateContentScripts([baseInpageScript])
		return
	}
	const scripts = await browser.scripting.getRegisteredContentScripts()
	if (scripts.some(({ id }) => id === hostScript.id)) await browser.scripting.updateContentScripts([hostScript])
	else await browser.scripting.registerContentScripts([hostScript])
	const hostedInpageScript = { ...baseInpageScript, excludeMatches: [...(baseInpageScript.excludeMatches ?? []), ...hosting.matches] }
	await browser.scripting.updateContentScripts([hostedInpageScript])
}

async function applySafeAppsHost(plan: HostingPlan, baseInpageScript: FixedContentScript, baseWasReconciled: boolean): Promise<HostRegistrationOutcome> {
	try {
		await reconcileSafeAppsHost(plan, baseInpageScript, baseWasReconciled)
		return 'configuration-applied'
	} catch (error: unknown) {
		// A partially installed host must not leave the ordinary provider excluded on that site.
		try {
			await removeSafeAppsHostScript()
			if (!baseWasReconciled || plan.hosting !== undefined && !('error' in plan.hosting)) await browser.scripting.updateContentScripts([baseInpageScript])
		} catch (recoveryError: unknown) {
			throw new AggregateError([error, recoveryError], 'Safe Apps host registration and provider rollback failed.')
		}
		await reportUnexpectedError(error, { code: 'safe_apps_host_registration_failed' })
		return 'hosting-failed'
	}
}

export type HostRegistrationRequest = {
	readonly storedItems: unknown
	// [isolated content listener, MAIN-world provider]; the host shares the provider's website-access exclusions.
	readonly baseScripts: readonly [FixedContentScript, FixedContentScript]
	// Present only when the base providers must be reconciled; it runs with this plan's host overlay so a current host is kept and a stale one pruned.
	readonly reconcileBase: ((hostScript: FixedContentScript | undefined) => Promise<void>) | undefined
	// Unchanged persisted configuration only reapplies hosting to retry the failure this caller observed.
	readonly configurationUnchanged: boolean
	readonly failedAttemptToRetry: number | undefined
}

function planHosting(storedItems: unknown, excludeMatches: string[] | undefined): HostingPlan {
	const hosting = getHostingConfiguration(storedItems)
	const hostScript = hosting === undefined || 'error' in hosting || hosting.matches.length === 0 ? undefined : {
		id: 'safe-apps-host',
		allFrames: true,
		matches: hosting.matches,
		excludeMatches,
		// Keep provider injection in embedded app frames, but the host itself only changes top-level pages.
		js: [...SAFE_APPS_HOST_SCRIPTS],
		runAt: 'document_start',
		world: 'MAIN',
		matchOriginAsFallback: true,
	} satisfies FixedContentScript
	return { hosting, hostScript }
}

// Owns the whole plan -> base reconcile -> host apply -> outcome lifecycle so whether the base was reconciled is never a caller-supplied flag.
export function createSafeAppsHostRegistration() {
	let appliedOutcome: HostRegistrationOutcome = 'configuration-applied'
	let appliedHosting: Extract<HostingConfiguration, { readonly matches: string[] }> | undefined
	let appliedScripts: readonly FixedContentScript[] | undefined
	let appliedAttempt = 0
	let hadHostingPlan = false
	const forgetAppliedHosting = () => {
		appliedHosting = undefined
		appliedScripts = undefined
		hadHostingPlan = false
	}
	const applyHosting = async (plan: HostingPlan, baseScripts: HostRegistrationRequest['baseScripts'], baseWasReconciled: boolean): Promise<HostRegistrationOutcome> => {
		const baseInpageScript = baseScripts[1]
		if (plan.hosting === undefined) {
			// Base reconciliation removes stale host scripts on startup; a prior hosting plan still needs explicit reversal.
			if (hadHostingPlan) {
				await removeSafeAppsHostScript()
				if (!baseWasReconciled) await browser.scripting.updateContentScripts([baseInpageScript])
			}
			forgetAppliedHosting()
			appliedOutcome = 'configuration-applied'
			appliedAttempt += 1
			return appliedOutcome
		}
		const outcome = await applySafeAppsHost(plan, baseInpageScript, baseWasReconciled)
		hadHostingPlan = true
		appliedAttempt += 1
		appliedOutcome = outcome
		appliedHosting = outcome === 'configuration-applied' && 'matches' in plan.hosting ? plan.hosting : undefined
		appliedScripts = appliedHosting === undefined ? undefined : [baseScripts[0], { ...baseInpageScript, excludeMatches: [...(baseInpageScript.excludeMatches ?? []), ...appliedHosting.matches] }, ...(plan.hostScript === undefined ? [] : [plan.hostScript])]
		return outcome
	}
	return {
		// Captured before queueing so concurrent callers retry the failure they observed once; a newer attempt owns subsequent retries.
		observedFailure: () => appliedOutcome === 'hosting-failed' ? appliedAttempt : undefined,
		async reconcile({ storedItems, baseScripts, reconcileBase, configurationUnchanged, failedAttemptToRetry }: HostRegistrationRequest): Promise<HostRegistrationOutcome> {
			const retryObservedFailure = appliedOutcome === 'hosting-failed' && failedAttemptToRetry === appliedAttempt
			if (configurationUnchanged && reconcileBase === undefined && !retryObservedFailure) return appliedOutcome
			try {
				const plan = planHosting(storedItems, baseScripts[1].excludeMatches)
				if (reconcileBase !== undefined) await reconcileBase(plan.hostScript)
				const needsUpdate = plan.hosting !== undefined || hadHostingPlan || appliedOutcome === 'hosting-failed'
				return needsUpdate ? await applyHosting(plan, baseScripts, reconcileBase !== undefined) : appliedOutcome
			} catch (error: unknown) {
				// A failed mutation can leave any script definition unknown, so the cached registrations no longer prove anything.
				forgetAppliedHosting()
				throw error
			}
		},
		hasOrigin: (origin: string) => appliedHosting?.origins.includes(origin) === true,
		async hasAppliedRegistrations() {
			if (appliedScripts === undefined) return false
			const scripts = await browser.scripting.getRegisteredContentScripts()
			return appliedScripts.every((desired) => scripts.some((script) => sameContentScript(script, desired)))
		},
	}
}
