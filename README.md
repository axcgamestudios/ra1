# Rocket Arena

A browser Rocket Ball car soccer game: deterministic RocketSim WASM physics at 120 Hz, Three.js rendering, ONNX bot opponents, and **peer-to-peer online 1v1 matches over WebRTC (PeerJS)** — no game server required.

**Play it:** deployed to GitHub Pages at `https://axcgamestudios.github.io/ra1/` (this repository).

## Multiplayer (peer-to-peer)

Online play is host-authoritative over PeerJS data channels:

- **Create a room** from Play → Multiplayer and share the five-letter code.
- A friend **joins with the code**; the host runs the authoritative arena in their browser (120 Hz WASM simulation, 20 Hz binary snapshots with native checkpoints) while the guest plays with client-side prediction and rollback reconciliation.
- No accounts, no matchmaking server, no database. Signaling uses the free PeerJS cloud; gameplay data flows directly browser-to-browser.
- If the host leaves mid-match the match ends; the guest sees the result screen.

Both players must use the default (experimental) physics build — the handshake verifies the physics hash before a match can start.

## Controls

Keyboard and mouse defaults match Rocket Ball:

| Action | Binding |
| --- | --- |
| Throttle / Reverse | W / S |
| Steer | A / D |
| Boost | Left mouse button |
| Jump | Right mouse button |
| Powerslide / Air roll (hold) | Left Shift |
| Air roll left / right | Q / E |
| Ball cam toggle | Space |
| Reset shot (training) | Backspace |

Gamepad defaults also mirror Rocket Ball (RT throttle, LT reverse, A jump, B boost, X powerslide/air roll, Y ball cam, right stick camera). Everything is rebindable in Settings → Controls. Camera defaults match Rocket Ball (110° FOV, distance 270, height 100, angle -3, stiffness 0.45, swivel 4.0, camera shake on).

Offline modes: **Bots** (Seer / Necto / Nexto ONNX policies, three difficulties) and **Free Play** work without any connection. Bots fall back to single-threaded inference where cross-origin isolation is unavailable (e.g. GitHub Pages).

## Deploy to GitHub Pages

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds with `ROCKET_ARENA_BASE_PATH=/ra1` and publishes `dist/` through the Pages Actions. Pages must be configured with the **GitHub Actions** source.

## Local development

Node 22+ required.

```sh
npm ci
npm start          # dev server with live reload on http://127.0.0.1:4173
npm run build      # production build into dist/
```

Useful environment variables: `ROCKET_ARENA_BASE_PATH=/ra1` for project-page builds, `ROCKET_ARENA_PORT` to change the dev port, `ROCKET_ARENA_DIST=1` to serve a built `dist/`.

Testing: `npm run verify`, `npm test`, `node scripts tests` — the legacy dedicated-server stack under `server/` and its tests are preserved but not used by the GitHub Pages deployment.

## Code map

- `src/online/p2p.js` — multiplayer UI + host/guest orchestration (PeerJS).
- `src/online/p2p-room.js` — host-authoritative room and input stream (browser port of the old server room).
- `src/online/protocol.js`, `prediction.js`, `snapshot-buffer.js` — binary snapshot protocol and guest prediction/rollback, shared with the legacy server netcode.
- `src/vendor/peerjs.mjs` — vendored PeerJS 1.5.5 (MIT).
- `src/physics/` — RocketSim WASM wrapper, presets, state layout.
- `src/input/`, `src/ui/`, `src/rendering/`, `src/bots/` — controls, menus/HUD, renderer, bot policies.

## License

Original contributions by Malik Abuallatta are licensed under the MIT License (see `LICENSE`). Third-party code, adaptations, dependencies, and assets retain their existing licenses and notices — see `SOURCE.md`, `public/licenses/`, and the asset credits. This license does not grant new rights to third-party material.
