import { XMarkIcon } from './icons.js'

export function DinoSays( { text } : { text: string }) {
	return <div class = 'media'>
		<div class = 'media-left dino-avatar'>
			<img class = 'dino-image' src = '../img/LOGOA.svg' width = '24' height = '24'/>
		</div>
		<div class = 'media-content dino-speech'>
			<span class = 'paragraph addressText'> - { text } </span>
		</div>
	</div>
}

export function DinoSaysNotification( { text, close, narrowSummary } : { text: string, close?: () => void, narrowSummary?: string }) {
	return <div class = { narrowSummary === undefined ? 'dino-notification' : 'dino-notification responsive-notification' }>
		<div class = 'notification notification-importance-box dino-notification-box'>
			<DinoSays text = { text }/>
			{ narrowSummary === undefined ? <></> : <details class = 'responsive-notification-details'>
				<summary>{ narrowSummary }</summary>
				<p class = 'paragraph'>{ text }</p>
			</details> }
			{ close !== undefined ?
				<button class = 'card-header-icon' aria-label = 'remove' onClick = { close }>
					<XMarkIcon />
				</button>
			: <></> }
		</div>
	</div>
}
