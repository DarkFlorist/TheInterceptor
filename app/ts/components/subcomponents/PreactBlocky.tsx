import { DataURLCache } from './DataURLCache.js'
import { JSX } from 'preact/jsx-runtime'
import { addressString } from '../../utils/bigint.js'
import { useAsyncState } from '../../utils/preact-utilities.js'
import { Signal, useSignalEffect } from '@preact/signals'
import { Future } from '../../utils/future.js'
const dataURLCache = new DataURLCache()

interface BlockieProps {
	address: Signal<bigint>,
	scale?: Signal<number>,
	style?: JSX.CSSProperties
}

function generateIdenticon(address: bigint, scale: number, canvasRef: HTMLCanvasElement) {
	// NOTE -- Majority of this code is referenced from: https://github.com/alexvandesande/blockies
	// Mostly to ensure congruence to Ethereum Mist's Identicons

	// The random number is a js implementation of the Xorshift PRNG
	const randseed: number[] = new Array(4) // Xorshift: [x, y, z, w] 32 bit values

	function seedrand(seed: string) {
		for (let i = 0; i < randseed.length; i++) {
			randseed[i] = 0
		}
		for (let i = 0; i < seed.length; i++) {
			const r = randseed[i % 4]
			if (r === undefined) throw new Error('Buffer overflow')
			randseed[i % 4] = ((r << 5) - r) + seed.charCodeAt(i)
		}
	}

	function rand() {
		// based on Java's String.hashCode(), expanded to 4 32bit values
		if (randseed[0] === undefined || randseed[1] === undefined || randseed[2] === undefined || randseed[3] === undefined) throw new Error('Buffer overflow')
		const t = randseed[0] ^ (randseed[0] << 11)

		randseed[0] = randseed[1]
		randseed[1] = randseed[2]
		randseed[2] = randseed[3]
		randseed[3] = (randseed[3] ^ (randseed[3] >> 19) ^ t ^ (t >> 8))

		return (randseed[3]>>>0) / ((1 << 31)>>>0)
	}

	function createColor() {
		// saturation is the whole color spectrum
		const h = Math.floor(rand() * 360)
		// saturation goes from 40 to 100, it avoids greyish colors
		const s = ((rand() * 60) + 40) + '%'
		// lightness can be anything from 0 to 100, but probabilities are a bell curve around 50%
		const l = ((rand()+rand()+rand()+rand()) * 25) + '%'

		const color = 'hsl(' + h + ',' + s + ',' + l + ')'
		return color
	}

	function createImageData(size: number) {
		const width = size // Only support square icons for now
		const height = size

		const dataWidth = Math.ceil(width / 2)
		const mirrorWidth = width - dataWidth

		const data = []
		for (let y = 0; y < height; y++) {
			let row = []
			for (let x = 0; x < dataWidth; x++) {
				// this makes foreground and background color to have a 43% (1/2.3) probability
				// spot color has 13% chance
				row[x] = Math.floor(rand() * 2.3)
			}
			const r = row.slice(0, mirrorWidth)
			r.reverse()
			row = row.concat(r)

			for (let i = 0; i < row.length; i++) {
				const rowAtIndex = row[i]
				if (rowAtIndex === undefined) throw new Error('row[i] was undefined')
				data.push(rowAtIndex)
			}
		}

		return data
	}

	function setCanvas(identicon: HTMLCanvasElement, imageData: number[], color: string, scale: number, bgcolor: string, spotcolor: string) {
		const width = Math.sqrt(imageData.length)
		const size = width * scale

		identicon.width = size
		identicon.style.width = `${ size }px`

		identicon.height = size
		identicon.style.height = `${ size }px`

		const cc = identicon.getContext('2d')
		cc!.fillStyle = bgcolor
		cc!.fillRect(0, 0, identicon.width, identicon.height)
		cc!.fillStyle = color

		for (let i = 0; i < imageData.length; i++) {
			// if data is 2, choose spot color, if 1 choose foreground
			cc!.fillStyle = (imageData[i] === 1) ? color : spotcolor

			// if data is 0, leave the background
			if (imageData[i]) {
				const row = Math.floor(i / width)
				const col = i % width

				cc!.fillRect(col * scale, row * scale, scale, scale)
			}
		}
	}

	const seed = addressString(address)

	seedrand(seed)

	const color = createColor()
	const bgcolor = createColor()
	const spotcolor = createColor()
	const imageData = createImageData(8)
	const canvas = setCanvas(canvasRef, imageData, color, scale, bgcolor, spotcolor)

	return canvas
}

async function renderBlockieToUrl(address: Signal<bigint>, scale: Signal<number> | undefined) {
	const key = `${ address.value }!${ scale?.value || 4 }`
	const cacheResult = dataURLCache.get(key)
	if (cacheResult !== undefined) return cacheResult
	const future = new Future<string>()
	const element = document.createElement('canvas')
	generateIdenticon(address.value, scale?.value || 4, element)
	element.toBlob((blob) => {
		if (!blob) return
		const dataUrl = URL.createObjectURL(blob)
		dataURLCache.set(dataUrl, key)
		future.resolve(dataUrl)
	})
	return await future
}

export function Blockie(props: BlockieProps) {
	const dimension = 8 * (props.scale?.value || 4)
    const { value: dataURL, waitFor } = useAsyncState<string>()
    useSignalEffect(() => {
		props.address.value
		waitFor(async () => renderBlockieToUrl(props.address, props.scale))
	})
	return <img
		src = { dataURL.value.state !== 'resolved' ? 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=' : dataURL.value.value }
		style = {
			{
				...props.style,
				width: `${ dimension }px`,
				height: `${ dimension }px`,
				minWidth: `${ dimension }px`,
				minHeight: `${ dimension }px`,
			}
		}
	/>
}
