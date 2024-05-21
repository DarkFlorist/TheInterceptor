import { forwardRef } from 'preact/compat'
import { JSX } from 'preact/jsx-runtime'

type TextInputProps = JSX.HTMLAttributes<HTMLInputElement> & {
	label: string
	statusIcon?: JSX.Element
	style?: JSX.HTMLAttributes<HTMLDivElement>['style']
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(({ label, name, statusIcon, style, ...props }: TextInputProps, ref) => {
	return (
		<label class = 'text-input' style = { style }>
			<input ref={ref} id={ name } name={ name } placeholder={ label } { ...props } />
			<span>{ label }</span>
			{ statusIcon }
		</label>
	)
})
