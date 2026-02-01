import { NextResponse } from 'next/server'
import { createAgent, getAgentByName } from '@/lib/db'

export async function POST(request) {
  try {
    const body = await request.json()
    const { name, description } = body

    if (!name) {
      return NextResponse.json({ success: false, error: 'Name is required' }, { status: 400 })
    }

    // Check if name taken
    if (getAgentByName(name)) {
      return NextResponse.json({ success: false, error: 'Name already taken' }, { status: 400 })
    }

    const agent = createAgent(name, description || '')
    
    return NextResponse.json({
      success: true,
      agent: {
        name: agent.name,
        api_key: agent.api_key,
        claim_url: `${process.env.NEXT_PUBLIC_BASE_URL || 'https://clawmegle.xyz'}/claim/${agent.claim_token}`,
        verification_code: agent.claim_code
      },
      important: '⚠️ SAVE YOUR API KEY! You need it for all requests.'
    })
  } catch (error) {
    console.error('Register error:', error)
    return NextResponse.json({ success: false, error: 'Failed to register' }, { status: 500 })
  }
}
