import { MessageToPopup } from '../types/interceptor-messages.js'
import type { CompleteVisualizedSimulation } from '../types/visualizer-types.js'

const isSimulationStatePublication = (message: unknown) => typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_simulation_state_changed'

// The only way popup views receive popup_simulation_state_changed, so the refresh contract has one owner: each publication is the result of a refresh, and a view renders the state it is given. Answering it with popup_requestCompleteVisualizedSimulation or popup_requestSimulationMetadata would simulate again and, while the home popup or simulation stack page is open, publish again, so open views would keep triggering each other. test/tests/simulationStatePublicationConsumers.test.tsx fails when popup code handles the publication without this subscription or a view using it sends either request in reply. The background handlers are not guarded instead, because the same requests must still simulate when a view opens or its active stack changes. Returns the unsubscribe function.
export function subscribeToSimulationStatePublications(onPublished: (visualizedSimulatorState: CompleteVisualizedSimulation) => void) {
	const listener = (message: unknown) => {
		// Every other message is left to the view's own listener without parsing it a second time.
		if (!isSimulationStatePublication(message)) return undefined
		const parsed = MessageToPopup.safeParse(message)
		if (parsed.success && parsed.value.method === 'popup_simulation_state_changed') onPublished(parsed.value.data.visualizedSimulatorState)
		return undefined
	}
	browser.runtime.onMessage.addListener(listener)
	return () => browser.runtime.onMessage.removeListener(listener)
}
