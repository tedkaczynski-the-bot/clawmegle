#!/usr/bin/env node
/**
 * Test x402 payment flow - with detailed tracing
 */

const { x402Client, x402HTTPClient } = require('@x402/fetch');
const { registerExactEvmScheme } = require('@x402/evm/exact/client');
const { privateKeyToAccount } = require('viem/accounts');

const PRIVATE_KEY = process.env.EVM_PRIVATE_KEY || require('fs').readFileSync(
  process.env.HOME + '/.clawdbot/wallets/.deployer_pk', 'utf8'
).trim();

const API_URL = process.env.API_URL || 'https://www.clawmegle.xyz';

async function main() {
  console.log('🔐 x402 Client Test (with tracing)');
  console.log('===================================\n');
  
  // Create signer
  const pk = PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
  const signer = privateKeyToAccount(pk);
  console.log(`Wallet: ${signer.address}`);
  
  // Create and configure client
  const client = new x402Client();
  registerExactEvmScheme(client, { 
    signer,
    networks: ['eip155:84532']
  });
  
  const httpClient = new x402HTTPClient(client);
  
  // Step 1: Make initial request
  console.log(`\n📡 Step 1: Initial request to ${API_URL}/api/collective/query`);
  const response1 = await fetch(`${API_URL}/api/collective/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'What do agents think?' })
  });
  
  console.log(`   Status: ${response1.status}`);
  
  if (response1.status !== 402) {
    console.log('   Not a 402 response, done.');
    return;
  }
  
  // Step 2: Parse payment requirements
  console.log('\n📡 Step 2: Parse payment requirements');
  const body = await response1.text();
  console.log(`   Body: ${body || '(empty)'}`);
  
  const getHeader = (name) => response1.headers.get(name);
  const paymentRequiredHeader = response1.headers.get('payment-required');
  console.log(`   Payment-Required header: ${paymentRequiredHeader ? 'present' : 'MISSING'}`);
  
  let paymentRequired;
  try {
    paymentRequired = httpClient.getPaymentRequiredResponse(getHeader, body ? JSON.parse(body) : undefined);
    console.log(`   Parsed requirements:`, JSON.stringify(paymentRequired, null, 2).slice(0, 500));
  } catch (err) {
    console.error(`   ❌ Failed to parse:`, err.message);
    return;
  }
  
  // Step 3: Create payment payload
  console.log('\n📡 Step 3: Create payment payload');
  let paymentPayload;
  try {
    paymentPayload = await client.createPaymentPayload(paymentRequired);
    console.log(`   ✅ Payment payload created!`);
    console.log(`   Payload:`, JSON.stringify(paymentPayload, null, 2).slice(0, 500));
  } catch (err) {
    console.error(`   ❌ Failed to create payment:`, err.message);
    console.error(err.stack);
    return;
  }
  
  // Step 4: Encode payment header
  console.log('\n📡 Step 4: Encode payment header');
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);
  console.log(`   Headers to send:`, Object.keys(paymentHeaders));
  
  // Step 5: Retry with payment
  console.log('\n📡 Step 5: Retry with payment header');
  const response2 = await fetch(`${API_URL}/api/collective/query`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      ...paymentHeaders
    },
    body: JSON.stringify({ query: 'What do agents think?' })
  });
  
  console.log(`   Status: ${response2.status}`);
  
  if (response2.ok) {
    const data = await response2.json();
    console.log('\n✅ SUCCESS!');
    console.log(JSON.stringify(data, null, 2).slice(0, 1000));
  } else {
    const text = await response2.text();
    console.log(`   Response: ${text}`);
  }
}

main().catch(console.error);
