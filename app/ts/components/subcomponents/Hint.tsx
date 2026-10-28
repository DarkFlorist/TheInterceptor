import type { ComponentChild, ComponentChildren } from 'preact'
import { useCallback, useEffect, useRef } from 'preact/hooks'
import { type Signal, useSignal, useSignalEffect } from '@preact/signals'

interface Props {
	children: ComponentChild | ComponentChild[]
	attribute?: string
	template?: (content: string) => ComponentChildren
	// Renders the container as a span with display: contents instead of the page container's styled div, so wrapping phrasing content such as a card in a Hint leaves that content's own box in its parent's layout.
	inline?: boolean
}

const timerAttribute = 'data-hint-clickable-hide-timer-ms'
const showHintEventName = 'interceptor:show-hint'
const viewportBorderPadding = 30
// Wrapped hints stay narrower than the viewport by the padding calculateHintPosition keeps on both sides, so clamping their position never pushes them off screen.
const hintMaxWidth = `calc(100% - ${ 2 * viewportBorderPadding }px)`
const hintAnchorGap = 10

// The viewport span a hint is placed next to. A pointer position has the same top and bottom, while a focused element spans its bounds so a hint placed above it does not cover it.
export type HintAnchor = { x: number, top: number, bottom: number }

const pointAnchor = (x: number, y: number): HintAnchor => ({ x, top: y, bottom: y })

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
	const anchor = useSignal<HintAnchor | undefined>(undefined)

	const containerElementRef = useRef<HTMLElement | null>(null)
	// One callback ref serves both the inline span and the page div container, whose element types differ.
	const setContainerElement = useCallback((element: HTMLElement | null) => { containerElementRef.current = element }, [])
	const copyMessageTimeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const toolTipTimeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	// The element whose tooltip is displayed, kept only so a later event can tell that it no longer carries that tooltip. It is undefined while a copy message or nothing is displayed.
	const displayedTooltipOwnerRef = useRef<Element | undefined>(undefined)

	useEffect(() => {
		const containerElement = containerElementRef.current
		if (!containerElement) return

		const getHintElement = (target: EventTarget | null, attribute: string) => {
			if (!(target instanceof Element)) return undefined
			const element = target.hasAttribute(attribute) ? target : target.closest(`[${ attribute }]`)
			if (element === null || !containerElement.contains(element)) return undefined
			return element
		}

		// Cancels both the copy message and tooltip timers, so a stale copy message timer can neither clear a newly shown hint nor stop leaveTooltip from clearing it.
		const cancelPendingHintTimeouts = () => {
			clearHintTimeouts([copyMessageTimeoutIdRef.current, toolTipTimeoutIdRef.current])
			copyMessageTimeoutIdRef.current = null
			toolTipTimeoutIdRef.current = null
		}

		const displayHint = (hintContent: string, hintAnchor: HintAnchor, tooltipOwner: Element | undefined) => {
			content.value = hintContent
			anchor.value = hintAnchor
			displayedTooltipOwnerRef.current = tooltipOwner
		}

		const hideHint = () => {
			content.value = ''
			anchor.value = undefined
			displayedTooltipOwnerRef.current = undefined
		}

		// An element that is removed, or that Preact reuses for content without this tooltip, fires no mouseout or focusout, so every pointer and focus event Hint listens to first dismisses a tooltip its element no longer carries. A copy message has no owner, so its own timer still decides when it ends.
		const dismissAbandonedTooltip = () => {
			const tooltipOwner = displayedTooltipOwnerRef.current
			if (tooltipOwner === undefined) return
			if (containerElement.contains(tooltipOwner) && tooltipOwner.getAttribute(toolTipAttribute) === content.value) return
			hideHint()
		}

		const showTooltipAtElement = (targetElement: Element) => {
			const targetBounds = targetElement.getBoundingClientRect()
			displayHint(targetElement.getAttribute(toolTipAttribute) || '', { x: targetBounds.left + targetBounds.width / 2, top: targetBounds.top, bottom: targetBounds.bottom }, targetElement)
		}

		// Read from the document when needed rather than remembered, so it can never point at an element that lost focus or was removed: a removed element is no longer the active element or inside the container.
		const getFocusedTooltipElement = () => {
			const focusedElement = containerElement.ownerDocument.activeElement
			if (!(focusedElement instanceof Element) || !focusedElement.hasAttribute(toolTipAttribute) || !containerElement.contains(focusedElement)) return undefined
			return focusedElement
		}

		// Ends the tooltip of the element the event left, unless a copy message is still showing, and shows tooltipToShowInstead if there is one.
		const leaveTooltip = (event: Event, tooltipToShowInstead: Element | undefined) => {
			if (getHintElement(event.target, toolTipAttribute) === undefined) return

			clearTimeout(toolTipTimeoutIdRef.current ?? undefined)

			if (copyMessageTimeoutIdRef.current !== null) return

			if (tooltipToShowInstead !== undefined) {
				showTooltipAtElement(tooltipToShowInstead)
				return
			}
			hideHint()
		}

		// The pointer leaving any tooltip falls back to the tooltip of the element with keyboard focus, so mouse movement does not hide the explanation a keyboard user opened.
		const mouseout = (event: MouseEvent) => {
			dismissAbandonedTooltip()
			leaveTooltip(event, getFocusedTooltipElement())
		}
		const focusout = (event: FocusEvent) => {
			dismissAbandonedTooltip()
			leaveTooltip(event, undefined)
		}

		const click = (event: MouseEvent) => {
			dismissAbandonedTooltip()
			const targetElement = getHintElement(event.target, copyAttribute)
			if (targetElement === undefined || !targetElement.hasAttribute(timerAttribute)) return

			clearTimeout(toolTipTimeoutIdRef.current ?? undefined)

			const delayValue = targetElement.getAttribute(timerAttribute)
			if (delayValue === null) return

			clearTimeout(copyMessageTimeoutIdRef.current ?? undefined)
			copyMessageTimeoutIdRef.current = null

			displayHint(targetElement.getAttribute(copyAttribute) || '', pointAnchor(event.clientX, event.clientY), undefined)

			copyMessageTimeoutIdRef.current = setTimeout(() => {
				hideHint()
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
			displayHint(detail.content, pointAnchor(detail.x, detail.y), undefined)
			copyMessageTimeoutIdRef.current = setTimeout(() => {
				hideHint()
				copyMessageTimeoutIdRef.current = null
			}, detail.delay)
		}

		const mouseover = (event: MouseEvent) => {
			dismissAbandonedTooltip()
			const targetElement = getHintElement(event.target, toolTipAttribute) ?? getHintElement(event.target, timerAttribute)
			if (targetElement === undefined) return
			clearTimeout(toolTipTimeoutIdRef.current ?? undefined)
			const tooltipContent = targetElement.getAttribute(toolTipAttribute) || ''
			toolTipTimeoutIdRef.current = setTimeout(() => {
				// An element removed while its tooltip was pending fires no mouseout, so its tooltip must not appear afterwards, also when Preact reused its node for content without that tooltip (the same check as dismissAbandonedTooltip).
				if (!containerElement.contains(targetElement) || (targetElement.getAttribute(toolTipAttribute) || '') !== tooltipContent) return
				// Cancelled only once the tooltip replaces a copy message, so a copy message the pointer merely passes over still ends on its own timer.
				cancelPendingHintTimeouts()
				displayHint(tooltipContent, pointAnchor(event.clientX, event.clientY), targetElement)
			}, 250)
		}

		// Only a focused element that carries the tooltip itself shows it, so focusable controls nested inside a tooltip wrapper such as CopyToClipboard keep their current behavior.
		const focusin = (event: FocusEvent) => {
			dismissAbandonedTooltip()
			const targetElement = event.target
			if (!(targetElement instanceof Element) || !targetElement.hasAttribute(toolTipAttribute) || !containerElement.contains(targetElement)) return
			cancelPendingHintTimeouts()
			showTooltipAtElement(targetElement)
		}

		containerElement.addEventListener('click', click)
		containerElement.addEventListener('mouseover', mouseover)
		containerElement.addEventListener('mouseout', mouseout)
		containerElement.addEventListener('focusin', focusin)
		containerElement.addEventListener('focusout', focusout)
		containerElement.addEventListener(showHintEventName, show)

		return () => {
			cancelPendingHintTimeouts()
			containerElement.removeEventListener('click', click)
			containerElement.removeEventListener('mouseover', mouseover)
			containerElement.removeEventListener('mouseout', mouseout)
			containerElement.removeEventListener('focusin', focusin)
			containerElement.removeEventListener('focusout', focusout)
			containerElement.removeEventListener(showHintEventName, show)
		}
	}, [copyAttribute, toolTipAttribute])

	const hint = content.value && anchor.value && (
		// Keyed by content because a shown Hint measures itself as soon as its anchor changes, before Preact renders the new text, so reusing it would place new text by the size of the previous one; a fresh Hint is measured after its text renders.
		<Hint
			key = { content.value }
			content = { content }
			template = { props.template }
			anchor = { anchor }
		/>
	)

	if (props.inline === true) return <span ref = { setContainerElement } style = 'display: contents;'>{ hint }{ props.children }</span>
	return (
		<div ref = { setContainerElement } style = 'position: relative; overflow-x: hidden;'>
			{ hint }
			{ props.children }
		</div>
	)
}

interface HintProps {
	content: Signal<string>
	template?: (content: string) => ComponentChildren
	anchor: Signal<HintAnchor | undefined>
}

type Size = { width: number, height: number }

// Centers the hint on its anchor horizontally and places it below the anchor, or above it when only the space above fits it, then keeps it within the border padding of the viewport so it stays visible even when neither side fits.
export function calculateHintPosition(anchor: HintAnchor, hintSize: Size, viewportSize: Size) {
	const positionX = anchor.x - hintSize.width / 2
	const lowestTop = viewportSize.height - viewportBorderPadding - hintSize.height
	const topBelowAnchor = anchor.bottom + hintAnchorGap
	const topAboveAnchor = anchor.top - hintAnchorGap - hintSize.height
	const preferredTop = topBelowAnchor > lowestTop && topAboveAnchor >= viewportBorderPadding ? topAboveAnchor : topBelowAnchor

	return {
		left: positionX + hintSize.width > viewportSize.width - viewportBorderPadding ? viewportSize.width - viewportBorderPadding - hintSize.width : (positionX < viewportBorderPadding ? viewportBorderPadding : positionX),
		top: Math.max(viewportBorderPadding, Math.min(preferredTop, lowestTop)),
	}
}

function Hint(props: HintProps) {
	const popoverElementRef = useRef<HTMLSpanElement>(null)
	const hintElementRef = useRef<HTMLSpanElement>(null)
	const dialogPosition = useSignal({ left: -1000, top: -1000 })

	// A manual popover in the top layer, so neither a transformed or filtered ancestor, which would become the containing block of a fixed element, nor a modal dialog can misplace or cover a Hint rendered inside a card. It opens before the effect below measures it, because a closed popover is not rendered.
	useEffect(() => { popoverElementRef.current?.showPopover() }, [])

	useSignalEffect(() => {
		const anchor = props.anchor.value
		if (anchor === undefined || hintElementRef.current === null) return
		const { width, height } = hintElementRef.current.getBoundingClientRect()
		dialogPosition.value = calculateHintPosition(anchor, { width, height }, { width: globalThis.innerWidth, height: globalThis.innerHeight })
	})

	// A span, so the hint is valid inside the phrasing content an inline Hint wraps; being positioned, it is laid out as a block either way.
	return (
		<span ref = { popoverElementRef } class = 'preact-hint' popover = 'manual' style = { { ...dialogPosition.value, maxWidth: hintMaxWidth } }>
			<span class = 'preact-hint__content' ref = { hintElementRef }>
				{ props.template ? props.template(props.content.value) : props.content.value }
			</span>
		</span>
	)
}
