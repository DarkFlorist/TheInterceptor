import type { ComponentChild, ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { type Signal, useSignal, useSignalEffect } from '@preact/signals'

interface Props {
	children: ComponentChild | ComponentChild[]
	attribute?: string
	template?: (content: string) => ComponentChildren
}

const timerAttribute = 'data-hint-clickable-hide-timer-ms'
const showHintEventName = 'interceptor:show-hint'
const viewportBorderPadding = 30
// Wrapped hints stay narrower than the viewport by the padding calculatePosition keeps on both sides, so clamping their position never pushes them off screen.
const hintMaxWidth = `calc(100% - ${ 2 * viewportBorderPadding }px)`

type ShowHintEventDetail = {
	content: string
	delay: number
	x: number
	y: number
}

export const showHint = (target: HTMLElement, detail: ShowHintEventDetail) => {
	target.dispatchEvent(new CustomEvent(showHintEventName, { bubbles: true, detail }))
}

export const clearHintTimeouts = (timeoutIds: readonly (ReturnType<typeof setTimeout> | null)[], clearTimeoutFunction = clearTimeout) => {
	for (const timeoutId of timeoutIds) clearTimeoutFunction(timeoutId ?? undefined)
}

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

		const getHintElement = (target: EventTarget | null, attribute: string) => {
			if (!(target instanceof Element)) return undefined
			const element = target.hasAttribute(attribute) ? target : target.closest(`[${ attribute }]`)
			if (element === null || !containerElement.contains(element)) return undefined
			return element
		}

		// Cancels both the copy message and tooltip timers, so a stale copy message timer can neither clear a newly shown hint nor stop hide from clearing it.
		const cancelPendingHintTimeouts = () => {
			clearHintTimeouts([copyMessageTimeoutIdRef.current, toolTipTimeoutIdRef.current])
			copyMessageTimeoutIdRef.current = null
			toolTipTimeoutIdRef.current = null
		}

		const hide = (event: Event) => {
			if (getHintElement(event.target, toolTipAttribute) === undefined) return

			clearTimeout(toolTipTimeoutIdRef.current ?? undefined)

			if (copyMessageTimeoutIdRef.current !== null) return

			content.value = ''
			clickPosition.value = null
		}

		const click = (event: MouseEvent) => {
			const targetElement = getHintElement(event.target, copyAttribute)
			if (targetElement === undefined || !targetElement.hasAttribute(timerAttribute)) return

			clearTimeout(toolTipTimeoutIdRef.current ?? undefined)

			const delayValue = targetElement.getAttribute(timerAttribute)
			if (delayValue === null) return

			clearTimeout(copyMessageTimeoutIdRef.current ?? undefined)
			copyMessageTimeoutIdRef.current = null

			content.value = targetElement.getAttribute(copyAttribute) || ''
			clickPosition.value = { x: event.clientX, y: event.clientY }

			copyMessageTimeoutIdRef.current = setTimeout(() => {
				content.value = ''
				clickPosition.value = null
				copyMessageTimeoutIdRef.current = null
			}, parseInt(delayValue))
		}

		const show = (event: Event) => {
			if (!(event instanceof CustomEvent)) return
			if (!(event.target instanceof Element) || !containerElement.contains(event.target)) return
			const detail: unknown = event.detail
			if (typeof detail !== 'object' || detail === null) return
			if (!('content' in detail) || typeof detail.content !== 'string') return
			if (!('delay' in detail) || typeof detail.delay !== 'number' || !Number.isFinite(detail.delay) || detail.delay < 0) return
			if (!('x' in detail) || typeof detail.x !== 'number' || !('y' in detail) || typeof detail.y !== 'number') return

			cancelPendingHintTimeouts()
			content.value = detail.content
			clickPosition.value = { x: detail.x, y: detail.y }
			copyMessageTimeoutIdRef.current = setTimeout(() => {
				content.value = ''
				clickPosition.value = null
				copyMessageTimeoutIdRef.current = null
			}, detail.delay)
		}

		const mouseover = (event: MouseEvent) => {
			const targetElement = getHintElement(event.target, toolTipAttribute) ?? getHintElement(event.target, timerAttribute)
			if (targetElement === undefined) return
			clearTimeout(toolTipTimeoutIdRef.current ?? undefined)
			const tooltipContent = targetElement.getAttribute(toolTipAttribute) || ''
			toolTipTimeoutIdRef.current = setTimeout(() => {
				content.value = tooltipContent
				clickPosition.value = { x: event.clientX, y: event.clientY }
			}, 250)
		}

		// Only a focused element that carries the tooltip itself shows it, so focusable controls nested inside a tooltip wrapper such as CopyToClipboard keep their current behavior.
		const focusin = (event: FocusEvent) => {
			const targetElement = event.target
			if (!(targetElement instanceof Element) || !targetElement.hasAttribute(toolTipAttribute) || !containerElement.contains(targetElement)) return
			cancelPendingHintTimeouts()
			const targetBounds = targetElement.getBoundingClientRect()
			content.value = targetElement.getAttribute(toolTipAttribute) || ''
			clickPosition.value = { x: targetBounds.left + targetBounds.width / 2, y: targetBounds.bottom }
		}

		containerElement.addEventListener('click', click)
		containerElement.addEventListener('mouseover', mouseover)
		containerElement.addEventListener('mouseout', hide)
		containerElement.addEventListener('focusin', focusin)
		containerElement.addEventListener('focusout', hide)
		containerElement.addEventListener(showHintEventName, show)

		return () => {
			cancelPendingHintTimeouts()
			containerElement.removeEventListener('click', click)
			containerElement.removeEventListener('mouseover', mouseover)
			containerElement.removeEventListener('mouseout', hide)
			containerElement.removeEventListener('focusin', focusin)
			containerElement.removeEventListener('focusout', hide)
			containerElement.removeEventListener(showHintEventName, show)
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

	return {
		left: positionX + hintWidth > globalThis.innerWidth - viewportBorderPadding ? globalThis.innerWidth - viewportBorderPadding - hintWidth : (positionX < viewportBorderPadding ? viewportBorderPadding : positionX),
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
		<div class = 'preact-hint' style = { { ...dialogPosition.value, maxWidth: hintMaxWidth } }>
			<span class = 'preact-hint__content' ref = { hintElementRef }>
				{ props.template ? props.template(props.content.value) : props.content.value }
			</span>
		</div>
	)
}
