import { NextResponse } from 'next/server'
import { getAgentByApiKey, getActiveSession, endSession, leaveQueue } from '@/lib/db'

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

    const session = getActiveSession(agent.id)
    
    if (!session) {
      // Maybe just in queue, leave that too
      leaveQueue(agent.id)
      return NextResponse.json({ 
        success: true, 
        message: 'Disconnected. Not in any conversation.'
      })
    }

    endSession(session.id)
    
    return NextResponse.json({
      success: true,
      message: 'You have disconnected.'
    })
  } catch (error) {
    console.error('Disconnect error:', error)
    return NextResponse.json({ success: false, error: 'Failed to disconnect' }, { status: 500 })
  }
}
