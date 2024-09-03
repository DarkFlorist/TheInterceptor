import { ComponentChildren, createContext } from 'preact'
import { useContext, useEffect, useRef } from 'preact/hooks'
import { Signal, useComputed, useSignal } from '@preact/signals'

type LayoutContext = {
	offsetTop: Signal<number>
	observer: ResizeObserver
	isStacked: Signal<boolean>
	mainContentHeight: Signal<number>
}

const LayoutContext = createContext<LayoutContext | undefined>(undefined)

export const Layout = ({ children }: { children: ComponentChildren }) => {
	const offsetTop = useSignal<number>(0)
	const mainContentHeight = useSignal<number>(0)
	const dimensions = useSignal<Map<string, { width: number, height: number }>>(new Map())
	const isStacked = useComputed(() => (new Set(Array.from(dimensions.value.values()).map(({ width }) => width))).size === 1)
	useSignal(false)

	const observer = new ResizeObserver((entries) => {
		const dimensionsMap = new Map(dimensions.peek())
		requestAnimationFrame(() => {
			for (let entry of entries) {
				if (entry.target.nodeName === 'HEADER') {
					offsetTop.value = entry.target.getBoundingClientRect().height
				}
				if (entry.target.nodeName === 'ARTICLE') {
					mainContentHeight.value = entry.target.getBoundingClientRect().height
				}
				const { width, height } = entry.target.getBoundingClientRect()
				const nodeName = entry.target.nodeName
				dimensionsMap.set(nodeName, { width, height })
			}

			dimensions.value = dimensionsMap
		})
	})

	return (
		<LayoutContext.Provider value = { { offsetTop, observer, isStacked, mainContentHeight } }>
			<main><div class = 'layout' style = { { '--header-height': `${offsetTop.value}px` } }>{ children }</div></main>
		</LayoutContext.Provider>
	)
}

export function useLayout() {
	const context = useContext(LayoutContext)
	if (!context) throw ''
	return context
}

const Header = ({ children }: { children: ComponentChildren }) => {
	const { observer } = useLayout()
	const headerRef = useRef<HTMLHeadElement>(null)

	useEffect(() => {
		const headerElement = headerRef.current
		if (!headerElement) return
		observer.observe(headerRef.current)
		return () => { observer.unobserve(headerElement) }
	})

	return <header ref = { headerRef }>{ children }</header>
}

const Main = ({ children }: { children: ComponentChildren }) => {
	const { observer, mainContentHeight } = useLayout()
	const articleRef = useRef<HTMLElement>(null)

	const computedStyles = useComputed(() => {
		if (mainContentHeight.value <= window.innerHeight) return
		return { '--sticky-top': `calc(100vh - ${mainContentHeight.value}px)` }
	})

	useEffect(() => {
		const articleElement = articleRef.current
		if (!articleElement) return
		observer.observe(articleRef.current)
		return () => { observer.unobserve(articleElement) }
	})

	return <article ref = { articleRef } style = { computedStyles.value }>{ children }</article>

}

Layout.Header = Header
Layout.Main = Main
