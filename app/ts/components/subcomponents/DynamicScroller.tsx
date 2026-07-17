import { type Signal, useComputed, useSignal } from '@preact/signals'
import type { ComponentChild } from 'preact'
import { useLayoutEffect, useRef } from 'preact/hooks'

interface DynamicScrollerProps<T extends {}> {
	items: Signal<Readonly<T[]>>
	renderItem: (item: T) => ComponentChild
}

function isPositiveFinite(value: number) {
	return Number.isFinite(value) && value > 0
}

export function calculateMaxVisibleItems(containerHeight: number, itemHeight: number) {
	if (!isPositiveFinite(containerHeight) || !isPositiveFinite(itemHeight)) return 0
	const maxItems = Math.ceil(containerHeight / itemHeight)
	return Number.isFinite(maxItems) ? maxItems : 0
}

export const DynamicScroller = <T extends {}>({ items, renderItem, }: DynamicScrollerProps<T>) => {
	const startIndex = useSignal(0)
	const containerHeight = useSignal(0)
	const itemHeight = useSignal(0)
	const scrollViewRef = useRef<HTMLDivElement>(null)
	const itemRef = useRef<HTMLDivElement>(null)

	const recalculateStartIndex = (event: Event) => {
		if (!(event.currentTarget instanceof HTMLDivElement)) return
		if (!isPositiveFinite(itemHeight.peek())) return
		startIndex.value = Math.floor(event.currentTarget.scrollTop / itemHeight.value)
	}

	const maxItems = useComputed(() => calculateMaxVisibleItems(containerHeight.value, itemHeight.value))
	const scrollViewHeight = useComputed(() => itemHeight.value * maxItems.value)
	const scrollAreaHeight = useComputed(() => items.value.length * itemHeight.value)
	const visibleItems = useComputed(() => items.value.slice(startIndex.value, startIndex.value + maxItems.value + 1))
	const scrollOffset = useComputed(() => Math.max(0, Math.min(startIndex.value * itemHeight.value, scrollAreaHeight.value - scrollViewHeight.value)))

	// The first row can render while an owning tab panel is hidden. ResizeObserver
	// remeasures it once visible, while zero-sized hidden measurements are ignored.
	useLayoutEffect(() => {
		if (itemRef.current === null) return
		const itemObserver = new ResizeObserver((entries) => {
			const entry = entries[0]
			if (entry === undefined || !isPositiveFinite(entry.contentRect.height)) return
			itemHeight.value = entry.contentRect.height
		})
		itemObserver.observe(itemRef.current)
		return () => { itemObserver.disconnect() }
	})

	// scroll view occupies the same height as parent
	useLayoutEffect(() => {
		if (scrollViewRef.current === null) return
		const containerObserver = new ResizeObserver((entries) => {
			const entry = entries[0]
			if (entry === undefined || !isPositiveFinite(entry.contentRect.height)) return
			containerHeight.value = entry.contentRect.height
		})
		containerObserver.observe(scrollViewRef.current)
		return () => { containerObserver.disconnect() }
	}, [])

	return (
		<div ref = { scrollViewRef } style = { { overflowY: 'scroll', maxHeight: '100%' } } onScroll = { recalculateStartIndex }>
			<div style = { { height: `${ scrollAreaHeight }px`, '--virtual-scroll-offset': `${ scrollOffset }px` } }>
				{ visibleItems.value.map((item, index) => (
					<div key = { startIndex.value + index } ref = { itemRef } style = { {  contain: 'layout', transform: 'translateY(var(--virtual-scroll-offset))' } }>
						{ renderItem(item) }
					</div>
				)) }
			</div>
		</div>
	)
}
