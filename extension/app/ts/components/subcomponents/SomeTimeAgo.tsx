import { useEffect, useState } from 'preact/hooks'

export interface SomeTimeAgoProps {
	priorTimestamp: Date,
}

export function SomeTimeAgo( props: SomeTimeAgoProps ): preact.VNode {
	const [, setNewSecondTrigger] = useState(0)
	useEffect(() => {
		const id = setInterval(() => setNewSecondTrigger(( old ) => old + 1), 1000)
		return () => clearInterval(id)
	}, [])
	return <>{ humanReadableDateDelta(new Date().getTime(), props.priorTimestamp.getTime()) }</>
}

function humanReadableDateDelta( currentDateMs: number, pastDateMs: number ) {
	const secondsDiff = (currentDateMs - pastDateMs) / 1000
	if (secondsDiff > 3600 * 1.5) {
		return `${ Math.floor((secondsDiff + 1800) / 3600) }h`
	} else if (secondsDiff > 60 * 1.5) {
		return `${ Math.floor((secondsDiff + 30) / 60) }m`
	} else {
		return `${ Math.floor(secondsDiff + 0.5) }s`
	}
}
