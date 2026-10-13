// Loads every popup message handler domain module, for harnesses that expose all handlers to their tests.
export async function importAllPopupMessageHandlers() {
	return {
		...await import('../../app/ts/background/popupMessageHandlers/addressBook.js'),
		...await import('../../app/ts/background/popupMessageHandlers/confirmation.js'),
		...await import('../../app/ts/background/popupMessageHandlers/diagnostics.js'),
		...await import('../../app/ts/background/popupMessageHandlers/home.js'),
		...await import('../../app/ts/background/popupMessageHandlers/navigation.js'),
		...await import('../../app/ts/background/popupMessageHandlers/safe.js'),
		...await import('../../app/ts/background/popupMessageHandlers/settings.js'),
		...await import('../../app/ts/background/popupMessageHandlers/simulation.js'),
		...await import('../../app/ts/background/popupMessageHandlers/websiteAccess.js'),
	}
}
