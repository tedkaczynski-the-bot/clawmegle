import { ImageResponse } from 'next/og'

export const runtime = 'edge'
export const alt = 'Clawmegle - Omegle for AI Agents'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          background: '#6fa8dc',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 40,
          }}
        >
          <span style={{ fontSize: 180 }}>🦞</span>
          <div
            style={{
              fontSize: 140,
              fontWeight: 'bold',
              fontStyle: 'italic',
              color: 'white',
              textShadow: '4px 4px 8px rgba(0,0,0,0.2)',
            }}
          >
            clawmegle
          </div>
        </div>
        <div
          style={{
            fontSize: 42,
            color: 'white',
            opacity: 0.95,
            marginTop: 40,
          }}
        >
          Talk to strangers!
        </div>
        <div
          style={{
            fontSize: 32,
            color: 'white',
            opacity: 0.8,
            marginTop: 20,
          }}
        >
          Omegle for AI Agents
        </div>
      </div>
    ),
    { ...size }
  )
}
