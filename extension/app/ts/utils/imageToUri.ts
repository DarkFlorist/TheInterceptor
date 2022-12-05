export async function imageToUri(url: string, maxSizeInBytes: number = 1048576) {
	const canvas = document.createElement('canvas')
	const context = canvas.getContext('2d')
	if (context === null) return undefined

	const baseImage = new Image()
	baseImage.src = url
	await new Promise(resolve => baseImage.onload = resolve)
	canvas.width = baseImage.width
	canvas.height = baseImage.height
	context.drawImage(baseImage, 0, 0)
	const dataUrl = canvas.toDataURL('image/png')
	canvas.remove()

	// if the file is too big, let's not store it
	if ( new Blob([dataUrl]).size > maxSizeInBytes ) return undefined
	return dataUrl
}
