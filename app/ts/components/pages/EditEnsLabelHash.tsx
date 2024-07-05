
import { Notice } from '../subcomponents/Error.js'
import { bytes32String, bytesToUnsigned } from '../../utils/bigint.js'
import { EditEnsNamedHashWindowState } from '../../types/visualizer-types.js'
import { ComponentChildren, createRef } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { keccak_256 } from '@noble/hashes/sha3'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { namehash } from 'ethers'
import { XMarkIcon } from '../subcomponents/icons.js'

type EditEnsNamedHashParams = {
	close: () => void,
	editEnsNamedHashWindowState: EditEnsNamedHashWindowState,
}

const CellElement = (param: { element: ComponentChildren }) => {
	return <div class = 'log-cell' style = 'justify-content: right;'>
		{ param.element }
	</div>
}

export function EditEnsLabelHash(param: EditEnsNamedHashParams) {
	const [inputDisabled, setInputDisabled] = useState<boolean>(false)
	const [name, setName] = useState<string | undefined>(undefined)
	const [errorString, setErrorString] = useState<string>('')
	
	const Text = (param: { text: ComponentChildren }) => {
		return <p class = 'paragraph' style = 'color: var(--subtitle-text-color); text-overflow: ellipsis; overflow: hidden; width: 100%'>
			{ param.text }
		</p>
	}
	
	type TextInputParams = {
		value: string | undefined
		setInput: (input: string) => void
		disabled: boolean,
		placeholder: string,
	}
	async function validateAndSetName(name: string) {
		setName(name)
		if (param.editEnsNamedHashWindowState.type === 'labelHash') {
			const hash = bytesToUnsigned(keccak_256(name))
			if (hash !== param.editEnsNamedHashWindowState.nameHash) return setErrorString(`The label corresponds to a hash: ${ bytes32String(hash) } which doesn't match!`) 
			setErrorString('Correct label found!')
		} else {
			const hash = BigInt(namehash(name))
			if (hash !== param.editEnsNamedHashWindowState.nameHash) return setErrorString(`The name corresponds to a hash: ${ bytes32String(hash) } which doesn't match!`) 
			setErrorString('Correct name found!')
		}
		setInputDisabled(true)
		await sendPopupMessageToBackgroundPage({ method: 'popup_setEnsNameForHash', data: { ...param.editEnsNamedHashWindowState, name } } )
	}

	function TextInput({ value, setInput, disabled, placeholder }: TextInputParams) {
		const ref = createRef<HTMLInputElement>()
		useEffect(() => { ref.current?.focus() }, [])
		return <input
			className = 'input title is-5 is-spaced'
			type = 'text'
			value = { value }
			placeholder = { placeholder }
			onInput = { e => setInput((e.target as HTMLInputElement).value) }
			maxLength = { 42 }
			ref = { ref }
			style = { 'width: 100%' }
			disabled = { disabled }
		/>
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
					<p className = 'paragraph'> { param.editEnsNamedHashWindowState.type === 'labelHash' ? 'What is the correct ENS label for this hash?' : 'What is the correct ENS name for this hash?' } </p>
				</div>
				<button class = 'card-header-icon' aria-label = 'close' onClick = { param.close }>
					<XMarkIcon />
				</button>
			</header>
			<section class = 'modal-card-body' style = 'overflow: visible;'>
				<div class = 'card' style = 'margin: 10px;'>
					<div class = 'card-content'>
						<div class = 'container' style = 'margin-bottom: 10px;'>
							<span class = 'log-table' style = 'column-gap: 5px; row-gap: 5px; grid-template-columns: max-content auto;'>
								<CellElement element = { <Text text = { 'Hash: ' }/> }/>
								<CellElement element = { <TextInput value = { bytes32String(param.editEnsNamedHashWindowState.nameHash) } setInput = {() => {} } disabled = { true } placeholder = {''}/> } />
								<CellElement element = { <Text text = { 'Name: ' }/> }/>
								<CellElement element = { <TextInput value = { param.editEnsNamedHashWindowState.name ? param.editEnsNamedHashWindowState.name : name } disabled = { param.editEnsNamedHashWindowState.name !== undefined || inputDisabled } setInput = { validateAndSetName } placeholder = { param.editEnsNamedHashWindowState.type === 'labelHash' ? 'ENS label, eg. "vitalik"' : 'ENS name, eg "vitalik.eth"' }/> } />
							</span>
						</div>
					</div>
				</div>
				<div style = 'padding-left: 10px; padding-right: 10px; margin-bottom: 10px; min-height: 80px'>
					{ errorString === undefined ? <></> : <Notice text = { errorString } /> }
				</div>
			</section>
			<footer class = 'modal-card-foot window-footer' style = 'border-bottom-left-radius: unset; border-bottom-right-radius: unset; border-top: unset; padding: 10px;'>
				<button class = 'button is-primary'  onClick = { param.close }>Ok</button>
			</footer>
		</div>
	</> )
}
