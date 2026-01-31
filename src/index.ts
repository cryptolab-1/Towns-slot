import { makeTownsBot } from '@towns-protocol/bot'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { readContract, waitForTransactionReceipt } from 'viem/actions'
import { encodeFunctionData } from 'viem'
import { execute } from 'viem/experimental/erc7821'
import commands from './commands'

// Slot machine symbols
const SLOT_SYMBOLS = ['🍒', '🍋', '🍊', '🍇', '🍉', '⭐', '💎', '🎰'] as const

// Entry fee: $0.25 USDC per game (USDC has 6 decimals)
const ENTRY_FEE_DOLLARS = 0.25
const ENTRY_FEE_USDC_UNITS = BigInt(250_000) // 0.25 * 1e6

// USDC on Base (chain 8453)
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const

const erc20Abi = [
    { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
    { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const

async function getUsdcBalance(
    client: { request: (args: unknown) => Promise<unknown> },
    address: `0x${string}`,
): Promise<bigint> {
    return readContract(client as Parameters<typeof readContract>[0], {
        address: USDC_ADDRESS as `0x${string}`,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address],
    })
}

function formatUsdc(units: bigint): string {
    return (Number(units) / 1e6).toFixed(2)
}

// Deployer wallet address (receives 10% fee on payouts)
const DEPLOYER_ADDRESS = process.env.DEPLOYER_ADDRESS as `0x${string}`

// Payout structure: Fixed amounts for small wins, percentage for jackpot
const PAYOUT_STRUCTURE = {
    threeDiamonds: { type: 'percentage' as const, value: 100 }, // 100% of jackpot (JACKPOT!)
    threeOfAKind: { type: 'fixed' as const, multiplier: 3 }, // 3x entry fee (fixed)
    twoOfAKind: { type: 'fixed' as const, multiplier: 1 }, // 1x entry fee (fixed)
    noMatch: { type: 'fixed' as const, multiplier: 0 }, // 0 (no win)
} as const

// Fee percentage (10% of payout goes to deployer)
const FEE_PERCENTAGE = 10

function spinSlotMachine(): [string, string, string] {
    const symbols = [...SLOT_SYMBOLS]
    return [
        symbols[Math.floor(Math.random() * symbols.length)],
        symbols[Math.floor(Math.random() * symbols.length)],
        symbols[Math.floor(Math.random() * symbols.length)],
    ]
}

function calculateWinnings(symbols: [string, string, string]): { 
    payoutType: 'fixed' | 'percentage'
    payoutValue: number // multiplier for fixed, percentage for percentage
    message: string 
} {
    const [a, b, c] = symbols

    // Three of a kind
    if (a === b && b === c) {
        if (a === '💎') {
            return {
                payoutType: PAYOUT_STRUCTURE.threeDiamonds.type,
                payoutValue: PAYOUT_STRUCTURE.threeDiamonds.value,
                message: '🎉 JACKPOT! Three diamonds! 🎉',
            }
        }
        return {
            payoutType: PAYOUT_STRUCTURE.threeOfAKind.type,
            payoutValue: PAYOUT_STRUCTURE.threeOfAKind.multiplier,
            message: `🎊 Three of a kind! ${a} ${a} ${a}`,
        }
    }

    // Two of a kind
    if (a === b || b === c || a === c) {
        return {
            payoutType: PAYOUT_STRUCTURE.twoOfAKind.type,
            payoutValue: PAYOUT_STRUCTURE.twoOfAKind.multiplier,
            message: '✨ Two of a kind!',
        }
    }

    // No match
    return {
        payoutType: PAYOUT_STRUCTURE.noMatch.type,
        payoutValue: PAYOUT_STRUCTURE.noMatch.multiplier,
        message: '😔 No match, better luck next time!',
    }
}

function formatSlotResult(
    symbols: [string, string, string],
    winnings: { payoutType: 'fixed' | 'percentage'; payoutValue: number; message: string },
    jackpotAmount: bigint,
    winnerPayout: bigint,
    hasFee: boolean,
    gameNumber?: number,
    totalGames?: number,
): string {
    const [a, b, c] = symbols
    const jackpotUsdc = formatUsdc(jackpotAmount)
    const title = totalGames && totalGames > 1 ? `🎰 GAME ${gameNumber}/${totalGames} 🎰` : '🎰 SLOT MACHINE 🎰'

    let result =
        `${title}\n\n` +
        '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
        `[ ${a} | ${b} | ${c} ]\n\n` +
        `${winnings.message}\n\n` +
        `💰 Current Jackpot: $${jackpotUsdc} USDC`

    if (winnings.payoutType === 'percentage' && winnings.payoutValue > 0) {
        result +=
            `\n\n🎁 You won ${winnings.payoutValue}% of the jackpot!` +
            `\n\n💵 Your payout: $${formatUsdc(winnerPayout)} USDC`
        if (hasFee) {
            result += `\n\n📝 10% fee deducted`
        }
    } else if (winnings.payoutType === 'fixed' && winnings.payoutValue > 0) {
        result +=
            `\n\n💵 Your payout: $${formatUsdc(winnerPayout)} USDC`
        if (hasFee) {
            result += `\n\n📝 10% fee deducted`
        }
    } else if (hasFee) {
        result += `\n\n📝 10% fee applies on winning spins`
    }

    return result
}

function formatMultiGameSummary(
    totalWinnings: bigint,
    totalPayout: bigint,
    hasFee: boolean,
    numGames: number,
): string {
    let summary = `\n\n🎉 **TOTAL RESULTS (${numGames} games):**\n\n`
    summary += `💰 **Total Winnings:** $${formatUsdc(totalWinnings)} USDC\n`
    summary += `💵 **Total Payout:** $${formatUsdc(totalPayout)} USDC`
    if (hasFee) {
        summary += `\n📝 *10% fee deducted from each win*`
    }
    return summary
}

// Validate required environment variables
if (!process.env.APP_PRIVATE_DATA) {
    throw new Error('APP_PRIVATE_DATA environment variable is required but not set')
}
if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required but not set')
}

const bot = await makeTownsBot(process.env.APP_PRIVATE_DATA, process.env.JWT_SECRET, {
    commands,
})

bot.onSlashCommand('jackpot', async (handler, { channelId }) => {
    console.log('Jackpot command received')
    try {
        const jackpot = await getUsdcBalance(bot.viem, bot.appAddress as `0x${string}`)
        await handler.sendMessage(
            channelId,
            `💰 **Current Jackpot:** $${formatUsdc(jackpot)} USDC`,
        )
    } catch (error) {
        console.error('Error fetching jackpot:', error)
        await handler.sendMessage(
            channelId,
            '⚠️ **Error:** Unable to fetch jackpot value. Please try again in a moment.',
        )
    }
})

bot.onSlashCommand('slot', async (handler, { channelId, userId }) => {
    console.log('Slot command received from user:', userId)
    const jackpot = await getUsdcBalance(bot.viem, bot.appAddress as `0x${string}`)
    await handler.sendMessage(
        channelId,
        '🎰 **Welcome to the Slot Machine!** 🎰\n\n' +
            `To play, send me a tip of **$${ENTRY_FEE_DOLLARS.toFixed(2)} USDC** per game\n\n` +
            '**How to play:**\n' +
            `1. Tip me $${ENTRY_FEE_DOLLARS.toFixed(2)} USDC for 1 game\n` +
            `2. Tip me more to play multiple games! (e.g., $${(ENTRY_FEE_DOLLARS * 4).toFixed(2)} = 4 games)\n` +
            '3. I\'ll spin the reels for you!\n\n' +
            `💰 **Current Jackpot:** $${formatUsdc(jackpot)} USDC\n\n` +
            '**Payouts:**\n' +
            '• Three 💎 = 100% of jackpot (JACKPOT!)\n' +
            '• Three of a kind = 3x entry fee (fixed)\n' +
            '• Two of a kind = 1x entry fee (fixed)\n' +
            '• No match = 0\n\n' +
            'Good luck! 🍀',
    )
    console.log('Slot command response sent')
})

bot.onMessage(async (handler, { message, channelId, eventId, createdAt }) => {
    if (message.includes('hello')) {
        await handler.sendMessage(channelId, 'Hello there! 👋')
        return
    }
    if (message.includes('ping')) {
        const now = new Date()
        await handler.sendMessage(channelId, `Pong! 🏓 ${now.getTime() - createdAt.getTime()}ms`)
        return
    }
    if (message.includes('react')) {
        await handler.sendReaction(channelId, eventId, '👍')
        return
    }
})

bot.onReaction(async (handler, { reaction, channelId }) => {
    if (reaction === '👋') {
        await handler.sendMessage(channelId, 'I saw your wave! 👋')
    }
})


bot.onTip(async (handler, event) => {
    console.log('Tip event received:', {
        senderAddress: event.senderAddress,
        receiverAddress: event.receiverAddress,
        amount: event.amount.toString(),
        channelId: event.channelId,
        messageId: event.messageId,
        userId: event.userId,
        spaceId: event.spaceId,
    })
    
    // Check if tip is to the bot
    if (event.receiverAddress !== bot.appAddress) {
        return
    }
    
    // Validate required fields for sendTip
    if (!event.channelId || !event.messageId) {
        console.error('Missing required fields for sendTip:', {
            channelId: event.channelId,
            messageId: event.messageId,
        })
        await handler.sendMessage(
            event.channelId || event.spaceId,
            '⚠️ Error: Missing channel information. Cannot process payout.',
            event.messageId ? { threadId: event.messageId } : undefined,
        )
        return
    }

    // Tip must be exact multiple of $0.25 USDC (250_000 units, 6 decimals)
    if (event.amount < ENTRY_FEE_USDC_UNITS || event.amount % ENTRY_FEE_USDC_UNITS !== BigInt(0)) {
        await handler.sendMessage(
            event.channelId,
            `❌ Invalid tip amount!\n\n` +
                `You sent: $${formatUsdc(event.amount)} USDC\n` +
                `Required: $${ENTRY_FEE_DOLLARS.toFixed(2)} USDC per game\n\n` +
                `Tip must be a multiple of $${ENTRY_FEE_DOLLARS.toFixed(2)} to play! 🎰\n` +
                `Examples: $${ENTRY_FEE_DOLLARS.toFixed(2)} (1 game), $${(ENTRY_FEE_DOLLARS * 4).toFixed(2)} (4 games)`,
            { threadId: event.messageId },
        )
        return
    }

    const numGames = Number(event.amount / ENTRY_FEE_USDC_UNITS)

    // Send countdown message to give players time to join the thread
    await handler.sendMessage(
        event.channelId,
        `🎰 **Slot Machine Game Starting!**\n\n` +
            `👤 Player: <@${event.userId}>\n\n` +
            `⏱️ Starting in **10** seconds...`,
        { threadId: event.messageId }
    )

    // Wait 5 seconds, then show 5
    await new Promise(resolve => setTimeout(resolve, 5000))
    await handler.sendMessage(
        event.channelId,
        `⏱️ Starting in **5** seconds...`,
        { threadId: event.messageId }
    )

    // Wait 5 more seconds, then show start
    await new Promise(resolve => setTimeout(resolve, 5000))
    await handler.sendMessage(
        event.channelId,
        `🚀 **Starting now!**`,
        { threadId: event.messageId }
    )

    let jackpot = await getUsdcBalance(bot.viem, bot.appAddress as `0x${string}`)

    // Track total winnings and payouts across all games
    let totalWinnings = BigInt(0)
    let totalPayout = BigInt(0)
    let totalDeployerFee = BigInt(0)
    const gameResults: string[] = []

    // Play multiple games
    for (let gameNum = 1; gameNum <= numGames; gameNum++) {
        // Use the current jackpot (which may have been reduced by previous wins)
        const currentJackpot = jackpot
        
        // Spin the slot machine!
        const symbols = spinSlotMachine()
        const winnings = calculateWinnings(symbols)

        // Calculate payout based on payout type (fixed or percentage)
        let payoutAmount = BigInt(0)
        let winnerPayout = BigInt(0)
        let hasFee = false

        if (winnings.payoutType === 'percentage' && winnings.payoutValue > 0) {
            // Percentage payout (three diamonds) - percentage of jackpot
            const percentageMultiplier = BigInt(winnings.payoutValue)
            payoutAmount = (currentJackpot * percentageMultiplier) / BigInt(100)
        } else if (winnings.payoutType === 'fixed' && winnings.payoutValue > 0) {
            payoutAmount = ENTRY_FEE_USDC_UNITS * BigInt(winnings.payoutValue)
        }

        if (payoutAmount > 0) {
            // Calculate fee (10% of payout goes to deployer, if deployer address is set)
            let feeAmount = BigInt(0)
            winnerPayout = payoutAmount

            if (DEPLOYER_ADDRESS) {
                feeAmount = (payoutAmount * BigInt(FEE_PERCENTAGE)) / BigInt(100)
                winnerPayout = payoutAmount - feeAmount
                hasFee = true
                totalDeployerFee += feeAmount
            }

            // Reduce jackpot by the full payout amount for the next game
            // This ensures subsequent games use the reduced jackpot
            // Note: We reduce by payoutAmount (not winnerPayout) because the full amount
            // comes out of the jackpot, even though some goes to the deployer as a fee
            jackpot -= payoutAmount

            // Accumulate totals
            totalWinnings += payoutAmount
            totalPayout += winnerPayout
        }

        // Format and store result for this game (use the jackpot that was used for calculation)
        const result = formatSlotResult(symbols, winnings, currentJackpot, winnerPayout, hasFee, gameNum, numGames)
        gameResults.push(result)
    }

    // Send all game results in thread (use threadId to continue in thread, not replyId to avoid quoting)
    for (const result of gameResults) {
        await handler.sendMessage(event.channelId, result, { threadId: event.messageId })
    }

    // Send total summary if multiple games
    if (numGames > 1) {
        const summary = formatMultiGameSummary(totalWinnings, totalPayout, !!DEPLOYER_ADDRESS, numGames)
        await handler.sendMessage(event.channelId, summary, { threadId: event.messageId })
    }

    // Automatically send payout when user wins (USDC)
    if (totalPayout > 0) {
        const payoutUsdc = formatUsdc(totalPayout)
        try {
            const { getSmartAccountFromUserId } = await import('@towns-protocol/bot')
            const winnerWallet = await getSmartAccountFromUserId(bot, { userId: event.userId })
            if (!winnerWallet) {
                throw new Error('Could not find winner wallet')
            }

            // USDC transfers: user payout + optional deployer fee in one execute()
            const calls: Array<{ to: `0x${string}`; value: bigint; data: `0x${string}` }> = [
                {
                    to: USDC_ADDRESS as `0x${string}`,
                    value: BigInt(0),
                    data: encodeFunctionData({
                        abi: erc20Abi,
                        functionName: 'transfer',
                        args: [winnerWallet as `0x${string}`, totalPayout],
                    }),
                },
            ]
            if (DEPLOYER_ADDRESS && totalDeployerFee > 0) {
                calls.push({
                    to: USDC_ADDRESS as `0x${string}`,
                    value: BigInt(0),
                    data: encodeFunctionData({
                        abi: erc20Abi,
                        functionName: 'transfer',
                        args: [DEPLOYER_ADDRESS, totalDeployerFee],
                    }),
                })
            }

            const paymentHash = await execute(bot.viem, {
                address: bot.appAddress as `0x${string}`,
                account: bot.viem.account,
                calls,
            })
            await waitForTransactionReceipt(bot.viem, { hash: paymentHash })

            console.log(`✅ Payout sent! $${payoutUsdc} USDC to ${event.userId}`)
            if (DEPLOYER_ADDRESS && totalDeployerFee > 0) {
                console.log(`✅ Deployer fee sent! $${formatUsdc(totalDeployerFee)} USDC to ${DEPLOYER_ADDRESS}`)
            }

            await handler.sendMessage(
                event.channelId,
                `🎉 **You won $${payoutUsdc} USDC!**\n\n💰 **Payment sent!**\n\nTransaction: \`${paymentHash}\``,
                { threadId: event.messageId },
            )
        } catch (error) {
            console.error('❌ Payment failed:', error)
            await handler.sendMessage(
                event.channelId,
                `⚠️ **Payout Error**\n\nUnable to send $${payoutUsdc} USDC.\n\nPlease contact support.`,
                { threadId: event.messageId },
            )
        }
    }
})
const { jwtMiddleware, handler } = bot.start()

const app = new Hono()
app.use(logger())

// Health check endpoint
app.get('/health', async (c) => {
    return c.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Webhook endpoint for Towns events
app.post('/webhook', jwtMiddleware, handler)

// Agent metadata endpoint
app.get('/.well-known/agent-metadata.json', async (c) => {
    try {
        console.log('Fetching agent metadata...')
        // Add timeout to prevent hanging requests
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Metadata request timeout')), 30000), // 30 second timeout
        )
        const metadataPromise = bot.getIdentityMetadata()
        const metadata = await Promise.race([metadataPromise, timeoutPromise])
        console.log('Agent metadata fetched successfully')
        return c.json(metadata)
    } catch (error) {
        console.error('Error fetching agent metadata:', error)
        // Return a basic response if metadata fetch fails
        return c.json(
            {
                error: 'Failed to fetch metadata',
                message: error instanceof Error ? error.message : 'Unknown error',
            },
            503,
        )
    }
})

// Log startup
const port = process.env.PORT || 5123
console.log(`🚀 Towns bot server starting on port ${port}`)
console.log(`📡 Webhook endpoint: http://localhost:${port}/webhook`)
console.log(`🏥 Health check: http://localhost:${port}/health`)
console.log(`✅ Bot initialized with appAddress: ${bot.appAddress}`)

// For Bun/Render compatibility
export default {
    port: Number(port),
    fetch: app.fetch,
}
