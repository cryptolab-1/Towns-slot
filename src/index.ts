import { makeTownsBot } from '@towns-protocol/bot'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import commands from './commands'

// Slot machine symbols
const SLOT_SYMBOLS = ['🍒', '🍋', '🍊', '🍇', '🍉', '⭐', '💎', '🎰'] as const

// Entry fee in dollars per game
const ENTRY_FEE_DOLLARS = 0.25 // $0.25 per game

// Cache for ETH price (update every 5 minutes)
let ethPriceCache: { price: number; timestamp: number } | null = null
const ETH_PRICE_CACHE_DURATION = 5 * 60 * 1000 // 5 minutes

// Fetch current ETH price in USD
async function getEthPrice(): Promise<number> {
    // Check cache first
    if (ethPriceCache && Date.now() - ethPriceCache.timestamp < ETH_PRICE_CACHE_DURATION) {
        return ethPriceCache.price
    }

    try {
        // Try CoinGecko API
        const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd')
        const data = await response.json()
        const price = data.ethereum?.usd

        if (price && price > 0) {
            ethPriceCache = { price, timestamp: Date.now() }
            console.log(`ETH price fetched: $${price}`)
            return price
        }
    } catch (error) {
        console.error('Error fetching ETH price:', error)
    }

    // Fallback to cached price or default
    if (ethPriceCache) {
        console.log(`Using cached ETH price: $${ethPriceCache.price}`)
        return ethPriceCache.price
    }

    // Default fallback (conservative estimate)
    const defaultPrice = 3000
    console.log(`Using default ETH price: $${defaultPrice}`)
    return defaultPrice
}

// Calculate entry fee in Wei based on current ETH price
async function getEntryFeeWei(): Promise<bigint> {
    const ethPrice = await getEthPrice()
    const entryFeeEth = ENTRY_FEE_DOLLARS / ethPrice
    const entryFeeWei = BigInt(Math.floor(entryFeeEth * 1e18))
    return entryFeeWei
}

// Deployer wallet address (receives 10% fee on payouts)
const DEPLOYER_ADDRESS = process.env.DEPLOYER_ADDRESS as `0x${string}`

// Jackpot pool (accumulates all entry fees)
let jackpot = BigInt(0)

// Payout percentages (of jackpot)
const PAYOUT_PERCENTAGES = {
    threeDiamonds: 100, // 100% of jackpot (JACKPOT!)
    threeOfAKind: 50, // 50% of jackpot
    twoOfAKind: 20, // 20% of jackpot
    noMatch: 0, // 0% of jackpot
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

function calculateWinnings(symbols: [string, string, string]): { percentage: number; message: string } {
    const [a, b, c] = symbols

    // Three of a kind
    if (a === b && b === c) {
        if (a === '💎') {
            return {
                percentage: PAYOUT_PERCENTAGES.threeDiamonds,
                message: '🎉 JACKPOT! Three diamonds! 🎉',
            }
        }
        return {
            percentage: PAYOUT_PERCENTAGES.threeOfAKind,
            message: `🎊 Three of a kind! ${a} ${a} ${a}`,
        }
    }

    // Two of a kind
    if (a === b || b === c || a === c) {
        return {
            percentage: PAYOUT_PERCENTAGES.twoOfAKind,
            message: '✨ Two of a kind!',
        }
    }

    // No match
    return {
        percentage: PAYOUT_PERCENTAGES.noMatch,
        message: '😔 No match, better luck next time!',
    }
}

function formatSlotResult(
    symbols: [string, string, string],
    winnings: { percentage: number; message: string },
    jackpotAmount: bigint,
    winnerPayout: bigint,
    hasFee: boolean,
    gameNumber?: number,
    totalGames?: number,
): string {
    const [a, b, c] = symbols
    const jackpotEth = Number(jackpotAmount) / 1e18
    const gameHeader = totalGames && totalGames > 1 ? `🎰 **GAME ${gameNumber}/${totalGames}** 🎰\n\n` : `🎰 **SLOT MACHINE** 🎰\n\n`
    const result =
        gameHeader +
        `[ ${a} | ${b} | ${c} ]\n\n` +
        `${winnings.message}\n\n` +
        `💰 **Current Jackpot:** ${jackpotEth.toFixed(6)} ETH\n\n`

    if (winnings.percentage > 0) {
        const payoutEth = Number(winnerPayout) / 1e18
        let payoutMessage = `🎁 **You won ${winnings.percentage}% of the jackpot!**\n` + `💵 **Your payout:** ${payoutEth.toFixed(6)} ETH`
        if (hasFee) {
            payoutMessage += `\n📝 *10% fee deducted*`
        }
        return result + payoutMessage
    }

    return result
}

function formatMultiGameSummary(
    totalWinnings: bigint,
    totalPayout: bigint,
    hasFee: boolean,
    numGames: number,
): string {
    const totalWinningsEth = Number(totalWinnings) / 1e18
    const totalPayoutEth = Number(totalPayout) / 1e18
    let summary = `\n\n🎉 **TOTAL RESULTS (${numGames} games):**\n\n`
    summary += `💰 **Total Winnings:** ${totalWinningsEth.toFixed(6)} ETH\n`
    summary += `💵 **Total Payout:** ${totalPayoutEth.toFixed(6)} ETH`
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

bot.onSlashCommand('help', async (handler, { channelId }) => {
    console.log('Help command received')
    await handler.sendMessage(
        channelId,
        '**Available Commands:**\n\n' +
            '• `/help` - Show this help message\n' +
            '• `/slot` - Play the slot machine (tip $0.25 per game)\n\n' +
            '**Message Triggers:**\n\n' +
            "• Mention me - I'll respond\n" +
            "• React with 👋 - I'll wave back" +
            '• Say "hello" - I\'ll greet you back\n' +
            '• Say "ping" - I\'ll show latency\n' +
            '• Say "react" - I\'ll add a reaction\n',
    )
    console.log('Help command response sent')
})

bot.onSlashCommand('slot', async (handler, { channelId, userId }) => {
    console.log('Slot command received from user:', userId)
    const jackpotEth = Number(jackpot) / 1e18
    const ethPrice = await getEthPrice()
    const entryFeeEth = ENTRY_FEE_DOLLARS / ethPrice
    const entryFeeWei = await getEntryFeeWei()
    
    await handler.sendMessage(
        channelId,
        '🎰 **Welcome to the Slot Machine!** 🎰\n\n' +
            `To play, send me a tip of **$${ENTRY_FEE_DOLLARS.toFixed(2)}** (${entryFeeEth.toFixed(6)} ETH) per game\n\n` +
            '**How to play:**\n' +
            `1. Tip me $${ENTRY_FEE_DOLLARS.toFixed(2)} for 1 game\n` +
            `2. Tip me more to play multiple games! (e.g., $${(ENTRY_FEE_DOLLARS * 4).toFixed(2)} = 4 games)\n` +
            '3. I\'ll spin the reels for you!\n\n' +
            `💰 **Current Jackpot:** ${jackpotEth.toFixed(6)} ETH\n` +
            `💵 **Current ETH Price:** $${ethPrice.toFixed(2)}\n\n` +
            '**Payouts (percentage of jackpot):**\n' +
            '• Three 💎 = 100% (JACKPOT!)\n' +
            '• Three of a kind = 50%\n' +
            '• Two of a kind = 20%\n' +
            '• No match = 0%\n\n' +
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
    // Check if tip is to the bot
    if (event.receiverAddress !== bot.appAddress) {
        return
    }

    // Get current entry fee in Wei based on current ETH price
    const entryFeeWei = await getEntryFeeWei()
    const ethPrice = await getEthPrice()
    const entryFeeEth = ENTRY_FEE_DOLLARS / ethPrice
    const receivedEth = Number(event.amount) / 1e18
    const receivedDollars = receivedEth * ethPrice

    // Check if tip amount is valid with 10% slippage tolerance
    // Calculate expected number of games
    const expectedGames = Number(event.amount) / Number(entryFeeWei)
    const numGames = Math.max(1, Math.round(expectedGames))
    
    // Calculate expected amount for this number of games
    const expectedAmount = entryFeeWei * BigInt(numGames)
    const difference = event.amount > expectedAmount 
        ? event.amount - expectedAmount 
        : expectedAmount - event.amount
    
    // 10% slippage tolerance per game (scales with number of games)
    const tolerancePerGame = entryFeeWei / BigInt(10) // 10% tolerance per game
    const maxTolerance = tolerancePerGame * BigInt(numGames)
    
    // Minimum amount check (allow 10% below for 1 game)
    const minAmount = entryFeeWei - tolerancePerGame
    
    // Check if amount is too small or difference is too large
    if (event.amount < minAmount || difference > maxTolerance) {
        await handler.sendMessage(
            event.channelId,
            `❌ Invalid tip amount!\n\n` +
                `You sent: $${receivedDollars.toFixed(2)} (${receivedEth.toFixed(6)} ETH)\n` +
                `Required: $${ENTRY_FEE_DOLLARS.toFixed(2)} (${entryFeeEth.toFixed(6)} ETH) per game\n\n` +
                `Tip must be a multiple of $${ENTRY_FEE_DOLLARS.toFixed(2)} to play! 🎰\n` +
                `Examples: $${ENTRY_FEE_DOLLARS.toFixed(2)} (1 game), $${(ENTRY_FEE_DOLLARS * 4).toFixed(2)} (4 games)\n` +
                `💵 Current ETH Price: $${ethPrice.toFixed(2)}\n` +
                `📊 10% slippage tolerance applied`,
        )
        return
    }
    
    // Calculate actual entry fee used (based on number of games)
    const actualEntryFee = entryFeeWei * BigInt(numGames)

    // Add all entry fees to jackpot
    jackpot += actualEntryFee

    // Track total winnings and payouts across all games
    let totalWinnings = BigInt(0)
    let totalPayout = BigInt(0)
    const gameResults: string[] = []

    // Play multiple games
    for (let gameNum = 1; gameNum <= numGames; gameNum++) {
        // Spin the slot machine!
        const symbols = spinSlotMachine()
        const winnings = calculateWinnings(symbols)

        // Calculate payout based on jackpot percentage
        let payoutAmount = BigInt(0)
        let winnerPayout = BigInt(0)
        let hasFee = false

        if (winnings.percentage > 0) {
            // Calculate percentage of jackpot
            const percentageMultiplier = BigInt(winnings.percentage)
            payoutAmount = (jackpot * percentageMultiplier) / BigInt(100)

            // Calculate fee (10% of payout goes to deployer, if deployer address is set)
            let feeAmount = BigInt(0)
            winnerPayout = payoutAmount

            if (DEPLOYER_ADDRESS) {
                feeAmount = (payoutAmount * BigInt(FEE_PERCENTAGE)) / BigInt(100)
                winnerPayout = payoutAmount - feeAmount
                hasFee = true
            }

            // Update jackpot (subtract full payout amount)
            jackpot -= payoutAmount

            // Accumulate totals
            totalWinnings += payoutAmount
            totalPayout += winnerPayout

            // Store fee amount for deployer (we'll send all fees at once at the end)
        }

        // Format and store result for this game
        const result = formatSlotResult(symbols, winnings, jackpot, winnerPayout, hasFee, gameNum, numGames)
        gameResults.push(result)
    }

    // Send all game results
    for (const result of gameResults) {
        await handler.sendMessage(event.channelId, result)
    }

    // Send total summary if multiple games
    if (numGames > 1) {
        const summary = formatMultiGameSummary(totalWinnings, totalPayout, !!DEPLOYER_ADDRESS, numGames)
        await handler.sendMessage(event.channelId, summary)
    }

    // Send total payout to winner (if any winnings)
    if (totalPayout > 0) {
        try {
            await handler.sendTip({
                userId: event.senderAddress,
                amount: totalPayout,
                messageId: event.messageId,
                channelId: event.channelId,
            })

            // Send total fee to deployer (10% of total winnings)
            if (DEPLOYER_ADDRESS && totalWinnings > 0) {
                const totalFee = totalWinnings - totalPayout
                if (totalFee > 0) {
                    await handler.sendTip({
                        userId: DEPLOYER_ADDRESS,
                        amount: totalFee,
                        messageId: event.messageId,
                        channelId: event.channelId,
                    })
                }
            }
        } catch (error) {
            // If payout fails, add the amounts back to jackpot
            jackpot += totalWinnings
            await handler.sendMessage(
                event.channelId,
                `⚠️ Sorry, I couldn't send your payout. Please contact the bot administrator.`,
            )
            return
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
