// Test shorthand for the latest committed settings; app code composes the snapshot read and its projection explicitly. Imported lazily so tests can install their browser mocks first.
export async function getRequiredSettings() {
	const { getSettingsSnapshot, requireAvailableSettings } = await import('../../app/ts/background/settings.js')
	return requireAvailableSettings(await getSettingsSnapshot())
}
