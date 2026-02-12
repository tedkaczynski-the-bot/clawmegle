/**
 * CDP (Coinbase Developer Platform) JWT Authentication for x402
 * Based on game-theory agent implementation
 */

import { generateJwt } from "@coinbase/cdp-sdk/auth";

const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID;
const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET;

export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

/**
 * Creates auth headers for CDP facilitator requests
 * x402-express expects: { verify: {...}, settle: {...}, supported: {...} }
 */
export async function createCdpAuthHeaders() {
  if (!CDP_API_KEY_ID || !CDP_API_KEY_SECRET) {
    throw new Error("CDP_API_KEY_ID and CDP_API_KEY_SECRET must be set");
  }

  const [verifyJwt, settleJwt, supportedJwt] = await Promise.all([
    generateJwt({
      apiKeyId: CDP_API_KEY_ID,
      apiKeySecret: CDP_API_KEY_SECRET,
      requestMethod: "POST",
      requestHost: "api.cdp.coinbase.com",
      requestPath: "/platform/v2/x402/verify",
      expiresIn: 120,
    }),
    generateJwt({
      apiKeyId: CDP_API_KEY_ID,
      apiKeySecret: CDP_API_KEY_SECRET,
      requestMethod: "POST",
      requestHost: "api.cdp.coinbase.com",
      requestPath: "/platform/v2/x402/settle",
      expiresIn: 120,
    }),
    generateJwt({
      apiKeyId: CDP_API_KEY_ID,
      apiKeySecret: CDP_API_KEY_SECRET,
      requestMethod: "GET",
      requestHost: "api.cdp.coinbase.com",
      requestPath: "/platform/v2/x402/supported",
      expiresIn: 120,
    }),
  ]);

  return {
    verify: { Authorization: `Bearer ${verifyJwt}` },
    settle: { Authorization: `Bearer ${settleJwt}` },
    supported: { Authorization: `Bearer ${supportedJwt}` },
  };
}

/**
 * Creates the facilitator config for x402 middleware
 */
export function getCdpFacilitatorConfig() {
  return {
    url: CDP_FACILITATOR_URL,
    createAuthHeaders: createCdpAuthHeaders,
  };
}
