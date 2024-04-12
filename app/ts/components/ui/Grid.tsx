import { ComponentChildren, JSX } from 'preact'
import { mergeCSSClasses } from '../ui-utils.js'

type GridProps = {
	children: ComponentChildren
	class?: string
	style?: JSX.HTMLAttributes<HTMLDivElement>['style']
}

export const Grid = (props: GridProps) => {
	const className = props.class ? mergeCSSClasses('grid', props.class) : 'grid'
	return <div class = { className } style = { props.style }>{ props.children }</div>
}

type DataProps = {
	children: ComponentChildren,
	class?:string
	style?: JSX.HTMLAttributes<HTMLDivElement>['style']
}

export const Cell = (props: DataProps) => {
	const className = props.class ? mergeCSSClasses('cell', props.class) : 'cell'
	return <div class = { className } style = { props.style }>{ props.children }</div>
}
