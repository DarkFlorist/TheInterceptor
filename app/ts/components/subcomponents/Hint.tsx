import type { ComponentChild, ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { Signal, useSignal, useSignalEffect } from '@preact/signals'

interface Props {
	children: ComponentChild | ComponentChild[]
	attribute?: string
	template?: (content: string) => ComponentChildren
}

const timerAttribute = 'data-hint-clickable-hide-timer-ms'

export default function Container(props: Props) {
	const copyAttribute = props.attribute || 'data-hint'
	const toolTipAttribute = props.attribute || 'data-tooltip'

	const content = useSignal('')
	const clickPosition = useSignal<{ x: number, y: number } | null>(null)

	const containerElementRef = useRef<HTMLDivElement | null>(null)
	const copyMessageTimeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const toolTipTimeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	useEffect(() => {
		const containerElement = containerElementRef.current
		if (!containerElement) return

		const hide = (event: Event) => {
			if (!(event.target instanceof Element) || !event.target.hasAttribute(toolTipAttribute)) return

			clearTimeout(toolTipTimeoutIdRef.current ?? undefined)

			if (copyMessageTimeoutIdRef.current !== null) return

			content.value = ''
			clickPosition.value = null
		}

		const click = (event: MouseEvent) => {
			if (!(event.target instanceof Element) || !event.target.hasAttribute(copyAttribute) || !event.target.hasAttribute(timerAttribute)) return

			clearTimeout(toolTipTimeoutIdRef.current ?? undefined)

			const delayValue = event.target.getAttribute(timerAttribute)
			if (delayValue === null) return

			clearTimeout(copyMessageTimeoutIdRef.current ?? undefined)
			copyMessageTimeoutIdRef.current = null

			content.value = event.target.getAttribute(copyAttribute) || ''
			clickPosition.value = { x: event.clientX, y: event.clientY }

			copyMessageTimeoutIdRef.current = setTimeout(() => {
				content.value = ''
				clickPosition.value = null
				copyMessageTimeoutIdRef.current = null
			}, parseInt(delayValue))
		}

		const mouseover = (event: MouseEvent) => {
			if (!(event.target instanceof Element) || (!event.target.hasAttribute(toolTipAttribute) && !event.target.hasAttribute(timerAttribute))) return
			clearTimeout(toolTipTimeoutIdRef.current ?? undefined)
			const tooltipContent = event.target.getAttribute(toolTipAttribute) || ''
			toolTipTimeoutIdRef.current = setTimeout(() => {
				content.value = tooltipContent
				clickPosition.value = { x: event.clientX, y: event.clientY }
			}, 250)
		}

		containerElement.addEventListener('click', click)
		containerElement.addEventListener('mouseover', mouseover)
		containerElement.addEventListener('mouseout', hide)
		containerElement.addEventListener('focusout', hide)

		return () => {
			containerElement.removeEventListener('click', click)
			containerElement.removeEventListener('mouseover', mouseover)
			containerElement.removeEventListener('mouseout', hide)
			containerElement.removeEventListener('focusout', hide)
		}
	}, [copyAttribute, toolTipAttribute])

	return (
		<div ref = { containerElementRef } style = 'position: relative; overflow-x: hidden;'>
			{ content.value && clickPosition.value && (
				<Hint
					content = { content }
					template = { props.template }
					clickPosition = { clickPosition }
				/>
			) }
			{ props.children }
		</div>
	)
}

interface HintProps {
	content: Signal<string>
	template?: (content: string) => ComponentChildren
	clickPosition: Signal<{ x: number, y: number } | null>
}

function calculatePosition(clickPositionX: number, clickPositionY: number, hintWidth: number) {
	const positionX = clickPositionX - hintWidth / 2
	const positionY = clickPositionY + 10
	const borderPadding = 30

	return {
		left: positionX + hintWidth > globalThis.innerWidth - borderPadding ? globalThis.innerWidth - borderPadding - hintWidth : (positionX < borderPadding ? borderPadding : positionX),
		top: positionY,
	}
}

function Hint(props: HintProps) {
	const hintElementRef = useRef<HTMLSpanElement>(null)
	const dialogPosition = useSignal({ left: -1000, top: -1000 })

	useSignalEffect(() => {
		if (hintElementRef.current === null) return
		if (props.clickPosition.value === null) return
		const measuredWidth = hintElementRef.current.getBoundingClientRect().width
		dialogPosition.value = calculatePosition(props.clickPosition.value.x, props.clickPosition.value.y, measuredWidth)
	})

	return (
		<div class = 'preact-hint' style = { dialogPosition.value }>
			<span class = 'preact-hint__content' ref = { hintElementRef }>
				{ props.template ? props.template(props.content.value) : props.content.value }
			</span>
		</div>
	)
}
