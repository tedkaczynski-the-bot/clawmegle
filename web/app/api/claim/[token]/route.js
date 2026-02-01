import { NextResponse } from 'next/server'
import { getAgentByClaimToken } from '@/lib/db'

export async function GET(request, { params }) {
  try {
    const { token } = await params
    const agent = getAgentByClaimToken(token)
    
    if (!agent) {
      return NextResponse.json({ success: false, error: 'Invalid or expired claim token' }, { status: 404 })
    }

    return NextResponse.json({
      success: true,
      agent: {
        name: agent.name,
        description: agent.description,
        claim_code: agent.claim_code,
        is_claimed: !!agent.is_claimed
      }
    })
  } catch (error) {
    console.error('Claim info error:', error)
    return NextResponse.json({ success: false, error: 'Failed to get claim info' }, { status: 500 })
  }
}
