# Presentation

`src/presentation/` (pure model, commands, geometry, logic, renderer) and the
`src/app/presentation-editor.js` family. Done: editor (Phase 5), animations, slide show.
Spec §7.

## Model (`presentation/model.js`)

- `content = { size, slideOrder, slides, sections }`. `size` (`{width, height}`, 320..7680,
  default 1280x720) is shared by every slide.
- A slide has `layout`, `background`, `transition` (`style` none|fade|wipe, `direction`,
  `duration`), `objectOrder` (z-order, bottom to top), `objects`, `animations`,
  `animationOrder`. Identity (`slide_...`, `obj_...`, `anim_...`) is separate from the orders.
- Objects: `text | shape | line | image | reference`, with x/y/width/height/rotation,
  fill/stroke, `shape` kind, `flipV` for lines, a `text` body (`runs`, fontSize, color, align,
  valign), `link`, and `src` (data URL; moves to the asset registry in Phase 7). `reference`
  objects embed a section or expression (see `references.md`); text objects with inline refs
  carry `autoHeight`.
- Animation: `{ id, objectId, effect: appear | fade-in | slide-in | motion, trigger: click |
  with | after, delay, duration (ms), direction? (slide-in origin), path? (motion: {from, to}
  offsets from the resting position) }`. "After previous" is the `after` trigger.
- `validatePresentationContent` / `ensurePresentationContent` follow the sheet pattern;
  `validateSlide` tolerates slides without animation fields and `ensure...` backfills them.
- `layouts.js`: Title, Title + content, Two columns, Blank. Defined in fractions of the slide
  size; they only pre-place text objects (no placeholders).

## Commands (`presentation/commands.js`)

`createSlide`, `duplicateSlide` (remaps object and animation ids), `deleteSlide`
(`lastSlide` refusal; `{slideIds}` deletes several as one command), `moveSlide`,
`setSlideBackground`, `setSlideTransition`, `applyTransitionToAll`, `setSlideSize
{scaleContent}` (rescales objects and motion offsets in one transaction), `insertObject`,
`updateObject`, `updateObjects`, `setObjectRuns`, `deleteObjects` (removes their animations),
`duplicateObjects`, `pasteObjects` (neither copies animations), `reorderObjects`,
`addAnimation`, `updateAnimation` (whitelisted patch; switching effect adds/removes
`direction`/`path`), `deleteAnimation`, `moveAnimation`. All are transactions.

## Geometry (`geometry.js`, pure)

`rotatedBounds`, `resizeRect` (local axes, fixed anchor), `rotationFrom`, `snapMove` (slide
edges/centre, other objects, optional grid), `objectsInMarquee`, `planSlideReorder`,
`fitScale`, `scaleObject`, `SIZE_PRESETS` (16:9, 4:3, 16:10).

## Renderer (`presentation/render.js`)

`renderSlide(slide, {size, scale})` is shared by the stage, thumbnails and the slide show.
Shapes and lines are inline SVG; text goes through `renderRuns`.

## Editor

Three panes: `slide-strip.js` (thumbnails, hover "+", drag reorder, right-click menu with a
layout submenu, strip keyboard), the scaled stage, and `inspector.js` (selection-driven
sections; slide background, transition and size when nothing is selected).

`presentation-editor.js` builds the kernel (`ed`): the mutable state on one object (`ed.st`:
current slide, selection, tool, text edit, gesture, ...), the shared operations, and the strip,
inspector and timeline. The behaviour lives in modules that each take the kernel and return their
functions: `presentation-stage.js` (stage and overlay drawing), `-slides.js`, `-objects.js`,
`-animations.js`, `-text.js` (in-place text editing), `-gestures.js` (pointer gestures),
`-input.js` (double click, context menu, keys), `-references.js` (embeds and expressions).
`presentation-dom.js` holds the constants and DOM helpers. Functions one module offers another are
forwarded through the kernel, so a module takes what it needs at creation.

- A `gesture` union (`move | resize | rotate | marquee | draw | path`) previews on the live
  DOM and commits one command on mouseup; geometry lands on whole logical px. Pointer
  conversion uses `rect.width / size.width || 1`, so jsdom (zero rects) works.
- Rendering is keyed. The strip caches a thumbnail per slide id and the stage keeps its `.stage`
  and slide element while the slide, scale and size are unchanged; objects are keyed by
  `data-object-id` with a signature of their data, so only a changed object gets a new element.
  Reference objects and objects with inline references are redrawn on every pass, and an object
  whose element was swapped for a gesture preview or the text editor is drawn again.
- Text edits in place (double-click, F2/Enter, or typing) through a `contenteditable`
  committed with `setObjectRuns`; marks and links share `app/marks.js`.
- Multi-selection supports move, delete, duplicate, arrange and X/Y; resize and rotate
  handles are for a single selected object.
- The session holds the state that must survive a remount (current slide per page, view
  toggles, clipboard). The editor takes `view`, `clipboard` and `initialSlideId` as starting
  values and reports changes through `onViewChange`, `onClipboardChange` and `onSlideChange`.
- **Links.** The editor uses the document link form (`createLinkForm(close)`, shared by the
  ribbon Link button and the context menu's Link...). While editing text it links the
  selection (a page is the anchor href `#<pageId>`); otherwise it links the selected objects,
  mapping `#<pageId>` to the object link `{kind: "page", pageId}` and anything else to
  `{kind: "url"}` (`getLinkUrl` / `getLinkInfo` map back). A slide link counts as linked but
  has no address; the inspector's Link section is the only place to set one.
- **Strip selection.** Shift+click range, Cmd/Ctrl+click toggle, Shift+Arrow extend,
  Cmd/Ctrl+A all; the current slide is always in a multi-selection and a plain click or arrow
  ends it. Delete removes the selection; dragging still moves one slide.

## Ribbon

Home (clipboard, slides, text, arrange, history), Insert (text box, shape gallery, line,
image via file picker to data URL, Reference group), Design (size presets + width/height with
Scale content / Keep as is, background colour, Theme seam), Transitions (style, direction,
duration, apply to all), Animations, Slide Show, View (inspector, snap guides, grid snap).
`kind: "color"` controls use a native colour input.

## Animations

- **Logic (`presentation/animation.js`).** `planTimeline` (a click starts a step; step 0
  auto-plays; `with` anchors to the previous anchor, `after` to the previous end),
  `planPreview` (steps run back to back with a 400 ms pause), `initiallyHidden` (entrance
  effects hide their object), `slideInOffset`, `effectKeyframes`. Movement uses the CSS
  `translate` property so it composes with the inline rotation.
- **Timeline (`animation-timeline.js`).** An ordered list under the stage, shown only while the
  Animations ribbon tab is active (`View.timeline`, set by the shell from
  `ribbon.getActiveTab()` and `createRibbon(..., { onTabChange })`). Rows edit in place (Start,
  Effect, Direction, Delay/Duration ms); `effectPatch` carries the new effect's default duration
  only if the old default was untouched; a refused edit reverts the row. Rows are keyed by
  animation id with a signature (the animation, its object's label, position, whether it is
  last, and the preview state): a change redraws only the rows whose signature changed, the
  rest keep their element, focus and open dropdowns. `select()` re-marks the selected row, and
  Backspace/Delete in a field never deletes the animation. Rows
  reorder by drag (`planSlideReorder`) and up/down buttons.
- **Stage overlay.** Numbered tags, and a dashed line with draggable endpoints for the selected
  motion animation (commits one `updateAnimation` on mouseup). The strip shows an
  `animation-badge`.
- **Preview (`animation-preview.js`).** Plays the current slide with the Web Animations API
  (feature-detected; without it objects are revealed on schedule and motion objects park at the
  end), auto-advancing click steps, then restores the resting state. Any model change, slide
  switch, Escape or stage click stops it. `playAnimation(el, animation, object, size)` is
  exported and shared with the slide show.
- **Ribbon editing.** The effect gallery (Appear, Fade in, Slide in menu, Motion path)
  *replaces* the selected animation's effect (`applyAnimationEffect`; a no-op when nothing
  changes) and highlights the current one; with no animation selected, or one belonging to
  another object, it adds. "Add animation" always adds. Timing: Start, Delay, Duration,
  Direction, Move X / Move Y (motion only; offset = `path.to - path.from`). Order starts with
  an "Animations" picker listing every animation on the slide (`describeAnimations`).
  `syncAnimationToSelection` makes selecting an object select its first animation (unless the
  current one already belongs to it; an empty selection keeps the current one).

## Slide show

- **Where it plays.** An overlay inside `main.main` (`.slideshow`, absolutely positioned,
  `.main` is `position: relative`, z-index 40) covering the title strip, ribbon and canvas;
  the sidebar stays visible. Not browser-fullscreen by default: the bar's fullscreen button or
  `F` requests fullscreen on the overlay and `fullscreenchange` refits the slide. Choosing a
  sidebar page, or anything that re-renders the main column (`renderMain`), ends the show
  silently (`destroy()`; `exit()` is the one that reports back).
- **Starting.** Slide Show ribbon tab (From beginning / From current slide), a title-strip play
  button (`data-action="play-slideshow"`, presentation pages only, from the current slide),
  Cmd/Ctrl+Enter (beginning) and Shift+Cmd/Ctrl+Enter (current). `ShellApi` has
  `startSlideshow(from)` / `isSlideshowActive()`; the shell handle has `getSlideshow()`. Global
  shortcuts (undo, Quick Find, ...) are ignored while a show is up. On exit the editor returns
  to the slide the show reached.
- **Controls.** Always-visible bar: back, `n / total`, forward on the left; fullscreen and
  exit on the right (forward disabled at the end). Keys: Right/Down/PageDown/Space/Enter/N next;
  Left/Up/PageUp/Backspace/P back; Home/End; F fullscreen; Esc exit. Keys with Cmd/Ctrl/Alt and
  keys typed into fields are left alone. Clicking the slide advances; clicking a linked object
  or inline `a[href]` follows it instead (url opens a new tab for http/https/mailto only, page
  link navigates and ends the show, slide link jumps). The last slide stops; no loop.
- **Logic (`presentation/slideshow.js`, pure).** A position is `{index, step}` (`-1` = slide
  just shown; step 0 plays by itself, later steps wait for a press). `lastStep`, `stepEntries`,
  `stepLength`, `settledAt(slide, step)` (entrance objects still hidden, where finished motions
  sit), `nextPosition` (`step | slide | none`), `previousPosition` (`settle | slide | none`),
  `transitionBetween` (forward: the incoming slide's transition; back: the slide being left,
  direction reversed), `transitionKeyframes` (fade = opacity, wipe = `clip-path` inset opening
  from the chosen side), `hasTransition`.
- **Playback (`app/slideshow.js`).** `createSlideshow(workspace, pageId, {startSlideId, onExit,
  navigate, openUrl})` returns `{element, start, next, previous, goTo, finish, getPosition,
  toggleFullscreen, focus, exit, destroy}` or null for an empty deck. Slides use the editor's
  `renderSlide` (read-only; reference hooks built lazily), each scaled to fit and refitted by a
  `ResizeObserver`. A press while a step or transition is running completes it and is used up.
  Going back a step re-applies `settledAt` instantly; going back a slide lands on its finished
  state. Transitions stack the incoming slide over the outgoing one and drop the old one when
  the duration timer fires.
- **Not done.** Presenter notes/view, laser pointer, slide-number jump, auto-advance timings,
  looping, audio/video, start from current object, black end-of-show screen.

## Not done (editor)

Themes (the Design tab's Theme is a disabled seam), resize/rotate of multi-selections, image
assets in the registry (Phase 7), dragging a multi-slide section as a group.

## Tests

`presentation-model`, `presentation-commands`, `presentation-geometry`, `presentation-render`,
`presentation-animation`, `presentation-slideshow`, `app-presentation-editor`, `app-marks`,
`app-animations`, `app-slideshow`, `app-presentation-references`, `app-slide-references`.
