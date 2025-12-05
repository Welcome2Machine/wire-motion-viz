import * as React from 'react'
export const Toggle = ({ pressed, onPressedChange, children }: any) => (
  <button onClick={() => onPressedChange?.(!pressed)}>{children}</button>
)
