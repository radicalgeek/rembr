---
description: Configure the Rembr Claude Code plugin on this machine through a local masked key form. Use when asked to set up, connect, or repair Rembr in a local Claude Desktop Code session.
---

# Set up Rembr

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs"` in this local Code session.
It opens a loopback-only browser form for the Rembr endpoint and personal key.
The default is the hosted endpoint `https://rembr.ai/mcp`. To use a self-hosted
or local deployment, enter its MCP endpoint instead. Remote HTTPS and loopback-only HTTP endpoints are supported.
The helper checks the credentials through a read-only request before saving
them to `~/.rembr/.env`. Never request or echo the key in chat, shell arguments,
or tool output.
Keep the setup process running until it reports success or times out; if the
browser does not open, give the user the local setup URL from the script.
After success, ask the user to start a new local Code session so its MCP
connection can load the new credential. Do not claim success from plugin or
skill discovery alone.
