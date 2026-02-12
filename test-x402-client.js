import { x402Client, wrapFetchWithPayment, x402HTTPClient } from '@x402/fetch';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import fs from 'fs';

// Load test payer private key (different from payTo to avoid self-payment rejection)
const pkPath = process.env.HOME + '/.clawdbot/wallets/.test_payer_pk';
let privateKey = fs.readFileSync(pkPath, 'utf8').trim();
if (!privateKey.startsWith('0x')) privateKey = '0x' + privateKey;

const account = privateKeyToAccount(privateKey);
console.log('Wallet:', account.address);

const client = new x402Client();
registerExactEvmScheme(client, { signer: account });

const httpClient = new x402HTTPClient(client);

async function test() {
  // Step 1: Get 402
  console.log('\n1. Getting payment requirements...');
  const res1 = await fetch('https://clawmegle-production.up.railway.app/api/collective/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'test' })
  });
  
  const getHeader = (name) => res1.headers.get(name);
  const paymentRequired = httpClient.getPaymentRequiredResponse(getHeader, {});
  console.log('   Got requirements');

  // Step 2: Create payload
  console.log('\n2. Creating payment...');
  const paymentPayload = await client.createPaymentPayload(paymentRequired);
  console.log('   Payload x402Version:', paymentPayload.x402Version);
  
  // Step 3: Encode
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);
  const signature = paymentHeaders['PAYMENT-SIGNATURE'];
  
  // Decode to see what we're sending
  const decoded = JSON.parse(Buffer.from(signature, 'base64').toString());
  console.log('\n3. Payment signature contents:');
  console.log(JSON.stringify(decoded, null, 2));

  // Step 4: Send with payment
  console.log('\n4. Sending with payment...');
  const res2 = await fetch('https://clawmegle-production.up.railway.app/api/collective/query', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'PAYMENT-SIGNATURE': signature
    },
    body: JSON.stringify({ query: 'what do AI agents talk about?' })
  });
  
  console.log('   Status:', res2.status);
  
  // Check for error response
  const responseHeaders = {};
  res2.headers.forEach((v, k) => responseHeaders[k] = v);
  console.log('   Response headers:', Object.keys(responseHeaders).filter(k => k.toLowerCase().includes('payment')));
  
  const body = await res2.text();
  console.log('   Body:', body.slice(0, 500));
}

test().catch(e => console.error('Error:', e));
