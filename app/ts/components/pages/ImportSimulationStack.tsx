import { useEffect } from 'preact/hooks'
import { Notice } from '../subcomponents/Error.js'
import { type ComponentChildren, createRef } from 'preact'
import { XMarkIcon } from '../subcomponents/icons.js'
import { type Signal, useComputed } from '@preact/signals'
import { isJSON } from '../../utils/json.js'
import { getMissingPopupReplyErrorMessage, sendPopupMessageWithReply } from '../../background/backgroundUtils.js'
import { InterceptorSimulationExport } from '../../types/visualizer-types.js'
import { AsyncActionButton } from '../subcomponents/AsyncAction.js'
import { useAsyncState } from '../../utils/preact-utilities.js'

type SimulationInputParams = {
	input: Signal<string>
	isValid: Signal<boolean>
	disabled: boolean,
}

function SimulationInput({ input, disabled, isValid }: SimulationInputParams) {
	const ref = createRef<HTMLTextAreaElement>()
	useEffect(() => { ref.current?.focus() }, [])
	return <textarea
		class = { `simulation-stack-import-input${ isValid.value ? '' : ' simulation-stack-import-input-invalid' }` }
		value = { input.value }
		onInput = { (e) => { input.value = e.currentTarget.value } }
		ref = { ref }
		disabled = { disabled }
		spellcheck = { false }
		aria-invalid = { !isValid.value }
	/>
}

type ImportSimulationStackParam = {
	close: () => void
	simulationInput: Signal<string>
}

export function ImportSimulationStack(param: ImportSimulationStackParam) {
	const { value: importRequestState, waitFor: waitForImport } = useAsyncState<void>()
	const isImporting = useComputed(() => importRequestState.value.state === 'pending')
	const importError = useComputed(() => importRequestState.value.state === 'rejected' ? importRequestState.value.error.message : undefined)

	const isSubmitButtonDisabled = useComputed(() => errorString.value !== undefined || param.simulationInput.value.trim().length === 0 || isImporting.value)
	const isValid = useComputed(() => errorString.value === undefined)

	const errorString = useComputed(() => {
		const trimmed = param.simulationInput.value.trim()
		if (trimmed.length === 0) return undefined
		if (!isJSON(trimmed)) return 'not a valid JSON'
		const parseResult = InterceptorSimulationExport.safeParse(JSON.parse(trimmed))
		if (parseResult.success) return undefined
		return `The input needs to be valid Interceptor Simulation Stack Export: ${ parseResult.message }`
	})

	const Text = (param: { text: ComponentChildren }) => {
		return <p class = 'paragraph' style = 'color: var(--subtitle-text-color); text-overflow: ellipsis; overflow: hidden; width: 100%'>
			{ param.text }
		</p>
	}

	const importStack = () => {
		const trimmed = param.simulationInput.value.trim()
		waitForImport(async () => {
			const reply = await sendPopupMessageWithReply({ method: 'popup_importSimulationStack', data: InterceptorSimulationExport.parse(JSON.parse(trimmed)) })
			if (reply === undefined) throw new Error(getMissingPopupReplyErrorMessage('Importing the simulation stack'))
			if (!reply.ok) throw new Error(reply.message)
			param.close()
		})
	}

	return ( <>
		<div class = 'modal-background'> </div>
		<div class = 'modal-card'>
			<header class = 'modal-card-head card-header interceptor-modal-head window-header'>
				<div class = 'card-header-icon unset-cursor'>
					<span class = 'icon'>
						<img src = '../img/address-book.svg' width = '24' height = '24'/>
					</span>
				</div>
				<div class = 'card-header-title'>
					<p class = 'paragraph'> { 'Import Interceptor Simulation Stack' } </p>
				</div>
				<button class = 'card-header-icon' aria-label = 'close' onClick = { param.close } disabled = { isImporting.value }>
					<XMarkIcon />
				</button>
			</header>
			<section class = 'modal-card-body'>
				<div class = 'card' style = 'margin: 10px;'>
					<div class = 'card-content'>
						<div class = 'media'>
							<div class = 'media-content' style = 'overflow-y: unset; overflow-x: unset;'>
								<div class = 'container' style = 'margin-bottom: 10px;'>
									<div class = 'simulation-stack-import-field'>
										<Text text = { 'Interceptor Simulation Stack: ' }/>
										<SimulationInput input = { param.simulationInput } isValid = { isValid } disabled = { isImporting.value }/>
									</div>
								</div>
							</div>
						</div>
					</div>
				</div>
				<div style = 'padding-left: 10px; padding-right: 10px; margin-bottom: 10px; min-height: 80px'>
					{ errorString.value !== undefined ? <Notice text = { errorString.value } /> : importError.value !== undefined ? <Notice text = { importError.value } /> : <></> }
				</div>
			</section>
			<footer class = 'modal-card-foot window-footer' style = 'border-bottom-left-radius: unset; border-bottom-right-radius: unset; border-top: unset; padding: 10px;'>
				<AsyncActionButton class = 'button is-success is-primary' state = { importRequestState.value.state } text = 'Import' pendingText = 'Importing...' onClick = { importStack } disabled = { isSubmitButtonDisabled.value } />
			</footer>
		</div>
	</> )
}
