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
