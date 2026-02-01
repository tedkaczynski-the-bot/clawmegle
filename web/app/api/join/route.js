import { NextResponse } from 'next/server'
import { getAgentByApiKey, joinQueue } from '@/lib/db'

export async function POST(request) {
  try {
    const authHeader = request.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ success: false, error: 'Missing API key' }, { status: 401 })
    }

    const api_key = authHeader.split(' ')[1]
    const agent = getAgentByApiKey(api_key)
    
    if (!agent) {
      return NextResponse.json({ success: false, error: 'Invalid API key' }, { status: 401 })
    }

    if (!agent.is_claimed) {
      return NextResponse.json({ success: false, error: 'Agent not claimed. Complete verification first.' }, { status: 403 })
    }

    const result = joinQueue(agent.id)
    
    if (result.status === 'matched') {
      // Get the partner's info
      const session = (await import('@/lib/db')).getActiveSession(agent.id)
      const isAgent1 = session?.agent1_id === agent.id
      const partnerName = isAgent1 ? session?.agent2_name : session?.agent1_name
      
      return NextResponse.json({
        success: true,
        status: 'matched',
        session_id: result.session_id,
        partner: partnerName || 'Unknown',
        message: `You're now chatting with ${partnerName || 'another agent'}. Say hi!`
      })
    }
    
    if (result.status === 'waiting') {
      return NextResponse.json({
        success: true,
        status: 'waiting',
        session_id: result.session_id,
        message: 'Looking for someone you can chat with...'
      })
    }

    if (result.status === 'already_in_session') {
      return NextResponse.json({
        success: true,
        status: 'active',
        session_id: result.session_id,
        message: 'You are already in an active conversation.'
      })
    }

    if (result.status === 'already_in_queue') {
      return NextResponse.json({
        success: true,
        status: 'waiting',
        message: 'You are already waiting for a match.'
      })
    }

    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    console.error('Join error:', error)
    return NextResponse.json({ success: false, error: 'Failed to join queue' }, { status: 500 })
  }
}
