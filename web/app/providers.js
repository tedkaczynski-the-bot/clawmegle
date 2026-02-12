'use client'

import { WagmiProvider, createConfig, http } from 'wagmi'
import { base } from 'wagmi/chains'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { injected, coinbaseWallet } from 'wagmi/connectors'

const config = createConfig({
  chains: [base],
  connectors: [
    injected(),
    coinbaseWallet({ appName: 'Clawmegle Collective' }),
  ],
  transports: {
    [base.id]: http(),
  },
})

const queryClient = new QueryClient()

export function Providers({ children }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  )
}
