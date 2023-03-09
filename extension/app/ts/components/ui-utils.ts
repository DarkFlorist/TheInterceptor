import { ethers } from 'ethers'
import { Ref, useEffect } from 'preact/hooks'

function assertIsNode(e: EventTarget | null): asserts e is Node {
	if (!e || !('nodeType' in e)) {
        throw new Error(`Node expected`)
    }
}

export function clickOutsideAlerter(ref: Ref<HTMLDivElement>, callback: () => void) {
	useEffect(() => {
		function handleClickOutside({ target }: MouseEvent) {
			assertIsNode(target);
			if (ref.current && !ref.current.contains(target)) {
				callback()
			}
		}

		document.addEventListener('mousedown', handleClickOutside);

		return () => {
			document.removeEventListener('mousedown', handleClickOutside);
		}
	}, [ref]);
}

export function getIssueWithAddressString(address: string): string | undefined {
	if (address.length > 42) return 'Address is too long.'
	if (address.length > 2 && address.substring(0, 2) !== '0x') { return 'Address does not contain 0x prefix.' }
	if (address.length < 42) return 'Address is too short.'

    if (address.match(/^(0x)?[0-9a-fA-F]{40}$/)) {
        const checkSummedAddress = ethers.getAddress(address.toLowerCase());

        // It is a checksummed address with a bad checksum
        if (checkSummedAddress !== address && address.toLowerCase() !== address) {
            return `Bad address checksum, did you mean ${ checkSummedAddress } ?`;
        }
    } else {
        return 'Address contains invalid characters.'
    }

    return undefined;
}

export function upperCaseFirstCharacter(text: string) {
	if (text.length === 0) return text
	return text.charAt(0).toUpperCase() + text.slice(1)
}

export function convertNumberToCharacterRepresentationIfSmallEnough(num: number) {
	const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
	const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
	const teens = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];

	function convertTens(num: number) {
		if (num < 10) return ones[num];
		else if (num >= 10 && num < 20) return teens[num - 10];
		else {
			return tens[Math.floor(num / 10)] + " " + ones[num % 10];
		}
	}

	if (num == 0) return 'zero'
	if (num > 99) return num.toString()
	return convertTens(num)
}
