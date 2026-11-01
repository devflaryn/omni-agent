# The Mission view's office art

The Mission view draws a mission as a pixel-art office:

- The **orchestrator** works in a glass-walled room at the back, between two ivory CRTs angled in toward him. A LED board on his wall shows the tasks done out of the total, the workers, his context use, how long the mission has run, how many workers are busy, and his model.
- **Workers** sit at desks on one shared open floor. Each CRT is turned toward its person, away from the camera, and its screen light falls on their face and desk.
- **Subagents** sit at small desks in front of their worker. Shell jobs appear there too, as server racks.
- **Cables** on the floor run from the orchestrator's door to every worker, and on to each worker's subagents. They are coloured by kind: Claude Code is terracotta, OpenCode is slate, shell jobs are grey.
- **Text** is written into the scene with pixel fonts:
  - Above each head: the kind and task id.
  - On the floor in front of each desk: the title, the plan step (a bar plus x/y), tokens, working time and state.
- **Clicks:** clicking a desk or the orchestrator's room selects it, and its details open below.

The design canvas the art was approved on is at <https://claude.ai/artifact/2c1CEtC33FC4PAg6KQwDvJ>. It is a reference picture; the code below is what Omni actually draws.

## How it is made

Nothing here is a hand-drawn bitmap. A small 3D renderer, which runs in the browser and in Node, casts one ray per pixel against boxes and ellipsoids. It shades with a few colours per material ("ramps"), adds a key light with cast shadows and coloured point lights for the screens, draws glass, and outlines objects. Because the objects are real 3D shapes at real angles, moving a monitor or turning a person stays consistent.

| File | What it holds | Change it to… |
| --- | --- | --- |
| `ui/office-props.js` | `RAMP` (every colour ramp, dark → light), `person()` (body, arms, head, hair styles, the OpenCode hood, the orchestrator's headset, faces), `crt()` (the three CRT models), `desk()`, `chair()`, `keyboard()`, `mug()`, `papers()`, `plant()` (five random kinds, three pots, three greens) | restyle people, clothes, hair, skin, monitors, furniture and plants |
| `ui/office.js` | `LAYOUT` (camera tilt, columns, room size, row gaps, how many subagents get a desk), `LIGHT` / `STATE_COLOR` (screen light per state), `POSE` (pose per state), `KIND` (labels, label and cable colours), the room and its decor in `renderOffice()`, all text in `labelOffice()`, the data mapping in `officeData()` | move things, change what is written where, change state colours, add decor |
| `ui/office-engine.js` | the renderer: `Scene` (box, ellipsoid, limb, light), `render()` (shading, shadows, glass, outlines), `paintOn()` (faces), the key light and ambient level (`Scene` constructor) | lighting, outline strength, glass look |
| `ui/office-font.js` | the 5×7 and 3×5 pixel fonts | add a character, change the shadow |

States and how they look:

| State | Agent status | Screen light | Pose |
| --- | --- | --- | --- |
| working | running, starting | blue `#7dd3fc` | typing |
| idle (orchestrator) | waiting for reports | violet `#c4b5fd` | leaning back |
| done | done | green `#86efac` | stretching |
| failed | error, timeout, stalled | red `#f87171` | typing |
| queued | queued | amber `#fbbf24` | an empty chair |
| stopped | cancelled, interrupted, paused | screen off | asleep at the desk |

## Seeing a change without the app

```sh
node scripts/office-preview.mjs office.png 3              # the sample mission, 3x
OFFICE_SELECTED=a2 node scripts/office-preview.mjs        # with a desk selected
node scripts/office-preview.mjs office.png 3 my-data.json # your own data (the shape officeData() returns)
```

The sample data is `SAMPLE` in `scripts/office-preview.mjs`. `test/ui-office.test.mjs` checks the data mapping, the hit boxes and the fonts, and checks that the 3D pass is skipped when only numbers change.

## Live in the app

`ui/mission.js` runs `createOffice().draw(officeData(…))` on every render.

- **Full 3D pass** (about 1 s for 8 workers): only when the *scene key* changes, meaning someone's state or the set of agents changed (`sceneKey()`).
- **Text pass** (a few ms): every time. Tokens, times and step counts only redraw the text.

Each agent record carries the numbers the office shows:

- `tokens` and `context`: counted from each model call in `server/agents.mjs`.
- `plan: { done, of }`: from the agent's plan tool, the goal keeper's progress, or Claude Code's `TodoWrite` list.
