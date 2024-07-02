import { Signal, useComputed, useSignal, useSignalEffect } from '@preact/signals'
import { ComponentChild } from 'preact'
import { useRef } from 'preact/hooks'

interface DynamicScrollerProps<T extends {}> {
	items: Signal<Readonly<T[]>>
	renderItem: (item: T) => ComponentChild
}

export const DynamicScroller = <T extends {}>({ items, renderItem, }: DynamicScrollerProps<T>) => {
	const startIndex = useSignal(0)
	const maxItems = useSignal(0)
	const itemHeight = useSignal(0)
	const scrollViewRef = useRef<HTMLDivElement>(null)
	const itemRef = useRef<HTMLDivElement>(null)

	const recalculateStartIndex = (event: Event) => {
		if (!(event.currentTarget instanceof HTMLDivElement)) return
		startIndex.value = Math.floor(event.currentTarget.scrollTop / itemHeight.value)
	}

	const scrollViewHeight = useComputed(() => itemHeight.value * maxItems.value)
	const scrollAreaHeight = useComputed(() => items.value.length * itemHeight.value)
	const visibleItems = useComputed(() => items.value.slice(startIndex.value, startIndex.value + maxItems.value + 1))
	const scrollOffset = useComputed(() => Math.min(startIndex.value * itemHeight.value, scrollAreaHeight.value - scrollViewHeight.value))

	// calculate item height
	useSignalEffect(() => {
		if (!itemRef.current || itemHeight.value > itemRef.current.clientHeight) return
		const { height } = itemRef.current.getBoundingClientRect()
		itemHeight.value = height
	})

	// scroll view occupies the same height as parent
	useSignalEffect(() => {
		if (!scrollViewRef.current) return
		const containerObserver = new ResizeObserver(([entry]) => {
			maxItems.value = Math.ceil(entry!.contentRect.height / itemHeight.value)
		})
		containerObserver.observe(scrollViewRef.current)
		return () => { containerObserver.disconnect() }
	})

	return (
		<div ref = { scrollViewRef } style = { { overflowY: 'scroll', maxHeight: '100%' } } onScroll = { recalculateStartIndex }>
			<div style = { { height: `${scrollAreaHeight}px`, '--virtual-scroll-offset': `${scrollOffset}px` } }>
				{ visibleItems.value.map((item) => (
					<div ref = { itemRef } style = { {  contain: 'layout', transform: 'translateY(var(--virtual-scroll-offset))' } }>
						{ renderItem(item) }
					</div>
				)) }
			</div>
		</div>
	)
}
