import type { Settings } from '../types/interceptor-messages.js'
import { Semaphore } from '../utils/semaphore.js'
import { getSettings } from './settings.js'

const settingsTransitionSemaphore = new Semaphore(1)
const lockedSettingsBrand = Symbol('LockedSettings')

// Settings read while the settings transition lock is held. Only this module can create one, so a function that requires it can only be called from inside the lock.
export type LockedSettings = {
	readonly [lockedSettingsBrand]: true
	readonly settings: Settings
}

export type SettingsTransitionLock = {
	// Re-read after writing so the caller acts on the committed transition.
	readonly readSettings: () => Promise<LockedSettings>
}

// Orders settings transitions with the website-approval reconciliation that publishes them. The lock is not re-entrant: the transition must not take this lock again or open access prompts, because resolving a prompt changes settings. Prompt after the transition returns.
export async function withSettingsTransitionLock<T>(transition: (lock: SettingsTransitionLock) => Promise<T>): Promise<T> {
	return await settingsTransitionSemaphore.execute(async () => await transition({
		readSettings: async (): Promise<LockedSettings> => ({ [lockedSettingsBrand]: true, settings: await getSettings() }),
	}))
}
