import type { ComponentChildren } from 'preact'

type PageContentFrameProps = {
	children?: ComponentChildren
	page: 'address-book' | 'simulation-stack'
	standalone?: boolean
	scrollable?: boolean
}

export function PageContentFrame({ children, page, standalone = false, scrollable = false }: PageContentFrameProps) {
	return <div class = { `page-content-frame page-content-frame--${ page }${ standalone ? ' page-content-frame--standalone' : '' }${ scrollable ? ' page-content-frame--scrollable' : '' }` }>{ children }</div>
}
