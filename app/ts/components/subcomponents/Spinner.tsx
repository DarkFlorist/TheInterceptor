export function Spinner({ height } : { height: string }) {
	return (
		<svg
			style = { { height, margin: 'auto'  } }
			class = 'spinner'
			viewBox = '0 0 100 100'
			xmlns = 'http://www.w3.org/2000/svg'>
				<circle cx = '50' cy = '50' r = '45'/>
		</svg>
	)
}

export function CenterToPageTextSpinner({ text } : { text: string }) {
	return <main class = 'center-to-page'>
		<div style = 'display: grid; place-items: center;'>
			<Spinner height = '3em'/>
			<p class = 'paragraph' style = 'font-size: 2em; word-break: break-word; color: var(--unimportant-text-color); padding-top: 10px; text-align: center;'> { text } </p>
		</div>
	</main>
}
