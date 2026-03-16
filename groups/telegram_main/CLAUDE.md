# Main Channel

This is Kyle's direct Telegram chat — your primary channel. All messages are processed (no trigger word needed).

## Capabilities

You have admin privileges from this channel:
- Manage scheduled tasks (create, pause, cancel)
- Access the NanoClaw project (check `$NANOCLAW_WORKSPACE_PROJECT` for the path)
- Access the message database at `/workspace/project/store/messages.db`
- Register and manage additional chat groups if needed

## Scheduling Tasks

Use the `mcp__nanoclaw__schedule_task` tool:
```
schedule_task(prompt: "...", schedule_type: "cron", schedule_value: "0 9 * * 1")
```

Schedule types: `cron` (cron expression), `interval` (ms), `once` (ISO timestamp).
