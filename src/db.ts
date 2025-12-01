import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

const dbPath = process.env.DATABASE_PATH || join(process.cwd(), 'jackpot.json')

interface JackpotData {
    amount: string // Store as string to preserve BigInt precision
    updated_at: number
}

function readJackpot(): JackpotData {
    if (existsSync(dbPath)) {
        try {
            const data = readFileSync(dbPath, 'utf-8')
            return JSON.parse(data) as JackpotData
        } catch (error) {
            console.error('Error reading jackpot database:', error)
            return { amount: '0', updated_at: Date.now() }
        }
    }
    return { amount: '0', updated_at: Date.now() }
}

function writeJackpot(data: JackpotData): void {
    try {
        writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf-8')
    } catch (error) {
        console.error('Error writing jackpot database:', error)
    }
}

export function getJackpot(): bigint {
    const data = readJackpot()
    return BigInt(data.amount)
}

export function setJackpot(amount: bigint): void {
    const data: JackpotData = {
        amount: amount.toString(),
        updated_at: Date.now(),
    }
    writeJackpot(data)
}

// Initialize database on first load
const initialData = readJackpot()
console.log(`Jackpot loaded from database: ${(Number(initialData.amount) / 1e18).toFixed(6)} ETH`)
