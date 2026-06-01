export function getCurrentTimestampString(
	currentDate: Date = new Date(),
): string {
	const hours = currentDate.getHours().toString().padStart(2, '0')
	const minutes = currentDate.getMinutes().toString().padStart(2, '0')
	const seconds = currentDate.getSeconds().toString().padStart(2, '0')
	return `[${hours}:${minutes}:${seconds}]`
}
