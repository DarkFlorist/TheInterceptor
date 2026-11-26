export type ExtensionTabName = 'settingsView' | 'addressBook' | 'websiteAccess' | 'simulationStack' | 'gnosisSafeAppsHost'

type TabReuseContext = {
	readonly targetUrl: string
	readonly resolvedTargetUrl: URL
	readonly currentTabUrl: string | undefined
	readonly targetSuffix: string
}

type TabReuse = { readonly action: 'open' } | { readonly action: 'reuse', readonly url?: string }
type TabReusePolicy = (context: TabReuseContext) => TabReuse

const focusOrNavigate: TabReusePolicy = ({ targetUrl, targetSuffix }) => targetSuffix.length === 0
	? { action: 'reuse' }
	: { action: 'reuse', url: targetUrl }

const simulationStackReuse: TabReusePolicy = (context) => {
	if (context.targetSuffix.length !== 0 || context.currentTabUrl === undefined) return focusOrNavigate(context)
	let clearTarget: boolean
	try {
		const currentUrl = new URL(context.currentTabUrl, new URL('/', context.resolvedTargetUrl))
		clearTarget = currentUrl.pathname !== context.resolvedTargetUrl.pathname || currentUrl.hash !== ''
	} catch (error: unknown) {
		if (!(error instanceof TypeError)) throw error
		clearTarget = context.currentTabUrl !== context.targetUrl
	}
	return clearTarget ? { action: 'reuse', url: context.targetUrl } : { action: 'reuse' }
}

// A host retains drafts and pending approvals: only an identical launch can reuse that session, without navigation.
const gnosisSafeAppsHostReuse: TabReusePolicy = ({ currentTabUrl, resolvedTargetUrl }) => currentTabUrl === resolvedTargetUrl.href
	? { action: 'reuse' }
	: { action: 'open' }

const tabReusePolicies: Readonly<Record<ExtensionTabName, TabReusePolicy>> = {
	settingsView: focusOrNavigate,
	addressBook: focusOrNavigate,
	websiteAccess: focusOrNavigate,
	simulationStack: simulationStackReuse,
	gnosisSafeAppsHost: gnosisSafeAppsHostReuse,
}

export const getExtensionTabReuse = (tabName: ExtensionTabName, context: TabReuseContext): TabReuse => tabReusePolicies[tabName](context)
