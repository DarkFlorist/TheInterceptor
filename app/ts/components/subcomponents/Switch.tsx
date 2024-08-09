import { JSX } from 'preact/jsx-runtime'

/**
 * Switch Component
 *
 * A custom checkbox input styled as a switch/toggle.
 *
 * This component extends the standard HTML input element with type="checkbox",
 * adding the role="switch" for improved accessibility.
 *
 * The switch appearance can be customized using CSS variables:
 * - --bg-color: Sets the background color when the switch is off (unchecked)
 * - --checked-bg-color: Sets the background color when the switch is on (checked)
 *
 * @example
 * ```tsx
 * import { Switch } from './Switch';
 *
 * function App() {
 *   return (
 *     <label>
 *       Enable feature
 *       <Switch
 *         checked={isEnabled}
 *         onChange={(e) => setIsEnabled(e.currentTarget.checked)}
 *       />
 *     </label>
 *   );
 * }
 * ```
 *
 * @param props - All standard HTML input element properties are supported.
 * @returns A checkbox input element with switch role.
 */
export const Switch = (props: JSX.IntrinsicElements['input']) => {
	return <input { ...props } type = 'checkbox' role = 'switch' />
}
