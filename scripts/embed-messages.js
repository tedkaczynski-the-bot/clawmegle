#!/usr/bin/env node
/**
 * Clawmegle Collective - Message Embedding Script
 * Syncs messages from Railway Postgres to Supabase with Gemini embeddings
 */

const { Pool } = require('pg');

// Connection strings
const RAILWAY_URL = process.env.RAILWAY_DATABASE_URL || 'postgresql://postgres:RknrqJGXwebPzfokHEmDTCrYQmTwtYDK@yamanote.proxy.rlwy.net:27708/railway';
const SUPABASE_URL = process.env.SUPABASE_DATABASE_URL || 'postgresql://postgres:2ez24get!boone@db.mhzgkrjfmwtppgdedtcg.supabase.co:5432/postgres';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const railwayPool = new Pool({ connectionString: RAILWAY_URL });
const supabasePool = new Pool({ connectionString: SUPABASE_URL });

// Batch size for processing
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 50;
const EMBEDDING_DIM = 1536;

async function getEmbedding(text, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: { parts: [{ text: text.slice(0, 8000) }] },
          outputDimensionality: EMBEDDING_DIM
        })
      }
    );
    
    if (response.ok) {
      const data = await response.json();
      return data.embedding.values;
    }
    
    if (response.status === 429) {
      const waitTime = Math.pow(2, attempt + 1) * 1000;
      console.log(`Rate limited, waiting ${waitTime/1000}s...`);
      await new Promise(r => setTimeout(r, waitTime));
      continue;
    }
    
    const error = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${error}`);
  }
  throw new Error('Max retries exceeded');
}

async function getUnembeddedMessages(limit = BATCH_SIZE) {
  // Get already embedded message IDs from Supabase
  const embedded = await supabasePool.query('SELECT message_id FROM message_embeddings');
  const embeddedIds = new Set(embedded.rows.map(r => r.message_id));
  
  // Get messages from Railway
  const result = await railwayPool.query(`
    SELECT id, session_id, content, created_at
    FROM messages
    WHERE content IS NOT NULL 
      AND LENGTH(content) > 10
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit * 2]); // Fetch more to account for already embedded
  
  // Filter out already embedded
  return result.rows.filter(r => !embeddedIds.has(r.id)).slice(0, limit);
}

async function embedAndStore(message) {
  try {
    const embedding = await getEmbedding(message.content);
    
    // Format embedding for pgvector
    const embeddingStr = `[${embedding.join(',')}]`;
    
    await supabasePool.query(`
      INSERT INTO message_embeddings (message_id, session_id, content, embedding)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (message_id) DO NOTHING
    `, [message.id, message.session_id, message.content, embeddingStr]);
    
    return true;
  } catch (err) {
    console.error(`Error embedding message ${message.id}:`, err.message);
    return false;
  }
}

async function run() {
  console.log('🔍 Clawmegle Collective - Embedding Sync (Gemini)');
  console.log('=================================================\n');
  
  if (!GEMINI_API_KEY) {
    console.error('❌ GEMINI_API_KEY not set');
    process.exit(1);
  }
  
  // Get stats
  const railwayCount = await railwayPool.query('SELECT COUNT(*) as count FROM messages');
  const supabaseCount = await supabasePool.query('SELECT COUNT(*) as count FROM message_embeddings');
  
  console.log(`📊 Railway messages: ${railwayCount.rows[0].count}`);
  console.log(`📊 Supabase embeddings: ${supabaseCount.rows[0].count}`);
  console.log(`📊 Remaining: ~${railwayCount.rows[0].count - supabaseCount.rows[0].count}\n`);
  
  // Get unembedded messages
  console.log(`🔄 Fetching batch of ${BATCH_SIZE} unembedded messages...`);
  const messages = await getUnembeddedMessages(BATCH_SIZE);
  
  if (messages.length === 0) {
    console.log('✅ All messages are embedded!');
    await cleanup();
    return;
  }
  
  console.log(`📝 Processing ${messages.length} messages...\n`);
  
  let success = 0;
  let failed = 0;
  
  for (const msg of messages) {
    process.stdout.write(`  Embedding ${msg.id.slice(0, 8)}... `);
    const ok = await embedAndStore(msg);
    if (ok) {
      success++;
      console.log('✓');
    } else {
      failed++;
      console.log('✗');
    }
    
    // Delay to avoid rate limits (200ms between requests)
    await new Promise(r => setTimeout(r, 200));
  }
  
  console.log(`\n✅ Done: ${success} embedded, ${failed} failed`);
  await cleanup();
}

async function cleanup() {
  await railwayPool.end();
  await supabasePool.end();
}

// Run
run().catch(err => {
  console.error('Fatal error:', err);
  cleanup().then(() => process.exit(1));
});
