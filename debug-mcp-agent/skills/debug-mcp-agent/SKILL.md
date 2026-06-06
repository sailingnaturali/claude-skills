---
name: debug-mcp-agent
description: Use when an AI agent backed by MCP servers or tools misbehaves — claims data is missing/unavailable, returns 404s or "server unreachable", gives plausible-but-wrong answers, queries the wrong path, or leaks chain-of-thought / control tokens. Probe ground truth before trusting the agent's account of itself.
---

# Debug an MCP / tool-backed agent

The agent's own narration of what went wrong is often *the bug*. **Probe ground truth
directly, out of band, before trusting anything the agent said.**

## 1. Ground truth — query the source directly, bypass the agent

Hit the underlying API / DB / tool yourself (curl, the CLI, a direct query) for the exact
thing the agent claimed was missing.
- **Data is there** → the failure is in the MCP/tool/agent layer, not the source.
- **Genuinely absent (404 / empty)** → that's "not available," **not an error**. Agents and
  MCP clients routinely conflate the two; a burst of 404s can even trip a client's circuit
  breaker and swallow *valid* reads afterward.
- **Connection refused / unreachable** → the source or the MCP process is down — not a missing
  field. Confirm the process/container is up; restart it.

## 2. Which model is driving?

Confirm the configured model is the one you expect. A weaker or local model silently swapped
in is a common root cause of: leaked chain-of-thought, leaked control tokens, skipped tool
calls, replies truncated mid-sentence, and confident confabulation about things it can't see.

## 3. The tool / MCP layer

- **"MCP server X unreachable after N attempts"** = the MCP process or its backing service
  died mid-conversation — *not* a missing path. Different fix than "data absent."
- **Wrong path / argument guessed** (e.g. `sensors.depth` vs the real
  `environment.depth.belowTransducer`): the agent is inventing the schema. Ground the real
  shape in the prompt, or give it a list/describe tool so it stops guessing identifiers.
- **Auth, not absence:** a `401/403` on a write or a privileged/admin route is a permissions
  problem, not missing data — check the token's scope, not the data.

## 4. Plausible-but-wrong values

If the numbers look reasonable but are wrong, suspect a **mock / fixture / sandbox** data
source rather than a logic bug — confirm which environment the agent is actually pointed at.

## Close out

A new root cause is a reusable lesson — write it into a lessons doc or runbook so the next
person doesn't re-derive it. The single highest-leverage habit when an agent misbehaves:
**never trust its self-report; reproduce against ground truth first.**
