# Sailing Naturali — Claude Code skills

A small [Claude Code](https://claude.com/claude-code) plugin marketplace of skills we've
found generally useful while building the [Sailing Naturali](https://github.com/sailingnaturali)
marine-AI stack.

## Install

```
/plugin marketplace add sailingnaturali/claude-skills
/plugin install signalk-plugin@sailingnaturali
```

## Plugins

### `signalk-plugin`
Authoring and publishing a [SignalK](https://signalk.org) server plugin to npm — the
`@signalk/server-api` patterns that actually work (serve data via a resource provider, not an
admin-gated router; deltas; vessel position), the package scaffold, npm **OIDC trusted
publishing** (including the new-package first-publish chicken-and-egg), and the Docker
`node_modules` / `EBUSY` install gotcha.

## License

MIT
