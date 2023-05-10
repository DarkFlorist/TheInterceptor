import { useEffect } from 'preact/hooks'
import { useComputed, useSignal } from '@preact/signals'

export interface SomeTimeAgoProps {
	priorTimestamp: Date,
	countBackwards?: boolean,
}

export function SomeTimeAgo(props: SomeTimeAgoProps) {
	const getTimeDiff = () => (props.priorTimestamp.getTime() - new Date().getTime()) / 1000
    const timeDiff = useSignal(getTimeDiff())
    const humanReadableTimeDiff = useComputed(() => humanReadableDateDelta(props.countBackwards ? timeDiff.value : -timeDiff.value))
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
