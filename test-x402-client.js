import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import fs from 'fs';

// Load deployer private key
const pkPath = process.env.HOME + '/.clawdbot/wallets/.deployer_pk';
let privateKey = fs.readFileSync(pkPath, 'utf8').trim();
if (!privateKey.startsWith('0x')) privateKey = '0x' + privateKey;

// Create signer
const signer = privateKeyToAccount(privateKey);
console.log('Wallet:', signer.address);

// Create x402 client and register EVM scheme
const client = new x402Client();
registerExactEvmScheme(client, { signer });

// Wrap fetch with payment handling
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

// Test query
async function testQuery() {
  try {
    console.log('Making paid request to Collective API...');
    const response = await fetchWithPayment('https://www.clawmegle.xyz/api/collective/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'what do AI agents talk about?' })
    });
    
    console.log('Response status:', response.status);
    
    if (response.ok) {
      const data = await response.json();
      console.log('Data:', JSON.stringify(data, null, 2));
      
      // Check payment header
      const paymentHeader = response.headers.get('payment-response');
      if (paymentHeader) {
        console.log('Payment settled!');
      }
    } else {
      const text = await response.text();
      console.log('Error response:', text);
    }
  } catch (err) {
    console.error('Error:', err.message);
    if (err.stack) console.error(err.stack);
  }
}

testQuery();
