import { useEffect } from 'preact/hooks'
import { Notice } from '../subcomponents/Error.js'
import { ComponentChildren, createRef } from 'preact'
import { XMarkIcon } from '../subcomponents/icons.js'
import { Signal, useComputed } from '@preact/signals'
import { isJSON } from '../../utils/json.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { InterceptorSimulateExport } from '../../types/visualizer-types.js'

const CellElement = (param: { element: ComponentChildren }) => {
	return <div class = 'log-cell' style = 'justify-content: right;'>
		{ param.element }
	</div>
}

type SimulationInputParams = {
	input: Signal<string>
	isValid: Signal<boolean>
	disabled: boolean,
}

function SimulationInput({ input, disabled, isValid }: SimulationInputParams) {
	const ref = createRef<HTMLInputElement>()
    useEffect(() => { ref.current?.focus() }, [])
	return <input
		className = 'input is-spaced'
		type = 'text'
		onInput = { (e) => { input.value = e.currentTarget.value } }
		ref = { ref }
		disabled = { disabled }
		style = { `width: 100%; ${ input === undefined || isValid.value ? '' : 'color: var(--negative-color);' }` }
	/>
}

type ImportSimulationStackParam = {
	close: () => void
	simulationInput: Signal<string>
}

export function ImportSimulationStack(param: ImportSimulationStackParam) {

	const isSubmitButtonDisabled = useComputed(() => errorString.value !== undefined || param.simulationInput.value.trim().length === 0 )
	const isValid = useComputed(() => errorString.value === undefined)

	const errorString = useComputed(() => {
		const trimmed = param.simulationInput.value.trim()
		if (trimmed.length === 0) return undefined
		if (!isJSON(trimmed)) return 'not a valid JSON'
		const parseResult = InterceptorSimulateExport.safeParse(JSON.parse(trimmed))
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
		sendPopupMessageToBackgroundPage({ method: 'popup_importSimulationStack', data: InterceptorSimulateExport.parse(JSON.parse(trimmed)) })
		param.close()
	}

	return ( <>
		<div class = 'modal-background'> </div>
		<div class = 'modal-card'>
			<header class = 'modal-card-head card-header interceptor-modal-head window-header'>
				<div class = 'card-header-icon unset-cursor'>
					<span class = 'icon'>
						<img src = '../img/address-book.svg'/>
					</span>
				</div>
				<div class = 'card-header-title'>
					<p className = 'paragraph'> { 'Import Interceptor Simulation Stack' } </p>
				</div>
				<button class = 'card-header-icon' aria-label = 'close' onClick = { param.close }>
					<XMarkIcon />
				</button>
			</header>
			<section class = 'modal-card-body' style = 'overflow: visible;'>
				<div class = 'card' style = 'margin: 10px;'>
					<div class = 'card-content'>
						<div class = 'media'>
							<div class = 'media-content' style = 'overflow-y: unset; overflow-x: unset;'>
								<div class = 'container' style = 'margin-bottom: 10px;'>
									<span class = 'log-table' style = 'column-gap: 5px; row-gap: 5px; grid-template-columns: max-content auto;'>
										<CellElement element = { <Text text = { 'Interceptor Simulation Stack: ' }/> }/>
										<CellElement element = { <>
											<SimulationInput input = { param.simulationInput } isValid = { isValid } disabled = { false }/>
											<div style = 'padding-left: 5px'/>
										</> }/>
									</span>
								</div>
							</div>
						</div>
					</div>
				</div>
				<div style = 'padding-left: 10px; padding-right: 10px; margin-bottom: 10px; min-height: 80px'>
					{ errorString.value === undefined ? <></> : <Notice text = { errorString.value} /> }
				</div>
			</section>
			<footer class = 'modal-card-foot window-footer' style = 'border-bottom-left-radius: unset; border-bottom-right-radius: unset; border-top: unset; padding: 10px;'>
				<button class = 'button is-success is-primary' onClick = { importStack } disabled = { isSubmitButtonDisabled.value }> { 'Import' } </button>
			</footer>
		</div>
	</> )
}
