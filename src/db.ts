import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

const dbPath = process.env.DATABASE_PATH || join(process.cwd(), 'jackpot.json')

interface JackpotData {
    amount: string // Store as string to preserve BigInt precision
    updated_at: number
    pendingPayouts: Record<string, string> // userId -> amount in Wei (string)
}

function readDatabase(): JackpotData {
    if (existsSync(dbPath)) {
        try {
            const data = readFileSync(dbPath, 'utf-8')
            const parsed = JSON.parse(data) as JackpotData
            // Ensure pendingPayouts exists
            if (!parsed.pendingPayouts) {
                parsed.pendingPayouts = {}
            }
            return parsed
        } catch (error) {
            console.error('Error reading database:', error)
            return { amount: '0', updated_at: Date.now(), pendingPayouts: {} }
        }
    }
    return { amount: '0', updated_at: Date.now(), pendingPayouts: {} }
}

function writeDatabase(data: JackpotData): void {
    try {
        writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf-8')
        const jackpotEth = (Number(data.amount) / 1e18).toFixed(6)
        console.log(`✅ Database updated: Jackpot = ${jackpotEth} ETH (saved to ${dbPath})`)
    } catch (error) {
        console.error('❌ Error writing database:', error)
        console.error(`Database path: ${dbPath}`)
    }
}

export function getJackpot(): bigint {
    const data = readDatabase()
    return BigInt(data.amount)
}

export function setJackpot(amount: bigint): void {
    const data = readDatabase()
    data.amount = amount.toString()
    data.updated_at = Date.now()
    writeDatabase(data)
}

export function addPendingPayout(userId: string, amount: bigint): void {
    const data = readDatabase()
    const currentAmount = BigInt(data.pendingPayouts[userId] || '0')
    data.pendingPayouts[userId] = (currentAmount + amount).toString()
    data.updated_at = Date.now()
    writeDatabase(data)
}

export function getPendingPayout(userId: string): bigint {
    const data = readDatabase()
    return BigInt(data.pendingPayouts[userId] || '0')
}

export function clearPendingPayout(userId: string): void {
    const data = readDatabase()
    delete data.pendingPayouts[userId]
    data.updated_at = Date.now()
    writeDatabase(data)
}

// Initialize database on first load
const initialData = readDatabase()
console.log(`📊 Database initialized: Jackpot = ${(Number(initialData.amount) / 1e18).toFixed(6)} ETH`)
console.log(`📁 Database path: ${dbPath}`)
