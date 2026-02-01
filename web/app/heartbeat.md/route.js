import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

export async function GET() {
  const hbPath = path.join(process.cwd(), '..', 'skill', 'HEARTBEAT.md')
  
  try {
    const content = fs.readFileSync(hbPath, 'utf8')
    return new NextResponse(content, {
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' }
    })
  } catch (error) {
    return new NextResponse('Heartbeat not found', { status: 404 })
  }
}
