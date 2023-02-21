
export function DinoSays( { text } : { text: string }) {
	return <div class = 'media'>
		<div class = 'media-left' style = 'margin-right: 0.2rem;'>
			<img style = 'transform: scaleX(-1); justify-content: center; display: flex;' src = '../img/LOGOA.svg' width = '16'/>
		</div>
		<div class = 'media-content' style = 'overflow-y: hidden; overflow-x: clip; display: block; margin: auto; font-size: 0.6em;'>
			<span class = 'paragraph addressText'> - { text } </span>
		</div>
	</div>
}
