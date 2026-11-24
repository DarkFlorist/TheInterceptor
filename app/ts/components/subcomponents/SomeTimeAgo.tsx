import { useSignal } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'

interface SomeTimeAgoProps {
	priorTimestamp: Date,
	countBackwards?: boolean,
	diffToText?: (secondsDiff: number) => string
}

export function getSomeTimeAgoText(
	priorTimestamp: Date,
	currentTimestamp: Date,
	countBackwards = false,
	diffToText: (secondsDiff: number) => string = humanReadableDateDelta,
) {
	const timeDiff = (priorTimestamp.getTime() - currentTimestamp.getTime()) / 1000
	return diffToText(countBackwards ? timeDiff : -timeDiff)
}

function getTextForProps(props: SomeTimeAgoProps) {
	return getSomeTimeAgoText(props.priorTimestamp, new Date(), props.countBackwards, props.diffToText)
}

export function SomeTimeAgo(props: SomeTimeAgoProps) {
	const text = useSignal('')
	const latestProps = useRef(props)
	latestProps.current = props
	// Plain prop changes update immediately; interval ticks write only the rendered text signal.
	text.value = getTextForProps(props)
	useEffect(() => {
		const intervalId = setInterval(() => { text.value = getTextForProps(latestProps.current) }, 1000)
		return () => clearInterval(intervalId)
	}, [])
	return <>{ text }</>
}

function humanReadableDateDelta(secondsDiff: number) {
	if (secondsDiff <= 0) return '0s'
	if (secondsDiff > 3600 * 24 * 1.5) return `${ Math.floor(secondsDiff / (3600 * 24) + 0.5) }d`
	if (secondsDiff > 3600 * 1.5) return `${ Math.floor((secondsDiff + 1800) / 3600) }h`
	if (secondsDiff > 60 * 1.5) return `${ Math.floor((secondsDiff + 30) / 60) }m`
	return `${ Math.floor(secondsDiff + 0.5) }s`
}

export function humanReadableDateDeltaLessDetailed(secondsDiff: number) {
	if (secondsDiff <= 15) return 'just now'
	if (secondsDiff <= 45) return '30s ago'
	if (secondsDiff <= 90) return 'a minute ago'
	return `${ humanReadableDateDelta(secondsDiff) } ago`
}
