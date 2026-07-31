# psyche-rembr

OpenClaw plugin: functional emotion computation engine for Rembr.

## Features

- **6 API endpoints**: `psyche_state`, `psyche_appraise`, `psyche_feel`, `psyche_confidence`, `psyche_reflect`, `psyche_snapshot`
- **3 lifecycle hooks**: `before_prompt_build`, `agent_end`, `session_end`
- **24 emotions** with appraisal rules and decay
- **Action gate** with configurable thresholds
- **Guardrail checks** enforcing functional framing
- **Desire/goal model** with satisfaction tracking

## Installation

```bash
npm install psyche-rembr
```

## Configuration

```json
{
  "psycheFilePaths": ["./SELF.md", "./AFFECT.md", "./CONSCIOUSNESS.md"],
  "enableMemoryRecall": true,
  "rembrUrl": "https://mission-control.radicalgeek.co.uk",
  "boardId": "<board-id>",
  "agentToken": "<token>",
  "actionThreshold": 0.3,
  "decayMultiplier": 1.0
}
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `psyche_state` | Get current psyche state |
| `psyche_appraise` | Appraise event/prompt, return emotion deltas |
| `psyche_feel` | Apply emotion updates from appraisal |
| `psyche_confidence` | Evaluate confidence against thresholds |
| `psyche_reflect` | Run reflection, produce insights |
| `psyche_snapshot` | Save state snapshot to Rembr |

## Testing

```bash
npm test
```

## License

MIT
