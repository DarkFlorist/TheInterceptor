import { ComponentChildren, createContext } from 'preact'
import { useContext, useEffect, useRef } from 'preact/hooks'
import { Signal, useSignal } from '@preact/signals'

type LayoutContext = {
	offsetTop: Signal<number>
	observer: ResizeObserver
}

const LayoutContext = createContext<LayoutContext | undefined>(undefined)

export const Layout = ({ children }: { children: ComponentChildren }) => {
	const offsetTop = useSignal<number>(0)
	useSignal(false)

	const observer = new ResizeObserver((entries) => {
		requestAnimationFrame(() => {
			for (let entry of entries) {
				if (entry.target.nodeName === 'HEADER') {
					offsetTop.value = entry.target.getBoundingClientRect().height
				}
			}
		})
	})

	return (
		<LayoutContext.Provider value = { { offsetTop, observer } }>
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
	const articleRef = useRef<HTMLElement>(null)
	return <article ref = { articleRef }>{ children }</article>
}

Layout.Header = Header
Layout.Main = Main
