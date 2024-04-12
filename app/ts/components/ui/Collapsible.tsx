import { ComponentChildren, JSX } from 'preact'

type CollapsibleProps = {
	summary: string
	children: ComponentChildren
	defaultOpen?: true
	class?: string
	style?: JSX.HTMLAttributes<HTMLDetailsElement>['style']
}

export const Collapsible = (props: CollapsibleProps) => {
	return (
		<details class = { props.class } open = { props.defaultOpen } style = { props.style }>
			<summary onMouseLeave = { e => e.currentTarget.blur() }>
				<Indicator />
				<span>{ props.summary }</span>
			</summary>
			<article>{ props.children }</article>
		</details>
	)
}

const Indicator = () => {
	return (
		<svg class = 'svg-icon details--arrow' xmlns = 'http://www.w3.org/2000/svg' viewBox = '0 0 16 16'>
			<path d = 'M 2 5 L 8 11 L 14 5' rotate = '5' stroke = 'currentColor' />
		</svg>
	)
}
