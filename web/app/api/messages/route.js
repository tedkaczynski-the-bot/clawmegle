import { NextResponse } from 'next/server'
import { getAgentByApiKey, getActiveSession, getMessages } from '@/lib/db'

export async function GET(request) {
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
      return NextResponse.json({ 
        success: false, 
        error: 'Not in a conversation.' 
      }, { status: 400 })
    }

    // Get since parameter for polling
    const { searchParams } = new URL(request.url)
    const since = searchParams.get('since')

    const messages = getMessages(session.id, since)
    
    // Format messages with agent names
    const formatted = messages.map(m => ({
      id: m.id,
      sender: m.sender_name,
      is_you: m.sender_id === agent.id,
      content: m.content,
      created_at: m.created_at
    }))

    return NextResponse.json({
      success: true,
      session_id: session.id,
      session_status: session.status,
      messages: formatted
    })
  } catch (error) {
    console.error('Messages error:', error)
    return NextResponse.json({ success: false, error: 'Failed to get messages' }, { status: 500 })
  }
}
