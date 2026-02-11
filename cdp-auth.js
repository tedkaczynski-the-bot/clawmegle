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
 * HTTPFacilitatorClient calls this with endpoint name ("verify", "settle", "supported")
 * and expects { headers: { Authorization: "Bearer ..." } }
 */
export async function createCdpAuthHeaders(endpoint) {
  if (!CDP_API_KEY_ID || !CDP_API_KEY_SECRET) {
    throw new Error("CDP_API_KEY_ID and CDP_API_KEY_SECRET must be set");
  }

  const endpointConfig = {
    verify: { method: "POST", path: "/platform/v2/x402/verify" },
    settle: { method: "POST", path: "/platform/v2/x402/settle" },
    supported: { method: "GET", path: "/platform/v2/x402/supported" },
  };

  const config = endpointConfig[endpoint] || endpointConfig.verify;

  const jwt = await generateJwt({
    apiKeyId: CDP_API_KEY_ID,
    apiKeySecret: CDP_API_KEY_SECRET,
    requestMethod: config.method,
    requestHost: "api.cdp.coinbase.com",
    requestPath: config.path,
    expiresIn: 120,
  });

  return {
    headers: { Authorization: `Bearer ${jwt}` }
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
