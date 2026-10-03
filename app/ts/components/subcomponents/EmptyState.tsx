// A centred panel with the Interceptor mascot, shown where a list or stack has nothing in it yet.
export function EmptyState({ title, text }: { title: string, text?: string }) {
	return <div class = 'empty-state'>
		<img class = 'empty-state-image' src = '../img/LOGOA.svg' alt = '' width = '64' height = '64'/>
		<p class = 'empty-state-title'>{ title }</p>
		{ text === undefined ? <></> : <p class = 'empty-state-text'>{ text }</p> }
	</div>
}
