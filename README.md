# MineLoot Executor

Separate worker service for `AutoMiner`.

What it does:
- polls the current round on Base
- reads active AutoMiner users from the contract
- builds the correct block arrays for each strategy
- sends `executeBatch()` from the configured executor wallet
- skips new executions in the last 20 seconds of a round so they roll into the next one

## Setup

```bash
cd /Users/brain/.openclaw/workspace/mineloot-executor
cp .env.example .env
npm install
npm run dev
```

Required env:
- `EXECUTOR_PRIVATE_KEY`

Important:
- the wallet from `EXECUTOR_PRIVATE_KEY` must match `AutoMiner.executor()`
- `GridMining.autoMiner` must point to the deployed `AutoMiner`
- this worker must stay online during active rounds

## Strategies

- `0` Random: executor generates unique random blocks
- `1` All: executor submits blocks `0..24`
- `2` Select: executor sends an empty array; contract uses stored bitmask

## Production

Build and run:

```bash
npm run build
npm run start
```

## Railway

Use it as a normal long-running service, not a cron job.

- Root directory: `mineloot-executor`
- Build command:

```bash
npm install && npm run build
```

- Start command:

```bash
npm run start
```

Required Railway env:

```env
RPC_URL_PRIMARY=https://mainnet.base.org
RPC_URL_FALLBACK_1=https://base.llamarpc.com
RPC_URL_FALLBACK_2=https://rpc.ankr.com/base
RPC_URL_FALLBACK_3=https://base-rpc.publicnode.com

EXECUTOR_PRIVATE_KEY=0x...

EXECUTOR_BATCH_SIZE=20
EXECUTOR_POLL_INTERVAL_MS=5000
EXECUTOR_MIN_ROUND_BUFFER_MS=20000

LOOT_ADDRESS=0x00E701Eff4f9Dc647f1510f835C5d1ee7E41D28f
TREASURY_ADDRESS=0x89885D1E97e211B6DeC8436F7E3456b06EB24c68
GRID_MINING_ADDRESS=0xA8E2F506aDcbBF18733A9F0f32e3D70b1A34d723
AUTO_MINER_ADDRESS=0x4b99Ebe4F9220Bd5206199b10dFC039a6a73eDBC
STAKING_ADDRESS=0x554CEAe7b091b21DdAeFe65cF79651132Ee84Ed7
```

Important:
- `EXECUTOR_PRIVATE_KEY` must match the wallet configured on-chain as `AutoMiner.executor()`
- current on-chain executor: `0xdF662217C14c8CD42aa1c9b19487602448193454`
- with the default `EXECUTOR_MIN_ROUND_BUFFER_MS=20000`, any user not executed in the final 20 seconds waits for the next round
