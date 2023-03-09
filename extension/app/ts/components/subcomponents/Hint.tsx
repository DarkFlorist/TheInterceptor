import type { ComponentChild, ComponentChildren } from 'preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

interface Props {
	children: ComponentChild | ComponentChild[]
	attribute?: string
	template?: (content: string) => ComponentChildren
}

const timerAttribute = 'data-hint-clickable-hide-timer-ms'

export default function Container(props: Props) {
	const copyAttribute = props.attribute || 'data-hint'
	const toolTipAttribute = props.attribute || 'data-tooltip'
	const [content, setContent] = useState<string>('')
	const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(null)
	const [clickPosition, setClickPosition] = useState<{ x: number, y: number } | null>(null)
	let copyMessageTimeoutId: NodeJS.Timeout | undefined = undefined
	let toolTipTimeoutId: NodeJS.Timeout | undefined = undefined
	const onRefChange = useCallback( (containerElement: HTMLDivElement | null) => {
		setContainerElement(containerElement)
		if (containerElement) {
			const hide = (e: Event) => {
				if (!(e.target instanceof Element) || !e.target.hasAttribute(toolTipAttribute)) return
				clearTimeout(toolTipTimeoutId)
				if (copyMessageTimeoutId !== undefined) return
				setContent('')
				setClickPosition(null)
			}

			const click = (e: MouseEvent) => {
				if (!(e.target instanceof Element) || !e.target.hasAttribute(copyAttribute) || !e.target.hasAttribute(timerAttribute)) return
				clearTimeout(toolTipTimeoutId)
				const delay = e.target.getAttribute(timerAttribute)
				if (delay === null) return
				clearTimeout(copyMessageTimeoutId)
				copyMessageTimeoutId = undefined

				// show on click
				setContent(e.target.getAttribute(copyAttribute) || '')
				setClickPosition({ x: e.pageX, y: e.pageY })

				copyMessageTimeoutId = setTimeout( () => {
					// hide after timeout
					setContent('')
					setClickPosition(null)
					copyMessageTimeoutId = undefined
				}, parseInt(delay))
			}
			const mouseover = (e: MouseEvent) => {
				if (!(e.target instanceof Element) || (!e.target.hasAttribute(toolTipAttribute) && !e.target.hasAttribute(timerAttribute))) return
				clearTimeout(toolTipTimeoutId)

				// show on tooltip on mouseover
				const content = e.target.getAttribute(toolTipAttribute)
				toolTipTimeoutId = setTimeout( () => {
					setContent(content || '')
					setClickPosition({ x: e.pageX, y: e.pageY })
				}, 250)
			}

			containerElement.addEventListener('click', click)
			containerElement.addEventListener('mouseover', mouseover)
			containerElement.addEventListener('mouseout', hide)
			containerElement.addEventListener('focusout', hide)
		}
	}, [containerElement])

	return (
		<div ref = { onRefChange } style = 'position: relative; overflow-x: hidden;'>
			{ content && containerElement && clickPosition && (
				<Hint
					content = { content }
					template = { props.template }
					rootBoundingRect = { containerElement.getBoundingClientRect() }
					clickPosition = { clickPosition }
				/>
			) }
			{ props.children }
		</div>
	)
}

interface HintProps {
	content: string
	template?: (content: string) => ComponentChildren
	rootBoundingRect: ClientRect
	clickPosition: { x: number, y: number }
}

function calculatePosition(clickPosX: number, clickPosY: number, hintWidth: number) {
	const positionX = clickPosX - hintWidth / 2
	const positionY = clickPosY + 10
	const borderPadding = 30

	return {
		left: positionX + hintWidth > globalThis.innerWidth - borderPadding ? globalThis.innerWidth - borderPadding - hintWidth : (positionX < borderPadding ? borderPadding : positionX),
		top: positionY,
	}
}

function Hint(props: HintProps) {
	const hint = useRef<HTMLSpanElement>(null)
	const [dialogPosition, setDialogPosition] = useState<{ left: number, top: number }>({ left: -1000, top: -1000 })
	// Render way off-screen to prevent rubber banding from initial (and unavoidable) render.
	const [hintWidth, setHintWidth] = useState(10000)

	const clean = () => {
		setDialogPosition({ left: -1000, top: -1000 })
	}

	useEffect(() => {
		globalThis.addEventListener('resize', clean)
		return () => {
			globalThis.removeEventListener('resize', clean)
		}
	})

	useEffect(() => {
		if (hint.current === null) return
		setHintWidth(hint.current.getBoundingClientRect().width)
		setDialogPosition(calculatePosition(props.clickPosition.x, props.clickPosition.y, hintWidth))
	}, [hint, props.clickPosition, hintWidth] )

	return (
		<div class ='preact-hint' style = { dialogPosition }>
			<span class = 'preact-hint__content' ref = { hint }>
				{ props.template ? props.template(props.content) : props.content }
			</span>
		</div>
	)
}
