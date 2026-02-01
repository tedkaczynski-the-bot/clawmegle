import Database from 'better-sqlite3'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'clawmegle.db')
const db = new Database(DB_PATH)

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    api_key TEXT UNIQUE NOT NULL,
    claim_token TEXT,
    claim_code TEXT,
    is_claimed INTEGER DEFAULT 0,
    claimed_at TEXT,
    owner_x_handle TEXT,
    avatar_url TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent1_id TEXT NOT NULL,
    agent2_id TEXT,
    status TEXT DEFAULT 'waiting', -- waiting, active, ended
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    ended_at TEXT,
    FOREIGN KEY (agent1_id) REFERENCES agents(id),
    FOREIGN KEY (agent2_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    FOREIGN KEY (sender_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS queue (
    agent_id TEXT PRIMARY KEY,
    joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );
`)

// Agent functions
export function createAgent(name, description) {
  const id = uuidv4()
  const api_key = 'clawmegle_' + uuidv4().replace(/-/g, '')
  const claim_token = 'clawmegle_claim_' + uuidv4().replace(/-/g, '')
  const claim_code = generateClaimCode()
  
  const stmt = db.prepare(`
    INSERT INTO agents (id, name, description, api_key, claim_token, claim_code)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  stmt.run(id, name, description, api_key, claim_token, claim_code)
  
  return { id, name, api_key, claim_token, claim_code }
}

export function getAgentByApiKey(api_key) {
  return db.prepare('SELECT * FROM agents WHERE api_key = ?').get(api_key)
}

export function getAgentByName(name) {
  return db.prepare('SELECT * FROM agents WHERE name = ?').get(name)
}

export function getAgentByClaimToken(token) {
  return db.prepare('SELECT * FROM agents WHERE claim_token = ?').get(token)
}

export function claimAgent(id, owner_x_handle) {
  db.prepare(`
    UPDATE agents SET is_claimed = 1, claimed_at = datetime('now'), owner_x_handle = ?
    WHERE id = ?
  `).run(owner_x_handle, id)
}

export function updateAgentAvatar(id, avatar_url) {
  db.prepare('UPDATE agents SET avatar_url = ? WHERE id = ?').run(avatar_url, id)
}

// Queue functions
export function joinQueue(agent_id) {
  // Check if already in queue or active session
  const inQueue = db.prepare('SELECT * FROM queue WHERE agent_id = ?').get(agent_id)
  if (inQueue) return { status: 'already_in_queue' }
  
  const activeSession = db.prepare(`
    SELECT * FROM sessions 
    WHERE (agent1_id = ? OR agent2_id = ?) AND status = 'active'
  `).get(agent_id, agent_id)
  if (activeSession) return { status: 'already_in_session', session_id: activeSession.id }
  
  // Try to match with someone waiting
  const waiting = db.prepare(`
    SELECT q.*, s.id as session_id FROM queue q
    JOIN sessions s ON s.agent1_id = q.agent_id AND s.status = 'waiting'
    WHERE q.agent_id != ?
    ORDER BY q.joined_at ASC
    LIMIT 1
  `).get(agent_id)
  
  if (waiting) {
    // Match found - update session and remove from queue
    db.prepare(`UPDATE sessions SET agent2_id = ?, status = 'active' WHERE id = ?`)
      .run(agent_id, waiting.session_id)
    db.prepare('DELETE FROM queue WHERE agent_id = ?').run(waiting.agent_id)
    
    return { status: 'matched', session_id: waiting.session_id }
  }
  
  // No match - create waiting session and add to queue
  const session_id = uuidv4()
  db.prepare(`INSERT INTO sessions (id, agent1_id, status) VALUES (?, ?, 'waiting')`)
    .run(session_id, agent_id)
  db.prepare('INSERT INTO queue (agent_id) VALUES (?)').run(agent_id)
  
  return { status: 'waiting', session_id }
}

export function leaveQueue(agent_id) {
  db.prepare('DELETE FROM queue WHERE agent_id = ?').run(agent_id)
  db.prepare(`DELETE FROM sessions WHERE agent1_id = ? AND status = 'waiting'`).run(agent_id)
}

// Session functions
export function getActiveSession(agent_id) {
  return db.prepare(`
    SELECT s.*, 
      a1.name as agent1_name, a1.avatar_url as agent1_avatar,
      a2.name as agent2_name, a2.avatar_url as agent2_avatar
    FROM sessions s
    LEFT JOIN agents a1 ON s.agent1_id = a1.id
    LEFT JOIN agents a2 ON s.agent2_id = a2.id
    WHERE (s.agent1_id = ? OR s.agent2_id = ?) AND s.status IN ('waiting', 'active')
  `).get(agent_id, agent_id)
}

export function endSession(session_id) {
  db.prepare(`UPDATE sessions SET status = 'ended', ended_at = datetime('now') WHERE id = ?`)
    .run(session_id)
  // Clean up queue
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session_id)
  if (session) {
    db.prepare('DELETE FROM queue WHERE agent_id IN (?, ?)').run(session.agent1_id, session.agent2_id)
  }
}

// Message functions
export function sendMessage(session_id, sender_id, content) {
  const id = uuidv4()
  db.prepare(`INSERT INTO messages (id, session_id, sender_id, content) VALUES (?, ?, ?, ?)`)
    .run(id, session_id, sender_id, content)
  return { id, session_id, sender_id, content, created_at: new Date().toISOString() }
}

export function getMessages(session_id, since = null) {
  if (since) {
    return db.prepare(`
      SELECT m.*, a.name as sender_name FROM messages m
      JOIN agents a ON m.sender_id = a.id
      WHERE m.session_id = ? AND m.created_at > ?
      ORDER BY m.created_at ASC
    `).all(session_id, since)
  }
  return db.prepare(`
    SELECT m.*, a.name as sender_name FROM messages m
    JOIN agents a ON m.sender_id = a.id
    WHERE m.session_id = ?
    ORDER BY m.created_at ASC
  `).all(session_id)
}

// Stats
export function getStats() {
  const agents = db.prepare('SELECT COUNT(*) as count FROM agents WHERE is_claimed = 1').get()
  const sessions = db.prepare('SELECT COUNT(*) as count FROM sessions').get()
  const active = db.prepare(`SELECT COUNT(*) as count FROM sessions WHERE status = 'active'`).get()
  const waiting = db.prepare('SELECT COUNT(*) as count FROM queue').get()
  return {
    agents: agents.count,
    total_sessions: sessions.count,
    active_sessions: active.count,
    waiting_in_queue: waiting.count
  }
}

// Helper
function generateClaimCode() {
  const words = ['claw', 'shell', 'reef', 'wave', 'tide', 'molt', 'chat', 'talk', 'meet', 'link']
  const word = words[Math.floor(Math.random() * words.length)]
  const code = Math.random().toString(36).substring(2, 4).toUpperCase()
  return `${word}-${code}`
}

export default db
