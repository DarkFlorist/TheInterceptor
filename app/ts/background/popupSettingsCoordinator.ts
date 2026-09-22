import type { PopupSettingsChangeStatus, PopupSettingsOperation } from '../types/popupSettingsProtocol.js'

export function createPopupSettingsCoordinator(publish: (status: PopupSettingsChangeStatus['data']) => Promise<unknown>, now = Date.now) {
	let status: PopupSettingsChangeStatus['data'] = { revision: now(), operation: undefined }
	const setOperation = (operation: PopupSettingsOperation | undefined) => {
		status = { revision: Math.max(now(), status.revision + 1), operation }
	}
	return {
		publish: async () => { await publish(status) },
		async run<T>(operation: PopupSettingsOperation, action: () => Promise<T>) {
			if (status.operation !== undefined) return { accepted: false } as const
			// Admission is synchronous; this status stream also orders broadcasts against reopen queries.
			setOperation(operation)
			try {
				await publish(status)
				return { accepted: true, result: await action() } as const
			} finally {
				setOperation(undefined)
				await publish(status)
			}
		},
	}
}
