import { type Signal, useComputed, useSignal, useSignalEffect } from '@preact/signals'
import type { ComponentChild } from 'preact'
import { useRef } from 'preact/hooks'

interface DynamicScrollerProps<T extends {}> {
	items: Signal<Readonly<T[]>>
	renderItem: (item: T) => ComponentChild
}

export const getDynamicScrollOffset = (startIndex: number, itemHeight: number, itemCount: number, maximumVisibleItems: number) => {
	if (itemHeight <= 0 || !Number.isFinite(itemHeight) || !Number.isFinite(maximumVisibleItems)) return 0
	const requestedOffset = getClampedDynamicScrollStartIndex(startIndex, itemCount, maximumVisibleItems) * itemHeight
	const maximumOffset = Math.max(0, (itemCount - maximumVisibleItems) * itemHeight)
	return Math.min(requestedOffset, maximumOffset)
}

export const getClampedDynamicScrollStartIndex = (startIndex: number, itemCount: number, maximumVisibleItems: number) => {
	if (!Number.isFinite(startIndex) || !Number.isFinite(itemCount) || !Number.isFinite(maximumVisibleItems)) return 0
	const maximumStartIndex = Math.max(0, Math.floor(itemCount) - Math.max(1, Math.floor(maximumVisibleItems)))
	return Math.min(Math.max(0, Math.floor(startIndex)), maximumStartIndex)
}

export const DynamicScroller = <T extends {}>({ items, renderItem, }: DynamicScrollerProps<T>) => {
	const startIndex = useSignal(0)
	const maxItems = useSignal(0)
	const itemHeight = useSignal(0)
	const scrollViewRef = useRef<HTMLDivElement>(null)
	const itemRef = useRef<HTMLDivElement>(null)

	const recalculateStartIndex = (event: Event) => {
		if (!(event.currentTarget instanceof HTMLDivElement)) return
		if (itemHeight.value <= 0) return
		startIndex.value = Math.floor(event.currentTarget.scrollTop / itemHeight.value)
	}

	const scrollAreaHeight = useComputed(() => items.value.length * itemHeight.value)
	const clampedStartIndex = useComputed(() => getClampedDynamicScrollStartIndex(startIndex.value, items.value.length, maxItems.value))
	const visibleItems = useComputed(() => items.value.slice(clampedStartIndex.value, clampedStartIndex.value + maxItems.value + 1))
	const scrollOffset = useComputed(() => getDynamicScrollOffset(clampedStartIndex.value, itemHeight.value, items.value.length, maxItems.value))

	useSignalEffect(() => {
		const synchronizedStartIndex = clampedStartIndex.value
		if (startIndex.value === synchronizedStartIndex) return
		startIndex.value = synchronizedStartIndex
		if (scrollViewRef.current !== null) scrollViewRef.current.scrollTop = getDynamicScrollOffset(synchronizedStartIndex, itemHeight.value, items.value.length, maxItems.value)
	})

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
			maxItems.value = itemHeight.value <= 0 ? 0 : Math.ceil(entry!.contentRect.height / itemHeight.value)
		})
		containerObserver.observe(scrollViewRef.current)
		return () => { containerObserver.disconnect() }
	})

	return (
		<div ref = { scrollViewRef } style = { { overflowY: 'scroll', maxHeight: '100%' } } onScroll = { recalculateStartIndex }>
			<div style = { { height: `${ scrollAreaHeight }px`, '--virtual-scroll-offset': `${ scrollOffset }px` } }>
				{ visibleItems.value.map((item, index) => (
					<div key = { clampedStartIndex.value + index } ref = { itemRef } style = { {  contain: 'layout', transform: 'translateY(var(--virtual-scroll-offset))' } }>
						{ renderItem(item) }
					</div>
				)) }
			</div>
		</div>
	)
}
