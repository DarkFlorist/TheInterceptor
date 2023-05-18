import { useEffect, useState } from 'preact/hooks'
import { DataURLCache } from './DataURLCache.js'
import { JSX } from 'preact/jsx-runtime'
import { addressString } from '../../utils/bigint.js'
const dataURLCache = new DataURLCache()

interface BlockieProps {
	address: bigint,
	scale?: number,
	color?: string,
	borderRadius?: string,
	style?: JSX.CSSProperties
}

function generateIdenticon(options: BlockieProps, canvasRef: HTMLCanvasElement) {
	// NOTE -- Majority of this code is referenced from: https://github.com/alexvandesande/blockies
	// Mostly to ensure congruence to Ethereum Mist's Identicons

	// The random number is a js implementation of the Xorshift PRNG
	const randseed = new Array(4) // Xorshift: [x, y, z, w] 32 bit values

	function seedrand(seed: string) {
		for (let i = 0; i < randseed.length; i++) {
			randseed[i] = 0
		}
		for (let i = 0; i < seed.length; i++) {
			randseed[i % 4] = ((randseed[i % 4] << 5) - randseed[i % 4]) + seed.charCodeAt(i)
		}
	}

	function rand() {
		// based on Java's String.hashCode(), expanded to 4 32bit values
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
				data.push(row[i])
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

	const opts = options || {}
	const scale = opts.scale || 4
	const seed = addressString(opts.address)

	seedrand(seed)

	const color = opts.color || createColor()
	const bgcolor = createColor()
	const spotcolor = createColor()
	const imageData = createImageData(8)
	const canvas = setCanvas(canvasRef, imageData, color, scale, bgcolor, spotcolor)

	return canvas
}

export default function Blockie(props: BlockieProps) {
	const scale = props.scale || 4
	const dimension = 8 * scale
	const [address, setAddress] = useState<bigint | undefined>(props.address)
	const [dataURL, setDataURL] = useState<string | undefined>(dataURLCache.get(`${ props.address }!${ dimension }`))

	useEffect(() => {
		if (dataURL === undefined || address !== props.address) {
			setAddress(props.address)
			const element = document.createElement('canvas')
			generateIdenticon(props, element)
			element.toBlob((blob) => {
				if (!blob) return
				const dataUrl = URL.createObjectURL(blob)
				setDataURL(dataUrl)
				dataURLCache.set(dataUrl, `${ props.address }!${ dimension }`)
			})
		}
	}, [props.address])
	return <img
		src = { dataURL === undefined ? 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=' : dataURL}
		style = {
			{
				...props.style,
				width: `${ dimension }px`,
				height: `${ dimension }px`,
				minWidth: `${ dimension }px`,
				minHeight: `${ dimension }px`,
				borderRadius: props.borderRadius ? props.borderRadius : '0%',
			}
		}
	/>
}
