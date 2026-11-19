export function Spinner({ height, color } : { height: string, color?: string }) {
	return (
		<svg
			style = { { height } }
			class = 'spinner'
			viewBox = '0 0 100 100'
			xmlns = 'http://www.w3.org/2000/svg'>
				<circle cx = '50' cy = '50' r = '45' style = { { ...color !== undefined ? { stroke: color } : {}  } }/>
		</svg>
	)
}

import { resolveSignal, type SignalOrValue } from '../../utils/signals.js'

export function CenterToPageTextSpinner({ text } : { text?: SignalOrValue<string> }) {
	return <main class = 'center-to-page'>
		<div class = 'spinner-page-content'>
			<Spinner height = '3em'/>
			{ text === undefined ? <></> : <p class = 'paragraph spinner-page-text'> { resolveSignal(text) } </p> }
		</div>
	</main>
}
