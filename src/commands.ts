import type { PlainMessage, SlashCommand } from '@towns-protocol/proto'

// Those commands will be registered to the bot as soon as the bot is initialized
// and will be available in the slash command autocomplete.
const commands = [
    {
        name: 'help',
        description: 'Get help with bot commands',
    },
    {
        name: 'slot',
        description: 'Play the slot machine (tip $0.10 to play)',
    },
] as const satisfies PlainMessage<SlashCommand>[]

export default commands
