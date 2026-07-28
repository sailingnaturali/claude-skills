# Contributing

Community skills are welcome. This marketplace started as skills from our own build, but the
[SignalK documentation](https://demo.signalk.org/documentation/Developing/Plugins.html#ai-assisted-plugin-development)
lists it as an AI-assisted plugin-development resource (and search finds it too), so skills
that serve the broader SignalK community are in scope — provided they meet the same bar as the rest of
the marketplace.

## What belongs here

- **Useful to us or the broad SignalK community.** Marine-stack skills, SignalK plugin/server
  development, and the general-purpose dev skills that fall out of that work (publishing,
  testing, debugging). A skill for your own package or plugin is fine — but expect scrutiny of
  its maturity, and a commitment that you'll keep the skill current as it evolves.
- **Distilled from real use.** Skills encode what actually happened — the gotchas that cost
  hours, the recipe that worked — not a tutorial paraphrase of upstream docs. If a claim can be
  verified (a CLI flag, an env var, an API shape), verify it against the current version before
  writing it down.
- **Long-term home.** Skills that are really SignalK documentation may eventually move to a
  SignalK-org marketplace; everything here is MIT precisely so that lift is easy. Contributing
  here doesn't fence anything in.

## Structure

Each plugin is a directory with two required pieces (copy `signalk-plugin/` as the template):

```
<plugin-name>/
  .claude-plugin/plugin.json        # name, description, version, author, license, keywords
  skills/<skill-name>/SKILL.md      # one dir per skill; supporting scripts live alongside
```

Plus, in the same PR:

- an entry in `.claude-plugin/marketplace.json` — keep the `description` to a sentence or two,
  matching the existing entries
- a `###` section in `README.md` and your plugin added to the install line

One plugin can ship **multiple related skills**. Sibling skills in the same plugin are always
installed together, so they may reference each other; skills in *different* plugins must not —
a skill can never assume another plugin is installed. If two skills would share substantial
text, make them siblings in one plugin and factor the shared material into one of them.

## Design bar

- **Self-contained.** A skill works with only what it ships and what it tells the reader to
  install.
- **Follow the [skill format policy](README.md#skill-format-policy)**: frontmatter is `name`
  and `description` only; no vendor-specific tool ids in prose.
- **Version-stamp anything brittle.** UI selectors, CLI flags, feature tables — anything that
  rots with releases gets a "verified against X vN.N, month year" note so future readers know
  when to re-verify instead of debugging.
- **Disclose third-party services.** If a skill drives a hosted service (a cloud reviewer, an
  API), it must state the prerequisite (account, CLI, auth) up front and say plainly what data
  leaves the machine.
- **Skills are executable instructions.** They load directly into agent sessions, so they get
  reviewed like code: no instructions to fetch and run remote content, no credential handling
  beyond pointing at the reader's own config.

## Process

- One plugin per PR. All PRs touch `marketplace.json` and `README.md`, so expect to rebase if
  another lands first.
- By contributing you agree your contribution is licensed under [MIT](LICENSE), same as the
  rest of the repo.
