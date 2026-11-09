# Prompt for a computer-use agent

Sitter's first painting came from this prompt. GPT-6.1 Sol, working through computer use, wrote its own stroke planner, proved it offline, then painted 6,706 strokes with real mouse input in about 38 minutes. Two earlier attempts painted by eye and missed the likeness. The likeness arrived when the agent's own algorithm chose every stroke.

Before you start:
- Run `npm run dev`.
- Add your reference (see [reference/README.md](../reference/README.md)).
- Close any open studio tab.
- Paste the text below into a fresh agent session, after filling in the angle-bracket placeholders.

---

Paint a portrait of <subject> in my painting app, Sitter. Work like a computational painter. First write your own painting algorithm that plans every stroke from the reference image, and prove it offline. Then perform every stroke as real mouse and keyboard input in the app.

## Workspace
- **Studio:** http://127.0.0.1:5195/?new=1. Open it once, in one tab. `?new=1` starts a recorded session, and the app logs every input event for the final video.
- **Your workspace:** `<a folder outside the Sitter checkout>`. Write all your code, plans and test images there.
  - Never write inside the Sitter folder. A file change there can reload the page mid-painting.
- **Reference:** `<path to the reference image>`. Scale and centre-crop it to exactly 810 × 1080, so pixel (x, y) is canvas unit (x, y).

## How Sitter behaves
- **Canvas:** 810 × 1080 logical units, displayed scaled.
  - Map screen to canvas with the canvas's on-screen rectangle: cx = (sx − left) / width · 810, cy = (sy − top) / height · 1080.
  - You may read that rectangle once (a screenshot measurement or a read-only layout query).
- **Brush buttons:** 120, 72, 40, 22, 12, 7, 4, 2. Each number is the brush diameter in canvas units.
- **Colour:** click the hex field (it auto-selects), type 6 hex digits, press Enter.
- **Paint:** near-opaque and never blends; later marks cover earlier ones.
  - A click lays one loaded dab.
  - A drag stamps every ≈ 0.075 × size along the path, and the paint load fades slowly on long drags.
- **Pass selector:** Block-in, Form & colour, Refinement, Fine details.

## Step 1: write the painter
Build a coarse-to-fine painter in the spirit of Hertzmann's "Painterly Rendering with Curved Brush Strokes":
- **Layers:** one per brush size, largest first. Sizes and passes:
  - 120 and 72 → Block-in
  - 40 and 22 → Form & colour
  - 12 and 7 → Refinement
  - 4 and 2 → Fine details
- **Per layer:** blur the reference to that brush's scale. Walk a grid with spacing ≈ half the brush size. Wherever the error between your simulated canvas and the blurred reference passes a threshold, place a stroke at the point of maximum error.
- **Strokes:**
  - short curves, 1–3 × the brush size, perpendicular to the luminance gradient
  - single dabs where the gradient is weak
- **Palette:** fit each layer's colours to a small palette (24 colours for large brushes, 40 for small ones) and paint colour group by colour group. Aim for 150–350 colour changes in total.
- **Small brushes** go where detail matters. Leave flat areas to the coarse layers.
- **Simulator:** keep an internal 810 × 1080 simulation of Sitter's marks to compute the errors.

## Step 2: prove it offline
- Render your simulated painting after each pass and at the end.
- Compare it with the reference, and tune it until the subject reads instantly.
- Report the strokes per pass, the colour changes and the estimated time.

## Step 3: check your input channel
Thousands of strokes need a scripted, batched channel that sends real pointer and keyboard events.
- **Allowed:** reading the canvas rectangle, and reading the page to confirm a click landed.
- **Not allowed:** calling the app's functions, drawing with page JavaScript, or writing its files.

If you can only send one action per tool call, stop and tell me.

## Step 4: paint
1. Open the studio once and measure the canvas.
2. **Calibrate:** select Block-in and brush 120, set the first colour, and lay the first planned stroke. Screenshot to confirm it landed where planned, and fix the mapping if not.
3. **Execute the plan in order:**
   - click each pass when its first layer begins
   - click each brush size when it changes
   - type each colour change
   - perform every stroke
4. **Look like a person painting:**
   - glide between strokes with intermediate moves
   - each stroke lasts 80–250 ms, with a move every 10–16 ms
   - pause 20–60 ms between strokes
5. **After each pass,** compare the canvas with your preview, and fix any divergence before continuing.
6. **Never** refresh, navigate away or close the tab. Use Undo only for a clear input mistake.

When you're done, click **Save PNG** and tell me the strokes, the colour changes, the time taken, and whether the result matches your preview.
