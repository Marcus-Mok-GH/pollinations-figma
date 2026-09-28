# Pollinations for Figma

Generate and edit images with [Pollinations](https://pollinations.ai) inside Figma, paying with your
own Pollen. Submitted for Pollinations quest #15572.

No build step: `manifest.json`, `code.js`, `ui.html`, and `api.js` run straight from this folder
in Figma dev mode. The API layer (`api.js`) is plain JavaScript that runs identically in the
plug-in UI and in Node, so the exact request/response code is unit-testable.

## Features

- **Fill the selection** — pick any image model from the live catalog, write a prompt, and the
  selected frame or shape gets an image fill at its aspect ratio (`IMAGE` paint, scale mode FILL)
- **Edit the selected image** — the selection is exported as PNG, sent to `/v1/images/edits`
  with your prompt, and the result replaces the fill in place. Only image-input-capable models
  are offered (the model list is filtered exactly like the official GIMP plug-in)
- **Player-funded sign-in** — BYOP device flow: paste your publishable `pk_` App Key, approve at
  `enter.pollinations.ai/device`, done. The token lives in `figma.clientStorage`, never in your
  document. A development API key option is also available
- **Live model catalog** — `GET /image/models`, filtered to image-output models; the approval
  URL is host-checked
- **Actionable errors** — notices for expired sign-in, low Pollen balance (top-up link), missing
  auth, and network failures; the edit poll loop treats `authorization_pending` HTTP 400 bodies
  as flow state, matching the real API

## Install (Figma dev mode)

1. Clone or download this repo.
2. In the Figma desktop app: Plugins → Development → Import plugin from manifest… and pick
   `manifest.json` from this folder.
3. Run **Plugins → Development → Pollinations**.
4. In the Account tab: paste your `pk_` App Key and connect (device flow), or set a development
   `sk_` API key.

## Short demo

1. Draw a rectangle, keep it selected, run the plug-in.
2. Generate tab → model `tongyi-mai/z-image-turbo`, prompt “a tiny pixel-art garden on an alien
   planet” → **Fill selection**. The rectangle fills with the generated image.
3. With that rectangle still selected, Edit tab → model `openai/gpt-image-2`, prompt “make it a
   night scene” → **Edit selected image**. The fill is replaced by the edited version, in place.
4. Account tab shows the connected state and a top-up link; Disconnect clears the stored token.

## Verification

Two suites ship in the repo (Node 20, no dependencies):

```bash
npm test          # 31 checks: api.js units + code.js integration against a mocked figma
npm run test:live # live catalog + generation + edit through the plug-in's own api.js
```

The offline suite covers request body shapes (including the `data:image/png;base64` edit body),
model-catalog filtering (drops video models, exactly like the official GIMP plug-in), b64_json
decoding, the device-flow state machine (pending arrives as HTTP 400 — matching the real API —
plus slow_down back-off, verification_uri_complete, and the approval-URL host check), and the
sandbox side: selection capability reporting, PNG export for edits, image fills applied to the
node, token storage in clientStorage, and notifications.

The live suite (with `POLLINATIONS_API_KEY`) verified against the real API: the filtered model
catalog loads (18 image models), a 181 KB JPEG generated and decoded via b64_json, and — the core
edit feature — `/v1/images/edits` returned a 175 KB edited image for a PNG source. The device-flow
endpoints were verified live separately: `/api/device/code` issues a real device code, and
`/api/device/token` returns `authorization_pending` (HTTP 400) as documented; full end-to-end
sign-in needs a registered `pk_` App Key.

The Figma-side glue (fills, export, clientStorage) is covered by the mocked integration tests
above; a visual pass inside the actual Figma app needs a Figma environment.

## License

MIT
