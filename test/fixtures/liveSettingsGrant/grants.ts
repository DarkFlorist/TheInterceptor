// Type-checked by liveSettingsGrantWindow.test.ts: each line marked `expect-type-error` must fail to compile, and nothing else in the file may.
import { grantWithLiveSettings } from '../../../app/ts/background/settings.js'
import type { Settings } from '../../../app/ts/types/interceptor-messages.js'

export async function grants(admitted: Settings) {
	await grantWithLiveSettings(admitted, (liveSettings) => liveSettings.simulationMode)
	await grantWithLiveSettings(admitted, (liveSettings) => ({ blocksUpdated: Promise.resolve(liveSettings.simulationMode) }))
	await grantWithLiveSettings(admitted, async (liveSettings) => liveSettings.simulationMode) // expect-type-error
	await grantWithLiveSettings(admitted, (liveSettings) => Promise.resolve(liveSettings.simulationMode)) // expect-type-error
}
