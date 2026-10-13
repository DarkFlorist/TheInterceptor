import { useEffect } from 'preact/hooks'

interface PasteProps {
	onPaste: (text: string) => void,
	enabled: boolean,
}

// catches paste events if enabled === true and callbacks OnPaste
export function PasteCatcher({ enabled, onPaste }: PasteProps) {
	useEffect(() => {
		function catcher(event: Event) {
			if (enabled === false) return
			if (!(event instanceof ClipboardEvent)) return
			if (event.clipboardData === null) return
			onPaste(event.clipboardData.getData('text'))
		}
		window.addEventListener('paste', catcher)
		return () => { window.removeEventListener('paste', catcher) }
	}, [enabled, onPaste])
	return <></>
}
