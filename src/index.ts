import { makeTownsBot } from '@towns-protocol/bot'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import commands from './commands'

// Slot machine symbols
const SLOT_SYMBOLS = ['🍒', '🍋', '🍊', '🍇', '🍉', '⭐', '💎', '🎰'] as const

// Entry fee: $0.10 = 0.0001 ETH = 100000000000000 Wei (assuming ETH ~$1000)
const ENTRY_FEE_WEI = BigInt('100000000000000') // 0.0001 ETH

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
): string {
    const [a, b, c] = symbols
    const jackpotEth = Number(jackpotAmount) / 1e18
    const result =
        `🎰 **SLOT MACHINE** 🎰\n\n` +
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

const bot = await makeTownsBot(process.env.APP_PRIVATE_DATA!, process.env.JWT_SECRET!, {
    commands,
})

bot.onSlashCommand('help', async (handler, { channelId }) => {
    await handler.sendMessage(
        channelId,
        '**Available Commands:**\n\n' +
            '• `/help` - Show this help message\n' +
            '• `/slot` - Play the slot machine (tip $0.10 to play)\n\n' +
            '**Message Triggers:**\n\n' +
            "• Mention me - I'll respond\n" +
            "• React with 👋 - I'll wave back" +
            '• Say "hello" - I\'ll greet you back\n' +
            '• Say "ping" - I\'ll show latency\n' +
            '• Say "react" - I\'ll add a reaction\n',
    )
})

bot.onSlashCommand('slot', async (handler, { channelId, userId }) => {
    const jackpotEth = Number(jackpot) / 1e18
    await handler.sendMessage(
        channelId,
        '🎰 **Welcome to the Slot Machine!** 🎰\n\n' +
            'To play, send me a tip of **$0.10 (0.0001 ETH)**\n\n' +
            '**How to play:**\n' +
            '1. Tip me 0.0001 ETH\n' +
            '2. I\'ll spin the reels for you!\n\n' +
            `💰 **Current Jackpot:** ${jackpotEth.toFixed(6)} ETH\n\n` +
            '**Payouts (percentage of jackpot):**\n' +
            '• Three 💎 = 100% (JACKPOT!)\n' +
            '• Three of a kind = 50%\n' +
            '• Two of a kind = 20%\n' +
            '• No match = 0%\n\n' +
            'Good luck! 🍀',
    )
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

    // Check if tip amount matches entry fee
    if (event.amount !== ENTRY_FEE_WEI) {
        const receivedEth = Number(event.amount) / 1e18
        const requiredEth = Number(ENTRY_FEE_WEI) / 1e18
        await handler.sendMessage(
            event.channelId,
            `❌ Invalid tip amount!\n\n` +
                `You sent: ${receivedEth.toFixed(6)} ETH\n` +
                `Required: ${requiredEth.toFixed(6)} ETH (0.0001 ETH = $0.10)\n\n` +
                `Please send exactly 0.0001 ETH to play the slot machine! 🎰`,
        )
        return
    }

    // Add entry fee to jackpot
    jackpot += event.amount

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

        // Send payout to winner
        try {
            await handler.sendTip({
                userId: event.senderAddress,
                amount: winnerPayout,
                messageId: event.messageId,
                channelId: event.channelId,
            })

            // Send fee to deployer (10%)
            if (DEPLOYER_ADDRESS && feeAmount > 0) {
                await handler.sendTip({
                    userId: DEPLOYER_ADDRESS,
                    amount: feeAmount,
                    messageId: event.messageId,
                    channelId: event.channelId,
                })
            }
        } catch (error) {
            // If payout fails, add the amount back to jackpot
            jackpot += payoutAmount
            await handler.sendMessage(
                event.channelId,
                `⚠️ Sorry, I couldn't send your payout. Please contact the bot administrator.`,
            )
            return
        }
    }

    // Format and send result
    const result = formatSlotResult(symbols, winnings, jackpot, winnerPayout, hasFee)
    await handler.sendMessage(event.channelId, result)
})
const { jwtMiddleware, handler } = bot.start()

const app = new Hono()
app.use(logger())
app.post('/webhook', jwtMiddleware, handler)
app.get('/.well-known/agent-metadata.json', async (c) => {
    return c.json(await bot.getIdentityMetadata())
})

export default app
