---
name: rembr-setup
description: Connect or repair Rembr in Codex using a local masked setup form and a read-only authentication check.
---

# Set up Rembr for Codex

Run the bundled `scripts/setup.mjs` from this skill's installed directory with Node.js. Keep it running while the local browser form opens.

The form accepts the endpoint and access key, checks them with a read-only memory-list request, and saves them to `~/.rembr/codex.env`. The key is sent only to the endpoint entered in the form. The bundled MCP bridge, prompt hook, and distiller all read their endpoint and key from this file. The form defaults to the hosted endpoint `https://rembr.ai/mcp`; to use a self-hosted Rembr server, enter its MCP endpoint instead.

Never ask for or echo the key in chat, command arguments, or tool output.

After setup succeeds, start a fresh Codex session or reconnect the MCP servers so they load the saved profile. Confirm an authenticated read before claiming the connection works.
