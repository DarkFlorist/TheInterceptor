import { useEffect } from 'preact/hooks'

interface PasteProps {
    onPaste: (text: string) => void,
	enabled: boolean,
}

// catches paste events if enabled == true and callbacks OnPaste
export function PasteCatcher(props: PasteProps) {
	function catcher(event: Event) {
		if (props.enabled === false) return
		if (!(event instanceof ClipboardEvent)) return
		if (event.clipboardData === null) return
		props.onPaste(event.clipboardData.getData('text'))
	}
	useEffect(() => {
		window.addEventListener('paste', catcher)
		return () => { window.removeEventListener('paste', catcher) }
	}, [props.enabled, props.onPaste])
	return <div></div>
}

export const readClipboard = (): Promise<string> => {
	return new Promise((resolve, reject) => {
		const element = document.createElement('textarea')
		element.value = 'before paste'
		document.body.append(element)
		element.select()
		const success = document.execCommand('paste')
		const text = element.value
		element.remove()
		if (!success) reject(new Error('Unable to read from clipboard'))
		resolve(text)
	})
}
