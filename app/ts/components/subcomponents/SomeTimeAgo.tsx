import { useEffect } from 'preact/hooks'
import { useComputed, useSignal } from '@preact/signals'

interface SomeTimeAgoProps {
	priorTimestamp: Date,
	countBackwards?: boolean,
	diffToText?: (secondsDiff: number) => string
}

export function SomeTimeAgo(props: SomeTimeAgoProps) {
	const getTimeDiff = () => (props.priorTimestamp.getTime() - new Date().getTime()) / 1000
	const timeDiff = useSignal(getTimeDiff())
	const diffTotext = props.diffToText !== undefined ? props.diffToText : humanReadableDateDelta
	const humanReadableTimeDiff = useComputed(() => diffTotext(props.countBackwards ? timeDiff.value : -timeDiff.value))
	useEffect(() => {
		const id = setInterval(() => timeDiff.value = getTimeDiff(), 1000)
		return () => clearInterval(id)
	})
	useEffect(() => { timeDiff.value = getTimeDiff() }, [props.priorTimestamp])
	return <>{ humanReadableTimeDiff }</>
}

function humanReadableDateDelta(secondsDiff: number) {
	if (secondsDiff <= 0) return '0s'
	if (secondsDiff > 3600 * 24 * 1.5) return `${ Math.floor((secondsDiff + 1800) / 3600 / 24) }d`
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
