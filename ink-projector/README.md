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
  **Sound** plays a drawing sound made live in the browser: louder and brighter the faster you draw,
  fading away when the pen stops, with its own character per brush (soft felt-tip for Pen, an airy hiss
  for Spray, scratchy Hatch, soft dabs for Polka and Triangles). It plays from the operator page when
  drawing on the pad, and from the output window when drawing on the projection. Set it to 0 to mute.

## Phones draw live on mapped shapes

Set **Input** to **Phones draw live (your mapped shapes)**. The outline switches to **My shapes**.

1. **Map the shapes (on site):** the **Map the shapes onto the wall** panel is a mirror of the projector
   screen. **+ Add shape**, then drag each shape's corners A–D onto the real corners you see on the wall.
   The projection follows as you drag. Drag inside a shape to move it, hold Shift for fine control, and
   click a corner and use the arrow keys to nudge it by one projector pixel. **Show guides on the wall**
   projects each shape's border and a grid while you line them up. **Width ÷ height** is the shape's real
   proportions, which visitors draw on (**Match the wall** takes them from the corners). Changing the
   proportions or adding or removing a shape clears the drawing.
2. **Visitors** scan the QR code (or open `draw.html`), see a map of the shapes, tap one and draw with
   Pen, Spray, Hatch, Ripple, Polka or Triangles in any colour, with the drawing sound on their phone.
   To switch boxes they swipe left or right (one finger anywhere off the drawing, or two fingers on it),
   use the ‹ › arrows or the dots, or tap a box on the small map of the wall at the top, where the box
   they're on is lit up. The label shows its name and "2 of 4". Each box keeps what they drew on it.
   The sound starts after the first tap (phones don't allow it sooner) and plays on iPhones even on silent.
   **Eraser** and **Clear** (tap twice) only ever remove that visitor's own lines in that box, on their phone
   and on the wall; anyone else's lines stay. Each phone keeps a random id (in the browser) to tell whose is whose.
   Each stroke is sent in small pieces while it's drawn. The operator page replays it on the wall at the
   speed it was drawn, about a second behind, and keeps it inside its shape.
3. The operator can draw on the pad, or straight on the output window, at the same time.
4. The operator's **Clear** wipes only the wall. Phones keep what they drew; visitors use their own Eraser and Clear.

The shapes are stored on the server (`op=setShapes`), and so are the stroke pieces (`op=stroke`, read with
`op=strokes`). Keep the operator page open: it's what draws the phone strokes. Phones can't reach `localhost`,
so test with real phones on the deployed site.

## Photo submissions (phones)

Set **Input** to **Photo submissions (phones)**. Visitors draw on a paper template and send a photo.

1. **Print the templates:** **Print templates (one page per part)** prints six pages: Left door, Right door,
   Arch, Left column, Right column and Steps. Each shows its part's shape in light blue, which is too faint
   to count as ink. Set **Paper size** to the paper you print on, and print at actual size.
2. **Visitors** draw inside the shape with a dark marker, scan the QR code on the projection, choose the
   same part on their phone and photograph the sheet. The phone (`submit.html`) finds the sheet,
   straightens it and keeps only the ink inside the template's shape area. Only that small image is uploaded.
3. **Approve:** drawings wait in the **Photo submissions** panel. **Approve** puts the drawing on its part
   exactly where it was drawn; anything past the part's border is cut off, like the colouring-book mode on
   the drawing pad. A new drawing for a part fades out that part's previous one. **Reject** deletes it.
4. **Clear** wipes the projection and the saved approved drawings. Approved drawings survive reloading
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

## Lining it up with the wall (mapping)

On the output window press **M**. Yellow corners A–D appear around each part: around each box with the
**Two boxes** outline, otherwise around the whole picture. Drag each corner onto the matching corner of
the real surface. Drag inside a part to move all of it, click a corner and use the arrow keys to nudge it
(Shift for bigger steps), and press **R** to reset. Press **M** again when you're done. The picture is warped in
perspective to fit, so it lines up even with the projector at an angle. The corners are saved in that
browser, separately for each outline. Re-drag them whenever the projector moves. The operator's preview
always stays flat.

**Drawing straight on the projection:** with **Input → Draw on screen**, you can draw with the mouse
(or a pen tablet) right on the output window, inside the mapped corners. The stroke uses the brush, colour
and size chosen on the operator page and stays inside the part it starts in. A stroke started outside every
part draws nothing.

**Two boxes** (Building outline → Building) gives two plain boxes. With *Stay inside each shape*, a stroke
started in a box can't leave it.

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
