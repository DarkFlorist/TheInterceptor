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
    const [targetBoundingRect, setTargetBoundingRect] = useState<ClientRect | null>(null)
	let copyMessageTimeoutId: NodeJS.Timeout|undefined = undefined
	let toolTipTimeoutId: NodeJS.Timeout|undefined = undefined
    const onRefChange = useCallback( (node: HTMLDivElement | null) => {
		setContainerElement(node)
		if (containerElement) {
			const hide = (e: Event) => {
				if (!(e.target instanceof Element) || !e.target.hasAttribute(toolTipAttribute)) return
				if ( toolTipTimeoutId !== undefined) clearTimeout(toolTipTimeoutId)
				if ( copyMessageTimeoutId !== undefined) return
				setContent('')
				setTargetBoundingRect(null)
			}

			const click = (e: Event) => {
				if ( !(e.target instanceof Element) || !e.target.hasAttribute(copyAttribute) || !e.target.hasAttribute(timerAttribute) ) return
				if ( toolTipTimeoutId !== undefined) clearTimeout(toolTipTimeoutId)
				const delay = e.target.getAttribute(timerAttribute)
				if ( delay === null ) return
				clearTimeout(copyMessageTimeoutId)

				// show on click
				setContent(e.target.getAttribute(copyAttribute) || '')
				setTargetBoundingRect(e.target.getBoundingClientRect())

				copyMessageTimeoutId = setTimeout( () => {
					// hide after timeout
					setContent('')
					setTargetBoundingRect(null)
					copyMessageTimeoutId = undefined
				}, parseInt(delay))
			}
			const mouseover = (e: Event) => {
				if ( !(e.target instanceof Element) || (!e.target.hasAttribute(toolTipAttribute) && !e.target.hasAttribute(timerAttribute)) ) return
				if ( copyMessageTimeoutId !== undefined ) return

				// show on tooltip on mouseover
				const content = e.target.getAttribute(toolTipAttribute)
				const bound = e.target.getBoundingClientRect()
				toolTipTimeoutId = setTimeout( () => {
					setContent(content || '')
					setTargetBoundingRect(bound)
					toolTipTimeoutId = undefined
				}, 500)
			}

			containerElement.addEventListener('click', click)
			containerElement.addEventListener('mouseover', mouseover)
			containerElement.addEventListener('mouseout', hide)
			containerElement.addEventListener('focusout', hide)
		}
    }, [containerElement])

    return (
        <div ref = { onRefChange } style = 'position: relative; overflow-x: hidden;'>
            { content && containerElement && targetBoundingRect && (
                <Hint
                    content = { content }
                    template = { props.template }
                    rootBoundingRect = { containerElement.getBoundingClientRect() }
                    targetBoundingRect = { targetBoundingRect }
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
    targetBoundingRect: ClientRect
}

function calculatePosition(props: HintProps, hintWidth: number) {
	const positionX = props.targetBoundingRect.left - props.rootBoundingRect.left - hintWidth / 2 + props.targetBoundingRect.width / 2
	const positionY = props.rootBoundingRect.height - props.targetBoundingRect.top + props.rootBoundingRect.top + 2
	const borderPadding = 30

	return {
		left: positionX + hintWidth > window.innerWidth - borderPadding ? window.innerWidth - borderPadding - hintWidth : (positionX < borderPadding ? borderPadding : positionX),
		bottom: positionY,
	}
}

function Hint(props: HintProps) {
    const hint = useRef<HTMLSpanElement>(null)
    // Render way off-screen to prevent rubber banding from initial (and unavoidable) render.
    const [hintWidth, setHintWidth] = useState(10000)

    useEffect( () => {
        if (hint.current === null) return
        setHintWidth(hint.current.getBoundingClientRect().width)
    }, [hint] )

    return (
        <div class = 'preact-hint' style = { calculatePosition(props, hintWidth) }>
            <span class = 'preact-hint__content' ref = { hint }>
                { props.template ? props.template(props.content) : props.content }
            </span>
        </div>
    )
}
