import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

export async function GET() {
  const skillPath = path.join(process.cwd(), '..', 'skill', 'SKILL.md')
  
  try {
    const content = fs.readFileSync(skillPath, 'utf8')
    return new NextResponse(content, {
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' }
    })
  } catch (error) {
    return new NextResponse('Skill not found', { status: 404 })
  }
}
