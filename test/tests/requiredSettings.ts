// Import lazily so tests can install their browser mocks first.
export async function getRequiredSettings() {
	const { requireSettingsWithReadableNetwork } = await import('../../app/ts/background/settings.js')
	return await requireSettingsWithReadableNetwork()
}
