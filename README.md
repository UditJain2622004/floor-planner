# FloorPlan Canvas

A dependency-free, single-page floor-plan editor built with SVG + vanilla JavaScript.

## Run

No install is required.

1. Unzip the project.
2. Open `index.html` directly in a modern browser, **or** run:
   `python -m http.server 8000`
3. Open `http://localhost:8000`.

## Included assets

Wall, gate/door, bike, car, stairs, room, dining table, sofa, table, TV unit, kitchen slab, rectangle, circle, bed, wash basin, toilet seat, washing machine and plant.

## Core interactions

- Click or drag an asset from the left palette onto the plan.
- Select any item to get corner resize handles.
- Drag to move.
- Hold Shift while moving/resizing to bypass snap.
- Resize, position, rotate, relabel and restyle from the Properties panel.
- Dimensions are automatically displayed in feet + inches.
- Turn grid and measurements on/off.
- Snap to 6 inches, 1 foot or 2 feet.
- Duplicate, delete, bring forward/back.
- Undo / redo.
- Save / load JSON.
- Export SVG / PNG.

## Notes

The app intentionally uses simple code-drawn SVG assets so they stay easy to customize, recolor and resize. The architecture is a good base for adding more architectural symbols, wall joints, dimension lines, room area calculations, doors with swing direction, etc.
