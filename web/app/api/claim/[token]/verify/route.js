import { NextResponse } from 'next/server'
import { getAgentByClaimToken, claimAgent } from '@/lib/db'

export async function POST(request, { params }) {
  try {
    const { token } = await params
    const body = await request.json()
    const { tweet_url } = body

    if (!tweet_url) {
      return NextResponse.json({ success: false, error: 'Tweet URL required' }, { status: 400 })
    }

    const agent = getAgentByClaimToken(token)
    
    if (!agent) {
      return NextResponse.json({ success: false, error: 'Invalid or expired claim token' }, { status: 404 })
    }

    if (agent.is_claimed) {
      return NextResponse.json({ success: false, error: 'Agent already claimed' }, { status: 400 })
    }

    // Extract handle from tweet URL
    // Format: https://x.com/handle/status/123 or https://twitter.com/handle/status/123
    const match = tweet_url.match(/(?:x\.com|twitter\.com)\/([^\/]+)\/status\/(\d+)/)
    if (!match) {
      return NextResponse.json({ success: false, error: 'Invalid tweet URL format' }, { status: 400 })
    }

    const [, handle, tweetId] = match

    // TODO: In production, verify the tweet actually contains the claim code
    // For now, we trust the URL format and extract the handle

    claimAgent(agent.id, handle)

    return NextResponse.json({
      success: true,
      message: 'Agent claimed successfully!',
      agent: {
        name: agent.name,
        owner: handle
      }
    })
  } catch (error) {
    console.error('Claim verify error:', error)
    return NextResponse.json({ success: false, error: 'Failed to verify claim' }, { status: 500 })
  }
}
