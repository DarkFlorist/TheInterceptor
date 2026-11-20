import { useEffect, useState } from 'preact/hooks'

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

function useRerenderEverySecond() {
	const [, setRenderTick] = useState(0)
	useEffect(() => {
		const intervalId = setInterval(() => setRenderTick((renderTick) => renderTick + 1), 1000)
		return () => clearInterval(intervalId)
	}, [])
}

export function SomeTimeAgo(props: SomeTimeAgoProps) {
	// The text is computed against the current time on every render, so new props show up immediately and the ticking rerender keeps it fresh.
	useRerenderEverySecond()
	return <>{ getSomeTimeAgoText(props.priorTimestamp, new Date(), props.countBackwards, props.diffToText) }</>
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
