export const POPUP_PERFORMANCE_MARKS = {
	scriptStart: 'interceptor:popup:script-start',
	shellPaint: 'interceptor:popup:shell-painted',
	homeFirstCommit: 'interceptor:popup:home-first-commit',
	refreshComplete: 'interceptor:popup:refresh-complete',
	refreshRendered: 'interceptor:popup:refresh-rendered',
	backgroundLoaded: 'interceptor:background:loaded',
	backgroundActivated: 'interceptor:background:activated',
	backgroundStartupReady: 'interceptor:background:startup-ready',
	backgroundRefreshStart: 'interceptor:background:refresh-home-start',
	backgroundRefreshEnd: 'interceptor:background:refresh-home-end',
	backgroundTransactionRequestReceived:
		'interceptor:background:transaction-request-received',
	backgroundTransactionConfirmPopupOpened:
		'interceptor:background:transaction-confirm-popup-opened',
	backgroundTransactionSimulationStart:
		'interceptor:background:transaction-simulation-start',
	backgroundTransactionSimulationEnd:
		'interceptor:background:transaction-simulation-end',
	backgroundTransactionStackAppended:
		'interceptor:background:transaction-stack-appended',
	confirmTransactionSimulationStarted:
		'interceptor:popup:confirm-transaction-simulation-started',
	confirmTransactionSimulationReady:
		'interceptor:popup:confirm-transaction-simulation-ready',
} as const

const marked = new Set<string>()

export function markPerformance(mark: string) {
	if (typeof globalThis.performance?.mark !== 'function') return
	globalThis.performance.mark(mark)
}

export function markPerformanceOnce(mark: string) {
	if (marked.has(mark)) return
	marked.add(mark)
	markPerformance(mark)
}

export function clearPerformanceMarks() {
	marked.clear()
	if (typeof globalThis.performance?.clearMarks !== 'function') return
	globalThis.performance.clearMarks()
}
