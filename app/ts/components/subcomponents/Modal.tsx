import { ComponentChildren, createContext, JSX } from 'preact'
import { Ref, useContext, useEffect, useRef } from 'preact/hooks'

/**
 * Modal Component
 *
 * A compound component for creating accessible modal dialogs.
 *
 * @example
 * ```tsx
 * import { Modal } from './Modal'
 *
 * function App() {
 *   return (
 *     <Modal>
 *       <Modal.Open>Open Modal</Modal.Open>
 *       <Modal.Dialog onClose={ (e) => console.log(e.currentTarget.returnValue) }>
 *         <h2>Modal Title</h2>
 *         <p>Modal content goes here.</p>
 *         <Modal.Close value = 'confirm'>Confirm</Modal.Close>
 *         <Modal.Close value = 'cancel'>Cancel</Modal.Close>
 *       </Modal.Dialog>
 *     </Modal>
 *   );
 * }
 * ```
 */
export const Modal = ({ children }: { children: ComponentChildren }) => {
	const dialogRef = useRef<HTMLDialogElement>(null)
	return <ModalContext.Provider value = { { dialogRef } }>{ children }</ModalContext.Provider>
}

const ModalContext = createContext<{ dialogRef: Ref<HTMLDialogElement> } | undefined>(undefined)

/**
 * Modal.Open Component
 *
 * A button component that opens the modal when clicked.
 *
 * @extends JSX.IntrinsicElements['button']
 */
const Open = (props: Omit<JSX.IntrinsicElements['button'], 'onClick'> & { onClick?: (event: Event) => void }) => {
	const context = useContext(ModalContext)
	if (!context) throw new Error('Modal.Open must be used within a Modal')
	const showModal = (event: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
		context.dialogRef.current?.showModal()
		props.onClick?.(event)
	}
	return <button { ...props } type = 'button' onClick = { showModal } />
}

/**
 * Modal.Dialog Component
 *
 * The dialog component that contains the modal content.
 *
 * @extends JSX.IntrinsicElements['dialog']
 * @property {(event: Event & { currentTarget: HTMLDialogElement }) => void} onClose - Callback fired when the dialog is closed. The event.currentTarget.returnValue will contain the value from Modal.Close.
 */
type ModalDialogProps<T extends string> = JSX.IntrinsicElements['dialog'] & {
	onClose: (returnValue: T) => void
}

const Dialog = <T extends string>({ children, onClose, ...props }: ModalDialogProps<T>) => {
	const context = useContext(ModalContext)
	if (!context) throw new Error('Modal.Dialog must be used within a Modal')

	const closeEventCallback = (event: Event) => {
		if (!(event.currentTarget instanceof HTMLDialogElement)) return
		onClose(event.currentTarget.returnValue as T)
	}

	useEffect(() => {
		const dialogElement = context.dialogRef.current
		if (dialogElement === null) return
		dialogElement.addEventListener('close', closeEventCallback)
		return () => { dialogElement.addEventListener('close', closeEventCallback) }
	}, [context.dialogRef.current])

	return (
		<dialog role = 'dialog' { ...props } ref = { context.dialogRef }>
			<form method = 'dialog'>{ children }</form>
		</dialog>
	)
}

/**
 * Modal.Close Component
 *
 * A button component that closes the modal when clicked.
 * The `value` prop will be passed to the onClose callback of Modal.Dialog.
 *
 * @extends Omit<JSX.IntrinsicElements['button'], 'value'>
 * @property { string | number | string[] } value - The value to be passed to the onClose callback when the modal is closed.
 */
type ModalCloseProps = Omit<JSX.IntrinsicElements['button'], 'value'> & { value: string | number | string[] }
const Close = (props: ModalCloseProps) => {
	const context = useContext(ModalContext)
	if (!context) throw new Error('Modal.Close must be used within a Modal')
	return <button { ...props } type = 'submit' />
}

Modal.Dialog = Dialog
Modal.Open = Open
Modal.Close = Close
