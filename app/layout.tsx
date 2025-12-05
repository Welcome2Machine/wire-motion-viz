import './globals.css'

export const metadata = {
  title: 'Wire Motion Flipbook',
  description: 'Interactive visualization for wire motion trajectories',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
