# Ink Projector (prototype v0)

A camera looks at a sheet of paper. The prototype finds the sheet, flattens it, pulls out only the ink,
and sends it to an output window where the strokes become glowing, shimmering particles.

## Run it

```bash
node ink-projector/serve.js
```

Open http://localhost:8765. It has to be a localhost page, not a double-clicked file, because the camera
and the link between windows only work there. Use Chrome.

## Two ways to draw

Pick one under **Source → Input**:

- **Paper + camera:** draw on real paper under a camera (described below).
- **Draw on screen:** draw with a mouse, trackpad or stylus on the pad in the operator window.
  Pick a brush, colour and size; stylus pressure changes the size.
  Brushes: **Pen** (plain line), **Spray** (soft cloud of fine dots),
  **Hatch** (short dashes across the stroke; circles become radiating rings), **Ripple**
  (parallel contour lines), **Polka** (big evenly spaced dots) and **Triangles** (scattered solid triangles). **Colour mix** spreads each mark's hue and lightness around the chosen colour. Lines become particles the
  moment you draw them, and Clear wipes the pad along with the output.

## Photo submissions (phones)

Set **Input** to **Photo submissions (phones)**. Visitors draw on paper and send a photo from their phone.

1. **Open a section:** click a shape on the doorway (a door panel, the arch, a step…). It glows on the
   output, and a QR code appears in the corner.
2. **Print its template:** **Print template for this section** prints just that shape in light blue,
   with a small map of the doorway showing where it goes. Light blue is too faint to count as ink.
3. **Visitors:** draw inside the shape with a dark marker, scan the QR code, and photograph the sheet.
   Their phone (`submit.html`) finds the sheet, straightens it, keeps only the ink inside the shape and
   shows a preview before sending. Only that small image is uploaded.
4. **Approve:** drawings wait in the **Photo submissions** panel. **Approve** fits the drawing into the
   shape it was drawn for, cut to its outline, and it turns into particles. **Reject** deletes it.
5. **Clear** wipes the projection and the saved approved drawings. Approved drawings survive reloading
   the operator page.

The server part is `api/ink.js` (Vercel + the project's Upstash Redis), with its logic in
`lib/ink-api.js`. Locally, `serve.js` runs the same logic in memory, but phones can't reach `localhost`,
so test with real phones on the deployed site. To stop strangers from approving drawings through the
API, set `INK_OPERATOR_KEY` in the Vercel project's environment variables. The operator page then asks
for the key once.

## Building outline

Turn on **Building outline** to draw on a building instead of a blank page. Use the **Sample building**,
or upload **My image**: either a photo (edges are found automatically; adjust **Edge detail**) or a clean
line drawing of the facade.

- **On the drawing pad** the outline is a faint blue guide. It is never captured.
- **Drawing limits** (drawing pad only): *Stay inside each shape* works like a colouring book: a stroke
  stays inside the shape it starts in (a door panel, the arch, a step…). *Stay inside the doorway*
  lets strokes cross lines but not leave the doorway. *Draw anywhere* removes the limits.
- **On the output** it can glow softly behind the drawing (toggle and brightness in the same section).
- **For paper**, **Print paper template** prints the outline in light blue. Light blue is too faint to
  count as ink, so the camera captures only what's drawn on top, and it lines up with the outline on
  the output.

## Two windows

- **Operator** (`index.html`): camera view with the paper outline, the flattened paper, the detected ink,
  a live preview of the output, and all controls.
- **Output** (`output.html`): press **Open output window**, drag that window onto the projector, press **F**.

## How capture works

1. **Paper:** finds the largest bright shape (white paper on a darker surface works best). Once the
   outline holds still briefly it locks itself. You can drag the corner dots, or use Lock to fix it by hand.
2. **Ink:** a pixel is ink when it's clearly darker than the paper around it, which copes with uneven light.
   Skin-coloured pixels are ignored.
3. **Capture:** ink is kept only after it has stayed put for the hold time with nothing moving nearby,
   so the pen and hand don't get projected.
4. **Clear:** Space, C, or the button. The particles drift away and fade. Capture then pauses until the
   old drawing leaves the camera (sheet swapped), so it isn't captured again.

## Physical clear button

Any USB button that types a key works, such as an arcade button with a USB keyboard encoder, a foot
pedal or a macro pad. Set it to send **Space**. Either window must be focused; the output window on the
projector usually is.

## Testing without a camera

Choose **Simulated drawing** as the input. It shows a fake sheet with a hand drawing on it, with shadows
and uneven light, and restarts when you press Clear. **Photo file** lets you test with a phone photo of a real drawing.
