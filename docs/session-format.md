# Session format

A session is one JSON file in `session/`, named `session-YYYYMMDD-HHMMSS.json`. The studio appends to it about once a second while you paint, and replay reads it back.

```json
{
  "version": 1,
  "session": "session-20261109-043156",
  "meta": {
    "app": "sitter",
    "startedAt": "2026-11-09T04:31:56.000Z",
    "stage": { "w": 1160, "h": 1200 },
    "canvas": { "x": 28, "y": 92, "w": 810, "h": 1080, "units": [810, 1080] },
    "userAgent": "…",
    "reference": { "src": "/reference/portrait.jpg", "credit": "…", "alt": "…" }
  },
  "events": [
    { "t": 0, "type": "move", "x": 456, "y": 527.3 }
  ]
}
```

Each event has a time `t` in milliseconds since the session started. Pointer positions `x, y` on `move`, `down` and `up` are in stage units, on the fixed 1160 × 1200 studio frame. Stroke points carry canvas units (`x, y`, on 810 × 1080) and stage units (`sx, sy`).

| type | fields | meaning |
|---|---|---|
| `move`, `down`, `up` | `x, y` | pointer movement and buttons, anywhere in the studio |
| `leave` | | the pointer left the window |
| `stroke` | `id, x, y, sx, sy, size, color` | a stroke starts. `size` is the brush diameter, and `color` is a 6-digit hex |
| `pt` | `id, x, y, sx, sy` | the next point of stroke `id` |
| `end` | `id` | stroke `id` is finished |
| `undo` | `id, via` | the last visible stroke `id` was undone (`via`: `button` or `key`). `id` is `null` when there was nothing to undo |
| `size` | `size` | brush size changed |
| `hexfocus`, `hexinput`, `hexblur` | `value` on input | the colour field gained focus, changed or lost focus |
| `color` | `hex, via` | a colour was applied (`via`: `enter` or `blur`) |
| `hexinvalid` | `value` | Enter was pressed on something that isn't a colour |
| `pass` | `pass` | painting pass changed: 0 Block-in, 1 Form & colour, 2 Refinement, 3 Fine details |
| `save` | `file` | Save PNG wrote `session/<name>-NN.png` |
| `resume` | | the page reloaded and continued this session |
| `viewport` | `w, h, scale` | the window was resized |

## Undo

Undo is a tree, not a stack. Each stroke's parent is whatever was on top when it began. Undo moves the top back to the parent, and a new stroke after an undo starts a new branch. The visible painting is the chain from the top back to the root. This keeps the full history (nothing is deleted from the log) while the canvas shows only what the painter kept. `tools/clean-session.mjs` uses the same rule to remove undone work from a timelapse.

## Determinism

Brush marks are a pure function of the stroke id, size, colour and points, so live painting, undo rebuilds and replays at any speed produce the same pixels.
