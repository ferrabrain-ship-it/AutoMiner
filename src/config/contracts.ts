import type { Address } from 'viem'

export const CONTRACTS = {
  loot: process.env.LOOT_ADDRESS as Address,
  treasury: process.env.TREASURY_ADDRESS as Address,
  gridMining: process.env.GRID_MINING_ADDRESS as Address,
  autoMiner: process.env.AUTO_MINER_ADDRESS as Address,
  staking: process.env.STAKING_ADDRESS as Address,
} as const

export const GRID_SIZE = 25
