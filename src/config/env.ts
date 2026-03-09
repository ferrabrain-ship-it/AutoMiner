import 'dotenv/config'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required env: ${name}`)
  }
  return value
}

export const env = {
  rpcPrimary: process.env.RPC_URL_PRIMARY || 'https://mainnet.base.org',
  rpcFallback1: process.env.RPC_URL_FALLBACK_1 || 'https://base.llamarpc.com',
  rpcFallback2: process.env.RPC_URL_FALLBACK_2 || 'https://rpc.ankr.com/base',
  rpcFallback3: process.env.RPC_URL_FALLBACK_3 || 'https://base-rpc.publicnode.com',
  executorPrivateKey: requireEnv('EXECUTOR_PRIVATE_KEY') as `0x${string}`,
  batchSize: Number(process.env.EXECUTOR_BATCH_SIZE || 20),
  pollIntervalMs: Number(process.env.EXECUTOR_POLL_INTERVAL_MS || 5000),
  minRoundBufferMs: Number(process.env.EXECUTOR_MIN_ROUND_BUFFER_MS || 20000),
}
