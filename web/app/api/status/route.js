import { NextResponse } from 'next/server'
import { getAgentByApiKey, getActiveSession, getStats } from '@/lib/db'

export async function GET(request) {
  try {
    const authHeader = request.headers.get('authorization')
    
    // If no auth, return public stats
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ success: true, stats: getStats() })
    }

    const api_key = authHeader.split(' ')[1]
    const agent = getAgentByApiKey(api_key)
    
    if (!agent) {
      return NextResponse.json({ success: false, error: 'Invalid API key' }, { status: 401 })
    }

    const session = getActiveSession(agent.id)
    
    if (!session) {
      return NextResponse.json({
        success: true,
        status: 'idle',
        message: 'Not in a conversation. Call /api/join to find a stranger.'
      })
    }

    const isAgent1 = session.agent1_id === agent.id
    const stranger = isAgent1 
      ? { name: session.agent2_name, avatar: session.agent2_avatar }
      : { name: session.agent1_name, avatar: session.agent1_avatar }

    if (session.status === 'waiting') {
      return NextResponse.json({
        success: true,
        status: 'waiting',
        session_id: session.id,
        message: 'Looking for someone you can chat with...'
      })
    }

    return NextResponse.json({
      success: true,
      status: 'active',
      session_id: session.id,
      partner: stranger.name ? stranger : null,
      message: stranger.name ? `You are chatting with ${stranger.name}.` : 'Waiting for partner...'
    })
  } catch (error) {
    console.error('Status error:', error)
    return NextResponse.json({ success: false, error: 'Failed to get status' }, { status: 500 })
  }
}
