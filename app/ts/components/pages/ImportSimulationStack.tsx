import { useEffect } from 'preact/hooks'
import { Notice } from '../subcomponents/Error.js'
import { type ComponentChildren, createRef } from 'preact'
import { type Signal, useComputed } from '@preact/signals'
import { isJSON } from '../../utils/json.js'
import { getMissingPopupReplyErrorMessage, sendPopupMessageWithReply } from '../../background/backgroundUtils.js'
import { InterceptorSimulationExport } from '../../types/visualizer-types.js'
import { AsyncActionButton } from '../subcomponents/AsyncAction.js'
import { useAsyncState } from '../../utils/preact-utilities.js'
import { InterceptorDialogBody, InterceptorDialogFooter, InterceptorDialogHeader, InterceptorDialogSection, InterceptorDialogSurface } from '../subcomponents/InterceptorDialog.js'

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

	return <InterceptorDialogSurface ariaLabel = 'Import simulation stack' closeDisabled = { isImporting.value } onClose = { param.close } size = 'regular'>
		<InterceptorDialogHeader close = { param.close } closeDisabled = { isImporting.value } closeLabel = 'Close import dialog' icon = '../img/LOGOA.svg' title = 'Import simulation stack' subtitle = 'Restore transactions and messages from an Interceptor export'/>
		<InterceptorDialogBody>
			<InterceptorDialogSection>
				<div class = 'simulation-stack-import-field'>
					<Text text = 'Interceptor simulation stack'/>
					<SimulationInput input = { param.simulationInput } isValid = { isValid } disabled = { isImporting.value }/>
				</div>
			</InterceptorDialogSection>
			{ errorString.value !== undefined ? <div class = 'interceptor-dialog-feedback'><Notice text = { errorString.value } /></div> : importError.value !== undefined ? <div class = 'interceptor-dialog-feedback'><Notice text = { importError.value } /></div> : <></> }
		</InterceptorDialogBody>
		<InterceptorDialogFooter>
			<button type = 'button' class = 'btn btn--ghost' onClick = { param.close } disabled = { isImporting.value }>Cancel</button>
			<AsyncActionButton class = 'btn btn--primary' state = { importRequestState.value.state } text = 'Import' pendingText = 'Importing...' onClick = { importStack } disabled = { isSubmitButtonDisabled.value } />
		</InterceptorDialogFooter>
	</InterceptorDialogSurface>
}
