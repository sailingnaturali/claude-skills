---
name: clipboard-fallback
description: Use when implementing or debugging copy-to-clipboard in a web app that may be served over plain HTTP — LAN devices, boat servers, embedded UIs. navigator.clipboard exists only in secure contexts, so copy works on localhost in dev and silently breaks on http://<lan-ip> in production; the fix is an isSecureContext-gated Clipboard API call with a document.execCommand('copy') textarea fallback. Covers the recipe, the localhost-testing trap, and why paste has no fallback.
---

# Copy to clipboard on plain-HTTP origins

The bug report is always the same: "the copy button does nothing on the device, but it works
on my machine." Both observations are correct — and that's the trap. The async Clipboard API
(`navigator.clipboard`) is exposed **only in secure contexts**: `https://`, plus `localhost` /
`127.0.0.1` as a development carve-out. A UI served from `http://<lan-ip>` — how boat servers,
routers, printers, and most embedded devices are actually reached — is *not* a secure context:

| Origin (same server, same browser)   | `isSecureContext` | `typeof navigator.clipboard` | `execCommand('copy')` |
| ------------------------------------ | ----------------- | ---------------------------- | --------------------- |
| `http://127.0.0.1:4650`              | `true`            | `object`                     | `true`                |
| `http://192.168.0.122:4650`          | `false`           | **`undefined`**              | `true`                |

So `navigator.clipboard.writeText(...)` on the LAN origin throws
`TypeError: Cannot read properties of undefined (reading 'writeText')` — usually swallowed by
a `catch` or an unhandled promise, which is why the button "does nothing". The legacy
`document.execCommand('copy')` on a selected element still works in insecure contexts
(verified on Chromium above; it is deprecated and best-effort, so treat its boolean return as
the truth) — but it is the only copy path a plain-HTTP origin has.

## The recipe

```js
async function copyText(text) {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // permission denied / focus lost — fall through to the legacy path
    }
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  ta.setSelectionRange(0, text.length) // iOS Safari wants an explicit range
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    // ok stays false
  }
  document.body.removeChild(ta)
  return ok
}
```

- **Gate on `window.isSecureContext && navigator.clipboard`, then still fall through on
  rejection.** Checking existence alone is not enough: `writeText` can reject even where the
  API exists (permission denied, document not focused), and the rejection must land in the
  fallback, not in a swallowed promise.
- **Call it from the click handler, and always consume the boolean.** `copyText` returning
  `false` is a real outcome (best-effort API, browser-dependent) — surface it ("Copy failed —
  select and copy manually"), never assume success. Some browsers gate both clipboard paths on
  a user gesture — don't fire copies from timers or detached async chains.
- **Do not "clean up" the fallback when a linter or reviewer flags `execCommand` as
  deprecated.** It is deprecated *and* it is the only thing that works on plain-HTTP origins;
  removing it un-breaks nothing and re-breaks every LAN user. Keep a one-line comment saying
  why it stays.

## The traps around it

- **Testing on `localhost` proves nothing** — it is a secure context, so the primary path
  works and the fallback never runs. Test through the machine's LAN IP
  (`http://192.168.x.x:port`), which is what real users hit. Headless-browser tests can do the
  same: point the browser at the LAN address, not `127.0.0.1`.
- **Paste has no fallback.** Reading the clipboard (`navigator.clipboard.readText`) is
  secure-context-only too, and `execCommand('paste')` is blocked in normal pages. On plain
  HTTP, offer a textarea the user pastes into with Ctrl/Cmd-V instead of a "paste" button.
- **Clipboard is only the loudest member of the class.** Service workers, geolocation, wake
  lock, WebUSB/Web Bluetooth and other powerful APIs are also secure-context-gated and vanish
  on `http://<ip>` origins — check `window.isSecureContext` first when any of them "works in
  dev, fails on the device".
- **HTTPS is the real fix, but on LAN devices it's rarely available** — a self-signed cert
  trades a broken button for a full-page browser warning, and public CAs don't issue for bare
  private IPs. Unless the device ships a real certificate story, the fallback is not optional.

---

*Behavior verified with headless Chromium (Playwright) against one server reached via both
origins in the table, August 2026: `navigator.clipboard` present on `127.0.0.1`, `undefined`
on the LAN IP, `execCommand('copy')` returning `true` on both.*
