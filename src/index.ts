import { makeTownsBot } from '@towns-protocol/bot'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { getBalance } from 'viem/actions'
import commands from './commands'
// Removed database jackpot - now using wallet balance directly

// Using handler.sendTip() for payouts (per Towns Protocol docs)

// Slot machine symbols
const SLOT_SYMBOLS = ['🍒', '🍋', '🍊', '🍇', '🍉', '⭐', '💎', '🎰'] as const

// Entry fee in dollars per game
const ENTRY_FEE_DOLLARS = 0.25 // $0.25 per game

// Fetch current ETH price in USD using multiple fallback APIs
async function getEthPrice(): Promise<number> {
    const timeout = 8000 // 8 seconds per API
    
    // List of APIs to try in order (with fallbacks)
    const apis = [
        {
            name: 'Binance',
            url: 'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT',
            parse: (data: any) => parseFloat(data.price),
        },
        {
            name: 'Coinbase',
            url: 'https://api.coinbase.com/v2/exchange-rates?currency=ETH',
            parse: (data: any) => parseFloat(data.data.rates.USD),
        },
        {
            name: 'Kraken',
            url: 'https://api.kraken.com/0/public/Ticker?pair=ETHUSD',
            parse: (data: any) => parseFloat(data.result.XETHZUSD.c[0]), // Last trade price
        },
        {
            name: 'CoinGecko',
            url: 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
            parse: (data: any) => data.ethereum?.usd,
        },
    ]
    
    // Try each API in order
    for (const api of apis) {
        try {
            console.log(`Fetching ETH price from ${api.name}...`)
            
            // Create abort controller for timeout
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), timeout)
            
            const response = await fetch(api.url, {
                signal: controller.signal,
                headers: {
                    'Accept': 'application/json',
                },
            })
            
            clearTimeout(timeoutId)
            
            if (!response.ok) {
                if (response.status === 429) {
                    console.log(`⚠️ ${api.name} rate limited, trying next API...`)
                    continue // Try next API
                }
                throw new Error(`HTTP ${response.status}: ${response.statusText}`)
            }
            
            const data = await response.json()
            const price = api.parse(data)

            if (price && price > 0 && isFinite(price)) {
                console.log(`✅ ETH price fetched from ${api.name}: $${price.toFixed(2)}`)
                return price
            } else {
                throw new Error(`Invalid price data from ${api.name}`)
            }
        } catch (error: any) {
            if (error.name === 'AbortError') {
                console.log(`⏱️ ${api.name} timeout, trying next API...`)
            } else {
                console.log(`⚠️ ${api.name} failed: ${error.message || error}, trying next API...`)
            }
            // Continue to next API
        }
    }
    
    // If all APIs fail, throw error
    console.error('❌ All ETH price APIs failed')
    throw new Error('Failed to fetch ETH price from all available APIs')
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

// Jackpot pool (accumulates all entry fees) - always read from database when needed
// Don't use a module-level variable to avoid sync issues

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

// Map to store user message IDs for tip payouts
// Key: userId, Value: messageId (must be a message authored by the user)
const slotGameMap = new Map<string, string>()

// Helper function to send tip using handler.sendTip() (per Towns Protocol docs)
async function sendTipWithRetry(
    handler: any,
    to: string,
    messageId: string,
    channelId: string,
    amount: bigint,
    maxRetries = 3,
): Promise<boolean> {
    const amountEth = Number(amount) / 1e18
    
    // Check balances for both wallets (per Towns Protocol docs)
    // Gas wallet (bot.botId) needs Base ETH for gas fees
    // Bot treasury (bot.appAddress) needs ETH to send as tips
    try {
        const appBalance = await getBalance(bot.viem, { address: bot.appAddress })
        const botIdBalance = await getBalance(bot.viem, { address: bot.botId as `0x${string}` })
        console.log(`Bot appAddress (treasury) balance: ${(Number(appBalance) / 1e18).toFixed(6)} ETH`)
        console.log(`Bot botId (gas wallet) balance: ${(Number(botIdBalance) / 1e18).toFixed(6)} ETH`)
        console.log(`Required payout: ${amountEth.toFixed(6)} ETH`)
        
        if (appBalance < amount) {
            console.error(`Insufficient balance in appAddress! Have ${(Number(appBalance) / 1e18).toFixed(6)} ETH, need ${amountEth.toFixed(6)} ETH`)
            return false
        }
        
        if (botIdBalance === BigInt(0)) {
            console.warn(`Warning: botId (gas wallet) has no balance! Gas fees may fail.`)
        }
    } catch (error) {
        console.error('Error checking balances:', error)
        return false
    }

    // Use handler.sendTip() per Towns Protocol docs
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`Sending tip attempt ${attempt}/${maxRetries} (handler.sendTip): ${amountEth.toFixed(6)} ETH to ${to}`)
            
            // Use handler.sendTip() per current Towns Protocol documentation:
            // await handler.sendTip({ userId, amount, messageId, channelId, currency? })
            const result = await handler.sendTip({
                userId: to,
                amount,
                messageId,
                channelId,
                // currency omitted -> defaults to ETH
            })
            
            console.log(
                `Tip sent successfully via handler.sendTip()! Amount: ${amountEth.toFixed(
                    6,
                )} ETH, tx/event:`,
                result,
            )
            return true
        } catch (error: any) {
            console.error(`handler.sendTip attempt ${attempt}/${maxRetries} failed:`, error?.message || error)
            
            if (attempt === maxRetries) {
                console.error('All handler.sendTip attempts failed. Possible reasons:')
                console.error('1. Insufficient balance in bot.appAddress (treasury)')
                console.error('2. Insufficient gas in bot.botId (gas wallet)')
                console.error('3. Network/connectivity issues')
                console.error('4. Invalid parameters (to/userId, messageId, channelId)')
            }
            
            // Wait before retry (exponential backoff)
            if (attempt < maxRetries) {
                await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
            }
        }
    }
    
    return false
}

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

bot.onSlashCommand('slot', async (handler, { channelId, userId, eventId }) => {
    console.log('Slot command received from user:', userId)
    
    // Store the user's eventId for later use in tip payouts
    // This eventId represents a user-authored event (the slash command)
    slotGameMap.set(userId, eventId)
    console.log(`Stored messageId ${eventId} for user ${userId}`)
    
    // Get jackpot from actual wallet balance (bot.appAddress)
    const jackpot = await getBalance(bot.viem, { address: bot.appAddress })
    const jackpotEth = Number(jackpot) / 1e18
    
    // Always fetch fresh ETH price (no caching, with retries)
    let ethPrice: number
    try {
        ethPrice = await getEthPrice()
    } catch (error) {
        console.error('Failed to fetch ETH price, cannot proceed:', error)
        await handler.sendMessage(
            channelId,
            '⚠️ **Error:** Unable to fetch current ETH price. Please try again in a moment.',
        )
        return
    }
    
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
            event.channelId || event.spaceId, // Fallback to spaceId if channelId missing
            '⚠️ Error: Missing channel information. Cannot process payout.',
        )
        return
    }

    // Get current entry fee in Wei based on current ETH price
    let ethPrice: number
    try {
        ethPrice = await getEthPrice()
    } catch (error) {
        console.error('Failed to fetch ETH price for tip validation:', error)
        await handler.sendMessage(
            event.channelId,
            '⚠️ **Error:** Unable to fetch current ETH price. Please try again in a moment.',
        )
        return
    }
    
    const entryFeeWei = await getEntryFeeWei()
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

    // Jackpot is the actual wallet balance (bot.appAddress)
    // Entry fees are automatically added to the wallet when users tip
    // So we just read the current balance as the jackpot
    let jackpot = await getBalance(bot.viem, { address: bot.appAddress })

    // Track total winnings and payouts across all games
    let totalWinnings = BigInt(0)
    let totalPayout = BigInt(0)
    let totalDeployerFee = BigInt(0)
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
            // Always read current jackpot from wallet balance before calculating payout
            jackpot = await getBalance(bot.viem, { address: bot.appAddress })
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
                totalDeployerFee += feeAmount
            }

            // Note: We don't update jackpot here because it's the actual wallet balance
            // The wallet balance will decrease automatically when we send payouts

            // Accumulate totals
            totalWinnings += payoutAmount
            totalPayout += winnerPayout
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

    // Automatically send payout when user wins
    if (totalPayout > 0) {
        const payoutEth = (Number(totalPayout) / 1e18).toFixed(6)
        
        // Get the user's messageId from the stored map
        // This must be a message authored by the user (from /slot command)
        // Use userId as key (not senderAddress) since sendTip expects userId
        const userMessageId = slotGameMap.get(event.userId)
        
        // Fallback to the tip event's messageId if not found in map
        // This is the message the user tipped on, which should be valid
        const payoutMessageId = userMessageId || event.messageId
        
        if (!payoutMessageId || !event.channelId) {
            console.error('Missing messageId or channelId for payout', {
                userMessageId,
                eventMessageId: event.messageId,
                channelId: event.channelId,
            })
            await handler.sendMessage(
                event.channelId || event.spaceId,
                `⚠️ **Payout Error**\n\n` +
                    `Unable to send payout: Missing required event information.\n\n` +
                    `Please contact support.`,
            )
            return
        }
        
        console.log(`Using messageId ${payoutMessageId} for payout to ${event.userId}`)
        
        await handler.sendMessage(
            event.channelId,
            `🎉 **You won ${payoutEth} ETH!**\n\n` +
                `💰 **Sending your winnings now...**`,
        )
        
        // Attempt to send payout automatically using handler.sendTip()
        // Use the messageId from the user's message (stored from /slot command or from tip event)
        // IMPORTANT: sendTip expects userId, not wallet address
        const payoutSuccess = await sendTipWithRetry(handler, event.userId, payoutMessageId, event.channelId, totalPayout)
        
        if (payoutSuccess) {
            await handler.sendMessage(
                event.channelId,
                `✅ **Payout Successful!**\n\n` +
                    `💰 You've received ${payoutEth} ETH!\n\n` +
                    `Transaction completed. Thanks for playing! 🎰`,
            )
            console.log(`Successfully paid out ${payoutEth} ETH to ${event.userId}`)
            
            // Send deployer fee if applicable
            // NOTE: DEPLOYER_ADDRESS is a wallet address, but sendTip needs a userId
            // For now, we'll skip deployer fee payout via sendTip since we don't have the deployer's userId
            // The deployer fee could be handled manually or through a different mechanism
            if (DEPLOYER_ADDRESS && totalDeployerFee > 0) {
                const deployerFeeEth = (Number(totalDeployerFee) / 1e18).toFixed(6)
                console.log(`⚠️ Deployer fee ${deployerFeeEth} ETH calculated but not sent automatically`)
                console.log(`   Deployer address: ${DEPLOYER_ADDRESS}`)
                console.log(`   Note: sendTip requires userId, not wallet address. Manual payout needed.`)
                // TODO: Implement deployer fee payout mechanism (may require different approach)
            }
        } else {
            await handler.sendMessage(
                event.channelId,
                `⚠️ **Payout Failed**\n\n` +
                    `Sorry, I couldn't send your payout of ${payoutEth} ETH automatically.\n\n` +
                    `This may be due to a temporary network issue. Please contact support if this problem persists.`,
            )
            console.error(`Failed to pay out ${payoutEth} ETH to ${event.userId}`)
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
