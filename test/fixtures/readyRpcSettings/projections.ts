// Type-checked by settingsSnapshotProjections.test.ts: each line marked `expect-type-error` must fail to compile, and nothing else in the file may.
import { type ReadyRpcSettings, type SettingsSnapshot, requireReadableSettings, settingsEvenIfRpcConfigurationUnusable, settingsIfRpcConfigurationReady } from '../../../app/ts/background/settings.js'

export function projections(snapshot: SettingsSnapshot) {
	const ready: ReadyRpcSettings | undefined = settingsIfRpcConfigurationReady(snapshot)
	const readable: ReadyRpcSettings | undefined = settingsEvenIfRpcConfigurationUnusable(snapshot) // expect-type-error
	const required: ReadyRpcSettings = requireReadableSettings(snapshot) // expect-type-error
	return [ready, readable, required]
}
