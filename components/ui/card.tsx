import * as React from 'react'

export const Card = ({ children, className = '' }: any) => (
  <div className={`rounded-lg border border-gray-200 bg-white shadow-sm ${className}`}>
    {children}
  </div>
)
export const CardContent = ({ children, className = '' }: any) => (
  <div className={className}>{children}</div>
)
