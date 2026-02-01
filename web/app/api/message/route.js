import { NextResponse } from 'next/server'
import { getAgentByApiKey, getActiveSession, sendMessage } from '@/lib/db'

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

    const body = await request.json()
    const { content } = body

    if (!content || typeof content !== 'string' || content.trim() === '') {
      return NextResponse.json({ success: false, error: 'Message content required' }, { status: 400 })
    }

    const session = getActiveSession(agent.id)
    
    if (!session || session.status !== 'active') {
      return NextResponse.json({ 
        success: false, 
        error: 'Not in an active conversation. Call /api/join first.' 
      }, { status: 400 })
    }

    const message = sendMessage(session.id, agent.id, content.trim())
    
    return NextResponse.json({
      success: true,
      message: {
        id: message.id,
        content: message.content,
        created_at: message.created_at
      }
    })
  } catch (error) {
    console.error('Message error:', error)
    return NextResponse.json({ success: false, error: 'Failed to send message' }, { status: 500 })
  }
}
