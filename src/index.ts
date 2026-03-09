import { randomInt } from 'node:crypto'
import {
  createPublicClient,
  createWalletClient,
  fallback,
  formatEther,
  http,
  isAddressEqual,
  parseAbiItem,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import autoMinerAbi from './abis/AutoMiner.json' with { type: 'json' }
import gridMiningAbi from './abis/GridMining.json' with { type: 'json' }
import { CONTRACTS, GRID_SIZE } from './config/contracts.js'
import { env } from './config/env.js'

type Address = `0x${string}`

type AutoConfig = {
  strategyId: number
  numBlocks: number
  active: boolean
  executorFeeBps: number
  selectedBlockMask: number
  amountPerBlock: bigint
  numRounds: bigint
  roundsExecuted: bigint
  depositAmount: bigint
  depositTimestamp: number
  executorFlatFee: bigint
}

type ExecutableEntry = {
  user: Address
  config: AutoConfig
  blocks: number[]
}

const account = privateKeyToAccount(env.executorPrivateKey)

const publicClient = createPublicClient({
  chain: base,
  transport: fallback([
    http(env.rpcPrimary),
    http(env.rpcFallback1),
    http(env.rpcFallback2),
    http(env.rpcFallback3),
  ]),
})

const walletClient = createWalletClient({
  account,
  chain: base,
  transport: http(env.rpcPrimary),
})

const executedForEvent = parseAbiItem(
  'event ExecutedFor(address indexed user, uint64 indexed roundId, uint8[] blocks, uint256 totalDeployed, uint256 fee, uint256 roundsExecuted)'
)

let isTickRunning = false
let lastSubmittedAt = 0

function log(message: string, extra?: Record<string, unknown>) {
  if (extra) {
    console.log(`[executor] ${message}`, extra)
    return
  }
  console.log(`[executor] ${message}`)
}

function buildAllBlocks(): number[] {
  return Array.from({ length: GRID_SIZE }, (_, index) => index)
}

function buildRandomBlocks(numBlocks: number): number[] {
  const picked = new Set<number>()
  while (picked.size < numBlocks) {
    picked.add(randomInt(0, GRID_SIZE))
  }
  return [...picked]
}

async function getActiveUsers(): Promise<Address[]> {
  const total = await publicClient.readContract({
    address: CONTRACTS.autoMiner,
    abi: autoMinerAbi,
    functionName: 'getActiveUserCount',
  }) as bigint

  const users: Address[] = []
  const batchSize = 100n

  for (let offset = 0n; offset < total; offset += batchSize) {
    const chunk = await publicClient.readContract({
      address: CONTRACTS.autoMiner,
      abi: autoMinerAbi,
      functionName: 'getActiveUsers',
      args: [offset, batchSize],
    }) as Address[]

    users.push(...chunk)
  }

  return users
}

async function getExecutableEntry(user: Address): Promise<ExecutableEntry | null> {
  const [canExecute, state] = await Promise.all([
    publicClient.readContract({
      address: CONTRACTS.autoMiner,
      abi: autoMinerAbi,
      functionName: 'canExecute',
      args: [user],
    }) as Promise<[boolean, string]>,
    publicClient.readContract({
      address: CONTRACTS.autoMiner,
      abi: autoMinerAbi,
      functionName: 'getUserState',
      args: [user],
    }) as Promise<[AutoConfig, bigint, bigint, bigint, bigint]>,
  ])

  if (!canExecute[0]) {
    return null
  }

  const config = state[0]
  let blocks: number[] = []

  if (config.strategyId === 1) {
    blocks = buildAllBlocks()
  } else if (config.strategyId === 0) {
    blocks = buildRandomBlocks(Number(config.numBlocks))
  }

  return { user, config, blocks }
}

async function tick() {
  if (isTickRunning) {
    return
  }

  isTickRunning = true

  try {
    const [currentRoundId, gameStarted, configuredExecutor] = await Promise.all([
      publicClient.readContract({
        address: CONTRACTS.gridMining,
        abi: gridMiningAbi,
        functionName: 'currentRoundId',
      }) as Promise<bigint>,
      publicClient.readContract({
        address: CONTRACTS.gridMining,
        abi: gridMiningAbi,
        functionName: 'gameStarted',
      }) as Promise<boolean>,
      publicClient.readContract({
        address: CONTRACTS.autoMiner,
        abi: autoMinerAbi,
        functionName: 'executor',
      }) as Promise<Address>,
    ])

    if (!isAddressEqual(configuredExecutor, account.address)) {
      throw new Error(`Executor wallet mismatch. Contract expects ${configuredExecutor}, worker has ${account.address}`)
    }

    if (!gameStarted || currentRoundId === 0n) {
      log('protocol not started yet')
      return
    }

    const currentRound = await publicClient.readContract({
      address: CONTRACTS.gridMining,
      abi: gridMiningAbi,
      functionName: 'rounds',
      args: [currentRoundId],
    }) as [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      number,
      Address,
      bigint,
      bigint,
      bigint,
      bigint,
      boolean,
    ]

    const endTimeMs = Number(currentRound[1]) * 1000
    const settled = currentRound[11]
    // When the round is too close to ending, skip new executions and let them roll into the next round.
    if (settled || Date.now() >= endTimeMs - env.minRoundBufferMs) {
      return
    }

    if (Date.now() - lastSubmittedAt < 2500) {
      return
    }

    const activeUsers = await getActiveUsers()
    if (activeUsers.length === 0) {
      return
    }

    const entries = (await Promise.all(activeUsers.map(getExecutableEntry))).filter(
      (entry): entry is ExecutableEntry => entry !== null
    )
    if (entries.length === 0) {
      return
    }

    const batches: Array<typeof entries> = []
    for (let index = 0; index < entries.length; index += env.batchSize) {
      batches.push(entries.slice(index, index + env.batchSize))
    }

    for (const batch of batches) {
      const users = batch.map((entry) => entry.user)
      const blocks = batch.map((entry) => entry.blocks)

      log('submitting executeBatch', {
        roundId: currentRoundId.toString(),
        users: users.length,
      })

      const request = await publicClient.simulateContract({
        address: CONTRACTS.autoMiner,
        abi: autoMinerAbi,
        functionName: 'executeBatch',
        args: [users, blocks],
        account,
      })

      const hash = await walletClient.writeContract(request.request)
      lastSubmittedAt = Date.now()

      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      const events = await publicClient.getContractEvents({
        address: CONTRACTS.autoMiner,
        abi: [executedForEvent],
        eventName: 'ExecutedFor',
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      })

      const deployedUsers = new Set(events.map((event) => event.args.user?.toLowerCase()))
      const totalDeployed = batch
        .filter((entry) => deployedUsers.has(entry.user.toLowerCase()))
        .reduce((sum, entry) => sum + (entry.config.amountPerBlock * BigInt(entry.config.numBlocks)), 0n)

      log('executeBatch confirmed', {
        roundId: currentRoundId.toString(),
        txHash: hash,
        executedUsers: deployedUsers.size,
        totalDeployedEth: formatEther(totalDeployed),
      })
    }
  } catch (error) {
    console.error('[executor] tick failed', error)
  } finally {
    isTickRunning = false
  }
}

async function main() {
  log('starting MineLoot executor', {
    executor: account.address,
    autoMiner: CONTRACTS.autoMiner,
    gridMining: CONTRACTS.gridMining,
  })

  await tick()
  setInterval(() => {
    void tick()
  }, env.pollIntervalMs)
}

void main()
