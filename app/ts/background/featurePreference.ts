// Each capability owns its listener and startup read. Storage events win over an older in-flight read.
export async function initializeFeaturePreference(feature: { readonly setEnabled: (enabled: boolean) => void, readonly dispose: () => void }, key: 'safeAppsCompatibilityMode' | 'siteRpcInterceptionEnabled', read: () => Promise<boolean>) {
	let changedDuringInitialization = false
	const onChanged = (changes: Record<string, browser.storage.StorageChange>, area: string) => {
		if (area !== 'local' || !(key in changes)) return
		changedDuringInitialization = true
		feature.setEnabled(changes[key]?.newValue === true)
	}
	browser.storage.onChanged.addListener(onChanged)
	try {
		const enabled = await read()
		if (!changedDuringInitialization) feature.setEnabled(enabled)
	} catch (error) {
		browser.storage.onChanged.removeListener(onChanged)
		feature.dispose()
		throw error
	}
	return () => { browser.storage.onChanged.removeListener(onChanged); feature.dispose() }
}
