export function DinoSays( { text } : { text: string }) {
	return <div class = 'media'>
		<div class = 'media-left' style = 'margin-right: 0.2rem;'>
			<img style = 'transform: scaleX(-1); justify-content: center; display: flex;' src = '../img/LOGOA.svg' width = '24'/>
		</div>
		<div class = 'media-content' style = 'overflow-y: hidden; overflow-x: clip; display: block; margin: auto;'>
			<span class = 'paragraph addressText'> - { text } </span>
		</div>
	</div>
}

export function DinoSaysNotification( { text, close } : { text: string, close: () => void }) {
	return <div class = 'notification transaction-importance-box' style = 'margin: 10px; display: flex'>
		<DinoSays text = { text }/>
		<button class = 'card-header-icon' aria-label = 'remove' onClick = { close }>
			<span class = 'icon' style = 'color: var(--text-color);'> X </span>
		</button>
	</div>
}
