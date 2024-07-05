import { ComponentChildren, createContext } from 'preact'
import { useContext, useRef } from 'preact/hooks'
import { Signal, useComputed, useSignal, useSignalEffect } from '@preact/signals'

type LayoutContext = {
	offsetTop: Signal<number>
	observer: Signal<ResizeObserver>
	isStacked: Signal<boolean>
}

const LayoutContext = createContext<LayoutContext | undefined>(undefined)

export const Layout = ({ children }: { children: ComponentChildren }) => {
	const offsetTop = useSignal<number>(0)
	const dimensions = useSignal<Map<string, { width: number, height: number }>>(new Map())

	const isStacked = useComputed(() => (new Set(Array.from(dimensions.value.values()).map(({ width }) => width))).size === 1)
	useSignal(false)

	const observer = useSignal(new ResizeObserver((entries) => {
		const dimensionsMap = new Map(dimensions.peek())
		// prevent watching for resize before first paint
		requestAnimationFrame(() => {
			for (let entry of entries) {
				if (entry.target.nodeName === 'HEADER') {
					offsetTop.value = entry.target.getBoundingClientRect().height
				}
				const { width, height } = entry.target.getBoundingClientRect()
				const nodeName = entry.target.nodeName
				dimensionsMap.set(nodeName, { width, height })
			}

			dimensions.value = dimensionsMap
		})
	}))

	return (
		<LayoutContext.Provider value={ { offsetTop, observer, isStacked } }>
			<main><div class='layout' style={ { '--header-height': `${offsetTop.value}px` } }>{ children }</div></main>
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

	useSignalEffect(() => {
		const headerElement = headerRef.current
		if (!observer.value || !headerElement) return
		observer.value.observe(headerElement)
		return () => { observer.value.unobserve(headerElement) }
	})

	return <header ref={ headerRef }>{ children }</header>
}

const Sidebar = ({ children }: { children: ComponentChildren }) => {
	const { observer } = useLayout()
	const asideRef = useRef<HTMLElement>(null)

	useSignalEffect(() => {
		const asideElement = asideRef.current
		if (!observer.value || !asideElement) return
		observer.value.observe(asideElement)
		return () => { observer.value.unobserve(asideElement) }
	})

	return <aside ref={ asideRef }>{ children }</aside>
}

const Main = ({ children }: { children: ComponentChildren }) => {
	const { observer } = useLayout()
	const articleRef = useRef<HTMLElement>(null)

	useSignalEffect(() => {
		const articleElement = articleRef.current
		if (!observer.value || !articleElement) return
		observer.value.observe(articleElement)
		return () => { observer.value.unobserve(articleElement) }
	})

	return <article ref={ articleRef }>{ children }</article>
}

Layout.Header = Header
Layout.Sidebar = Sidebar
Layout.Main = Main
