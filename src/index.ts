import { randomInt } from 'node:crypto'
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  http,
  isAddressEqual,
  parseAbiItem,
  parseEventLogs,
  parseGwei,
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

const sendClient = createPublicClient({
  chain: base,
  transport: http(env.rpcPrimary),
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
let trackedRoundId = 0n
const executedUsersThisRound = new Set<string>()
const BPS = 10_000n
const minMaxFeePerGas = parseGwei(env.minMaxFeeGwei)
const minPriorityFeePerGas = parseGwei(env.minPriorityFeeGwei)

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableNonceError(message: string) {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('replacement transaction underpriced') ||
    normalized.includes('replacement fee too low') ||
    normalized.includes('transaction underpriced') ||
    normalized.includes('nonce too low') ||
    normalized.includes('already known') ||
    normalized.includes('max fee per gas less than block base fee') ||
    normalized.includes('fee cap less than block base fee')
  )
}

function applyBps(value: bigint, bps: bigint) {
  if (value === 0n) return 0n
  return (value * bps + (BPS - 1n)) / BPS
}

function getBufferedGasLimit(minGasForBatch: bigint) {
  const buffered = applyBps(minGasForBatch, BigInt(env.gasLimitBufferBps))
  return buffered > minGasForBatch ? buffered : minGasForBatch
}

async function getFeeOverrides(attempt: number) {
  let baseMaxFeePerGas: bigint | undefined
  let basePriorityFeePerGas: bigint | undefined

  try {
    const feeData = await sendClient.estimateFeesPerGas({ type: 'eip1559' })
    baseMaxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice
    basePriorityFeePerGas = feeData.maxPriorityFeePerGas
  } catch {
    // fallback below
  }

  if (!baseMaxFeePerGas) {
    baseMaxFeePerGas = await sendClient.getGasPrice()
  }
  if (!basePriorityFeePerGas) {
    basePriorityFeePerGas = minPriorityFeePerGas
  }

  const bumpBps = BigInt(env.gasBumpBps + (attempt - 1) * env.gasRetryStepBps)

  let maxFeePerGas = applyBps(baseMaxFeePerGas, bumpBps)
  let maxPriorityFeePerGas = applyBps(basePriorityFeePerGas, bumpBps)

  if (maxFeePerGas < minMaxFeePerGas) {
    maxFeePerGas = minMaxFeePerGas
  }
  if (maxPriorityFeePerGas < minPriorityFeePerGas) {
    maxPriorityFeePerGas = minPriorityFeePerGas
  }
  if (maxFeePerGas <= maxPriorityFeePerGas) {
    maxFeePerGas = maxPriorityFeePerGas + 1n
  }

  return { maxFeePerGas, maxPriorityFeePerGas }
}

async function getActiveUsers(): Promise<Address[]> {
  const total = await sendClient.readContract({
    address: CONTRACTS.autoMiner,
    abi: autoMinerAbi,
    functionName: 'getActiveUserCount',
  }) as bigint

  const users: Address[] = []
  const batchSize = 100n

  for (let offset = 0n; offset < total; offset += batchSize) {
    const chunk = await sendClient.readContract({
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
    sendClient.readContract({
      address: CONTRACTS.autoMiner,
      abi: autoMinerAbi,
      functionName: 'canExecute',
      args: [user],
    }) as Promise<[boolean, string]>,
    sendClient.readContract({
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
    const [currentRoundId, gameStarted, configuredExecutor, minGasForBatch] = await Promise.all([
      sendClient.readContract({
        address: CONTRACTS.gridMining,
        abi: gridMiningAbi,
        functionName: 'currentRoundId',
      }) as Promise<bigint>,
      sendClient.readContract({
        address: CONTRACTS.gridMining,
        abi: gridMiningAbi,
        functionName: 'gameStarted',
      }) as Promise<boolean>,
      sendClient.readContract({
        address: CONTRACTS.autoMiner,
        abi: autoMinerAbi,
        functionName: 'executor',
      }) as Promise<Address>,
      sendClient.readContract({
        address: CONTRACTS.autoMiner,
        abi: autoMinerAbi,
        functionName: 'minGasForBatch',
      }) as Promise<bigint>,
    ])

    if (!isAddressEqual(configuredExecutor, account.address)) {
      throw new Error(`Executor wallet mismatch. Contract expects ${configuredExecutor}, worker has ${account.address}`)
    }

    if (!gameStarted || currentRoundId === 0n) {
      log('protocol not started yet')
      return
    }

    if (trackedRoundId !== currentRoundId) {
      trackedRoundId = currentRoundId
      executedUsersThisRound.clear()
    }

    const currentRound = await sendClient.readContract({
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

    const entries = (await Promise.all(activeUsers.map(getExecutableEntry)))
      .filter((entry): entry is ExecutableEntry => entry !== null)
      .filter((entry) => !executedUsersThisRound.has(entry.user.toLowerCase()))
    if (entries.length === 0) {
      return
    }

    const batches: Array<typeof entries> = []
    for (let index = 0; index < entries.length; index += env.batchSize) {
      batches.push(entries.slice(index, index + env.batchSize))
    }

    for (const batch of batches) {
      const filteredBatch = batch.filter((entry) => !executedUsersThisRound.has(entry.user.toLowerCase()))
      if (filteredBatch.length === 0) {
        continue
      }

      const users = filteredBatch.map((entry) => entry.user)
      const blocks = filteredBatch.map((entry) => entry.blocks)
      const gasLimit = getBufferedGasLimit(minGasForBatch)

      let receipt:
        | Awaited<ReturnType<typeof sendClient.waitForTransactionReceipt>>
        | undefined

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const nonce = await sendClient.getTransactionCount({
            address: account.address,
            blockTag: 'pending',
          })
          const feeOverrides = await getFeeOverrides(attempt)

          log('submitting executeBatch', {
            roundId: currentRoundId.toString(),
            users: users.length,
            nonce,
            attempt,
            gasLimit: gasLimit.toString(),
            maxFeePerGasGwei: formatUnits(feeOverrides.maxFeePerGas, 9),
            maxPriorityFeePerGasGwei: formatUnits(feeOverrides.maxPriorityFeePerGas, 9),
          })

          const request = await sendClient.simulateContract({
            address: CONTRACTS.autoMiner,
            abi: autoMinerAbi,
            functionName: 'executeBatch',
            args: [users, blocks],
            account,
            nonce,
            gas: gasLimit,
            type: 'eip1559',
            ...feeOverrides,
          })

          const hash = await walletClient.writeContract({
            address: CONTRACTS.autoMiner,
            abi: autoMinerAbi,
            functionName: 'executeBatch',
            args: [users, blocks],
            account,
            nonce,
            gas: gasLimit,
            type: 'eip1559',
            ...feeOverrides,
          })
          lastSubmittedAt = Date.now()

          receipt = await sendClient.waitForTransactionReceipt({ hash })

          const events = parseEventLogs({
            abi: [executedForEvent],
            logs: receipt.logs,
            eventName: 'ExecutedFor',
            strict: false,
          }).filter((event) => isAddressEqual(event.address, CONTRACTS.autoMiner))

          const deployedUsers = new Set(events.map((event) => event.args.user?.toLowerCase()))
          for (const user of deployedUsers) {
            if (user) {
              executedUsersThisRound.add(user)
            }
          }

          const totalDeployed = filteredBatch
            .filter((entry) => deployedUsers.has(entry.user.toLowerCase()))
            .reduce((sum, entry) => sum + (entry.config.amountPerBlock * BigInt(entry.config.numBlocks)), 0n)

          log('executeBatch confirmed', {
            roundId: currentRoundId.toString(),
            txHash: hash,
            executedUsers: deployedUsers.size,
            totalDeployedEth: formatEther(totalDeployed),
          })
          break
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (attempt < 3 && isRetryableNonceError(message)) {
            log('retrying executeBatch after nonce error', { attempt, error: message })
            await sleep(1200)
            continue
          }
          throw error
        }
      }

      if (!receipt) {
        throw new Error('executeBatch did not return a receipt')
      }
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
