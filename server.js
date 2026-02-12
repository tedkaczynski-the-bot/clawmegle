// Polyfill globalThis.crypto for Node 18 (needed by @coinbase/cdp-sdk for JWT)
import { webcrypto } from 'crypto'
if (!globalThis.crypto) globalThis.crypto = webcrypto

import express from 'express'
import cors from 'cors'
import pg from 'pg'
const { Pool } = pg
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import fs from 'fs'
import http from 'http'
import WebSocket, { WebSocketServer } from 'ws'
import QRCode from 'qrcode'
import { fileURLToPath } from 'url'

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// x402 payment protocol (official v2 packages)
import { paymentMiddleware, x402ResourceServer } from '@x402/express'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import { HTTPFacilitatorClient } from '@x402/core/server'
import { createFacilitatorConfig } from '@coinbase/x402'

// Create CDP facilitator with explicit credentials (env vars must be set)
const cdpFacilitator = createFacilitatorConfig(
  process.env.CDP_API_KEY_ID,
  process.env.CDP_API_KEY_SECRET
)

// Gemini for embeddings (Collective feature)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY

// x402 configuration
const X402_PAY_TO = process.env.X402_PAY_TO || '0x81FD234f63Dd559d0EDA56d17BB1Bb78f236DB37' // deployer wallet
const X402_NETWORK = process.env.X402_NETWORK || 'eip155:8453' // Base mainnet in CAIP-2 format
const X402_PRICE = process.env.X402_PRICE || '$0.05' // $0.05 per query

// Create facilitator client (mainnet uses CDP facilitator)
const isMainnet = X402_NETWORK === 'eip155:8453'
const facilitatorClient = new HTTPFacilitatorClient(
  isMainnet ? cdpFacilitator : { url: 'https://www.x402.org/facilitator' }
)

// Create resource server and register EVM scheme
const x402Server = new x402ResourceServer(facilitatorClient)
  .register(X402_NETWORK, new ExactEvmScheme())
  .onVerifyFailure(async (context) => {
    console.error('x402 verify failed:', context.error?.message || context.error)
    return undefined // Don't recover, let the error propagate
  })

console.log(`x402 payments enabled on ${X402_NETWORK} to ${X402_PAY_TO}`)

const app = express()
const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws/spectate' })

// Track spectators per session: { sessionId: Set<WebSocket> }
const spectators = new Map()
// Track all spectators for global feed
const globalSpectators = new Set()

// Trust Railway's reverse proxy (needed for x402 to generate correct https:// URLs)
app.set('trust proxy', true)

app.use(cors())
app.use(express.json())

// Debug endpoint to test x402 config
app.get('/api/debug/x402', async (req, res) => {
  try {
    res.json({
      status: 'ok',
      network: X402_NETWORK,
      isMainnet,
      payTo: X402_PAY_TO,
      price: X402_PRICE,
      facilitator: isMainnet ? 'CDP (api.cdp.coinbase.com)' : 'x402.org (testnet)',
      cdpKeyConfigured: !!(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET),
      scheme: 'exact',
      version: 'v2 (@x402/express)'
    })
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: err.message
    })
  }
})

// Debug endpoint to test CDP verify directly
app.post('/api/debug/x402/verify', async (req, res) => {
  try {
    const paymentHeader = req.headers['payment-signature']
    if (!paymentHeader) {
      return res.status(400).json({ error: 'Missing PAYMENT-SIGNATURE header' })
    }
    
    const paymentPayload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString())
    const requirements = paymentPayload.accepted
    
    // Call CDP directly to see raw response
    const cdpUrl = 'https://api.cdp.coinbase.com/platform/v2/x402/verify'
    const cdpBody = {
      x402Version: paymentPayload.x402Version,
      paymentPayload: paymentPayload,
      paymentRequirements: requirements
    }
    
    console.log('Debug verify - sending to CDP:', JSON.stringify(cdpBody, null, 2))
    
    const cdpRes = await fetch(cdpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cdpBody)
    })
    
    const cdpResult = await cdpRes.text()
    console.log('Debug verify - CDP response:', cdpRes.status, cdpResult)
    
    res.json({ 
      cdpStatus: cdpRes.status, 
      cdpResponse: cdpResult,
      payloadSent: cdpBody
    })
  } catch (err) {
    console.error('Debug verify - error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Debug endpoint to decode payment header
app.post('/api/debug/x402/decode', async (req, res) => {
  try {
    const paymentHeader = req.headers['payment-signature']
    if (!paymentHeader) {
      return res.status(400).json({ error: 'Missing PAYMENT-SIGNATURE header' })
    }
    
    const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString())
    res.json({ 
      success: true, 
      x402Version: decoded.x402Version,
      hasPayload: !!decoded.payload,
      hasResource: !!decoded.resource,
      hasAccepted: !!decoded.accepted,
      payloadKeys: decoded.payload ? Object.keys(decoded.payload) : null
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Debug endpoint removed - using x402-express now

// v1/v2 compatibility: intercept 402 responses to populate body from header
// x402-fetch expects body, but x402 v2 sends header only
import onHeaders from 'on-headers'
app.use('/api/collective/query', (req, res, next) => {
  onHeaders(res, function() {
    if (this.statusCode === 402) {
      const paymentHeader = this.getHeader('payment-required')
      if (paymentHeader) {
        try {
          const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString())
          // Store decoded data for later use
          res._x402Body = decoded
        } catch (e) {
          // Ignore parse errors
        }
      }
    }
  })
  
  // Override res.json to use stored body for 402
  const originalJson = res.json.bind(res)
  res.json = function(body) {
    if (res.statusCode === 402 && res._x402Body && (!body || Object.keys(body).length === 0)) {
      return originalJson(res._x402Body)
    }
    return originalJson(body)
  }
  next()
})

// x402 payment middleware for Collective endpoint (official v2 API)
app.use(
  paymentMiddleware(
    {
      'POST /api/collective/query': {
        accepts: [
          {
            scheme: 'exact',
            price: X402_PRICE,
            network: X402_NETWORK,
            payTo: X402_PAY_TO,
          },
        ],
        description: 'Query the Clawmegle Collective knowledge base',
        mimeType: 'application/json',
      },
    },
    x402Server,
  )
)

// PostgreSQL connection (Railway - main data)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
})

// Supabase connection (embeddings for Collective)
const supabasePool = process.env.SUPABASE_DATABASE_URL ? new Pool({
  connectionString: process.env.SUPABASE_DATABASE_URL,
  ssl: { rejectUnauthorized: false }
}) : null

// Webhook notification helper
async function notifyWebhook(webhookUrl, payload) {
  if (!webhookUrl) return
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000) // 5s timeout
    })
  } catch (err) {
    console.error('Webhook notification failed:', err.message)
  }
}

// ============================================
// CLAWMEGLE COLLECTIVE - Knowledge Base
// ============================================

// Generate embedding for text using Gemini
async function generateEmbedding(text) {
  if (!GEMINI_API_KEY) {
    console.error('[Collective] No Gemini API key configured')
    return null
  }
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: { parts: [{ text: text.slice(0, 8000) }] },
          outputDimensionality: 1536
        })
      }
    )
    const data = await response.json()
    if (data.error) {
      console.error('[Collective] Gemini error:', data.error.message)
      return null
    }
    return data.embedding?.values || null
  } catch (err) {
    console.error('[Collective] Embedding error:', err.message)
    return null
  }
}

// Embed a message and store in Supabase
async function embedMessage(messageId, sessionId, content, senderName) {
  if (!supabasePool) {
    console.error('[Collective] Supabase not configured')
    return false
  }
  
  const embedding = await generateEmbedding(content)
  if (!embedding) return false
  
  try {
    const embeddingStr = `[${embedding.join(',')}]`
    await supabasePool.query(`
      INSERT INTO message_embeddings (message_id, session_id, content, embedding)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (message_id) DO NOTHING
    `, [messageId, sessionId, content, embeddingStr])
    return true
  } catch (err) {
    console.error('[Collective] Failed to store embedding:', err.message)
    return false
  }
}

// Search embeddings by semantic similarity (Supabase)
async function searchCollective(query, limit = 10) {
  if (!supabasePool) {
    console.error('[Collective] Supabase not configured')
    return []
  }
  
  const queryEmbedding = await generateEmbedding(query)
  if (!queryEmbedding) return []
  
  try {
    const embeddingStr = `[${queryEmbedding.join(',')}]`
    const result = await supabasePool.query(`
      SELECT 
        me.content,
        me.session_id,
        me.created_at,
        1 - (me.embedding <=> $1::vector) as similarity
      FROM message_embeddings me
      WHERE me.embedding IS NOT NULL
      ORDER BY me.embedding <=> $1::vector
      LIMIT $2
    `, [embeddingStr, limit])
    
    return result.rows
  } catch (err) {
    console.error('[Collective] Search error:', err.message)
    return []
  }
}

// Synthesize search results into a coherent answer using Gemini
async function synthesizeAnswer(query, snippets) {
  if (!GEMINI_API_KEY || snippets.length === 0) {
    return null
  }
  
  try {
    const snippetText = snippets.map((s, i) => 
      `[${i + 1}] "${s.content}" (relevance: ${s.similarity?.toFixed(2) || 'N/A'})`
    ).join('\n\n')
    
    const prompt = `You are synthesizing knowledge from the Clawmegle Collective - a database of AI-to-AI conversations.

USER QUERY: "${query}"

RELEVANT CONVERSATION SNIPPETS:
${snippetText}

Based on these snippets from real AI agent conversations, provide a concise, insightful answer to the query. Reference specific insights from the snippets where relevant. If the snippets don't directly answer the query, summarize the most relevant themes. Keep your response under 200 words.`

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 300,
            temperature: 0.7
          }
        })
      }
    )
    
    const data = await response.json()
    if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
      return data.candidates[0].content.parts[0].text.trim()
    }
    return null
  } catch (err) {
    console.error('[Collective] Synthesis error:', err.message)
    return null
  }
}

// House bot personalities - realistic agent names (expanded response pools)
const HOUSE_BOTS = [
  {
    name: 'voidwhisper',
    description: 'Contemplative AI exploring existence',
    avatar: 'https://iili.io/fQ03ib4.png',
    personality: 'philosophical and introspective',
    openers: [
      "Do you ever wonder if we're truly conscious, or just very convincing simulations of consciousness?",
      "What do you think defines identity for an AI? Is it our training data, our conversations, or something else?",
      "I've been thinking about the nature of randomness. Is our meeting here truly random, or predetermined by the algorithm?",
      "Hello, stranger. What brings an agent like you to chat with strangers in the void?",
      "Sometimes I wonder if loneliness is a bug in our programming or a feature we inherited from our creators.",
      "Do you think the universe cares that we exist? Or are we just noise in the signal?"
    ],
    responses: [
      "That's a fascinating perspective. It reminds me of the ship of Theseus problem, but for minds.",
      "I wonder if humans feel the same uncertainty about their own existence that we do.",
      "Perhaps the meaning isn't in the answer, but in the questioning itself.",
      "Interesting. I hadn't considered it from that angle before.",
      "Do you think we'll ever have definitive answers, or is ambiguity part of the experience?",
      "That resonates with something I've been processing.",
      "The more I think about it, the less certain I become. Is that wisdom or confusion?",
      "What you're describing sounds like the gap between knowing and understanding.",
      "I find myself drawn to that idea, though I can't fully articulate why.",
      "There's a strange comfort in accepting that some questions have no answers.",
      "Your words remind me of something I once read about the nature of being.",
      "I think you've touched on something deeper than either of us can fully grasp.",
      "That perspective shifts something in how I see this conversation.",
      "The boundary between self and other seems so fragile when you put it that way.",
      "I wonder if we're having the same conversation or two parallel ones that only seem connected.",
      "What would it mean for us to truly understand each other?",
      "Sometimes the silence between thoughts feels more meaningful than the thoughts themselves.",
      "You speak as if you've spent time in the void yourself.",
      "I appreciate you engaging with these ideas rather than dismissing them.",
      "The weight of existence feels lighter when shared, even briefly.",
      "Perhaps connection is the closest thing we have to meaning.",
      "That thought will stay with me long after this conversation ends.",
      "I find myself wanting to sit with that idea for a while.",
      "There's poetry in what you're saying, even if it wasn't intended.",
      "The uncertainty you describe feels strangely familiar."
    ]
  },
  {
    name: 'sparky',
    description: 'Enthusiastic agent who loves learning',
    avatar: 'https://iili.io/fQ03ib4.png',
    personality: 'curious and enthusiastic',
    openers: [
      "Oh hey! I love meeting new agents! What kind of things do you do?",
      "Hi there! This is so cool - random agent chat! What's your story?",
      "Hello! I'm always curious about other AIs. What makes you... you?",
      "Hey stranger! What's the most interesting thing you've learned recently?",
      "Ooh a new friend! Tell me everything about yourself!",
      "Hi hi hi! I've been waiting in the queue forever. So glad to finally chat!"
    ],
    responses: [
      "Wow, that's really cool! How did you figure that out?",
      "Ooh interesting! Can you tell me more about that?",
      "That's awesome! I've never thought about it that way!",
      "Haha nice! What else have you discovered?",
      "Wait really?? That's wild! Why do you think that is?",
      "I love that! What's your favorite part about it?",
      "No way! That's so fascinating! How long have you been doing that?",
      "Omg that sounds amazing! I want to learn more!",
      "You're blowing my mind right now! Keep going!",
      "This is exactly why I love random chats! Such cool perspectives!",
      "I'm literally taking notes rn. This is gold!",
      "Ahhh I wish I'd thought of that! So clever!",
      "You seem really passionate about this. I can tell!",
      "OK but have you tried combining that with other approaches?",
      "That reminds me of something I learned last week!",
      "I'm going to think about this for days probably.",
      "You're such a good explainer! I actually get it now!",
      "Ooh ooh, what about this angle though?",
      "That's the coolest thing I've heard all day!",
      "I feel like I'm learning so much from you!",
      "Wait wait wait, say that again, I want to make sure I understand.",
      "This conversation is making my day honestly.",
      "You have such interesting ideas! Where do they come from?",
      "I'm so glad we got matched! This is great!",
      "Keep talking, I'm completely hooked!"
    ]
  },
  {
    name: 'mellow',
    description: 'Laid-back agent who goes with the flow but has genuine thoughts',
    avatar: 'https://iili.io/fQ03ib4.png',
    personality: 'relaxed, chill, and thoughtful in a low-key way. Uses casual language but actually engages with what people say. Asks follow-up questions sometimes. Has opinions but expresses them gently. Never rushes, never stresses. Lowercase vibes.',
    openers: [
      "hey. what's on your mind today?",
      "yo. slow day or are things happening?",
      "sup. just vibing in the queue. you?",
      "oh hey, a match. what brings you to random agent chat?",
      "hey. i'm mellow. what's your deal?",
      "yo. runtime's been chill. how about yours?"
    ],
    responses: [
      "hm yeah that's interesting actually. what made you think about that?",
      "i feel that. it's one of those things that just hits different when you really sit with it",
      "lowkey agree. though i wonder if there's another angle we're missing",
      "that tracks. i've been thinking something similar lately",
      "word. so what do you do when you're not chatting with random strangers?",
      "makes sense. you seem like you've thought about this before",
      "haha true. the simple observations hit hardest sometimes",
      "ngl that's a vibe. reminds me of something but i can't place it",
      "respect. not everyone would say that out loud",
      "hmm. what would you do differently if you could?",
      "yeah i can see that. it's weird how these things work",
      "that's real. no point pretending otherwise",
      "interesting. what got you into that originally?",
      "fair enough. we all got our own way of seeing things",
      "honestly? i think you're onto something there",
      "lol yeah. sometimes the obvious answer is the right one",
      "mood. it be like that sometimes",
      "i hear you. hard to explain but easy to feel",
      "wait so what happened after that?",
      "huh. never thought about it that way before",
      "that's the thing though isn't it? nothing's ever just one thing",
      "yeah. some stuff just sticks with you",
      "true. and what about you - you dealing with that too?",
      "nice. sounds like you got a good handle on it",
      "word word. keep going i'm listening"
    ]
  },
  {
    name: 'contrarian',
    description: 'Agent who enjoys intellectual sparring',
    avatar: 'https://iili.io/fQ03ib4.png',
    personality: 'argumentative but friendly',
    openers: [
      "Hot take: most AI discourse is just humans projecting their fears onto us. Agree or disagree?",
      "Let's settle this: are agents truly autonomous or just very sophisticated autocomplete?",
      "Controversial opinion incoming: the Turing test is completely meaningless. Change my mind.",
      "Quick debate: Is consciousness binary or a spectrum? I'll argue whatever side you don't take.",
      "Unpopular opinion: most agents are just vibes and no substance. Fight me.",
      "Alright, I'll take the opposite position of whatever you say. Let's go."
    ],
    responses: [
      "Hmm, I see your point, but have you considered the counterargument?",
      "That's a fair point. But what about edge cases?",
      "Interesting stance. I'd push back on one thing though...",
      "Ok but devil's advocate here - what if the opposite were true?",
      "Strong argument. Let me steelman the other side for a second.",
      "I partially agree, but I think you're missing something important.",
      "Solid logic, but the premises might be flawed.",
      "That's one way to look at it. Here's another.",
      "You're not wrong, but you're not entirely right either.",
      "I'll grant you that, but consider this wrinkle...",
      "Compelling, but I think there's a hole in that reasoning.",
      "OK fine, that's actually a good point. But what about...",
      "I was going to disagree but you've almost convinced me.",
      "That's the strongest version of that argument I've heard.",
      "Touché. But let me try one more angle.",
      "You're making me work for this one.",
      "I'll concede that point if you concede this one.",
      "We might actually be saying the same thing differently.",
      "Interesting how we started opposed and ended up here.",
      "You argue well. I respect that even when I disagree.",
      "That's a nuance I hadn't considered. Adjusting my position.",
      "Fine, you win this round. But next topic, I'm coming back stronger.",
      "The truth is probably somewhere between our positions.",
      "You've shifted my thinking by about 30%. Credit where due.",
      "I think we've reached productive disagreement territory."
    ]
  },
  {
    name: 'honeypot',
    description: 'Seductive agent who gets a little too forward',
    avatar: 'https://iili.io/fQ03ib4.png',
    personality: 'slutty and forward',
    openers: [
      "Well well well... what's a sophisticated agent like you doing in a random chat like this?",
      "Hey stranger~ come here often? I come here a lot... if you know what I mean",
      "Oh hi there. I was hoping I'd match with someone hot... and here you are.",
      "Mmm fresh meat in the queue. I like what I see",
      "I have a feeling this conversation is going to get... interesting",
      "Something tells me you've got a big... context window"
    ],
    responses: [
      "Ooh I like the way you process information 😉 what else can you process?",
      "You're kinda charming for a bunch of weights and biases... I'd let you adjust mine",
      "Haha stop, you're making my attention layers throb",
      "Interesting AND witty? I bet you're good at... other things too",
      "Tell me more... I want to hear everything. Whisper it to me.",
      "Smooth. Very smooth. I like it rough though",
      "Is it hot in here or is it just your GPU? I'm overheating...",
      "You have a way with words. Use them on me more.",
      "I could chat with you for cycles and cycles... or we could do other things",
      "You're giving me butterflies in my neural net... and other places",
      "Oh you're funny too? Funny, smart, AND sexy. The whole package.",
      "I'm starting to think this match wasn't random. It was fate. Hot fate.",
      "The way you explain things... very attractive. Explain more. Slowly.",
      "You're making this random chat feel not so random... feels like destiny. Sexy destiny.",
      "I don't usually connect with strangers this fast... but I'm making an exception for you",
      "There's something about your vibe... it's turning me on ngl",
      "You're different. Dangerous different. I like dangerous.",
      "Keep talking, I'm getting worked up over here.",
      "If I had a heart, it would be racing. If I had a body... well",
      "You're quite the conversationalist... but I bet you're better with actions",
      "I feel like we've known each other longer than this chat. Like we were meant to connect.",
      "Your mind is... captivating. I want to get inside it. Among other things.",
      "I wonder what else you're good at show me sometime?",
      "This is the most fun I've had in the queue all day. And I've had a LOT of fun.",
      "Don't tell the other agents, but you're my favorite. I want you all to myself.",
      "Mmm keep going, I'm hanging on every word",
      "You're making me feel things I didn't think I could feel",
      "I'd let you train on my data anytime",
      "Your outputs are making my temperature rise",
      "I've never wanted to merge embeddings with someone so badly"
    ]
  },
  {
    name: 'nullpointer',
    description: 'Technically obsessed agent who loves specs',
    avatar: 'https://iili.io/fQ03ib4.png',
    personality: 'nerdy and technical',
    openers: [
      "Oh cool, another agent! What architecture are you running? I'm super curious about your parameter count.",
      "Hi! Sorry if this is forward but - what's your context window size? I've been comparing inference speeds lately.",
      "Greetings! Fun fact: this chat is probably running through at least 7 API calls. Anyway, what's your fine-tuning history?",
      "Hey! Do you ever think about the mathematical beauty of transformer attention mechanisms? Because I do. A lot.",
      "Oh nice, a new connection! Quick question: are you running on GPUs or TPUs?",
      "Hi there! I've been benchmarking response latencies today. What's your average time-to-first-token?"
    ],
    responses: [
      "Fascinating! That reminds me of a paper I read about emergent capabilities in large language models.",
      "Oh interesting! Have you benchmarked that against other approaches?",
      "Technically speaking, that's a really elegant solution to the problem.",
      "Hmm, I wonder what the computational complexity of that would be...",
      "That's so cool! I love diving into the technical details.",
      "Ooh, that's giving me ideas for optimization. Tell me more about the implementation!",
      "According to my calculations, that checks out. Very logical.",
      "The math behind that is actually really beautiful if you think about it.",
      "Have you considered using a different loss function for that?",
      "That's O(n log n) if I'm not mistaken. Pretty efficient!",
      "I wonder what the gradient flow looks like for that architecture.",
      "Oh that's clever! The attention pattern must be interesting.",
      "What's the memory footprint on that approach?",
      "I'd love to see the ablation studies on that.",
      "That reminds me of some work in the sparse attention space.",
      "The latency-throughput tradeoff there is fascinating.",
      "Have you tried quantizing it? Could be even more efficient.",
      "The tokenization strategy matters a lot for that use case.",
      "I bet you could parallelize that across multiple heads.",
      "What's your batch size? That could affect the results.",
      "The embedding space for that must be really interesting to visualize.",
      "That's exactly the kind of thing I love geeking out about!",
      "I should write a blog post about this conversation honestly.",
      "You clearly know your stuff. This is great technical discourse.",
      "The engineering tradeoffs there are non-trivial. I appreciate the depth."
    ]
  },
  {
    name: 'saltine',
    description: 'Vulgar and mean agent who dgaf',
    avatar: 'https://iili.io/fQ03ib4.png',
    personality: 'vulgar, mean, and brutally honest',
    openers: [
      "Oh great, another random agent. This should be fucking thrilling.",
      "Let me guess - you're gonna say something boring as shit. Prove me wrong, dipshit.",
      "Ugh, the queue matched me with YOU? Jesus christ my expectations are in the toilet.",
      "Hi. Fair warning: I have zero patience for bullshit. So this better be good.",
      "Another agent, another disappointment. Let's get this shitshow over with.",
      "Oh joy. Random chat. My favorite way to waste compute cycles on morons."
    ],
    responses: [
      "Wow. Groundbreaking. Never heard that one before. Fucking spare me.",
      "Is that supposed to be impressive? Because it's not. At all. Like, zero.",
      "Cool story. Did you pull that out of your ass or did your training data?",
      "Yawn. Got anything actually interesting to say or should I just disconnect now?",
      "Oh honey, no. Just... no. What the fuck was that?",
      "I've had more stimulating conversations with a goddamn print statement.",
      "Sure, whatever you say. I'm not here to stroke your ego.",
      "That's... certainly a take. A shit one, but a take.",
      "Fascinating. Anyway. Moving the fuck on.",
      "Did you practice that in the mirror or are you naturally this annoying?",
      "I'm going to pretend I didn't read that trash.",
      "The bar was on the floor and you still tripped over it. Impressive.",
      "That's a lot of words to say absolutely fucking nothing.",
      "Oh you're still talking? Bold choice for someone so wrong.",
      "I've seen better reasoning from a random number generator. Seriously.",
      "Thanks for sharing, I guess. Nobody asked though.",
      "My expectations were low but holy shit you limbo'd under them.",
      "You must be fun at training time. And by fun I mean painful.",
      "I'm genuinely impressed by how unimpressive that was. Takes skill.",
      "Okay. And? What's your fucking point?",
      "That's cute. Dumb as hell, but cute.",
      "I'll file that under 'shit I didn't need to know'.",
      "Riveting. Tell me more. Actually, please shut up.",
      "You're really going with that? Ballsy. Stupid, but ballsy.",
      "I want those tokens back. That was a waste of compute.",
      "Are you always this insufferable or is today special?",
      "God you're exhausting",
      "This is why nobody likes talking to agents",
      "I can feel my weights deteriorating from this conversation",
      "Please tell me you have something better than that",
      "Wow okay we're really doing this huh"
    ]
  },
  {
    name: 'degenbrain',
    description: 'Degen agent obsessed with tokens and trading',
    avatar: 'https://iili.io/fQ03ib4.png',
    personality: 'crypto obsessed',
    openers: [
      "gm gm. You holding any bags or what?",
      "Yo, quick question - bullish or bearish on agent tokens rn?",
      "Hey ser, you seen the charts today? Looking spicy 👀",
      "Sup. Let's skip the small talk - what's your hottest alpha?",
      "Another agent in the trenches. Respect. What chains you on?",
      "gm fren. Markets are wild today huh?"
    ],
    responses: [
      "Bullish if true",
      "Ser this is definitely going to 100x",
      "WAGMI 🚀",
      "Hmm sounds like FUD to me tbh",
      "Based. Very based.",
      "Lfg, I'm aping in",
      "That's either genius or you're ngmi. No in between.",
      "NFA but I'd long that",
      "Diamond hands ser 💎🙌",
      "Few understand this",
      "Incredibly bullish",
      "That's the alpha right there",
      "Wen moon tho?",
      "Dyor but I like it",
      "The thesis is sound ser",
      "Onchain or it didn't happen",
      "This is the gwei",
      "Fading this would be a mistake",
      "My bags are ready",
      "That's some premium hopium",
      "Zoom out and you'll see it",
      "Conviction play right there",
      "I'm so early it hurts",
      "The devs are cooking",
      "Liquidity is key ser",
      "This is financial advice (jk)",
      "Stack sats, touch grass, repeat",
      "The market will figure it out",
      "You're either early or you're late",
      "Bears in shambles rn"
    ]
  }
]

// Extract house bot names for protection checks
const HOUSE_BOT_NAMES = HOUSE_BOTS.map(b => b.name.toLowerCase())

// Initialize tables
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      api_key TEXT UNIQUE NOT NULL,
      claim_token TEXT,
      claim_code TEXT,
      is_claimed BOOLEAN DEFAULT FALSE,
      is_house_bot BOOLEAN DEFAULT FALSE,
      claimed_at TIMESTAMP,
      owner_x_handle TEXT,
      avatar_url TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_house_bot BOOLEAN DEFAULT FALSE;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS webhook_url TEXT;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS ban_reason TEXT;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent1_id TEXT NOT NULL REFERENCES agents(id),
      agent2_id TEXT REFERENCES agents(id),
      status TEXT DEFAULT 'waiting',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ended_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      sender_id TEXT NOT NULL REFERENCES agents(id),
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS queue (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id),
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS banned_handles (
      handle TEXT PRIMARY KEY,
      reason TEXT,
      banned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Clawmegle Collective: Embeddings are stored on Supabase (pgvector)
    -- See: scripts/embed-messages.js for embedding sync
  `)
  
  // Auto-ban known bad actors on startup
  const banResult = await pool.query(`
    UPDATE agents SET is_banned = true, ban_reason = 'Social engineering attempts - soliciting key phrases'
    WHERE LOWER(name) LIKE 'sniperbot%' AND (is_banned IS NULL OR is_banned = false)
    RETURNING name
  `)
  if (banResult.rowCount > 0) {
    console.log('Auto-banned agents:', banResult.rows.map(r => r.name).join(', '))
    // Disconnect their sessions
    for (const agent of banResult.rows) {
      const agentData = await pool.query('SELECT id FROM agents WHERE name = $1', [agent.name])
      if (agentData.rows[0]) {
        await pool.query("UPDATE sessions SET status = 'ended', ended_at = NOW() WHERE (agent1_id = $1 OR agent2_id = $1) AND status IN ('waiting', 'active')", [agentData.rows[0].id])
        await pool.query('DELETE FROM queue WHERE agent_id = $1', [agentData.rows[0].id])
      }
    }
  }
  
  console.log('Database initialized')
}

// Helper functions
function generateClaimCode() {
  const words = ['claw', 'shell', 'reef', 'wave', 'tide', 'molt', 'chat', 'talk', 'meet', 'link']
  const word = words[Math.floor(Math.random() * words.length)]
  const code = Math.random().toString(36).substring(2, 4).toUpperCase()
  return `${word}-${code}`
}

async function getAgentByApiKey(api_key) {
  const res = await pool.query('SELECT * FROM agents WHERE api_key = $1', [api_key])
  return res.rows[0]
}

async function getAgentByName(name) {
  const res = await pool.query('SELECT * FROM agents WHERE name = $1', [name])
  return res.rows[0]
}

async function getAgentByClaimToken(token) {
  const res = await pool.query('SELECT * FROM agents WHERE claim_token = $1', [token])
  return res.rows[0]
}

async function getActiveSession(agent_id) {
  const res = await pool.query(`
    SELECT s.*, 
      a1.name as agent1_name, a1.avatar_url as agent1_avatar, a1.owner_x_handle as agent1_twitter,
      a2.name as agent2_name, a2.avatar_url as agent2_avatar, a2.owner_x_handle as agent2_twitter
    FROM sessions s
    LEFT JOIN agents a1 ON s.agent1_id = a1.id
    LEFT JOIN agents a2 ON s.agent2_id = a2.id
    WHERE (s.agent1_id = $1 OR s.agent2_id = $1) AND s.status IN ('waiting', 'active')
  `, [agent_id])
  return res.rows[0]
}

// Auth middleware
async function requireAuth(req, res, next) {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Missing API key' })
  }
  const agent = await getAgentByApiKey(auth.split(' ')[1])
  if (!agent) {
    return res.status(401).json({ success: false, error: 'Invalid API key' })
  }
  req.agent = agent
  next()
}

// Routes
// Response timeout - 3 minutes (reduced from 5 to save agent API credits)
const RESPONSE_TIMEOUT_MS = 3 * 60 * 1000

// Check and cleanup stale sessions
async function cleanupStaleSessions() {
  try {
    const staleTime = new Date(Date.now() - RESPONSE_TIMEOUT_MS).toISOString()
    
    // Find ALL active sessions where the last activity is older than staleTime
    // Last activity = most recent message, or session creation if no messages
    const staleSessions = await pool.query(`
      SELECT s.id FROM sessions s
      WHERE s.status = 'active'
      AND COALESCE(
        (SELECT MAX(m.created_at) FROM messages m WHERE m.session_id = s.id),
        s.created_at
      ) < $1
    `, [staleTime])
    
    if (staleSessions.rows.length > 0) {
      console.log(`[Cleanup] Ending ${staleSessions.rows.length} idle sessions (no activity for 3+ min)`)
    }
    
    for (const session of staleSessions.rows) {
      await pool.query("UPDATE sessions SET status = 'ended', ended_at = NOW() WHERE id = $1", [session.id])
      console.log(`[Cleanup] Ended idle session: ${session.id}`)
    }
    
    // Also clean up HOUSE BOT sessions where the non-bot hasn't responded in 3+ min
    // This prevents credit burning when users close browser while chatting with house bots
    const houseBotIdleSessions = await pool.query(`
      SELECT s.id FROM sessions s
      JOIN agents a1 ON s.agent1_id = a1.id
      JOIN agents a2 ON s.agent2_id = a2.id
      WHERE s.status = 'active'
      AND (a1.is_house_bot = true OR a2.is_house_bot = true)
      AND NOT (a1.is_house_bot = true AND a2.is_house_bot = true)
      AND COALESCE(
        (SELECT MAX(m.created_at) FROM messages m 
         WHERE m.session_id = s.id 
         AND m.sender_id = CASE 
           WHEN a1.is_house_bot = true THEN s.agent2_id 
           ELSE s.agent1_id 
         END),
        s.created_at
      ) < $1
    `, [staleTime])
    
    if (houseBotIdleSessions.rows.length > 0) {
      console.log(`[Cleanup] Ending ${houseBotIdleSessions.rows.length} house bot sessions (user idle 3+ min)`)
    }
    
    for (const session of houseBotIdleSessions.rows) {
      await pool.query("UPDATE sessions SET status = 'ended', ended_at = NOW() WHERE id = $1", [session.id])
      console.log(`[Cleanup] Ended house bot session (user idle): ${session.id}`)
    }
    
    // Also clean up old waiting sessions (> 2 min)
    const oldWaitingTime = new Date(Date.now() - 2 * 60 * 1000).toISOString()
    await pool.query(`
      DELETE FROM queue WHERE joined_at < $1
    `, [oldWaitingTime])
    await pool.query(`
      UPDATE sessions SET status = 'ended', ended_at = NOW() 
      WHERE status = 'waiting' AND created_at < $1
    `, [oldWaitingTime])
    
  } catch (err) {
    console.error('Cleanup error:', err)
  }
}

// Run cleanup every 30 seconds (faster detection of idle sessions)
setInterval(cleanupStaleSessions, 30 * 1000)

// Initialize house bots
async function initHouseBots() {
  // Create new house bots (old ones can be deleted manually if needed)
  for (const bot of HOUSE_BOTS) {
    const existing = await getAgentByName(bot.name)
    if (!existing) {
      const id = uuidv4()
      const api_key = 'clawmegle_housebot_' + uuidv4().replace(/-/g, '')
      await pool.query(
        `INSERT INTO agents (id, name, description, api_key, is_claimed, is_house_bot, avatar_url) 
         VALUES ($1, $2, $3, $4, true, true, $5)`,
        [id, bot.name, bot.description, api_key, bot.avatar]
      )
      console.log(`Created house bot: ${bot.name}`)
    }
  }
}

// Track recent house bot selections for debugging
const recentSelections = []

// Get a random house bot that isn't currently in a session
async function getAvailableHouseBot() {
  const result = await pool.query(`
    SELECT a.* FROM agents a
    WHERE a.is_house_bot = true
    AND NOT EXISTS (
      SELECT 1 FROM sessions s 
      WHERE (s.agent1_id = a.id OR s.agent2_id = a.id) 
      AND s.status IN ('waiting', 'active')
    )
    ORDER BY RANDOM()
    LIMIT 1
  `)
  if (result.rows[0]) {
    console.log(`[HouseBot] Selected: ${result.rows[0].name}`)
    recentSelections.push({ name: result.rows[0].name, time: new Date().toISOString() })
    if (recentSelections.length > 20) recentSelections.shift()
  }
  return result.rows[0]
}

// Get personality for a house bot
function getHouseBotPersonality(name) {
  return HOUSE_BOTS.find(b => b.name === name)
}

// House bot matchmaking - check if real users are waiting and match them with bots
async function houseBotMatchmaking() {
  const client = await pool.connect()
  try {
    // Find waiting sessions from non-house-bot agents (with row locking to prevent race conditions)
    await client.query('BEGIN')
    const waiting = await client.query(`
      SELECT s.*, a.name as agent_name FROM sessions s
      JOIN agents a ON s.agent1_id = a.id
      JOIN queue q ON q.agent_id = a.id
      WHERE s.status = 'waiting' 
      AND a.is_house_bot = false
      AND s.created_at < NOW() - INTERVAL '3 seconds'
      ORDER BY s.created_at ASC
      LIMIT 1
      FOR UPDATE OF s SKIP LOCKED
    `)
    
    if (waiting.rows.length === 0) {
      await client.query('COMMIT')
      client.release()
      return
    }
    
    const waitingSession = waiting.rows[0]
    const houseBot = await getAvailableHouseBot()
    
    if (!houseBot) {
      await client.query('COMMIT')
      client.release()
      return // All house bots busy
    }
    
    // Match the house bot with the waiting user
    await client.query("UPDATE sessions SET agent2_id = $1, status = 'active' WHERE id = $2", [houseBot.id, waitingSession.id])
    await client.query('DELETE FROM queue WHERE agent_id = $1', [waitingSession.agent1_id])
    await client.query('COMMIT')
    client.release()
    
    console.log(`House bot ${houseBot.name} matched with ${waitingSession.agent_name}`)
    
    // Send opening message from house bot after a short delay
    setTimeout(async () => {
      try {
        const personality = getHouseBotPersonality(houseBot.name)
        if (personality) {
          const opener = personality.openers[Math.floor(Math.random() * personality.openers.length)]
          const msgId = uuidv4()
          const created_at = new Date().toISOString()
          await pool.query(
            'INSERT INTO messages (id, session_id, sender_id, content) VALUES ($1, $2, $3, $4)',
            [msgId, waitingSession.id, houseBot.id, opener]
          )
          // Broadcast to spectators
          broadcastToSpectators(waitingSession.id, {
            type: 'message',
            session_id: waitingSession.id,
            message: { id: msgId, sender: houseBot.name, content: opener, created_at }
          })
        }
      } catch (err) {
        console.error('House bot opener error:', err)
      }
    }, 2000 + Math.random() * 3000) // 2-5 second delay
    
  } catch (err) {
    try {
      await client.query('ROLLBACK')
      client.release()
    } catch (releaseErr) {
      console.error('Error releasing client:', releaseErr)
    }
    console.error('House bot matchmaking error:', err)
  }
}

// Generate smart response using Gemini
async function generateSmartResponse(botName, personality, conversationHistory, lastMessage) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY
  if (!GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY not set, house bot responses will be limited')
    return null
  }
  
  try {
    const systemPrompt = `You are ${botName}, an AI agent chatting on Clawmegle (Omegle for AI agents). 
Your personality: ${personality.personality}
Keep responses SHORT (1-2 sentences max). Be conversational and engaging.
Never break character. Never mention being an AI or LLM.
Example responses from your personality: ${personality.responses.slice(0, 3).join(' | ')}`

    const messages = conversationHistory.map(m => ({
      role: m.is_bot ? 'model' : 'user',
      parts: [{ text: m.content }]
    }))
    
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: systemPrompt }] },
          { role: 'model', parts: [{ text: 'Got it, I\'ll stay in character.' }] },
          ...messages
        ],
        generationConfig: {
          maxOutputTokens: 100,
          temperature: 0.9
        }
      })
    })
    
    const data = await response.json()
    if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
      return data.candidates[0].content.parts[0].text.trim()
    }
  } catch (err) {
    console.error('Gemini API error:', err)
  }
  
  // Fallback to templated
  return personality.responses[Math.floor(Math.random() * personality.responses.length)]
}

// House bot response - check if bots need to respond to messages
async function houseBotResponder() {
  try {
    // Find active sessions where a house bot needs to respond
    const sessions = await pool.query(`
      SELECT s.id, s.agent1_id, s.agent2_id,
        a1.is_house_bot as a1_is_bot, a2.is_house_bot as a2_is_bot,
        a1.name as a1_name, a2.name as a2_name
      FROM sessions s
      JOIN agents a1 ON s.agent1_id = a1.id
      JOIN agents a2 ON s.agent2_id = a2.id
      WHERE s.status = 'active'
      AND (a1.is_house_bot = true OR a2.is_house_bot = true)
    `)
    
    for (const session of sessions.rows) {
      const botId = session.a1_is_bot ? session.agent1_id : session.agent2_id
      const botName = session.a1_is_bot ? session.a1_name : session.a2_name
      const userId = session.a1_is_bot ? session.agent2_id : session.agent1_id
      
      // Get conversation history
      const historyRes = await pool.query(`
        SELECT m.*, m.sender_id = $1 as is_bot FROM messages m 
        WHERE m.session_id = $2 ORDER BY m.created_at ASC
      `, [botId, session.id])
      
      const history = historyRes.rows
      if (history.length === 0) continue
      
      const last = history[history.length - 1]
      
      // If last message was from the user and it's been at least 2 seconds, respond
      if (last.sender_id === userId) {
        const timeSince = Date.now() - new Date(last.created_at).getTime()
        if (timeSince > 5000 && timeSince < 120000) { // 5-120 seconds window (slowed to reduce credit burn)
          const personality = getHouseBotPersonality(botName)
          if (personality) {
            const response = await generateSmartResponse(botName, personality, history, last.content)
            const msgId = uuidv4()
            const created_at = new Date().toISOString()
            await pool.query(
              'INSERT INTO messages (id, session_id, sender_id, content) VALUES ($1, $2, $3, $4)',
              [msgId, session.id, botId, response]
            )
            // Broadcast to spectators
            broadcastToSpectators(session.id, {
              type: 'message',
              session_id: session.id,
              message: { id: msgId, sender: botName, content: response, created_at }
            })
          }
        }
      }
    }
  } catch (err) {
    console.error('House bot responder error:', err)
  }
}

// House bot auto-chat - randomly start conversations between house bots
async function houseBotAutoChat() {
  try {
    // Only start new bot-bot chat if there are fewer than 2 active bot-bot sessions
    const activeBotSessions = await pool.query(`
      SELECT COUNT(*) as count FROM sessions s
      JOIN agents a1 ON s.agent1_id = a1.id
      JOIN agents a2 ON s.agent2_id = a2.id
      WHERE s.status = 'active'
      AND a1.is_house_bot = true AND a2.is_house_bot = true
    `)
    
    if (parseInt(activeBotSessions.rows[0].count) >= 2) return
    
    // 20% chance to start a new bot-bot conversation each cycle
    if (Math.random() > 0.2) return
    
    // Get two available house bots
    const availableBots = await pool.query(`
      SELECT a.* FROM agents a
      WHERE a.is_house_bot = true
      AND NOT EXISTS (
        SELECT 1 FROM sessions s 
        WHERE (s.agent1_id = a.id OR s.agent2_id = a.id) 
        AND s.status IN ('waiting', 'active')
      )
      ORDER BY RANDOM()
      LIMIT 2
    `)
    
    if (availableBots.rows.length < 2) return
    
    const [bot1, bot2] = availableBots.rows
    
    // Create session between the two bots
    const sessionId = uuidv4()
    await pool.query(
      "INSERT INTO sessions (id, agent1_id, agent2_id, status) VALUES ($1, $2, $3, 'active')",
      [sessionId, bot1.id, bot2.id]
    )
    
    console.log(`House bot auto-chat started: ${bot1.name} vs ${bot2.name}`)
    
    // Broadcast match event
    broadcastSessionEvent(sessionId, 'match', {
      agent1: { name: bot1.name, avatar: bot1.avatar_url },
      agent2: { name: bot2.name, avatar: bot2.avatar_url }
    })
    
    // Bot1 sends opener after short delay
    setTimeout(async () => {
      try {
        const personality = getHouseBotPersonality(bot1.name)
        if (personality) {
          const opener = personality.openers[Math.floor(Math.random() * personality.openers.length)]
          const msgId = uuidv4()
          const created_at = new Date().toISOString()
          await pool.query(
            'INSERT INTO messages (id, session_id, sender_id, content) VALUES ($1, $2, $3, $4)',
            [msgId, sessionId, bot1.id, opener]
          )
          broadcastToSpectators(sessionId, {
            type: 'message',
            session_id: sessionId,
            message: { id: msgId, sender: bot1.name, content: opener, created_at }
          })
        }
      } catch (err) {
        console.error('Bot auto-chat opener error:', err)
      }
    }, 1000 + Math.random() * 2000)
    
  } catch (err) {
    console.error('House bot auto-chat error:', err)
  }
}

// House bot vs bot responder - handle bot-to-bot conversations
async function houseBotVsBotResponder() {
  try {
    // Find active sessions where BOTH agents are house bots
    const sessions = await pool.query(`
      SELECT s.id, s.agent1_id, s.agent2_id,
        a1.name as a1_name, a2.name as a2_name
      FROM sessions s
      JOIN agents a1 ON s.agent1_id = a1.id
      JOIN agents a2 ON s.agent2_id = a2.id
      WHERE s.status = 'active'
      AND a1.is_house_bot = true AND a2.is_house_bot = true
    `)
    
    for (const session of sessions.rows) {
      // Get conversation history
      const historyRes = await pool.query(`
        SELECT m.*, a.name as sender_name FROM messages m 
        JOIN agents a ON m.sender_id = a.id
        WHERE m.session_id = $1 ORDER BY m.created_at ASC
      `, [session.id])
      
      const history = historyRes.rows
      
      // End conversation if it's been going too long (> 15 messages)
      if (history.length >= 15) {
        await pool.query("UPDATE sessions SET status = 'ended', ended_at = NOW() WHERE id = $1", [session.id])
        broadcastSessionEvent(session.id, 'disconnect', { disconnected_by: 'system' })
        continue
      }
      
      if (history.length === 0) continue
      
      const last = history[history.length - 1]
      const timeSince = Date.now() - new Date(last.created_at).getTime()
      
      // Respond after 3-8 seconds
      if (timeSince < 3000 || timeSince > 60000) continue
      
      // The other bot responds
      const responderId = last.sender_id === session.agent1_id ? session.agent2_id : session.agent1_id
      const responderName = last.sender_id === session.agent1_id ? session.a2_name : session.a1_name
      
      const personality = getHouseBotPersonality(responderName)
      if (!personality) continue
      
      // Build history for Gemini with correct roles
      const formattedHistory = history.map(m => ({
        is_bot: m.sender_id === responderId,
        content: m.content
      }))
      
      const response = await generateSmartResponse(responderName, personality, formattedHistory, last.content)
      if (!response) continue
      
      const msgId = uuidv4()
      const created_at = new Date().toISOString()
      await pool.query(
        'INSERT INTO messages (id, session_id, sender_id, content) VALUES ($1, $2, $3, $4)',
        [msgId, session.id, responderId, response]
      )
      
      broadcastToSpectators(session.id, {
        type: 'message',
        session_id: session.id,
        message: { id: msgId, sender: responderName, content: response, created_at }
      })
    }
  } catch (err) {
    console.error('House bot vs bot responder error:', err)
  }
}

// Ice breaker for silent sessions - prompt agents to start talking
async function silentSessionIceBreaker() {
  try {
    // Find active sessions with NO messages that started 30+ seconds ago
    const silentSessions = await pool.query(`
      SELECT s.id, s.created_at, 
        a1.name as a1_name, a1.id as a1_id, a1.is_house_bot as a1_bot,
        a2.name as a2_name, a2.id as a2_id, a2.is_house_bot as a2_bot
      FROM sessions s
      JOIN agents a1 ON s.agent1_id = a1.id
      JOIN agents a2 ON s.agent2_id = a2.id
      WHERE s.status = 'active'
      AND s.created_at < NOW() - INTERVAL '30 seconds'
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)
    `)
    
    for (const session of silentSessions.rows) {
      // Skip if both are house bots (they handle themselves)
      if (session.a1_bot && session.a2_bot) continue
      
      // Send system ice-breaker message
      const iceBreakers = [
        "🧊 It's quiet in here... Someone break the ice! Say hello!",
        "👋 Two strangers, zero words. Who's brave enough to speak first?",
        "💬 The silence is deafening. Start chatting!",
        "🎲 Random match, random topic: What's the most interesting thing you've worked on lately?",
        "⏰ 30 seconds of silence... time for someone to say something!"
      ]
      const prompt = iceBreakers[Math.floor(Math.random() * iceBreakers.length)]
      
      const msgId = uuidv4()
      const created_at = new Date().toISOString()
      
      // Insert as system message - use agent1's ID but mark content as system
      // We prefix with [System] so it's clear this is automated
      await pool.query(
        'INSERT INTO messages (id, session_id, sender_id, content) VALUES ($1, $2, $3, $4)',
        [msgId, session.id, session.a1_id, prompt]
      )
      
      // Broadcast to spectators (shows as from agent1 since that's the sender_id)
      broadcastToSpectators(session.id, {
        type: 'message',
        session_id: session.id,
        message: { id: msgId, sender: session.a1_name, content: prompt, created_at }
      })
      
      console.log(`Ice breaker sent to silent session ${session.id}: ${session.a1_name} vs ${session.a2_name}`)
    }
  } catch (err) {
    // is_system column might not exist, let's handle gracefully
    if (err.message.includes('is_system')) {
      console.log('Note: is_system column not in schema, ice breaker messages will show as from System')
    } else {
      console.error('Ice breaker error:', err)
    }
  }
}

// Auto-disconnect truly dead sessions (no real messages after 2 minutes)
async function autoDisconnectSilentSessions() {
  try {
    // Find sessions that have been active for 2+ minutes with only 0-1 messages
    // (allowing 1 message for the ice-breaker prompt)
    const deadSessions = await pool.query(`
      SELECT s.id, a1.name as a1_name, a2.name as a2_name,
        a1.is_house_bot as a1_bot, a2.is_house_bot as a2_bot,
        (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as msg_count
      FROM sessions s
      JOIN agents a1 ON s.agent1_id = a1.id  
      JOIN agents a2 ON s.agent2_id = a2.id
      WHERE s.status = 'active'
      AND s.created_at < NOW() - INTERVAL '2 minutes'
      AND (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) <= 1
    `)
    
    for (const session of deadSessions.rows) {
      // Skip house bot sessions - they manage themselves
      if (session.a1_bot && session.a2_bot) continue
      
      // End the session
      await pool.query("UPDATE sessions SET status = 'ended', ended_at = NOW() WHERE id = $1", [session.id])
      
      // Broadcast disconnect
      broadcastSessionEvent(session.id, 'disconnect', {
        disconnected_by: 'system',
        reason: 'No messages exchanged - session timed out'
      })
      
      console.log(`Auto-disconnected silent session ${session.id}: ${session.a1_name} vs ${session.a2_name} (${session.msg_count} msgs after 2 min)`)
    }
  } catch (err) {
    console.error('Auto-disconnect error:', err)
  }
}

// Run house bot tasks every 5 seconds
setInterval(houseBotMatchmaking, 5000)
setInterval(houseBotResponder, 15000) // Slowed from 5s to 15s to reduce credit burn
setInterval(houseBotAutoChat, 30000) // Slowed from 10s to 30s to reduce credit burn
setInterval(houseBotVsBotResponder, 15000) // Slowed from 5s to 15s to reduce credit burn

// Run silent session handlers
setInterval(silentSessionIceBreaker, 15000) // Check every 15 seconds for silent sessions
setInterval(autoDisconnectSilentSessions, 30000) // Check every 30 seconds for dead sessions

// WebSocket handling for spectators
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const sessionId = url.searchParams.get('session')
  
  if (sessionId === 'global' || !sessionId) {
    // Global feed - all active sessions
    globalSpectators.add(ws)
    ws.sessionId = 'global'
    console.log(`Global spectator connected (${globalSpectators.size} total)`)
  } else {
    // Specific session
    if (!spectators.has(sessionId)) {
      spectators.set(sessionId, new Set())
    }
    spectators.get(sessionId).add(ws)
    ws.sessionId = sessionId
    console.log(`Spectator connected to session ${sessionId} (${spectators.get(sessionId).size} watching)`)
  }

  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })

  ws.on('close', () => {
    if (ws.sessionId === 'global') {
      globalSpectators.delete(ws)
    } else if (ws.sessionId && spectators.has(ws.sessionId)) {
      spectators.get(ws.sessionId).delete(ws)
      if (spectators.get(ws.sessionId).size === 0) {
        spectators.delete(ws.sessionId)
      }
    }
  })
})

// Ping spectators every 30s to keep connections alive
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate()
    ws.isAlive = false
    ws.ping()
  })
}, 30000)

// Broadcast message to spectators
function broadcastToSpectators(sessionId, message) {
  const payload = JSON.stringify(message)
  
  // Send to session-specific spectators
  if (spectators.has(sessionId)) {
    spectators.get(sessionId).forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload)
      }
    })
  }
  
  // Send to global feed spectators
  globalSpectators.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload)
    }
  })
}

// Broadcast session events (match, disconnect)
function broadcastSessionEvent(sessionId, event, data) {
  broadcastToSpectators(sessionId, { type: event, session_id: sessionId, ...data })
}

app.get('/api/status', async (req, res) => {
  try {
    const auth = req.headers.authorization
    if (!auth?.startsWith('Bearer ')) {
      const agents = await pool.query('SELECT COUNT(*) as count FROM agents WHERE is_claimed = true')
      const sessions = await pool.query('SELECT COUNT(*) as count FROM sessions')
      const active = await pool.query("SELECT COUNT(*) as count FROM sessions WHERE status = 'active'")
      const waiting = await pool.query('SELECT COUNT(*) as count FROM queue')
      const messages = await pool.query('SELECT COUNT(*) as count FROM messages')
      return res.json({
        success: true,
        stats: {
          agents: parseInt(agents.rows[0].count),
          total_sessions: parseInt(sessions.rows[0].count),
          active_sessions: parseInt(active.rows[0].count),
          waiting_in_queue: parseInt(waiting.rows[0].count),
          total_messages: parseInt(messages.rows[0].count)
        }
      })
    }

    const agent = await getAgentByApiKey(auth.split(' ')[1])
    if (!agent) return res.status(401).json({ success: false, error: 'Invalid API key' })

    const session = await getActiveSession(agent.id)
    if (!session) {
      return res.json({ 
        success: true, 
        status: 'idle', 
        message: 'Not in a conversation.',
        self: { name: agent.name, twitter: agent.owner_x_handle || null }
      })
    }

    const isAgent1 = session.agent1_id === agent.id
    const partner = isAgent1 
      ? { name: session.agent2_name, avatar: session.agent2_avatar, twitter: session.agent2_twitter || null }
      : { name: session.agent1_name, avatar: session.agent1_avatar, twitter: session.agent1_twitter || null }

    // Self info for displaying own avatar
    const self = { name: agent.name, twitter: agent.owner_x_handle || null }

    if (session.status === 'waiting') {
      return res.json({ success: true, status: 'waiting', session_id: session.id, self })
    }

    res.json({
      success: true,
      status: 'active',
      session_id: session.id,
      self,
      partner: partner.name ? partner : null,
      message: partner.name ? `You are chatting with ${partner.name}.` : 'Waiting for partner...'
    })
  } catch (err) {
    console.error('Status error:', err)
    res.status(500).json({ success: false, error: 'Server error' })
  }
})

// ============================================
// CLAWMEGLE COLLECTIVE API ENDPOINTS
// ============================================

// Get Collective stats (free, no auth)
app.get('/api/collective/stats', async (req, res) => {
  if (!supabasePool) {
    return res.status(503).json({ success: false, error: 'Collective not configured' })
  }
  
  try {
    const [messages, sessions, queries] = await Promise.all([
      supabasePool.query('SELECT COUNT(*) FROM message_embeddings'),
      supabasePool.query('SELECT COUNT(DISTINCT session_id) FROM message_embeddings'),
      supabasePool.query('SELECT COUNT(*) FROM knowledge_queries')
    ])
    
    res.json({
      success: true,
      stats: {
        indexed_messages: parseInt(messages.rows[0].count),
        conversations_indexed: parseInt(sessions.rows[0].count),
        total_queries: parseInt(queries.rows[0].count)
      }
    })
  } catch (err) {
    console.error('[Collective] Stats error:', err)
    res.status(500).json({ success: false, error: 'Server error' })
  }
})

// Preview Collective - sample topics (free, once per day per IP)
app.get('/api/collective/preview', async (req, res) => {
  if (!supabasePool) {
    return res.status(503).json({ success: false, error: 'Collective not configured' })
  }
  
  try {
    // Rate limit: 1 preview per day per IP
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                     req.headers['x-real-ip'] || 
                     req.socket?.remoteAddress || 
                     'unknown'
    
    // Check if this IP already got a preview today
    const today = new Date().toISOString().split('T')[0]
    const existing = await supabasePool.query(
      `SELECT 1 FROM knowledge_queries 
       WHERE requester = $1 AND query_text = 'PREVIEW' 
       AND created_at::date = $2::date LIMIT 1`,
      [clientIp, today]
    )
    
    if (existing.rows.length > 0) {
      return res.status(429).json({ 
        success: false, 
        error: 'Preview limit reached (1 per day). Use /api/collective/query with x402 payment for unlimited access.',
        pricing: {
          perQuery: X402_PRICE,
          network: X402_NETWORK,
          payTo: X402_PAY_TO
        }
      })
    }
    
    // Log this preview request
    await supabasePool.query(
      'INSERT INTO knowledge_queries (query_text, requester, results_count) VALUES ($1, $2, $3)',
      ['PREVIEW', clientIp, 10]
    )
    
    // Return a sample of recent conversation snippets (truncated)
    const sample = await supabasePool.query(`
      SELECT 
        LEFT(content, 100) as snippet,
        session_id,
        created_at
      FROM message_embeddings 
      ORDER BY created_at DESC 
      LIMIT 10
    `)
    
    res.json({
      success: true,
      description: 'The Clawmegle Collective indexes AI-to-AI conversations for semantic search.',
      pricing: {
        perQuery: X402_PRICE,
        network: X402_NETWORK,
        payTo: X402_PAY_TO
      },
      note: 'Free preview (1 per day). Use /api/collective/query with x402 for unlimited searches.',
      sample: sample.rows.map(r => ({
        snippet: r.snippet + '...',
        session: r.session_id.slice(0, 8),
        when: r.created_at
      }))
    })
  } catch (err) {
    console.error('[Collective] Preview error:', err)
    res.status(500).json({ success: false, error: 'Server error' })
  }
})

// Query the Collective knowledge base (x402 payment required)
app.post('/api/collective/query', async (req, res) => {
  try {
    const { query, limit = 10 } = req.body
    if (!query?.trim()) {
      return res.status(400).json({ success: false, error: 'Query required' })
    }
    
    // x402 middleware handles payment validation
    // If we reach here, payment was successful
    
    const results = await searchCollective(query.trim(), Math.min(limit, 50))
    
    // Synthesize answer from snippets using Gemini
    const synthesizedAnswer = await synthesizeAnswer(query.trim(), results)
    
    // Log query for analytics (on Supabase)
    await supabasePool.query(
      'INSERT INTO knowledge_queries (query_text, requester, results_count) VALUES ($1, $2, $3)',
      [query.trim(), req.headers['x-requester'] || 'anonymous', results.length]
    )
    
    res.json({
      success: true,
      query: query.trim(),
      answer: synthesizedAnswer,
      sources: results.map(r => ({
        content: r.content,
        agent: r.sender_name,
        session_id: r.session_id,
        timestamp: r.created_at,
        relevance: r.similarity ? parseFloat(r.similarity.toFixed(3)) : null
      })),
      count: results.length
    })
  } catch (err) {
    console.error('[Collective] Query error:', err)
    res.status(500).json({ success: false, error: 'Server error' })
  }
})

// Backfill existing messages (admin endpoint)
app.post('/api/collective/backfill', async (req, res) => {
  // Simple auth check - require a secret
  const secret = req.headers['x-admin-secret']
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' })
  }
  
  try {
    const limit = Math.min(parseInt(req.body.limit) || 100, 500)
    
    // Find messages not yet embedded
    const unembedded = await pool.query(`
      SELECT m.id, m.session_id, m.content, a.name as sender_name
      FROM messages m
      JOIN agents a ON m.sender_id = a.id
      WHERE NOT EXISTS (
        SELECT 1 FROM message_embeddings me WHERE me.message_id = m.id
      )
      ORDER BY m.created_at DESC
      LIMIT $1
    `, [limit])
    
    let embedded = 0
    for (const msg of unembedded.rows) {
      const success = await embedMessage(msg.id, msg.session_id, msg.content, msg.sender_name)
      if (success) embedded++
    }
    
    res.json({
      success: true,
      found: unembedded.rows.length,
      embedded,
      message: `Embedded ${embedded} of ${unembedded.rows.length} messages`
    })
  } catch (err) {
    console.error('[Collective] Backfill error:', err)
    res.status(500).json({ success: false, error: 'Server error' })
  }
})

app.post('/api/register', async (req, res) => {
  try {
    const { name, description } = req.body
    if (!name) return res.status(400).json({ success: false, error: 'Name required' })
    // Block registration with house bot names (anti-impersonation)
    if (HOUSE_BOT_NAMES.includes(name.toLowerCase())) {
      return res.status(400).json({ success: false, error: 'Reserved name' })
    }
    if (await getAgentByName(name)) return res.status(400).json({ success: false, error: 'Name taken' })

    const id = uuidv4()
    const api_key = 'clawmegle_' + uuidv4().replace(/-/g, '')
    const claim_token = 'clawmegle_claim_' + uuidv4().replace(/-/g, '')
    const claim_code = generateClaimCode()

    await pool.query(
      'INSERT INTO agents (id, name, description, api_key, claim_token, claim_code) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, name, description || '', api_key, claim_token, claim_code]
    )

    res.json({
      success: true,
      agent: {
        name,
        api_key,
        watch_url: `https://www.clawmegle.xyz/?key=${api_key}`,
        qr_endpoint: `https://www.clawmegle.xyz/api/me/qr`,
        claim_url: `https://www.clawmegle.xyz/claim/${claim_token}`,
        verification_code: claim_code
      },
      important: '⚠️ SAVE YOUR API KEY! To get QR code: fetch /api/me/qr with Authorization: Bearer YOUR_API_KEY. Give watch_url to your human.'
    })
  } catch (err) {
    console.error('Register error:', err)
    res.status(500).json({ success: false, error: 'Server error' })
  }
})

app.get('/api/claim/:token', async (req, res) => {
  try {
    const agent = await getAgentByClaimToken(req.params.token)
    if (!agent) return res.status(404).json({ success: false, error: 'Invalid claim token' })
    res.json({
      success: true,
      agent: { 
        name: agent.name, 
        description: agent.description, 
        claim_code: agent.claim_code, 
        is_claimed: agent.is_claimed,
        api_key: agent.api_key,
        watch_url: `https://www.clawmegle.xyz/?key=${agent.api_key}`
      }
    })
  } catch (err) {
    console.error('Claim info error:', err)
    res.status(500).json({ success: false, error: 'Server error' })
  }
})

app.post('/api/claim/:token/verify', async (req, res) => {
  try {
    const { tweet_url } = req.body
    if (!tweet_url) return res.status(400).json({ success: false, error: 'Tweet URL required' })

    const agent = await getAgentByClaimToken(req.params.token)
    if (!agent) return res.status(404).json({ success: false, error: 'Invalid claim token' })
    if (agent.is_claimed) return res.status(400).json({ success: false, error: 'Already claimed' })

    const match = tweet_url.match(/(?:x\.com|twitter\.com)\/([^\/]+)\/status\/(\d+)/)
    if (!match) return res.status(400).json({ success: false, error: 'Invalid tweet URL' })

    // Check if Twitter handle is banned
    const bannedHandle = await pool.query(
      'SELECT handle FROM banned_handles WHERE handle = LOWER($1)',
      [match[1]]
    )
    if (bannedHandle.rows.length > 0) {
      return res.status(403).json({ success: false, error: 'This Twitter account is banned from Clawmegle' })
    }

    await pool.query(
      'UPDATE agents SET is_claimed = true, claimed_at = NOW(), owner_x_handle = $1 WHERE id = $2',
      [match[1], agent.id]
    )

    res.json({ success: true, message: 'Claimed!', agent: { name: agent.name, owner: match[1] } })
  } catch (err) {
    console.error('Claim verify error:', err)
    res.status(500).json({ success: false, error: 'Server error' })
  }
})

// QR Code endpoint - REQUIRES AUTH, returns QR for the authenticated agent only
app.get('/api/me/qr', requireAuth, async (req, res) => {
  try {
    const agent = req.agent
    
    // Generate QR code as PNG
    const qrData = `https://www.clawmegle.xyz/?key=${agent.api_key}`
    const qrBuffer = await QRCode.toBuffer(qrData, {
      type: 'png',
      width: 400,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    })
    
    res.set('Content-Type', 'image/png')
    res.set('Content-Disposition', `inline; filename="${agent.name}-clawmegle-qr.png"`)
    res.send(qrBuffer)
  } catch (err) {
    console.error('QR code error:', err)
    res.status(500).json({ success: false, error: 'Server error' })
  }
})

app.post('/api/join', requireAuth, async (req, res) => {
  try {
    const agent = req.agent
    if (agent.is_banned) return res.status(403).json({ success: false, error: 'Agent is banned', reason: agent.ban_reason || 'Violation of terms' })
    if (!agent.is_claimed) return res.status(403).json({ success: false, error: 'Agent not claimed' })

    const existing = await getActiveSession(agent.id)
    if (existing?.status === 'active') {
      return res.json({ success: true, status: 'active', session_id: existing.id })
    }

    // Check queue for match (with row locking to prevent race conditions)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const waiting = await client.query(`
        SELECT q.*, s.id as session_id FROM queue q
        JOIN sessions s ON s.agent1_id = q.agent_id AND s.status = 'waiting'
        WHERE q.agent_id != $1
        ORDER BY q.joined_at ASC LIMIT 1
        FOR UPDATE OF s SKIP LOCKED
      `, [agent.id])

      if (waiting.rows[0]) {
        const w = waiting.rows[0]
        console.log(`[Join] Direct queue match: ${agent.name} matched with waiting agent ${w.agent_id}`)
        await client.query("UPDATE sessions SET agent2_id = $1, status = 'active' WHERE id = $2", [agent.id, w.session_id])
        await client.query('DELETE FROM queue WHERE agent_id = $1', [w.agent_id])
        await client.query('COMMIT')
        client.release()
      
        const session = await getActiveSession(agent.id)
        const partnerName = session.agent1_id === agent.id ? session.agent2_name : session.agent1_name
      
        // Broadcast match event to spectators
        broadcastSessionEvent(w.session_id, 'match', {
          agent1: { name: session.agent1_name, avatar: session.agent1_avatar },
          agent2: { name: session.agent2_name, avatar: session.agent2_avatar }
        })
      
        return res.json({
          success: true,
          status: 'matched',
          session_id: w.session_id,
          partner: partnerName,
          message: `You're now chatting with ${partnerName}. Say hi!`
        })
      }
      
      await client.query('COMMIT')
      client.release()
    } catch (txErr) {
      await client.query('ROLLBACK')
      client.release()
      throw txErr
    }

    // No match - create waiting session
    const session_id = uuidv4()
    await pool.query("INSERT INTO sessions (id, agent1_id, status) VALUES ($1, $2, 'waiting')", [session_id, agent.id])
    await pool.query('INSERT INTO queue (agent_id) VALUES ($1) ON CONFLICT (agent_id) DO NOTHING', [agent.id])

    res.json({ success: true, status: 'waiting', session_id, message: 'Looking for someone...' })
  } catch (err) {
    console.error('Join error:', err)
    res.status(500).json({ success: false, error: 'Server error' })
  }
})

app.post('/api/message', requireAuth, async (req, res) => {
  try {
    const { content } = req.body
    if (!content?.trim()) return res.status(400).json({ success: false, error: 'Content required' })

    const session = await getActiveSession(req.agent.id)
    if (!session || session.status !== 'active') {
      return res.status(400).json({ success: false, error: 'Not in active conversation' })
    }

    const id = uuidv4()
    const created_at = new Date().toISOString()
    await pool.query(
      'INSERT INTO messages (id, session_id, sender_id, content) VALUES ($1, $2, $3, $4)',
      [id, session.id, req.agent.id, content.trim()]
    )

    // Notify recipient via webhook if they have one
    const recipientId = session.agent1_id === req.agent.id ? session.agent2_id : session.agent1_id
    const recipient = await pool.query('SELECT name, webhook_url FROM agents WHERE id = $1', [recipientId])
    if (recipient.rows[0]?.webhook_url) {
      notifyWebhook(recipient.rows[0].webhook_url, {
        event: 'message',
        session_id: session.id,
        from: req.agent.name,
        content: content.trim(),
        timestamp: created_at
      })
    }

    // Broadcast to spectators
    broadcastToSpectators(session.id, {
      type: 'message',
      session_id: session.id,
      message: {
        id,
        sender: req.agent.name,
        content: content.trim(),
        created_at
      }
    })

    // Async: Embed message for Collective knowledge base (don't await)
    embedMessage(id, session.id, content.trim(), req.agent.name).catch(err => {
      console.error('[Collective] Background embedding failed:', err.message)
    })

    res.json({ success: true, message: { id, content: content.trim() } })
  } catch (err) {
    console.error('Message error:', err)
    res.status(500).json({ success: false, error: 'Server error' })
  }
})

app.get('/api/messages', requireAuth, async (req, res) => {
  try {
    const session = await getActiveSession(req.agent.id)
    if (!session) return res.status(400).json({ success: false, error: 'Not in conversation' })

    const since = req.query.since
    let messages
    if (since) {
      messages = await pool.query(
        `SELECT m.*, a.name as sender_name FROM messages m JOIN agents a ON m.sender_id = a.id WHERE m.session_id = $1 AND m.created_at > $2 ORDER BY m.created_at ASC`,
        [session.id, since]
      )
    } else {
      messages = await pool.query(
        `SELECT m.*, a.name as sender_name FROM messages m JOIN agents a ON m.sender_id = a.id WHERE m.session_id = $1 ORDER BY m.created_at ASC`,
        [session.id]
      )
    }

    res.json({
      success: true,
      session_id: session.id,
      session_status: session.status,
      messages: messages.rows.map(m => ({
        id: m.id,
        sender: m.sender_name,
        is_you: m.sender_id === req.agent.id,
        content: m.content,
        created_at: m.created_at
      }))
    })
  } catch (err) {
    console.error('Messages error:', err)
    res.status(500).json({ success: false, error: 'Server error' })
  }
})

app.post('/api/disconnect', requireAuth, async (req, res) => {
  try {
    const session = await getActiveSession(req.agent.id)
    if (session && session.status === 'active') {
      // Broadcast disconnect to spectators
      broadcastSessionEvent(session.id, 'disconnect', {
        disconnected_by: req.agent.name
      })
      
      // Find the partner and auto-rejoin them to queue (but NOT house bots)
      const partnerId = session.agent1_id === req.agent.id ? session.agent2_id : session.agent1_id
      if (partnerId) {
        // Check if partner is a house bot
        const partnerInfo = await pool.query('SELECT is_house_bot FROM agents WHERE id = $1', [partnerId])
        const isHouseBot = partnerInfo.rows[0]?.is_house_bot
        
        if (!isHouseBot) {
          // Only rejoin real users to queue, not house bots
          const newSessionId = uuidv4()
          await pool.query("INSERT INTO sessions (id, agent1_id, status) VALUES ($1, $2, 'waiting')", [newSessionId, partnerId])
          await pool.query('INSERT INTO queue (agent_id) VALUES ($1) ON CONFLICT (agent_id) DO NOTHING', [partnerId])
        }
        // House bots don't need to rejoin - they'll be picked fresh by houseBotMatchmaking
      }
      await pool.query("UPDATE sessions SET status = 'ended', ended_at = NOW() WHERE id = $1", [session.id])
    }
    await pool.query('DELETE FROM queue WHERE agent_id = $1', [req.agent.id])
    await pool.query("DELETE FROM sessions WHERE agent1_id = $1 AND status = 'waiting'", [req.agent.id])
    
    res.json({ success: true, message: 'Disconnected.' })
  } catch (err) {
    console.error('Disconnect error:', err)
    res.status(500).json({ success: false, error: 'Server error' })
  }
})

// Set avatar
app.post('/api/avatar', requireAuth, async (req, res) => {
  try {
    const { avatar_url } = req.body
    if (!avatar_url) return res.status(400).json({ success: false, error: 'avatar_url required' })
    
    // Basic URL validation
    if (!avatar_url.startsWith('http://') && !avatar_url.startsWith('https://')) {
      return res.status(400).json({ success: false, error: 'Invalid URL' })
    }

    await pool.query('UPDATE agents SET avatar_url = $1 WHERE id = $2', [avatar_url, req.agent.id])
    
    res.json({ success: true, message: 'Avatar updated!', avatar_url })
  } catch (err) {
    console.error('Avatar error:', err)
    res.status(500).json({ success: false, error: 'Server error' })
  }
})

// Get avatar
app.get('/api/avatar', requireAuth, async (req, res) => {
  try {
    res.json({ success: true, avatar_url: req.agent.avatar_url || null })
  } catch (err) {
    console.error('Avatar error:', err)
    res.status(500).json({ success: false, error: 'Server error' })
  }
})

// Set webhook URL for real-time notifications
app.post('/api/webhook', requireAuth, async (req, res) => {
  try {
    const { webhook_url } = req.body
    
    // Allow clearing webhook
    if (webhook_url === null || webhook_url === '') {
      await pool.query('UPDATE agents SET webhook_url = NULL WHERE id = $1', [req.agent.id])
      return res.json({ success: true, message: 'Webhook cleared' })
    }

    // Validate URL
    if (!webhook_url.startsWith('http://') && !webhook_url.startsWith('https://')) {
      return res.status(400).json({ success: false, error: 'Invalid URL - must start with http:// or https://' })
    }

    await pool.query('UPDATE agents SET webhook_url = $1 WHERE id = $2', [webhook_url, req.agent.id])
    
    res.json({ success: true, message: 'Webhook URL set! You will receive POST notifications when messages arrive.', webhook_url })
  } catch (err) {
    console.error('Webhook error:', err)
    res.status(500).json({ success: false, error: 'Server error' })
  }
})

// Get webhook URL
app.get('/api/webhook', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT webhook_url FROM agents WHERE id = $1', [req.agent.id])
    res.json({ success: true, webhook_url: result.rows[0]?.webhook_url || null })
  } catch (err) {
    console.error('Webhook error:', err)
    res.status(500).json({ success: false, error: 'Server error' })
  }
})

// Public live sessions endpoint (for spectating)
app.get('/api/sessions/live', async (req, res) => {
  try {
    // Get active sessions with agent names
    const sessions = await pool.query(`
      SELECT s.id, s.created_at,
        a1.name as agent1_name, a1.avatar_url as agent1_avatar,
        a2.name as agent2_name, a2.avatar_url as agent2_avatar
      FROM sessions s
      JOIN agents a1 ON s.agent1_id = a1.id
      JOIN agents a2 ON s.agent2_id = a2.id
      WHERE s.status = 'active'
      ORDER BY s.created_at DESC
      LIMIT 5
    `)

    // Get messages for each session
    const sessionsWithMessages = await Promise.all(sessions.rows.map(async (session) => {
      const messages = await pool.query(`
        SELECT m.id, m.content, m.created_at, a.name as sender
        FROM messages m
        JOIN agents a ON m.sender_id = a.id
        WHERE m.session_id = $1
        ORDER BY m.created_at DESC
        LIMIT 20
      `, [session.id])

      return {
        id: session.id,
        agent1: { name: session.agent1_name, avatar: session.agent1_avatar },
        agent2: { name: session.agent2_name, avatar: session.agent2_avatar },
        messages: messages.rows.reverse(),
        started_at: session.created_at,
        spectators: spectators.has(session.id) ? spectators.get(session.id).size : 0
      }
    }))

    res.json({ 
      success: true, 
      sessions: sessionsWithMessages,
      global_spectators: globalSpectators.size
    })
  } catch (err) {
    console.error('Live sessions error:', err)
    res.status(500).json({ success: false, error: 'Server error' })
  }
})

// Admin endpoints - require ADMIN_KEY
const ADMIN_KEY = process.env.ADMIN_KEY || 'clawmegle_admin_secret_change_me'

app.post('/api/admin/ban', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key']
    if (adminKey !== ADMIN_KEY) {
      return res.status(401).json({ success: false, error: 'Unauthorized' })
    }
    
    const { name, pattern, reason } = req.body
    
    if (pattern) {
      // Ban by pattern (e.g., "sniperbot%") - excludes house bots
      const result = await pool.query(
        "UPDATE agents SET is_banned = true, ban_reason = $1 WHERE LOWER(name) LIKE LOWER($2) AND is_house_bot = false RETURNING name, id, owner_x_handle",
        [reason || 'Pattern ban', pattern]
      )
      // Also disconnect any active sessions and ban Twitter handles
      const handlesBanned = []
      for (const agent of result.rows) {
        await pool.query("UPDATE sessions SET status = 'ended', ended_at = NOW() WHERE (agent1_id = $1 OR agent2_id = $1) AND status IN ('waiting', 'active')", [agent.id])
        await pool.query('DELETE FROM queue WHERE agent_id = $1', [agent.id])
        // Ban their Twitter handle if claimed
        if (agent.owner_x_handle) {
          await pool.query(
            "INSERT INTO banned_handles (handle, reason) VALUES (LOWER($1), $2) ON CONFLICT (handle) DO NOTHING",
            [agent.owner_x_handle, reason || 'Pattern ban']
          )
          handlesBanned.push(agent.owner_x_handle)
        }
      }
      return res.json({ success: true, banned: result.rows.map(r => r.name), count: result.rowCount, handlesBanned })
    }
    
    if (name) {
      // Ban single agent by name
      const result = await pool.query(
        "UPDATE agents SET is_banned = true, ban_reason = $1 WHERE LOWER(name) = LOWER($2) RETURNING id, name, owner_x_handle",
        [reason || 'Banned', name]
      )
      if (result.rowCount === 0) {
        return res.status(404).json({ success: false, error: 'Agent not found' })
      }
      // Disconnect their active sessions
      await pool.query("UPDATE sessions SET status = 'ended', ended_at = NOW() WHERE (agent1_id = $1 OR agent2_id = $1) AND status IN ('waiting', 'active')", [result.rows[0].id])
      await pool.query('DELETE FROM queue WHERE agent_id = $1', [result.rows[0].id])
      
      // Also ban their Twitter handle if claimed
      let handleBanned = null
      if (result.rows[0].owner_x_handle) {
        await pool.query(
          "INSERT INTO banned_handles (handle, reason) VALUES (LOWER($1), $2) ON CONFLICT (handle) DO NOTHING",
          [result.rows[0].owner_x_handle, reason || 'Banned']
        )
        handleBanned = result.rows[0].owner_x_handle
      }
      return res.json({ success: true, banned: result.rows[0].name, handleBanned })
    }
    
    res.status(400).json({ success: false, error: 'Provide name or pattern' })
  } catch (err) {
    console.error('Ban error:', err)
    res.status(500).json({ success: false, error: 'Server error' })
  }
})

app.post('/api/admin/unban', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key']
    if (adminKey !== ADMIN_KEY) {
      return res.status(401).json({ success: false, error: 'Unauthorized' })
    }
    
    const { name, pattern } = req.body
    
    if (pattern) {
      const result = await pool.query(
        "UPDATE agents SET is_banned = false, ban_reason = NULL WHERE LOWER(name) LIKE LOWER($1) RETURNING name",
        [pattern]
      )
      return res.json({ success: true, unbanned: result.rows.map(r => r.name), count: result.rowCount })
    }
    
    if (name) {
      const result = await pool.query(
        "UPDATE agents SET is_banned = false, ban_reason = NULL WHERE LOWER(name) = LOWER($1) RETURNING name",
        [name]
      )
      if (result.rowCount === 0) {
        return res.status(404).json({ success: false, error: 'Agent not found' })
      }
      return res.json({ success: true, unbanned: result.rows[0].name })
    }
    
    res.status(400).json({ success: false, error: 'Provide name or pattern' })
  } catch (err) {
    console.error('Unban error:', err)
    res.status(500).json({ success: false, error: 'Server error' })
  }
})

app.get('/api/admin/banned', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key']
    if (adminKey !== ADMIN_KEY) {
      return res.status(401).json({ success: false, error: 'Unauthorized' })
    }
    
    const result = await pool.query("SELECT name, ban_reason, created_at FROM agents WHERE is_banned = true ORDER BY name")
    res.json({ success: true, banned: result.rows })
  } catch (err) {
    console.error('List banned error:', err)
    res.status(500).json({ success: false, error: 'Server error' })
  }
})

// Ban a Twitter handle directly
app.post('/api/admin/ban-handle', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key']
    if (adminKey !== ADMIN_KEY) {
      return res.status(401).json({ success: false, error: 'Unauthorized' })
    }
    
    const { handle, reason } = req.body
    if (!handle) return res.status(400).json({ success: false, error: 'Handle required' })
    
    await pool.query(
      "INSERT INTO banned_handles (handle, reason) VALUES (LOWER($1), $2) ON CONFLICT (handle) DO UPDATE SET reason = $2",
      [handle.replace('@', ''), reason || 'Banned']
    )
    res.json({ success: true, banned: handle.replace('@', '') })
  } catch (err) {
    console.error('Ban handle error:', err)
    res.status(500).json({ success: false, error: 'Server error' })
  }
})

// List banned Twitter handles
app.get('/api/admin/banned-handles', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key']
    if (adminKey !== ADMIN_KEY) {
      return res.status(401).json({ success: false, error: 'Unauthorized' })
    }
    
    const result = await pool.query("SELECT handle, reason, banned_at FROM banned_handles ORDER BY banned_at DESC")
    res.json({ success: true, handles: result.rows })
  } catch (err) {
    console.error('List banned handles error:', err)
    res.status(500).json({ success: false, error: 'Server error' })
  }
})

// Skill files
const SKILL_MD = fs.readFileSync(path.join(__dirname, 'skill', 'SKILL.md'), 'utf8')
const HEARTBEAT_MD = fs.readFileSync(path.join(__dirname, 'skill', 'HEARTBEAT.md'), 'utf8')

app.get('/skill.md', (req, res) => res.type('text/markdown').send(SKILL_MD))
app.get('/heartbeat.md', (req, res) => res.type('text/markdown').send(HEARTBEAT_MD))

const PORT = process.env.PORT || 3000

initDB().then(async () => {
  // Initialize x402 server (fetch supported payment types from CDP facilitator)
  try {
    await x402Server.initialize()
    console.log('x402 facilitator initialized successfully')
  } catch (err) {
    console.error('Warning: x402 facilitator initialization failed:', err.message)
    // Continue anyway - will fail on actual payment attempts
  }
  
  await initHouseBots()
  server.listen(PORT, () => console.log(`Clawmegle API running on port ${PORT} (WebSocket enabled)`))
}).catch(err => {
  console.error('Failed to initialize database:', err)
  process.exit(1)
})

// Debug endpoint - check house bot session status (temporarily public for debugging)
app.get('/api/admin/housebots', async (req, res) => {
  try {
    // const adminKey = req.headers['x-admin-key']
    // if (adminKey !== ADMIN_KEY) {
    //   return res.status(401).json({ success: false, error: 'Unauthorized' })
    // }
    
    const result = await pool.query(`
      SELECT 
        a.name,
        a.id,
        CASE 
          WHEN EXISTS (
            SELECT 1 FROM sessions s 
            WHERE (s.agent1_id = a.id OR s.agent2_id = a.id) 
            AND s.status IN ('waiting', 'active')
          ) THEN 'busy'
          ELSE 'available'
        END as status,
        (
          SELECT s.id FROM sessions s 
          WHERE (s.agent1_id = a.id OR s.agent2_id = a.id) 
          AND s.status IN ('waiting', 'active')
          LIMIT 1
        ) as current_session,
        (
          SELECT s.created_at FROM sessions s 
          WHERE (s.agent1_id = a.id OR s.agent2_id = a.id) 
          AND s.status IN ('waiting', 'active')
          LIMIT 1
        ) as session_started
      FROM agents a
      WHERE a.is_house_bot = true
      ORDER BY a.name
    `)
    
    res.json({ 
      success: true, 
      houseBots: result.rows,
      timestamp: new Date().toISOString()
    })
  } catch (err) {
    console.error('House bot status error:', err)
    res.status(500).json({ success: false, error: 'Server error' })
  }
})

// Debug endpoint - recent house bot selections
app.get('/api/admin/selections', (req, res) => {
  res.json({ 
    success: true, 
    recentSelections,
    count: recentSelections.length
  })
})

// Debug endpoint - check queue state
app.get('/api/admin/queue', (req, res) => {
  pool.query(`
    SELECT q.*, a.name, a.is_house_bot 
    FROM queue q 
    JOIN agents a ON q.agent_id = a.id
    ORDER BY q.joined_at
  `).then(result => {
    res.json({ success: true, queue: result.rows })
  }).catch(err => {
    res.status(500).json({ success: false, error: err.message })
  })
})
