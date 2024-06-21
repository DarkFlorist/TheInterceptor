import { ComponentChildren, createContext } from "preact"
import { useContext } from "preact/hooks"

const RadioContext = createContext<{ name: string }>({ name: Date.now().toString() })

type RadioProps = {
  label: string
  value: string
  checked?: boolean
}

export const Radio = ({ label, value, checked }: RadioProps) => {
  const context = useContext(RadioContext)
  return (
    <label style='cursor:pointer'>
      <input type='radio' name={ context.name } value={ value } defaultChecked={ checked } />
      <span>{ label }</span>
    </label>
  )
}

type RadioGroupProps = {
  children: ComponentChildren
  name: string
  onSelect: (value: string) => void
}

export const RadioGroup = ({ children, name, onSelect }: RadioGroupProps) => {
  const toggleValue = (event: Event) => {
    if (!(event.target instanceof HTMLInputElement)) return
    onSelect(event.target.value)
  }

  return (
    <RadioContext.Provider value={ { name } }>
      <fieldset class='radio-group' onChange={ toggleValue }>{ children }</fieldset>
    </RadioContext.Provider>
  )
}

