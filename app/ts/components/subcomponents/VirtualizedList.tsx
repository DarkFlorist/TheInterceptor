import { useEffect, useRef, useState } from 'preact/hooks'

type VirtualizedListProps<T extends {}> = {
	items: readonly T[]
	itemHeight: number
	height: number
}

const VirtualizedList = <T extends {}>({ items, itemHeight, height }: VirtualizedListProps<T>) => {
	const [scrollTop, setScrollTop] = useState(0)
	const containerRef = useRef<HTMLDivElement | null>(null)

	const totalHeight = items.length * itemHeight
	const visibleItemCount = Math.ceil(height / itemHeight)
	const startIndex = Math.floor(scrollTop / itemHeight)
	const endIndex = Math.min(items.length, startIndex + visibleItemCount)

	const handleScroll = () => {
		setScrollTop(containerRef.current?.scrollTop || 0)
	}

	useEffect(() => {
		const container = containerRef.current
		if (!container) return

		container.addEventListener('scroll', handleScroll)
		return () => {
			container.removeEventListener('scroll', handleScroll)
		}
	}, [containerRef.current])

	const visibleItems = items.slice(startIndex, endIndex)

	return (
		<div
			ref = { containerRef }
			style = { {
				height: `${height}px`,
				overflowY: 'auto',
				position: 'relative',
			} }
		>
			<div style = { { height: `${totalHeight}px`, position: 'relative' } }>
				{visibleItems.map((item, index) => (
					<div
						key = { startIndex + index }
						style = { {
							position: 'absolute',
							top: `${(startIndex + index) * itemHeight}px`,
							height: `${itemHeight}px`,
							width: '100%',
						} }
					>
						{item}
					</div>
				))}
			</div>
		</div>
	)
}

export default VirtualizedList
