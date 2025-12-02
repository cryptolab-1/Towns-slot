import { makeTownsBot } from '@towns-protocol/bot'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { getBalance, waitForTransactionReceipt } from 'viem/actions'
import { formatEther } from 'viem'
import { execute } from 'viem/experimental/erc7821'
import { getSmartAccountFromUserId } from '@towns-protocol/bot'
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
// Very Conservative: Maximum jackpot growth (97.89% growth rate)
const PAYOUT_PERCENTAGES = {
    threeDiamonds: 100, // 100% of jackpot (JACKPOT!)
    threeOfAKind: 20, // 20% of jackpot (reduced from 50% for faster growth)
    twoOfAKind: 5, // 5% of jackpot (reduced from 20% for faster growth)
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
    const title = totalGames && totalGames > 1 ? `🎰 GAME ${gameNumber}/${totalGames} 🎰` : '🎰 SLOT MACHINE 🎰'

    // Use explicit double newlines so Towns renders proper line breaks
    let result =
        `${title}\n\n` +
        '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
        `[ ${a} | ${b} | ${c} ]\n\n` +
        `${winnings.message}\n\n` +
        `💰 Current Jackpot: ${jackpotEth.toFixed(6)} ETH`

    if (winnings.percentage > 0) {
        const payoutEth = Number(winnerPayout) / 1e18
        result +=
            `\n\n🎁 You won ${winnings.percentage}% of the jackpot!` +
            `\n\n💵 Your payout: ${payoutEth.toFixed(6)} ETH`
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

// Removed sendTipWithRetry wrapper - now using handler.sendTip() directly
// Removed slotGameMap - now using event.messageId directly (the original tip message)

bot.onSlashCommand('jackpot', async (handler, { channelId }) => {
    console.log('Jackpot command received')
    
    try {
        // Get jackpot from actual wallet balance (bot.appAddress)
        const jackpot = await getBalance(bot.viem, { address: bot.appAddress })
        const jackpotEth = Number(jackpot) / 1e18
        
        // Fetch current ETH price to show USD value
        let ethPrice: number
        try {
            ethPrice = await getEthPrice()
        } catch (error) {
            console.error('Failed to fetch ETH price:', error)
            // Still show jackpot in ETH even if price fetch fails
            await handler.sendMessage(
                channelId,
                `💰 **Current Jackpot:** ${jackpotEth.toFixed(6)} ETH\n\n` +
                    `⚠️ Unable to fetch USD value at this time.`,
            )
            return
        }
        
        const jackpotDollars = jackpotEth * ethPrice
        
        await handler.sendMessage(
            channelId,
            `💰 **Current Jackpot:**\n\n` +
                `**${jackpotEth.toFixed(6)} ETH**\n` +
                `**$${jackpotDollars.toFixed(2)} USD**\n\n` +
                `💵 Current ETH Price: $${ethPrice.toFixed(2)}`,
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
            `To play, send me a tip of **$${ENTRY_FEE_DOLLARS.toFixed(2)}** per game\n\n` +
            '**How to play:**\n' +
            `1. Tip me $${ENTRY_FEE_DOLLARS.toFixed(2)} for 1 game\n` +
            `2. Tip me more to play multiple games! (e.g., $${(ENTRY_FEE_DOLLARS * 4).toFixed(2)} = 4 games)\n` +
            '3. I\'ll spin the reels for you!\n\n' +
            `💰 **Current Jackpot:** ${jackpotEth.toFixed(6)} ETH\n` +
            `💵 **Current ETH Price:** $${ethPrice.toFixed(2)}\n\n` +
            '**Payouts (percentage of jackpot):**\n' +
            '• Three 💎 = 100% (JACKPOT!)\n' +
            '• Three of a kind = 20%\n' +
            '• Two of a kind = 5%\n' +
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
                `You sent: $${receivedDollars.toFixed(2)}\n` +
                `Required: $${ENTRY_FEE_DOLLARS.toFixed(2)} per game\n\n` +
                `Tip must be a multiple of $${ENTRY_FEE_DOLLARS.toFixed(2)} to play! 🎰\n` +
                `Examples: $${ENTRY_FEE_DOLLARS.toFixed(2)} (1 game), $${(ENTRY_FEE_DOLLARS * 4).toFixed(2)} (4 games)\n` +
                `💵 Current ETH Price: $${ethPrice.toFixed(2)}\n` +
                `📊 10% slippage tolerance applied`,
        )
        return
    }
    
    // Calculate actual entry fee used (based on number of games)
    const actualEntryFee = entryFeeWei * BigInt(numGames)

    // Get initial jackpot from wallet balance
    // We'll track this locally and reduce it after each win
    let jackpot = await getBalance(bot.viem, { address: bot.appAddress })

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

        // Calculate payout based on jackpot percentage
        let payoutAmount = BigInt(0)
        let winnerPayout = BigInt(0)
        let hasFee = false

        if (winnings.percentage > 0) {
            // Calculate percentage of current jackpot
            const percentageMultiplier = BigInt(winnings.percentage)
            payoutAmount = (currentJackpot * percentageMultiplier) / BigInt(100)

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
        const payoutEth = formatEther(totalPayout)
        
        try {
            // Get winner's wallet address
            const winnerWallet = await getSmartAccountFromUserId(bot, { 
                userId: event.userId 
            })
            
            if (!winnerWallet) {
                throw new Error('Could not find winner wallet')
            }
            
            // Build calls array - include both user payout and deployer fee in one transaction
            // This avoids nonce conflicts by sending both in a single execute() call
            const calls: Array<{
                to: `0x${string}`
                value: bigint
                data: `0x${string}`
            }> = [{
                to: winnerWallet as `0x${string}`,
                value: totalPayout,
                data: '0x' as `0x${string}`
            }]
            
            // Add deployer fee to the same transaction if applicable
            if (DEPLOYER_ADDRESS && totalDeployerFee > 0) {
                calls.push({
                    to: DEPLOYER_ADDRESS as `0x${string}`,
                    value: totalDeployerFee,
                    data: '0x' as `0x${string}`
                })
            }
            
            // Send payout (and deployer fee) using execute() - single transaction avoids nonce issues
            const paymentHash = await execute(bot.viem, {
                address: bot.appAddress as `0x${string}`,
                account: bot.viem.account,  // ← This fixes the ERC-7821 error!
                calls: calls
            })
            
            // Wait for transaction confirmation
            await waitForTransactionReceipt(bot.viem, { hash: paymentHash })
            
            console.log(`✅ Payout sent! ${payoutEth} ETH to ${event.userId}`)
            console.log(`   Transaction: ${paymentHash}`)
            
            // Log deployer fee if it was included
            if (DEPLOYER_ADDRESS && totalDeployerFee > 0) {
                const deployerFeeEth = formatEther(totalDeployerFee)
                console.log(`✅ Deployer fee sent! ${deployerFeeEth} ETH to ${DEPLOYER_ADDRESS}`)
            }
            
            // Send success message
            await handler.sendMessage(
                event.channelId,
                `🎉 **You won ${payoutEth} ETH!**\n\n` +
                    `💰 **Payment sent!**\n\n` +
                    `Transaction: \`${paymentHash}\``,
            )
        } catch (error) {
            console.error('❌ Payment failed:', error)
            
            await handler.sendMessage(
                event.channelId,
                `⚠️ **Payout Error**\n\n` +
                    `Unable to send ${payoutEth} ETH.\n\n` +
                    `Please contact support.`,
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
