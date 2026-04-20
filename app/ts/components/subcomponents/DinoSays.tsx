import { XMarkIcon } from "./icons.js"

export function DinoSays( { text } : { text: string }) {
	return <div class = 'media-layout'>
		<div class = 'media-layout__aside' style = 'margin-right: 0.2rem;'>
			<img style = 'transform: scaleX(-1); justify-content: center; display: flex;' src = '../img/LOGOA.svg' width = '24'/>
		</div>
		<div class = 'media-layout__content' style = 'overflow-y: hidden; overflow-x: clip; display: block; margin: auto;'>
			<span class = 'paragraph addressText'> - { text } </span>
		</div>
	</div>
}

export function DinoSaysNotification( { text, close } : { text: string, close?: () => void }) {
	return <div style = 'display: flex; align-items: center; justify-content: center;'>
		<div class = 'notice-box notification-importance-box' style = 'padding: 10px; display: flex;'>
			<DinoSays text = { text }/>
			{ close !== undefined ?
				<button class = 'panel-card__icon' aria-label = 'remove' onClick = { close }>
					<XMarkIcon />
				</button>
			: <></> }
		</div>
	</div>
}
