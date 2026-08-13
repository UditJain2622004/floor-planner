const NS = "http://www.w3.org/2000/svg";

const canvas = {
  // World units are feet. The drawing surface has no finite boundary.
  scale: 20,
};

let state = {
  objects: [],
  selectedId: null,
  showGrid: true,
  showMeasurements: true,
  snap: 0,
  background: "#ffffff",
  dimensionRef: "inner",
  smartAlign: true,
  distancePair: null,
};

let camera = {
  x: -20,
  y: -12,
  w: 40,
  h: 30,
};

let undoStack = [];
let redoStack = [];
let drag = null;
let pan = null;
let spaceDown = false;
let measureMode = false;
let measureDraft = null;
let clipboardObject = null;
let distancePickMode = false;
let autosaveTimer = null;
const cameraBaseWidth = 40;
const AUTOSAVE_KEY = "floorplan-canvas-autosave-v1";

const ASSETS = [
  ["door", "Gate / Door"],
  ["bike", "Bike"],
  ["car", "Car"],
  ["stairs", "Stairs"],
  ["room", "Room"],
  ["dining", "Dining Table"],
  ["sofa", "Sofa"],
  ["table", "Table"],
  ["tv", "TV Unit"],
  ["kitchen", "Kitchen Slab"],
  ["rect", "Rectangle"],
  ["circle", "Circle"],
  ["bed", "Bed"],
  ["basin", "Wash Basin"],
  ["toilet", "Toilet Seat"],
  ["washing", "Washing Machine"],
  ["plant", "Plant"],
];

const defaults = {
  door: { w: 4, h: 0.7, fill: "#ffffff", stroke: "#4a5661" },
  bike: { w: 2.2, h: 6.2, fill: "#ffffff", stroke: "#34414d" },
  car: { w: 5.8, h: 11.5, fill: "#dfe5ea", stroke: "#34414d" },
  stairs: { w: 5, h: 7, fill: "#ffffff", stroke: "#46525d" },
  room: { w: 12, h: 10, fill: "#f7fafb", stroke: "#3f4a55" },
  dining: { w: 6, h: 4, fill: "#d8c4a7", stroke: "#5a4d3c" },
  sofa: { w: 6, h: 2.7, fill: "#cad3da", stroke: "#4a5864" },
  table: { w: 4, h: 2.2, fill: "#d8c09e", stroke: "#5c4d3d" },
  tv: { w: 5.2, h: 0.8, fill: "#2f363d", stroke: "#20262c" },
  kitchen: { w: 8, h: 2.2, fill: "#d8dde1", stroke: "#4b5660" },
  rect: { w: 5, h: 4, fill: "#edf0f2", stroke: "#4b5660" },
  circle: { w: 4, h: 4, fill: "#edf0f2", stroke: "#4b5660" },
  bed: { w: 5, h: 6.5, fill: "#d4e3ec", stroke: "#42515d" },
  basin: { w: 2, h: 1.8, fill: "#edf3f5", stroke: "#4f5e69" },
  toilet: { w: 1.8, h: 2.5, fill: "#f5f7f8", stroke: "#4f5b65" },
  washing: { w: 2.2, h: 2.2, fill: "#e8ecef", stroke: "#4d5963" },
  plant: { w: 2, h: 2, fill: "#bfd3bd", stroke: "#536a56" },
};

const ASSET_NAMES = Object.fromEntries(ASSETS);
ASSET_NAMES.measurement = "Measurement";

const roomDimensionInputNote = document.getElementById(
  "roomDimensionInputNote",
);
const doorPlacementHint = document.getElementById("doorPlacementHint");

function uid() {
  return "o" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function el(name, attrs = {}) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

function ftIn(value) {
  const totalIn = Math.max(0, Math.round(value * 12));
  let ft = Math.floor(totalIn / 12);
  let inches = totalIn % 12;
  return `${ft}'-${inches}"`;
}

function parseFtIn(value) {
  if (typeof value === "number") return value;

  const raw = String(value ?? "")
    .trim()
    .replace(/\u2033/g, '"')
    .replace(/\u2019/g, "'");
  if (!raw) return 0;

  // Explicit feet + inches.
  let m = raw.match(
    /^\s*(\d+(?:\.\d+)?)\s*(?:ft|feet|')\s*(?:[-\s]\s*)?(\d+(?:\.\d+)?)?\s*(?:"|in|inch|inches)?\s*$/i,
  );
  if (m) {
    return Number(m[1]) + Number(m[2] || 0) / 12;
  }

  // Explicit inches only.
  m = raw.match(/^\s*(\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)\s*$/i);
  if (m) return Number(m[1]) / 12;

  // "10-3", "10 3" or "10.3" style feet/inches entry.
  m = raw.match(/^\s*(\d+)\s*[-\s]\s*(\d+(?:\.\d+)?)\s*$/);
  if (m) return Number(m[1]) + Number(m[2]) / 12;

  // Compact architectural entry: 103 means 10'-3", 68 means 6'-8".
  if (/^\d{2,3}$/.test(raw)) {
    const n = Number(raw);
    if (n >= 100) return Math.floor(n / 10) + (n % 10) / 12;
    if (n >= 20) return Math.floor(n / 10) + (n % 10) / 12;
  }

  // Plain numeric entry means feet. 10.5 = 10'-6".
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function snapValue(v) {
  return state.snap ? Math.round(v / state.snap) * state.snap : v;
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function normalizeObject(o) {
  const minSize = 0.25;
  o.x = Number.isFinite(Number(o.x)) ? Number(o.x) : 0;
  o.y = Number.isFinite(Number(o.y)) ? Number(o.y) : 0;
  o.w = Math.max(minSize, Number(o.w) || minSize);
  o.h = Math.max(minSize, Number(o.h) || minSize);
}

function selected() {
  return state.objects.find((o) => o.id === state.selectedId) || null;
}

function objectName(o) {
  return o.label || ASSET_NAMES[o.type] || "Object";
}

function pushHistory() {
  undoStack.push(
    JSON.stringify({
      state: JSON.parse(JSON.stringify(state)),
    }),
  );
  if (undoStack.length > 80) undoStack.shift();
  redoStack = [];
  updateUndoRedo();
}

function restoreHistory(snapshot) {
  const parsed = JSON.parse(snapshot);
  state = parsed.state;
  render();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify({ state: JSON.parse(JSON.stringify(state)) }));
  restoreHistory(undoStack.pop());
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify({ state: JSON.parse(JSON.stringify(state)) }));
  restoreHistory(redoStack.pop());
}

function updateUndoRedo() {
  undoBtn.disabled = !undoStack.length;
  redoBtn.disabled = !redoStack.length;
}

function addObject(type, x = 8, y = 6) {
  const d = defaults[type] || defaults.rect;
  const offset = (state.objects.length % 8) * 0.5;

  const o = {
    id: uid(),
    type,
    x: snapValue(x + offset),
    y: snapValue(y + offset),
    w: d.w,
    h: d.h,
    rotation: 0,
    label: type === "room" ? "BED ROOM" : "",
    labelOffsetX: 0,
    labelOffsetY: -0.8,
    dimensionOffsetX: 0,
    dimensionOffsetY: 1.2,
    topWall: type === "room" ? 3 / 12 : 0,
    rightWall: type === "room" ? 3 / 12 : 0,
    bottomWall: type === "room" ? 3 / 12 : 0,
    leftWall: type === "room" ? 3 / 12 : 0,
    locked: false,
    fill: d.fill,
    stroke: d.stroke,
  };

  normalizeObject(o);
  state.objects.push(o);
  state.selectedId = o.id;
  render();
}

function removeSelected() {
  if (!selected()) return;
  pushHistory();
  state.objects = state.objects.filter((o) => o.id !== state.selectedId);
  state.selectedId = null;
  state.distancePair = null;
  distancePickMode = false;
  render();
}

function duplicateSelected() {
  const o = selected();
  if (!o) return;

  pushHistory();
  const c = JSON.parse(JSON.stringify(o));
  c.id = uid();
  c.x = snapValue(c.x + 1);
  c.y = snapValue(c.y + 1);
  normalizeObject(c);
  state.objects.push(c);
  state.selectedId = c.id;
  render();
}

function bringFront() {
  const o = selected();
  if (!o) return;
  pushHistory();
  state.objects = state.objects.filter((x) => x.id !== o.id);
  state.objects.push(o);
  render();
}

function sendBack() {
  const o = selected();
  if (!o) return;
  pushHistory();
  state.objects = state.objects.filter((x) => x.id !== o.id);
  state.objects.unshift(o);
  render();
}

function rotatePoint(point, cx, cy, deg) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a),
    s = Math.sin(a);
  const dx = point.x - cx,
    dy = point.y - cy;
  return {
    x: cx + dx * c - dy * s,
    y: cy + dx * s + dy * c,
  };
}

function localPointFromWorld(point, o) {
  const cx = o.x + o.w / 2,
    cy = o.y + o.h / 2;
  return rotatePoint(point, cx, cy, -(o.rotation || 0));
}

function worldPointFromLocal(local, cx, cy, rotation) {
  return rotatePoint(local, cx, cy, rotation || 0);
}

function rotatedCorners(o) {
  const cx = o.x + o.w / 2,
    cy = o.y + o.h / 2;
  return [
    worldPointFromLocal({ x: o.x, y: o.y }, cx, cy, o.rotation),
    worldPointFromLocal({ x: o.x + o.w, y: o.y }, cx, cy, o.rotation),
    worldPointFromLocal({ x: o.x + o.w, y: o.y + o.h }, cx, cy, o.rotation),
    worldPointFromLocal({ x: o.x, y: o.y + o.h }, cx, cy, o.rotation),
  ];
}

function objectBoxPx(o) {
  return {
    x: o.x * canvas.scale,
    y: o.y * canvas.scale,
    w: o.w * canvas.scale,
    h: o.h * canvas.scale,
  };
}

function buildGeometry(o) {
  const b = objectBoxPx(o);
  const w = b.w,
    h = b.h;
  const stroke = o.stroke || "#3d4650";
  const fill = o.fill || "#edf0f2";
  const thin = 1.1;
  const med = 2.0;
  const shapes = [];

  const line = (x1, y1, x2, y2, sw = thin, extra = {}) =>
    shapes.push(
      el("line", { x1, y1, x2, y2, stroke, "stroke-width": sw, ...extra }),
    );

  const rect = (x, y, ww, hh, fill2 = fill, rx = 0, sw = thin, extra = {}) =>
    shapes.push(
      el("rect", {
        x,
        y,
        width: ww,
        height: hh,
        fill: fill2,
        stroke,
        "stroke-width": sw,
        rx,
        ...extra,
      }),
    );

  const circle = (cx, cy, r, fill2 = "none", sw = thin, extra = {}) =>
    shapes.push(
      el("circle", {
        cx,
        cy,
        r,
        fill: fill2,
        stroke,
        "stroke-width": sw,
        ...extra,
      }),
    );

  const ellipse = (cx, cy, rx, ry, fill2 = "none", sw = thin) =>
    shapes.push(
      el("ellipse", {
        cx,
        cy,
        rx,
        ry,
        fill: fill2,
        stroke,
        "stroke-width": sw,
      }),
    );

  if (o.type === "wall") {
    rect(0, 0, w, h, fill, 1, med);
    line(0, h / 2, w, h / 2, 0.65, { stroke: "#7f8992" });
  } else if (o.type === "door") {
    // Door is intentionally a simple wall-opening marker.
    // A background-colored rectangle visually removes the wall beneath it.
    // A very light outline makes the opening discoverable on blank space.
    rect(w * 0.08, h * 0.1, w * 0.84, h * 0.8, "#ffffff", 0, 1.0, {
      stroke: "#8f979e",
      "stroke-dasharray": "4 3",
    });

    // Small threshold ticks on the sides make orientation obvious.
    line(w * 0.08, h * 0.1, w * 0.08, h * 0.22, 1.1, { stroke: "#6f7880" });
    line(w * 0.92, h * 0.1, w * 0.92, h * 0.22, 1.1, { stroke: "#6f7880" });
  } else if (o.type === "bike") {
    const r = Math.min(w, h) * 0.19;
    circle(w * 0.22, h * 0.72, r, "none", med);
    circle(w * 0.78, h * 0.72, r, "none", med);

    line(w * 0.22, h * 0.72, w * 0.4, h * 0.45, med);
    line(w * 0.4, h * 0.45, w * 0.63, h * 0.72, med);
    line(w * 0.63, h * 0.72, w * 0.22, h * 0.72, med);
    line(w * 0.4, h * 0.45, w * 0.54, h * 0.35, med);
    line(w * 0.54, h * 0.35, w * 0.68, h * 0.32, 1.4);
    line(w * 0.4, h * 0.45, w * 0.28, h * 0.39, 1.4);

    // pedals + seat
    circle(w * 0.43, h * 0.57, Math.min(w, h) * 0.06, "none", 0.9);
    line(w * 0.29, h * 0.36, w * 0.45, h * 0.36, 1.5);
  } else if (o.type === "car") {
    rect(w * 0.08, h * 0.03, w * 0.84, h * 0.94, "#dce3e8", w * 0.11, med);
    rect(w * 0.18, h * 0.16, w * 0.64, h * 0.28, "#b9c9d5", w * 0.035, 1.0);
    rect(w * 0.18, h * 0.56, w * 0.64, h * 0.22, "#d7dfe5", w * 0.025, 1.0);

    circle(w * 0.18, h * 0.82, w * 0.075, "#252b31", 0.8);
    circle(w * 0.82, h * 0.82, w * 0.075, "#252b31", 0.8);
    circle(w * 0.18, h * 0.18, w * 0.075, "#252b31", 0.8);
    circle(w * 0.82, h * 0.18, w * 0.075, "#252b31", 0.8);

    line(w * 0.5, h * 0.44, w * 0.5, h * 0.56, 1.0);
    line(w * 0.31, h * 0.67, w * 0.69, h * 0.67, 0.8);
    line(w * 0.3, h * 0.13, w * 0.7, h * 0.13, 1.0);
  } else if (o.type === "stairs") {
    // Transparent stair symbol with an explicit outer border.
    rect(0, 0, w, h, "none", 0, 1.6);
    for (let i = 1; i < 8; i++) {
      line(0, (h * i) / 8, w, (h * i) / 8, 0.8, { stroke: "#626e78" });
    }

    // Turning stair path / direction.
    line(w * 0.24, h * 0.84, w * 0.24, h * 0.54, 1.8);
    line(w * 0.24, h * 0.54, w * 0.62, h * 0.54, 1.8);
    line(w * 0.62, h * 0.54, w * 0.62, h * 0.18, 1.8);

    shapes.push(
      el("path", {
        d: `M ${w * 0.62} ${h * 0.18}
         l -${w * 0.07} ${h * 0.08}
         M ${w * 0.62} ${h * 0.18}
         l ${w * 0.07} ${h * 0.08}`,
        fill: "none",
        stroke,
        "stroke-width": 1.7,
      }),
    );
  } else if (o.type === "room") {
    ensureRoomWalls(o);
    const top = Math.max(0, o.topWall * canvas.scale);
    const right = Math.max(0, o.rightWall * canvas.scale);
    const bottom = Math.max(0, o.bottomWall * canvas.scale);
    const left = Math.max(0, o.leftWall * canvas.scale);

    // Clear interior.
    rect(
      left,
      top,
      Math.max(1, w - left - right),
      Math.max(1, h - top - bottom),
      "#fff",
      0,
      0.8,
      { stroke: "#7d878f" },
    );

    // Four separate wall bands.
    if (top > 0) rect(0, 0, w, top, "#dfe3e6", 0, 1, { stroke: "#68737c" });
    if (bottom > 0)
      rect(0, h - bottom, w, bottom, "#dfe3e6", 0, 1, { stroke: "#68737c" });
    if (left > 0)
      rect(0, top, left, Math.max(0, h - top - bottom), "#dfe3e6", 0, 1, {
        stroke: "#68737c",
      });
    if (right > 0)
      rect(
        w - right,
        top,
        right,
        Math.max(0, h - top - bottom),
        "#dfe3e6",
        0,
        1,
        { stroke: "#68737c" },
      );
  } else if (o.type === "dining") {
    rect(w * 0.22, h * 0.17, w * 0.56, h * 0.66, "#d8c4a7", 6, med);
    const cr = Math.min(w, h) * 0.075;
    for (const [px, py] of [
      [0.1, 0.25],
      [0.1, 0.5],
      [0.1, 0.75],
      [0.9, 0.25],
      [0.9, 0.5],
      [0.9, 0.75],
    ])
      circle(w * px, h * py, cr, "#eef1f2", 1.0);

    circle(w * 0.5, h * 0.5, Math.min(w, h) * 0.06, "#c3aa89", 0.7);
  } else if (o.type === "sofa") {
    rect(0, h * 0.22, w, h * 0.61, "#c7d1d8", 10, med);
    rect(w * 0.06, h * 0.05, w * 0.88, h * 0.28, "#d9e1e6", 9, med);
    rect(w * 0.01, h * 0.55, w * 0.18, h * 0.3, "#b7c3cb", 8, 1.0);
    rect(w * 0.81, h * 0.55, w * 0.18, h * 0.3, "#b7c3cb", 8, 1.0);
    line(w * 0.33, h * 0.28, w * 0.33, h * 0.75, 0.9);
    line(w * 0.66, h * 0.28, w * 0.66, h * 0.75, 0.9);
  } else if (o.type === "table") {
    rect(w * 0.08, h * 0.15, w * 0.84, h * 0.7, "#d8c09e", 7, med);
    line(w * 0.2, h * 0.79, w * 0.2, h, 1.7);
    line(w * 0.8, h * 0.79, w * 0.8, h, 1.7);
    line(w * 0.27, h * 0.5, w * 0.73, h * 0.5, 0.8);
  } else if (o.type === "tv") {
    rect(0, 0, w, h * 0.72, "#333a41", 2, med);
    rect(w * 0.08, h * 0.1, w * 0.84, h * 0.48, "#14181c", 1, 0.8);
    line(w * 0.42, h * 0.72, w * 0.42, h, 1.5);
    line(w * 0.58, h * 0.72, w * 0.58, h, 1.5);
    line(w * 0.36, h, w * 0.64, h, 1.7);
  } else if (o.type === "kitchen") {
    rect(0, 0, w, h, "#d8dde1", 2, med);
    rect(w * 0.05, h * 0.12, w * 0.9, h * 0.76, "#f0f2f3", 1, 0.9);

    // modules
    for (const x of [0.28, 0.52, 0.72])
      line(w * x, h * 0.12, w * x, h * 0.88, 0.8);

    // sink
    rect(w * 0.68, h * 0.22, w * 0.22, h * 0.42, "#fff", 2, 0.9);
    ellipse(w * 0.79, h * 0.43, w * 0.065, h * 0.1, "none", 0.8);
    shapes.push(
      el("path", {
        d: `M ${w * 0.79} ${h * 0.22} q 0 -${h * 0.1} ${w * 0.06} 0`,
        fill: "none",
        stroke,
        "stroke-width": 1.1,
      }),
    );

    // hob
    for (const x of [0.18, 0.39])
      circle(w * x, h * 0.45, Math.min(w, h) * 0.055, "none", 0.8);
  } else if (o.type === "measurement") {
    const y = h / 2;
    line(0, y, w, y, 1.6, { stroke: "#3d6cdf" });
    line(0, y - 6, 0, y + 6, 1.2, { stroke: "#3d6cdf" });
    line(w, y - 6, w, y + 6, 1.2, { stroke: "#3d6cdf" });
  } else if (o.type === "rect") {
    rect(0, 0, w, h, "none", 0, med);
  } else if (o.type === "circle") {
    ellipse(w / 2, h / 2, w / 2 - 1, h / 2 - 1, "none", med);
  } else if (o.type === "bed") {
    rect(0, 0, w, h, "#d4e3ec", 8, med);
    rect(w * 0.07, h * 0.06, w * 0.86, h * 0.23, "#f7f9fa", 4, 0.9);
    rect(w * 0.1, h * 0.09, w * 0.3, h * 0.16, "#fff", 2, 0.8);
    rect(w * 0.6, h * 0.09, w * 0.3, h * 0.16, "#fff", 2, 0.8);
    line(w * 0.07, h * 0.34, w * 0.93, h * 0.34, 0.9);
    line(w * 0.07, h * 0.71, w * 0.93, h * 0.71, 0.9);

    // two side rails / wooden outline feel
    line(w * 0.04, h * 0.04, w * 0.04, h * 0.96, 0.8, { stroke: "#71808b" });
    line(w * 0.96, h * 0.04, w * 0.96, h * 0.96, 0.8, { stroke: "#71808b" });
  } else if (o.type === "basin") {
    ellipse(w * 0.5, h * 0.56, w * 0.39, h * 0.29, "#eef4f7", med);
    shapes.push(
      el("path", {
        d: `M ${w * 0.42} ${h * 0.28} Q ${w * 0.5} ${h * 0.07} ${w * 0.58} ${h * 0.28}`,
        fill: "none",
        stroke,
        "stroke-width": 1.5,
      }),
    );
    circle(w * 0.5, h * 0.58, Math.min(w, h) * 0.04, "#fff", 0.8);
    line(w * 0.5, h * 0.1, w * 0.5, h * 0.2, 0.8);
  } else if (o.type === "toilet") {
    rect(w * 0.18, 0, w * 0.64, h * 0.2, "#eef2f4", 4, 0.9);
    ellipse(w * 0.5, h * 0.59, w * 0.28, h * 0.32, "#f9fafb", med);
    shapes.push(
      el("path", {
        d: `M ${w * 0.34} ${h * 0.82} Q ${w * 0.5} ${h * 0.94} ${w * 0.66} ${h * 0.82}`,
        fill: "none",
        stroke,
        "stroke-width": 0.8,
      }),
    );
    line(w * 0.5, h * 0.27, w * 0.5, h * 0.42, 0.9);
  } else if (o.type === "washing") {
    rect(0, 0, w, h, "#e8ecef", 3, med);
    rect(w * 0.08, h * 0.07, w * 0.84, h * 0.14, "#f9fafb", 1, 0.8);
    circle(w * 0.5, h * 0.57, w * 0.27, "#f8fafb", med);
    circle(w * 0.5, h * 0.57, w * 0.18, "#dbe5eb", 0.9);
    circle(w * 0.78, h * 0.14, Math.min(w, h) * 0.035, "#5a656e", 0.7);
  } else if (o.type === "plant") {
    rect(w * 0.27, h * 0.58, w * 0.46, h * 0.3, "#c5ae97", 4, 0.9);

    for (const [px, py, rx, ry, rot] of [
      [0.36, 0.4, 0.13, 0.2, -20],
      [0.5, 0.22, 0.14, 0.25, 0],
      [0.65, 0.4, 0.13, 0.2, 20],
      [0.5, 0.46, 0.11, 0.18, 0],
    ]) {
      const leaf = el("ellipse", {
        cx: w * px,
        cy: h * py,
        rx: w * rx,
        ry: h * ry,
        fill: "#a9c8a6",
        stroke: "#57715a",
        "stroke-width": 0.8,
      });
      leaf.setAttribute("transform", `rotate(${rot} ${w * px} ${h * py})`);
      shapes.push(leaf);
    }
  }

  return { b, shapes };
}

function measurementEndpoints(o) {
  const a = { x: o.x, y: o.y };
  const r = ((o.rotation || 0) * Math.PI) / 180;
  const b = { x: o.x + o.w * Math.cos(r), y: o.y + o.w * Math.sin(r) };
  return { a, b };
}

function nearestWall(point, maxDist = 0.75) {
  let best = null;
  for (const wall of state.objects) {
    if (wall.type !== "wall") continue;

    const cx = wall.x + wall.w / 2,
      cy = wall.y + wall.h / 2;
    const local = rotatePoint(point, cx, cy, -(wall.rotation || 0));

    if (local.x < -maxDist || local.x > wall.w + maxDist) continue;

    const centerY = wall.h / 2;
    const d = Math.abs(local.y - centerY);

    if (d <= maxDist && (!best || d < best.distance)) {
      best = { wall, distance: d, local };
    }
  }
  return best;
}

function measurementInfo(o) {
  const raw = Math.max(0.001, Math.abs(o.w || 0));
  const mode = o.dimensionRef || state.dimensionRef || "inner";
  const { a, b } = measurementEndpoints({ ...o, rotation: 0 });

  const unit = {
    x: (b.x - a.x) / raw,
    y: (b.y - a.y) / raw,
  };

  const wa = nearestWall(a);
  const wb = nearestWall(b);

  // For a dimension drawn between two parallel walls, the centerline distance
  // differs from the face-to-face distance by half of each wall thickness.
  // This is the common architectural convention the UI exposes as Inner/Outer.
  let value = raw;
  let inferred = false;

  if (wa || wb) {
    const usableWalls = [wa, wb].filter(Boolean);
    const compatible = usableWalls.every((hit) => {
      const tangent = {
        x: Math.cos(((hit.wall.rotation || 0) * Math.PI) / 180),
        y: Math.sin(((hit.wall.rotation || 0) * Math.PI) / 180),
      };
      const parallel = Math.abs(unit.x * tangent.x + unit.y * tangent.y) < 0.35;
      return parallel;
    });

    if (compatible && usableWalls.length === 2) {
      const correction = wa.wall.h / 2 + wb.wall.h / 2;
      if (mode === "inner") {
        value = Math.max(0, raw - correction);
        inferred = true;
      } else if (mode === "outer") {
        value = raw + correction;
        inferred = true;
      }
    }
  }

  const label =
    mode === "inner"
      ? inferred
        ? "INNER / CLEAR"
        : "INNER"
      : mode === "outer"
        ? inferred
          ? "OUTER / OVERALL"
          : "OUTER"
        : "CENTERLINE";

  return { value, label, mode, inferred, raw };
}

function dimensionModeLabel(mode) {
  return mode === "inner"
    ? "INNER / CLEAR"
    : mode === "outer"
      ? "OUTER / OVERALL"
      : "CENTERLINE";
}

function ensureRoomWalls(o) {
  const t = 3 / 12;

  if (!Number.isFinite(Number(o.topWall))) o.topWall = t;
  if (!Number.isFinite(Number(o.rightWall))) o.rightWall = t;
  if (!Number.isFinite(Number(o.bottomWall))) o.bottomWall = t;
  if (!Number.isFinite(Number(o.leftWall))) o.leftWall = t;

  o.topWall = Math.max(0, Number(o.topWall));
  o.rightWall = Math.max(0, Number(o.rightWall));
  o.bottomWall = Math.max(0, Number(o.bottomWall));
  o.leftWall = Math.max(0, Number(o.leftWall));
}

function roomDimensionInfo(o) {
  ensureRoomWalls(o);
  return {
    w: Math.max(0, o.w - o.leftWall - o.rightWall),
    h: Math.max(0, o.h - o.topWall - o.bottomWall),
    mode: "inner",
    label: "INNER / CLEAR",
  };
}

function drawObject(o) {
  const g = el("g", {
    class: "plan-object",
    "data-id": o.id,
    cursor: "move",
  });

  const { b, shapes } = buildGeometry(o);
  g.setAttribute(
    "transform",
    `translate(${b.x} ${b.y}) rotate(${o.rotation || 0} ${b.w / 2} ${b.h / 2})`,
  );

  // Full bounding-box hit target. The visual geometry can be sparse
  // (doors/stairs especially), but dragging should always work from anywhere
  // inside the asset's footprint.
  const hitTarget = el("rect", {
    x: 0,
    y: 0,
    width: b.w,
    height: b.h,
    fill: "#fff",
    "fill-opacity": "0",
    stroke: "none",
    "pointer-events": "all",
  });
  g.appendChild(hitTarget);

  for (const shape of shapes) g.appendChild(shape);

  if (o.label || o.type === "room") {
    const label = el("text", {
      x: b.w / 2 + (Number(o.labelOffsetX) || 0) * canvas.scale,
      y: b.h * 0.42 + (Number(o.labelOffsetY) || 0) * canvas.scale,
      "text-anchor": "middle",
      "dominant-baseline": "middle",
      fill: "#34404a",
      "font-size": Math.max(10, Math.min(16, b.w * 0.05)),
      "font-family": "Arial, sans-serif",
      "font-weight": "700",
      "pointer-events": "all",
      class: "room-label",
    });
    label.textContent = o.label || objectName(o);

    if (o.type === "room") {
      label.style.cursor = "move";
      label.addEventListener("pointerdown", (e) => {
        beginRoomTextDrag(e, o.id, "label");
      });
    }

    g.appendChild(label);

    if (o.type === "room") {
      const d = roomDimensionInfo(o);
      const dim = el("text", {
        x: b.w / 2 + (Number(o.dimensionOffsetX) || 0) * canvas.scale,
        y: b.h * 0.57 + (Number(o.dimensionOffsetY) || 0) * canvas.scale,
        "text-anchor": "middle",
        "dominant-baseline": "middle",
        fill: "#46525d",
        "font-size": 16,
        "font-family": "Arial, sans-serif",
        "font-weight": "600",
        "pointer-events": "all",
        class: "room-dimension",
      });
      dim.textContent = `${ftIn(d.w)} × ${ftIn(d.h)}`;
      dim.style.cursor = "move";
      dim.addEventListener("pointerdown", (e) => {
        beginRoomTextDrag(e, o.id, "dimension");
      });
      g.appendChild(dim);
    }
  }

  const showDefaultDimension =
    state.showMeasurements &&
    (state.selectedId === o.id ||
      o.type === "room" ||
      o.type === "rect" ||
      o.type === "measurement");

  if (showDefaultDimension) {
    const label = el("text", {
      x: b.w / 2,
      y: b.h + 20,
      "text-anchor": "middle",
      fill: "#33414d",
      "font-size": 16,
      "font-family": "Arial, sans-serif",
      "font-weight": "600",
      "pointer-events": "none",
    });

    if (o.type === "measurement") {
      const m = measurementInfo(o);
      label.textContent = ftIn(m.value);
    } else if (o.type === "wall") {
      label.textContent = `${ftIn(o.w)} L × ${ftIn(o.h)} THK`;
    } else if (o.type === "room") {
      label.textContent = "";
    } else if (o.type === "circle") {
      label.textContent = `⌀ ${ftIn(o.w)}`;
    } else {
      label.textContent = `${ftIn(o.w)} × ${ftIn(o.h)}`;
    }

    g.appendChild(label);
  }

  g.addEventListener("pointerdown", (e) => beginDrag(e, o.id));
  return g;
}

function render() {
  canvasBg.setAttribute("fill", state.background);
  renderGrid();
  const renderOrder = (o) => {
    if (o.type === "wall" || o.type === "room") return 0;
    if (o.type === "stairs") return 1;
    if (o.type === "door") return 2;
    return 3;
  };
  const ordered = [...state.objects].sort(
    (a, b) => renderOrder(a) - renderOrder(b),
  );
  objectsLayer.replaceChildren(...ordered.map(drawObject));
  drawSelection();
  updateProps();
  updateStatus();
  updateUndoRedo();
  updateCamera();
  scheduleAutosave();
}

function niceGridStep(zoom) {
  const targetPx = 22;
  const idealFeet = targetPx / (canvas.scale * zoom);
  const candidates = [
    0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000,
  ];
  return candidates.find((v) => v >= idealFeet) || 5000;
}

function renderGrid() {
  overlayGrid.replaceChildren();
  if (!state.showGrid) return;

  const rect = svgViewport.getBoundingClientRect();
  const zoom = rect.width / (camera.w * canvas.scale);
  const step = niceGridStep(zoom);

  const startX = Math.floor(camera.x / step) * step;
  const endX = camera.x + camera.w + step;
  const startY = Math.floor(camera.y / step) * step;
  const endY = camera.y + camera.h + step;

  let index = 0;
  for (let x = startX; x <= endX; x += step, index++) {
    const major = index % 5 === 0;
    overlayGrid.appendChild(
      el("line", {
        x1: x * canvas.scale,
        y1: camera.y * canvas.scale,
        x2: x * canvas.scale,
        y2: (camera.y + camera.h) * canvas.scale,
        class: major ? "grid-major-world" : "grid-minor-world",
      }),
    );
  }

  index = 0;
  for (let y = startY; y <= endY; y += step, index++) {
    const major = index % 5 === 0;
    overlayGrid.appendChild(
      el("line", {
        x1: camera.x * canvas.scale,
        y1: y * canvas.scale,
        x2: (camera.x + camera.w) * canvas.scale,
        y2: y * canvas.scale,
        class: major ? "grid-major-world" : "grid-minor-world",
      }),
    );
  }

  // Origin axes make it easy to understand where the plan is in the infinite space.
  if (camera.x <= 0 && camera.x + camera.w >= 0) {
    overlayGrid.appendChild(
      el("line", {
        x1: 0,
        y1: camera.y * canvas.scale,
        x2: 0,
        y2: (camera.y + camera.h) * canvas.scale,
        stroke: "#bcc5cc",
        "stroke-width": "1.4",
      }),
    );
  }
  if (camera.y <= 0 && camera.y + camera.h >= 0) {
    overlayGrid.appendChild(
      el("line", {
        x1: camera.x * canvas.scale,
        y1: 0,
        x2: (camera.x + camera.w) * canvas.scale,
        y2: 0,
        stroke: "#bcc5cc",
        "stroke-width": "1.4",
      }),
    );
  }
}

function axisAlignedObject(o) {
  return (
    Math.abs((o.rotation || 0) % 90) < 0.001 ||
    Math.abs(Math.abs((o.rotation || 0) % 90) - 90) < 0.001
  );
}

function objectBounds(o) {
  if (!axisAlignedObject(o)) {
    const pts = rotatedCorners(o);
    return {
      left: Math.min(...pts.map((p) => p.x)),
      right: Math.max(...pts.map((p) => p.x)),
      top: Math.min(...pts.map((p) => p.y)),
      bottom: Math.max(...pts.map((p) => p.y)),
    };
  }
  return { left: o.x, right: o.x + o.w, top: o.y, bottom: o.y + o.h };
}

function gapBetweenObjects(aObj, bObj) {
  const a = objectBounds(aObj);
  const b = objectBounds(bObj);

  // Positive separation on each axis. Zero means the projections overlap/touch.
  const dx = Math.max(a.left - b.right, b.left - a.right, 0);
  const dy = Math.max(a.top - b.bottom, b.top - a.bottom, 0);

  let horizontal = null;
  let vertical = null;

  if (dx > 0) {
    // Pick a useful y halfway through the overlapping or closest vertical span.
    const yTop = Math.max(a.top, b.top);
    const yBottom = Math.min(a.bottom, b.bottom);
    const y =
      yTop <= yBottom
        ? (yTop + yBottom) / 2
        : (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2;

    horizontal = {
      distance: dx,
      x1: a.right <= b.left ? a.right : b.right,
      x2: a.right <= b.left ? b.left : a.left,
      y,
    };
  }

  if (dy > 0) {
    const xLeft = Math.max(a.left, b.left);
    const xRight = Math.min(a.right, b.right);
    const x =
      xLeft <= xRight
        ? (xLeft + xRight) / 2
        : (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2;

    vertical = {
      distance: dy,
      y1: a.bottom <= b.top ? a.bottom : b.bottom,
      y2: a.bottom <= b.top ? b.top : a.top,
      x,
    };
  }

  return { horizontal, vertical, dx, dy };
}

function nearestGapsFor(o) {
  let bestH = null,
    bestV = null;

  for (const other of state.objects) {
    if (other.id === o.id || other.type === "measurement") continue;

    const gaps = gapBetweenObjects(o, other);

    if (
      gaps.horizontal &&
      gaps.horizontal.distance >= 0 &&
      (!bestH || gaps.horizontal.distance < bestH.distance)
    ) {
      bestH = { ...gaps.horizontal, other };
    }

    if (
      gaps.vertical &&
      gaps.vertical.distance >= 0 &&
      (!bestV || gaps.vertical.distance < bestV.distance)
    ) {
      bestV = { ...gaps.vertical, other };
    }
  }

  // Only show close, meaningful gaps. The limit is generous enough for
  // normal room/furniture spacing without covering an infinite canvas.
  if (bestH && bestH.distance > 10) bestH = null;
  if (bestV && bestV.distance > 10) bestV = null;

  return { horizontal: bestH, vertical: bestV };
}

function drawGapDimension(g, d, horizontal = true) {
  if (!d || d.distance < 0.01) return;

  const color = "#7c3aed";
  const offset = 0.65;

  if (horizontal) {
    const y = d.y;
    const x1 = d.x1,
      x2 = d.x2;
    g.appendChild(
      el("line", {
        x1: x1 * canvas.scale,
        y1: y * canvas.scale,
        x2: x2 * canvas.scale,
        y2: y * canvas.scale,
        stroke: color,
        "stroke-width": 1.25,
      }),
    );
    g.appendChild(
      el("line", {
        x1: x1 * canvas.scale,
        y1: (y - offset) * canvas.scale,
        x2: x1 * canvas.scale,
        y2: (y + offset) * canvas.scale,
        stroke: color,
        "stroke-width": 1.05,
      }),
    );
    g.appendChild(
      el("line", {
        x1: x2 * canvas.scale,
        y1: (y - offset) * canvas.scale,
        x2: x2 * canvas.scale,
        y2: (y + offset) * canvas.scale,
        stroke: color,
        "stroke-width": 1.05,
      }),
    );

    const t = el("text", {
      x: ((x1 + x2) / 2) * canvas.scale,
      y: (y - 0.18) * canvas.scale,
      "text-anchor": "middle",
      fill: color,
      "font-size": 15,
      "font-family": "Arial, sans-serif",
      "font-weight": "700",
      "paint-order": "stroke",
      stroke: "#fff",
      "stroke-width": 4,
      "stroke-linejoin": "round",
      "pointer-events": "none",
    });
    t.textContent = ftIn(d.distance);
    g.appendChild(t);
  } else {
    const x = d.x;
    const y1 = d.y1,
      y2 = d.y2;
    g.appendChild(
      el("line", {
        x1: x * canvas.scale,
        y1: y1 * canvas.scale,
        x2: x * canvas.scale,
        y2: y2 * canvas.scale,
        stroke: color,
        "stroke-width": 1.25,
      }),
    );
    g.appendChild(
      el("line", {
        x1: (x - offset) * canvas.scale,
        y1: y1 * canvas.scale,
        x2: (x + offset) * canvas.scale,
        y2: y1 * canvas.scale,
        stroke: color,
        "stroke-width": 1.05,
      }),
    );
    g.appendChild(
      el("line", {
        x1: (x - offset) * canvas.scale,
        y1: y2 * canvas.scale,
        x2: (x + offset) * canvas.scale,
        y2: y2 * canvas.scale,
        stroke: color,
        "stroke-width": 1.05,
      }),
    );

    const mid = (y1 + y2) / 2;
    const t = el("text", {
      x: (x + 0.18) * canvas.scale,
      y: mid * canvas.scale,
      "text-anchor": "start",
      "dominant-baseline": "middle",
      fill: color,
      "font-size": 15,
      "font-family": "Arial, sans-serif",
      "font-weight": "700",
      "paint-order": "stroke",
      stroke: "#fff",
      "stroke-width": 4,
      "stroke-linejoin": "round",
      "pointer-events": "none",
    });
    t.textContent = ftIn(d.distance);
    t.setAttribute(
      "transform",
      `rotate(-90 ${(x + 0.18) * canvas.scale} ${mid * canvas.scale})`,
    );
    g.appendChild(t);
  }
}

function drawAutomaticGaps(selectedObject) {
  const gaps = nearestGapsFor(selectedObject);
  if (!gaps.horizontal && !gaps.vertical) return;

  const g = el("g", { class: "automatic-dimensions", pointerEvents: "none" });
  drawGapDimension(g, gaps.horizontal, true);
  drawGapDimension(g, gaps.vertical, false);
  overlayLayer.appendChild(g);
}

function drawPairDimensions(first, second) {
  const g = el("g", { class: "pair-dimensions", pointerEvents: "none" });
  const gaps = gapBetweenObjects(first, second);

  if (!gaps.horizontal && !gaps.vertical) {
    // If the two objects touch/intersect, explicitly show 0 when their
    // projections overlap closely rather than silently doing nothing.
    const a = objectBounds(first),
      b = objectBounds(second);
    const xGap = Math.max(
      0,
      Math.max(a.left, b.left) - Math.min(a.right, b.right),
    );
    const yGap = Math.max(
      0,
      Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom),
    );
    if (xGap === 0 && yGap === 0) {
      const t = el("text", {
        x:
          ((Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2) *
          canvas.scale,
        y:
          ((Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2) *
          canvas.scale,
        "text-anchor": "middle",
        fill: "#7c3aed",
        "font-size": 16,
        "font-weight": "700",
        "paint-order": "stroke",
        stroke: "#fff",
        "stroke-width": 5,
      });
      t.textContent = "0'-0\"";
      g.appendChild(t);
    }
  }

  if (gaps.horizontal) drawGapDimension(g, gaps.horizontal, true);
  if (gaps.vertical) drawGapDimension(g, gaps.vertical, false);

  const a = objectBounds(first),
    b = objectBounds(second);
  const label = el("text", {
    x: Math.min(a.left, b.left) * canvas.scale,
    y: (Math.min(a.top, b.top) - 0.9) * canvas.scale,
    fill: "#7c3aed",
    "font-size": 12,
    "font-weight": "700",
    "paint-order": "stroke",
    stroke: "#fff",
    "stroke-width": 4,
  });
  label.textContent = `${objectName(first)} ↔ ${objectName(second)}`;
  g.appendChild(label);

  overlayLayer.appendChild(g);
}

function enterDistancePickMode() {
  const o = selected();
  if (!o) return;

  distancePickMode = true;
  flash("Now click the second object");
  render();
}

function drawSelection() {
  overlayLayer.replaceChildren();

  const o = selected();
  if (!o) return;
  if (o.type === "measurement") {
    const pts = rotatedCorners(o);
    const a = pts[0];
    const b = pts[1];
    const g = el("g", { pointerEvents: "none" });

    g.appendChild(
      el("line", {
        x1: a.x * canvas.scale,
        y1: a.y * canvas.scale,
        x2: b.x * canvas.scale,
        y2: b.y * canvas.scale,
        stroke: "#2563eb",
        "stroke-width": 1.5,
        "stroke-dasharray": "4 3",
      }),
    );

    for (const p of [a, b]) {
      const h = el("rect", {
        x: p.x * canvas.scale - 5,
        y: p.y * canvas.scale - 5,
        width: 10,
        height: 10,
        fill: "#fff",
        stroke: "#2563eb",
        "stroke-width": 1.5,
        "pointer-events": "all",
      });
      h.style.cursor = "crosshair";
      h.addEventListener("pointerdown", (e) => {
        beginMeasurementResize(e, o.id, p === a ? 0 : 1);
      });
      g.appendChild(h);
    }

    const mid = {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
    };
    const t = el("text", {
      x: mid.x * canvas.scale,
      y: mid.y * canvas.scale - 9,
      "text-anchor": "middle",
      fill: "#2563eb",
      "font-size": 15,
      "font-weight": "700",
      "paint-order": "stroke",
      stroke: "#fff",
      "stroke-width": 4,
      "pointer-events": "none",
    });
    t.textContent = ftIn(o.w);
    g.appendChild(t);

    overlayLayer.appendChild(g);
    return;
  }
  const pts = rotatedCorners(o);
  const g = el("g", { pointerEvents: "none" });

  // Rotated selection outline.
  g.appendChild(
    el("polygon", {
      points: pts
        .map((p) => `${p.x * canvas.scale},${p.y * canvas.scale}`)
        .join(" "),
      fill: "none",
      stroke: "#2563eb",
      "stroke-width": 1.5,
      "stroke-dasharray": "6 4",
    }),
  );

  const handles = [
    [pts[0], "nwse-resize", 0],
    [pts[1], "nesw-resize", 1],
    [pts[2], "nwse-resize", 2],
    [pts[3], "nesw-resize", 3],
  ];

  for (const [p, cursor, index] of handles) {
    const h = el("rect", {
      x: p.x * canvas.scale - 5,
      y: p.y * canvas.scale - 5,
      width: 10,
      height: 10,
      fill: "#fff",
      stroke: "#2563eb",
      "stroke-width": 1.5,
      "pointer-events": "all",
    });
    h.style.cursor = cursor;
    h.setAttribute(
      "transform",
      `rotate(${o.rotation || 0} ${p.x * canvas.scale} ${p.y * canvas.scale})`,
    );
    h.addEventListener("pointerdown", (e) => beginResize(e, o.id, index));
    g.appendChild(h);
  }

  const topMid = {
    x: (pts[0].x + pts[1].x) / 2,
    y: (pts[0].y + pts[1].y) / 2,
  };
  const sideMid = {
    x: (pts[0].x + pts[3].x) / 2,
    y: (pts[0].y + pts[3].y) / 2,
  };

  const top = el("text", {
    x: topMid.x * canvas.scale,
    y: topMid.y * canvas.scale - 8,
    "text-anchor": "middle",
    fill: "#2563eb",
    "font-size": 14,
    "font-weight": "700",
    "pointer-events": "none",
    transform: `rotate(${o.rotation || 0} ${topMid.x * canvas.scale} ${topMid.y * canvas.scale})`,
  });
  top.textContent = ftIn(o.w);

  const side = el("text", {
    x: sideMid.x * canvas.scale - 8,
    y: sideMid.y * canvas.scale,
    "text-anchor": "end",
    "dominant-baseline": "middle",
    fill: "#2563eb",
    "font-size": 14,
    "font-weight": "700",
    "pointer-events": "none",
    transform: `rotate(${o.rotation || 0} ${sideMid.x * canvas.scale} ${sideMid.y * canvas.scale})`,
  });
  side.textContent = ftIn(o.h);

  g.appendChild(top);
  g.appendChild(side);

  if (o.type === "door") {
    const tag = el("text", {
      x: topMid.x * canvas.scale,
      y: topMid.y * canvas.scale - 24,
      "text-anchor": "middle",
      fill: "#2563eb",
      "font-size": 11,
      "font-weight": "700",
      "pointer-events": "none",
    });
    tag.textContent = "DOOR";
    g.appendChild(tag);
  }

  if (o.type === "measurement") {
    const tag = el("text", {
      x: topMid.x * canvas.scale,
      y: topMid.y * canvas.scale - 18,
      "text-anchor": "middle",
      fill: "#2563eb",
      "font-size": 11,
      "font-weight": "700",
      "pointer-events": "none",
    });
    tag.textContent = "MEASUREMENT";
    g.appendChild(tag);
  }

  drawAutomaticGaps(o);

  if (state.distancePair) {
    const first = state.objects.find((x) => x.id === state.distancePair.aId);
    const second = state.objects.find((x) => x.id === state.distancePair.bId);
    if (first && second) drawPairDimensions(first, second);
  }

  overlayLayer.appendChild(g);
}

function beginRoomTextDrag(e, id, kind) {
  e.preventDefault();
  e.stopPropagation();

  const o = state.objects.find((x) => x.id === id);
  if (!o || o.type !== "room" || o.locked) return;

  const p = screenToWorld(e);

  const ox =
    kind === "label"
      ? Number(o.labelOffsetX) || 0
      : Number(o.dimensionOffsetX) || 0;
  const oy =
    kind === "label"
      ? Number(o.labelOffsetY) || 0
      : Number(o.dimensionOffsetY) || 0;

  roomTextDrag = {
    id,
    kind,
    startX: p.x,
    startY: p.y,
    origX: ox,
    origY: oy,
    historyPushed: false,
  };

  try {
    planSvg.setPointerCapture(e.pointerId);
  } catch {}
  window.addEventListener("pointermove", onRoomTextDrag);
  window.addEventListener("pointerup", endRoomTextDrag);
}

let roomTextDrag = null;

function onRoomTextDrag(e) {
  if (!roomTextDrag) return;
  const o = state.objects.find((x) => x.id === roomTextDrag.id);
  if (!o) return;

  const p = screenToWorld(e);
  if (!roomTextDrag.historyPushed) {
    pushHistory();
    roomTextDrag.historyPushed = true;
  }

  const nx = roomTextDrag.origX + (p.x - roomTextDrag.startX);
  const ny = roomTextDrag.origY + (p.y - roomTextDrag.startY);

  if (roomTextDrag.kind === "label") {
    o.labelOffsetX = nx;
    o.labelOffsetY = ny;
  } else {
    o.dimensionOffsetX = nx;
    o.dimensionOffsetY = ny;
  }
  render();
}

function endRoomTextDrag() {
  roomTextDrag = null;
  window.removeEventListener("pointermove", onRoomTextDrag);
  window.removeEventListener("pointerup", endRoomTextDrag);
}

function screenToWorld(e) {
  const pt = planSvg.createSVGPoint();
  pt.x = e.clientX;
  pt.y = e.clientY;
  const matrix = planSvg.getScreenCTM();
  if (!matrix) return { x: 0, y: 0 };
  const svgPoint = pt.matrixTransform(matrix.inverse());

  return {
    x: svgPoint.x / canvas.scale,
    y: svgPoint.y / canvas.scale,
  };
}

function beginMeasurement(e) {
  e.preventDefault();
  e.stopPropagation();

  state.selectedId = null;
  state.distancePair = null;
  distancePickMode = false;

  const p = screenToWorld(e);
  measureDraft = {
    startX: p.x,
    startY: p.y,
  };

  window.addEventListener("pointermove", onMeasurementMove);
  window.addEventListener("pointerup", endMeasurement);
}

function onMeasurementMove(e) {
  if (!measureDraft) return;
  renderMeasurementDraft(screenToWorld(e));
}

function renderMeasurementDraft(p) {
  const old = overlayLayer.querySelector(".measurement-draft");
  old?.remove();

  const g = el("g", { class: "measurement-draft", pointerEvents: "none" });
  const sx = measureDraft.startX * canvas.scale;
  const sy = measureDraft.startY * canvas.scale;
  const ex = p.x * canvas.scale;
  const ey = p.y * canvas.scale;
  const dx = ex - sx,
    dy = ey - sy;
  const len = Math.hypot(dx, dy);

  g.appendChild(
    el("line", {
      x1: sx,
      y1: sy,
      x2: ex,
      y2: ey,
      stroke: "#2563eb",
      "stroke-width": 1.5,
    }),
  );
  g.appendChild(
    el("line", {
      x1: sx - (dy / len) * 6,
      y1: sy + (dx / len) * 6,
      x2: sx + (dy / len) * 6,
      y2: sy - (dx / len) * 6,
      stroke: "#2563eb",
      "stroke-width": 1.2,
    }),
  );
  g.appendChild(
    el("line", {
      x1: ex - (dy / len) * 6,
      y1: ey + (dx / len) * 6,
      x2: ex + (dy / len) * 6,
      y2: ey - (dx / len) * 6,
      stroke: "#2563eb",
      "stroke-width": 1.2,
    }),
  );

  const t = el("text", {
    x: (sx + ex) / 2,
    y: (sy + ey) / 2 - 8,
    "text-anchor": "middle",
    fill: "#2563eb",
    "font-size": 12,
    "font-weight": "700",
  });
  const draftObj = {
    x: measureDraft.startX,
    y: measureDraft.startY,
    w: Math.hypot(p.x - measureDraft.startX, p.y - measureDraft.startY),
    h: 0.15,
    rotation:
      (Math.atan2(p.y - measureDraft.startY, p.x - measureDraft.startX) * 180) /
      Math.PI,
    dimensionRef: state.dimensionRef || "inner",
    type: "measurement",
  };
  const dm = measurementInfo(draftObj);
  t.textContent = `${ftIn(dm.value)} • ${dm.label}`;
  g.appendChild(t);

  overlayLayer.appendChild(g);
}

function endMeasurement(e) {
  if (!measureDraft) return;

  const p = screenToWorld(e);
  const dx = p.x - measureDraft.startX;
  const dy = p.y - measureDraft.startY;
  const length = Math.hypot(dx, dy);

  window.removeEventListener("pointermove", onMeasurementMove);
  window.removeEventListener("pointerup", endMeasurement);

  const draft = measureDraft;
  measureDraft = null;

  if (length < 0.05) return;

  pushHistory();

  const startX = draft.startX;
  const endX = p.x;
  const lineX = Math.min(startX, endX);
  const lineW = Math.max(0.05, Math.abs(endX - startX));
  const lineY = draft.startY;

  const o = {
    id: uid(),
    type: "measurement",
    x: lineX,
    y: lineY,
    w: lineW,
    h: 0.15,
    rotation: 0,
    label: "",
    fill: "none",
    stroke: "#3d6cdf",
    dimensionRef: "inner",
  };

  state.objects.push(o);
  state.selectedId = o.id;
  measureMode = false;
  measureToolBtn.classList.remove("active");
  render();
}

function beginDrag(e, id) {
  e.preventDefault();
  e.stopPropagation();

  const o = state.objects.find((x) => x.id === id);
  if (!o) return;

  if (distancePickMode && state.selectedId && state.selectedId !== id) {
    const first = state.objects.find((x) => x.id === state.selectedId);
    distancePickMode = false;
    state.distancePair = { aId: first.id, bId: o.id };
    render();
    return;
  }

  state.selectedId = id;
  state.distancePair = null;
  distancePickMode = false;
  roomTextDrag = null;
  measureSecondHint.classList.add("hidden");
  render();

  // A locked object can still be selected, copied, or unlocked, but cannot move.
  if (o.locked) return;
  if (spaceDown || e.button === 1) return;

  const p = screenToWorld(e);
  drag = {
    kind: "move",
    id,
    startX: p.x,
    startY: p.y,
    origX: o.x,
    origY: o.y,
    historyPushed: false,
  };

  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch {}
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", endPointer);
}

function beginResize(e, id, handleIndex) {
  e.preventDefault();
  e.stopPropagation();

  const o = state.objects.find((x) => x.id === id);
  if (!o || o.locked) return;

  const p = screenToWorld(e);
  const corners = [
    { x: o.x, y: o.y },
    { x: o.x + o.w, y: o.y },
    { x: o.x + o.w, y: o.y + o.h },
    { x: o.x, y: o.y + o.h },
  ];

  const opposite = (handleIndex + 2) % 4;

  const center = { x: o.x + o.w / 2, y: o.y + o.h / 2 };

  drag = {
    kind: "resize",
    id,
    startX: p.x,
    startY: p.y,
    origX: o.x,
    origY: o.y,
    origW: o.w,
    origH: o.h,
    origRotation: o.rotation || 0,
    handleIndex,
    oppositeLocal: {
      x: corners[opposite].x - center.x,
      y: corners[opposite].y - center.y,
    },
    historyPushed: false,
  };

  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch {}
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", endPointer);
}

function axisAnchors(o, x, y) {
  return {
    x: [x, x + o.w / 2, x + o.w],
    y: [y, y + o.h / 2, y + o.h],
  };
}

function findSmartSnap(o, nx, ny) {
  if (!state.smartAlign || o.rotation) return { x: nx, y: ny, guides: [] };

  const tolerance = 0.35; // 4.2 inches: enough to catch a wall/room while dragging.
  const self = axisAnchors(o, nx, ny);
  let bestX = null,
    bestY = null;
  const guides = [];

  for (const other of state.objects) {
    if (other.id === o.id || other.rotation) continue;

    const target = axisAnchors(other, other.x, other.y);

    for (const a of self.x) {
      for (const b of target.x) {
        const delta = b - a;
        const ad = Math.abs(delta);
        if (ad <= tolerance && (!bestX || ad < bestX.abs)) {
          bestX = { delta, abs: ad, value: b };
        }
      }
    }

    for (const a of self.y) {
      for (const b of target.y) {
        const delta = b - a;
        const ad = Math.abs(delta);
        if (ad <= tolerance && (!bestY || ad < bestY.abs)) {
          bestY = { delta, abs: ad, value: b };
        }
      }
    }
  }

  if (bestX) {
    nx += bestX.delta;
    guides.push({ axis: "x", value: bestX.value });
  }
  if (bestY) {
    ny += bestY.delta;
    guides.push({ axis: "y", value: bestY.value });
  }

  return { x: nx, y: ny, guides };
}

function renderSnapGuides(guides) {
  const existing = overlayLayer.querySelector(".snap-guides");
  existing?.remove();
  if (!guides?.length) return;

  const g = el("g", { class: "snap-guides", pointerEvents: "none" });

  for (const guide of guides) {
    if (guide.axis === "x") {
      g.appendChild(
        el("line", {
          x1: guide.value * canvas.scale,
          y1: camera.y * canvas.scale,
          x2: guide.value * canvas.scale,
          y2: (camera.y + camera.h) * canvas.scale,
          stroke: "#2563eb",
          "stroke-width": "1",
          "stroke-dasharray": "4 4",
          opacity: ".55",
        }),
      );
    } else {
      g.appendChild(
        el("line", {
          x1: camera.x * canvas.scale,
          y1: guide.value * canvas.scale,
          x2: (camera.x + camera.w) * canvas.scale,
          y2: guide.value * canvas.scale,
          stroke: "#2563eb",
          "stroke-width": "1",
          "stroke-dasharray": "4 4",
          opacity: ".55",
        }),
      );
    }
  }

  overlayLayer.appendChild(g);
}

function beginMeasurementResize(e, id, endpointIndex) {
  e.preventDefault();
  e.stopPropagation();

  const o = state.objects.find((x) => x.id === id);
  if (!o || o.locked) return;

  const p = screenToWorld(e);

  measurementResize = {
    id,
    endpointIndex,
    startX: p.x,
    startY: p.y,
    origX: o.x,
    origY: o.y,
    origW: o.w,
    historyPushed: false,
  };

  try {
    planSvg.setPointerCapture(e.pointerId);
  } catch {}
  window.addEventListener("pointermove", onMeasurementResizeMove);
  window.addEventListener("pointerup", endMeasurementResize);
}

let measurementResize = null;

function onMeasurementResizeMove(e) {
  if (!measurementResize) return;

  const o = state.objects.find((x) => x.id === measurementResize.id);
  if (!o) return;

  const p = screenToWorld(e);

  if (!measurementResize.historyPushed) {
    pushHistory();
    measurementResize.historyPushed = true;
  }

  const fixedX =
    measurementResize.endpointIndex === 1
      ? measurementResize.origX
      : measurementResize.origX + measurementResize.origW;

  const nextX = measurementResize.endpointIndex === 1 ? p.x : p.x;

  if (measurementResize.endpointIndex === 1) {
    o.x = Math.min(fixedX, nextX);
    o.w = Math.max(0.05, Math.abs(nextX - fixedX));
  } else {
    o.x = Math.min(nextX, fixedX);
    o.w = Math.max(0.05, Math.abs(fixedX - nextX));
  }

  o.y = measurementResize.origY;
  o.rotation = 0;
  normalizeObject(o);
  render();
}

function endMeasurementResize() {
  measurementResize = null;
  window.removeEventListener("pointermove", onMeasurementResizeMove);
  window.removeEventListener("pointerup", endMeasurementResize);
}

function onPointerMove(e) {
  if (drag) {
    const o = state.objects.find((x) => x.id === drag.id);
    if (!o) return;

    const p = screenToWorld(e);

    if (!drag.historyPushed) {
      pushHistory();
      drag.historyPushed = true;
    }

    if (drag.kind === "move") {
      let nx = drag.origX + (p.x - drag.startX);
      let ny = drag.origY + (p.y - drag.startY);

      const aligned = findSmartSnap(o, nx, ny);
      nx = aligned.x;
      ny = aligned.y;

      o.x = nx;
      o.y = ny;
      normalizeObject(o);

      renderSnapGuides(aligned.guides);
    } else {
      const pWorld = screenToWorld(e);
      const center0 = {
        x: drag.origX + drag.origW / 2,
        y: drag.origY + drag.origH / 2,
      };

      // Convert pointer into the unrotated object-local coordinate space.
      const pLocal = rotatePoint(
        pWorld,
        center0.x,
        center0.y,
        -(drag.origRotation || 0),
      );

      let fixed = {
        x: center0.x + drag.oppositeLocal.x,
        y: center0.y + drag.oppositeLocal.y,
      };

      // Work in local coordinates relative to the original center.
      let newCorner = { x: pLocal.x, y: pLocal.y };
      let w = Math.abs(newCorner.x - fixed.x);
      let h = Math.abs(newCorner.y - fixed.y);

      const min = 0.25;
      w = Math.max(min, w);
      h = Math.max(min, h);

      if (lockAspect.checked) {
        const ratio = drag.origW / drag.origH;
        if (Math.abs(pLocal.x - fixed.x) >= Math.abs(pLocal.y - fixed.y)) {
          h = w / ratio;
        } else {
          w = h * ratio;
        }
      }

      // Determine the sign from the dragged corner.
      const sx = drag.handleIndex === 0 || drag.handleIndex === 3 ? -1 : 1;
      const sy = drag.handleIndex === 0 || drag.handleIndex === 1 ? -1 : 1;

      const actualCorner = {
        x: fixed.x + sx * w,
        y: fixed.y + sy * h,
      };

      // Grid snapping is intentionally off. Dimensions resize continuously.

      const localCenter = {
        x: (fixed.x + actualCorner.x) / 2,
        y: (fixed.y + actualCorner.y) / 2,
      };

      const worldCenter = worldPointFromLocal(
        localCenter,
        center0.x,
        center0.y,
        drag.origRotation,
      );

      o.w = w;
      o.h = h;
      o.rotation = drag.origRotation;

      const rotatedHalf = worldPointFromLocal(
        { x: localCenter.x - w / 2, y: localCenter.y - h / 2 },
        center0.x,
        center0.y,
        drag.origRotation,
      );

      o.x =
        worldCenter.x -
        (o.w / 2) * Math.cos(((o.rotation || 0) * Math.PI) / 180) +
        (o.h / 2) * Math.sin(((o.rotation || 0) * Math.PI) / 180);
      o.y =
        worldCenter.y -
        (o.w / 2) * Math.sin(((o.rotation || 0) * Math.PI) / 180) -
        (o.h / 2) * Math.cos(((o.rotation || 0) * Math.PI) / 180);

      // The above center equation is more stable if explicitly derived from
      // the rotated top-left local corner.
      const tlLocal = {
        x: localCenter.x - w / 2,
        y: localCenter.y - h / 2,
      };
      const tlWorld = worldPointFromLocal(
        tlLocal,
        center0.x,
        center0.y,
        drag.origRotation,
      );
      o.x = tlWorld.x;
      o.y = tlWorld.y;

      normalizeObject(o);
    }
    render();
    return;
  }

  if (pan) {
    const rect = svgViewport.getBoundingClientRect();

    const dxPx = e.clientX - pan.clientX;
    const dyPx = e.clientY - pan.clientY;

    // Convert screen motion to current world/viewBox units.
    const worldPerPxX = camera.w / rect.width;
    const worldPerPxY = camera.h / rect.height;

    camera.x -= dxPx * worldPerPxX;
    camera.y -= dyPx * worldPerPxY;

    clampCamera();
    updateCamera();
    pan.clientX = e.clientX;
    pan.clientY = e.clientY;
  }
}

function endPointer() {
  drag = null;
  pan = null;
  renderSnapGuides([]);
  render();
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", endPointer);
}

function clampCamera() {
  // Infinite canvas: camera can travel anywhere. Only enforce a sensible
  // minimum viewport size so zoom never reaches an unusable numerical range.
  camera.w = Math.max(0.4, Number(camera.w) || 40);
  camera.h = Math.max(0.4, Number(camera.h) || 30);

  const viewport = svgViewport.getBoundingClientRect();
  if (viewport.width && viewport.height) {
    const aspect = viewport.width / viewport.height;
    camera.h = camera.w / aspect;
  }
}

function updateCamera() {
  clampCamera();

  planSvg.setAttribute(
    "viewBox",
    `${camera.x * canvas.scale} ${camera.y * canvas.scale} ${camera.w * canvas.scale} ${camera.h * canvas.scale}`,
  );

  zoomText.textContent = `${Math.round((cameraBaseWidth / camera.w) * 100)}%`;
  renderGrid();
}

function fitView() {
  camera = { x: -2, y: -2, w: 28, h: 22 };
  updateCamera();
}

function zoomAt(clientX, clientY, factor) {
  const rect = svgViewport.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const point = screenToWorld({ clientX, clientY });
  const oldW = camera.w;
  const oldH = camera.h;

  const newW = Math.max(0.4, oldW * factor);
  const viewportAspect = rect.width / rect.height;
  const newH = newW / viewportAspect;

  const rx = (point.x - camera.x) / oldW;
  const ry = (point.y - camera.y) / oldH;

  camera.w = newW;
  camera.h = newH;
  camera.x = point.x - rx * newW;
  camera.y = point.y - ry * newH;

  updateCamera();
}

function zoomIn() {
  zoomAt(
    svgViewport.getBoundingClientRect().left + svgViewport.clientWidth / 2,
    svgViewport.getBoundingClientRect().top + svgViewport.clientHeight / 2,
    0.82,
  );
}

function zoomOut() {
  zoomAt(
    svgViewport.getBoundingClientRect().left + svgViewport.clientWidth / 2,
    svgViewport.getBoundingClientRect().top + svgViewport.clientHeight / 2,
    1.22,
  );
}

function beginPan(e) {
  const allow = e.button === 1 || spaceDown || e.button === 2;
  if (!allow) return;

  e.preventDefault();

  pan = {
    clientX: e.clientX,
    clientY: e.clientY,
  };

  svgViewport.setPointerCapture?.(e.pointerId);
}

function normalizeRotation(angle) {
  let a = Number(angle) || 0;
  a = ((a % 360) + 360) % 360;
  return a;
}

function rotateSelected(delta) {
  const o = selected();
  if (!o) return;
  pushHistory();
  o.rotation = normalizeRotation((o.rotation || 0) + delta);
  render();
}

function buildPreview(type) {
  const svg = el("svg", { viewBox: "0 0 100 70", xmlns: NS });
  const d = defaults[type];

  const o = {
    type,
    x: 0,
    y: 0,
    w: d.w,
    h: d.h,
    rotation: 0,
    fill: d.fill,
    stroke: d.stroke,
    label: type === "room" ? "ROOM" : "",
  };

  const built = buildPreviewGeometry(o);
  for (const child of built) svg.appendChild(child);

  svg.setAttribute("aria-hidden", "true");
  return svg.outerHTML;
}

function buildPreviewGeometry(o) {
  const w = 100,
    h = 62;
  const stroke = o.stroke,
    fill = o.fill;
  const shapes = [];
  const line = (x1, y1, x2, y2, sw = 1) =>
    shapes.push(el("line", { x1, y1, x2, y2, stroke, "stroke-width": sw }));
  const rect = (x, y, ww, hh, fill2 = fill, rx = 1, sw = 1) =>
    shapes.push(
      el("rect", {
        x,
        y,
        width: ww,
        height: hh,
        fill: fill2,
        stroke,
        "stroke-width": sw,
        rx,
      }),
    );
  const circle = (cx, cy, r, fill2 = "none", sw = 1) =>
    shapes.push(
      el("circle", { cx, cy, r, fill: fill2, stroke, "stroke-width": sw }),
    );

  if (o.type === "wall") {
    rect(4, 28, 92, 10, fill, 1, 2);
    line(4, 33, 96, 33, 0.7);
  } else if (o.type === "door") {
    rect(12, 12, 76, 40, "#fff", 0, 1, {
      stroke: "#8f979e",
      "stroke-dasharray": "4 3",
    });
    line(12, 12, 12, 20, 1);
    line(88, 12, 88, 20, 1);
  } else if (o.type === "bike") {
    circle(25, 42, 10, "none", 2);
    circle(75, 42, 10, "none", 2);
    line(25, 42, 42, 25, 2);
    line(42, 25, 63, 42, 2);
    line(63, 42, 25, 42, 2);
    line(42, 25, 55, 19, 2);
    line(55, 19, 69, 17, 1.3);
    line(40, 18, 54, 18, 1.4);
  } else if (o.type === "car") {
    rect(22, 7, 56, 54, "#dce3e8", 8, 2);
    rect(29, 16, 42, 15, "#b9c9d5", 3, 1);
    rect(29, 38, 42, 11, "#d7dfe5", 2, 1);
    circle(29, 49, 5, "#252b31", 0.8);
    circle(71, 49, 5, "#252b31", 0.8);
  } else if (o.type === "stairs") {
    for (let i = 1; i < 8; i++)
      line(4, 4 + (i * 54) / 8, 96, 4 + (i * 54) / 8, 0.8);
    line(28, 53, 28, 32, 2);
    line(28, 32, 62, 32, 2);
    line(62, 32, 62, 14, 2);
    shapes.push(
      el("path", {
        d: "M62 14 l-7 8 M62 14 l7 8",
        fill: "none",
        stroke,
        "stroke-width": 1.7,
      }),
    );
  } else if (o.type === "room") {
    rect(4, 4, 92, 54, "#f7fafb", 0, 2);
    rect(8, 8, 84, 46, "none", 0, 0.8);
    const t = el("text", {
      x: 50,
      y: 35,
      "text-anchor": "middle",
      fill: "#35414a",
      "font-size": 10,
      "font-weight": "700",
    });
    t.textContent = "ROOM";
    shapes.push(t);
  } else if (o.type === "dining") {
    rect(28, 17, 44, 36, "#d8c4a7", 4, 2);
    for (const [x, y] of [
      [16, 22],
      [16, 35],
      [16, 48],
      [84, 22],
      [84, 35],
      [84, 48],
    ])
      circle(x, y, 5, "#eef1f2", 1);
  } else if (o.type === "sofa") {
    rect(8, 20, 84, 31, "#c7d1d8", 5, 2);
    rect(14, 10, 72, 15, "#d9e1e6", 4, 2);
    line(36, 23, 36, 46, 0.8);
    line(64, 23, 64, 46, 0.8);
  } else if (o.type === "table") {
    rect(17, 14, 66, 36, "#d8c09e", 4, 2);
    line(28, 49, 28, 62, 1.7);
    line(72, 49, 72, 62, 1.7);
  } else if (o.type === "tv") {
    rect(8, 10, 84, 35, "#333a41", 2, 2);
    rect(15, 17, 70, 21, "#14181c", 1, 0.8);
    line(43, 45, 43, 60, 1.5);
    line(57, 45, 57, 60, 1.5);
    line(38, 60, 62, 60, 1.5);
  } else if (o.type === "kitchen") {
    rect(5, 8, 90, 46, "#d8dde1", 2, 2);
    for (const x of [30, 52, 72]) line(x, 13, x, 49, 0.8);
    rect(69, 17, 20, 22, "#fff", 2, 0.8);
    circle(79, 28, 4.2, "none", 0.8);
    circle(21, 28, 3.5, "none", 0.8);
    circle(38, 28, 3.5, "none", 0.8);
  } else if (o.type === "rect") {
    rect(5, 6, 90, 50, fill, 0, 2);
  } else if (o.type === "circle") {
    shapes.push(
      el("ellipse", {
        cx: 50,
        cy: 31,
        rx: 45,
        ry: 24,
        fill,
        stroke,
        "stroke-width": 2,
      }),
    );
  } else if (o.type === "bed") {
    rect(9, 5, 82, 54, "#d4e3ec", 4, 2);
    rect(15, 8, 70, 13, "#f7f9fa", 2, 0.8);
    rect(19, 10, 24, 9, "#fff", 1, 0.7);
    rect(57, 10, 24, 9, "#fff", 1, 0.7);
    line(15, 24, 85, 24, 0.8);
    line(15, 44, 85, 44, 0.8);
  } else if (o.type === "basin") {
    shapes.push(
      el("ellipse", {
        cx: 50,
        cy: 36,
        rx: 35,
        ry: 18,
        fill: "#eef4f7",
        stroke,
        "stroke-width": 2,
      }),
    );
    shapes.push(
      el("path", {
        d: "M42 18 Q50 7 58 18",
        fill: "none",
        stroke,
        "stroke-width": 1.4,
      }),
    );
    circle(50, 36, 3.2, "#fff", 0.7);
  } else if (o.type === "toilet") {
    rect(30, 5, 40, 12, "#eef2f4", 2, 0.8);
    shapes.push(
      el("ellipse", {
        cx: 50,
        cy: 37,
        rx: 22,
        ry: 17,
        fill: "#f9fafb",
        stroke,
        "stroke-width": 2,
      }),
    );
  } else if (o.type === "washing") {
    rect(9, 5, 82, 54, "#e8ecef", 3, 2);
    rect(17, 10, 66, 8, "#f9fafb", 1, 0.8);
    circle(50, 36, 14, "#f8fafb", 2);
    circle(50, 36, 9, "#dbe5eb", 0.8);
  } else if (o.type === "plant") {
    rect(32, 39, 36, 17, "#c5ae97", 2, 0.8);
    for (const [x, y, rx, ry] of [
      [36, 29, 8, 12],
      [50, 18, 9, 14],
      [64, 29, 8, 12],
      [50, 31, 7, 10],
    ])
      shapes.push(
        el("ellipse", {
          cx: x,
          cy: y,
          rx,
          ry,
          fill: "#a9c8a6",
          stroke: "#57715a",
          "stroke-width": 0.7,
        }),
      );
  }

  const group = el("g", { transform: "scale(1 1)" });
  shapes.forEach((s) => group.appendChild(s));
  return [group];
}

function buildPalette() {
  assetPalette.innerHTML = "";

  for (const [type, name] of ASSETS) {
    const btn = document.createElement("button");
    btn.className = "asset-btn";
    btn.draggable = true;
    btn.dataset.type = type;

    btn.innerHTML = `
      <div class="asset-icon">${buildPreview(type)}</div>
      <div class="asset-name">${name}</div>
    `;

    btn.addEventListener("click", () => addObject(type, 8, 6));
    btn.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/floorplan-type", type);
    });

    assetPalette.appendChild(btn);
  }
}

function updateProps() {
  const o = selected();

  emptyProps.classList.toggle("hidden", !!o);
  propsPanel.classList.toggle("hidden", !o);

  if (!o) return;

  propType.textContent = objectName(o);
  propId.textContent = o.id;
  propX.value = ftIn(o.x);
  propY.value = ftIn(o.y);

  if (o.type === "room") {
    ensureRoomWalls(o);
    const rd = roomDimensionInfo(o);
    propW.value = ftIn(rd.w);
    propH.value = ftIn(rd.h);

    roomDimensionInputNote?.classList.remove("hidden");
    roomWallsPanel.classList.remove("hidden");
    roomTopWall.value = ftIn(o.topWall);
    roomRightWall.value = ftIn(o.rightWall);
    roomBottomWall.value = ftIn(o.bottomWall);
    roomLeftWall.value = ftIn(o.leftWall);
  } else {
    propW.value = ftIn(o.w);
    propH.value = ftIn(o.h);

    roomDimensionInputNote?.classList.add("hidden");
    roomWallsPanel.classList.add("hidden");
  }

  wallDimensionNote?.classList.toggle("hidden", o.type !== "wall");
  doorPlacementHint?.classList.toggle("hidden", o.type !== "door");
  widthLabel.textContent = o.type === "room" ? "Inner Width" : "Width";
  heightLabel.textContent = o.type === "room" ? "Inner Height" : "Height";
  propRotation.value = (o.rotation || 0) + "°";
  propLabel.value = o.label || "";
  propFill.value = o.fill || "#ffffff";
  propStroke.value = o.stroke || "#000000";
  lockToggleBtn.textContent = o.locked ? "Unlock selected" : "Lock selected";
}

function setPropNum(id, key) {
  const o = selected();
  if (!o) return;

  const value = parseFtIn(document.getElementById(id).value);
  if (!Number.isFinite(value)) return;

  pushHistory();

  if (o.type === "room" && (key === "w" || key === "h")) {
    ensureRoomWalls(o);
    if (key === "w") {
      o.w = Math.max(0.25, value + o.leftWall + o.rightWall);
    } else {
      o.h = Math.max(0.25, value + o.topWall + o.bottomWall);
    }
  } else {
    o[key] = Math.max(0.25, value);
  }

  normalizeObject(o);
  render();
}

function buildPlanPayload() {
  return {
    version: 4,
    canvas: { units: "feet", infinite: true, scale: canvas.scale },
    state: JSON.parse(JSON.stringify(state)),
    camera: { ...camera },
  };
}

function saveFile() {
  const payload = buildPlanPayload();

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "floorplan.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
  flash("Floor plan saved");
}

function saveAutoState() {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(buildPlanPayload()));
  } catch (err) {
    console.warn("Unable to save autosave state:", err);
  }
}

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    saveAutoState();
  }, 300);
}

function restoreAutoState() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return false;

    const payload = JSON.parse(raw);
    if (!payload || !payload.state || !Array.isArray(payload.state.objects)) {
      return false;
    }

    const incomingState = payload.state;
    state = {
      ...state,
      ...incomingState,
      selectedId: null,
      snap: 0,
    };

    state.objects = (state.objects || []).map((o) => {
      const base = defaults[o.type] || defaults.rect;
      const obj = { ...base, ...o };
      if (obj.type === "room") ensureRoomWalls(obj);
      normalizeObject(obj);
      return obj;
    });

    if (payload.camera) {
      camera = {
        x: Number(payload.camera.x),
        y: Number(payload.camera.y),
        w: Number(payload.camera.w),
        h: Number(payload.camera.h),
      };
    }

    undoStack = [];
    redoStack = [];
    clipboardObject = null;
    distancePickMode = false;
    state.distancePair = null;
    syncControls();
    render();
    return true;
  } catch (err) {
    console.warn("Unable to restore autosave state:", err);
    return false;
  }
}

function migrateImportedState(raw) {
  // Accept:
  // 1) our current payload: {version, canvas, state, camera}
  // 2) older payloads with state only
  // 3) plain {objects:[...], ...}
  const incoming =
    raw && raw.state && typeof raw.state === "object" ? raw.state : raw;

  if (!incoming || !Array.isArray(incoming.objects)) {
    throw new Error("The selected file is not a FloorPlan Canvas design.");
  }

  const migrated = {
    objects: [],
    selectedId: null,
    showGrid: incoming.showGrid !== false,
    showMeasurements: incoming.showMeasurements !== false,
    snap: 0,
    background:
      typeof incoming.background === "string" ? incoming.background : "#ffffff",
    dimensionRef: ["inner", "outer", "center"].includes(incoming.dimensionRef)
      ? incoming.dimensionRef
      : "inner",
    wallThickness: Number(incoming.wallThickness) || 3 / 12,
    smartAlign: incoming.smartAlign !== false,
    distancePair: null,
  };

  for (const source of incoming.objects) {
    if (!source || !source.type) continue;

    const base = defaults[source.type] || defaults.rect;
    const o = { ...base, ...source };

    // Older versions sometimes had string coordinates/dimensions.
    o.x = Number(o.x);
    o.y = Number(o.y);
    o.w = Number(o.w);
    o.h = Number(o.h);
    o.rotation = Number(o.rotation) || 0;

    if (!Number.isFinite(o.x)) o.x = 0;
    if (!Number.isFinite(o.y)) o.y = 0;
    if (!Number.isFinite(o.w) || o.w <= 0) o.w = Number(base.w) || 1;
    if (!Number.isFinite(o.h) || o.h <= 0) o.h = Number(base.h) || 1;

    o.id = o.id || uid();

    if (o.type === "measurement") {
      o.dimensionRef = o.dimensionRef || migrated.dimensionRef;
      o.stroke = o.stroke || "#3d6cdf";
      o.fill = "none";
    }

    migrated.objects.push(o);
  }

  return migrated;
}

function validImportedCamera(c) {
  return (
    c &&
    Number.isFinite(Number(c.x)) &&
    Number.isFinite(Number(c.y)) &&
    Number.isFinite(Number(c.w)) &&
    Number.isFinite(Number(c.h)) &&
    Number(c.w) > 0.4 &&
    Number(c.h) > 0.4 &&
    Number(c.w) < 100000 &&
    Number(c.h) < 100000
  );
}

function cameraForImportedContent() {
  if (!state.objects.length) return { x: -20, y: -12, w: 40, h: 30 };

  const bounds = getContentBounds();
  const pad = Math.max(2, Math.max(bounds.w, bounds.h) * 0.15);
  return {
    x: bounds.x - pad,
    y: bounds.y - pad,
    w: Math.max(20, bounds.w + pad * 2),
    h: Math.max(15, bounds.h + pad * 2),
  };
}

function extractFloorPlanPayload(text) {
  // Handle UTF-8 BOM and the occasional double-encoded JSON file.
  let value = String(text || "")
    .replace(/^\uFEFF/, "")
    .trim();
  if (!value) throw new Error("Empty design file");

  let parsed = JSON.parse(value);

  if (typeof parsed === "string") {
    parsed = JSON.parse(parsed.replace(/^\uFEFF/, "").trim());
  }

  // Current format: { version, canvas, state, camera }
  if (parsed && parsed.state && Array.isArray(parsed.state.objects)) {
    return {
      state: parsed.state,
      camera: parsed.camera,
    };
  }

  // Plain state format: { objects, ... }
  if (parsed && Array.isArray(parsed.objects)) {
    return {
      state: parsed,
      camera: parsed.camera,
    };
  }

  // A few older exports wrapped the state one level deeper.
  if (parsed && parsed.data && Array.isArray(parsed.data.objects)) {
    return {
      state: parsed.data,
      camera: parsed.data.camera || parsed.camera,
    };
  }

  throw new Error("No objects array found");
}

function loadFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();

  reader.onload = () => {
    try {
      const payload = JSON.parse(reader.result);

      // This is intentionally the same format v15 used:
      // { version, canvas, state, camera }
      // Also accept a plain state object for convenience.
      const incomingState = payload && payload.state ? payload.state : payload;

      if (!incomingState || !Array.isArray(incomingState.objects)) {
        throw new Error("No objects array found");
      }

      const importedState = {
        ...incomingState,
        snap: 0,
        smartAlign: incomingState.smartAlign !== false,
        dimensionRef: ["inner", "outer", "center"].includes(
          incomingState.dimensionRef,
        )
          ? incomingState.dimensionRef
          : "inner",
        distancePair: null,
        selectedId: null,
      };

      importedState.objects = importedState.objects
        .map((source) => {
          if (!source || !source.type) return null;

          const base = defaults[source.type] || defaults.rect;
          const copy = { ...base, ...source };

          copy.x = Number(copy.x);
          copy.y = Number(copy.y);
          copy.w = Number(copy.w);
          copy.h = Number(copy.h);
          copy.rotation = Number(copy.rotation) || 0;
          copy.id = copy.id || uid();

          if (!Number.isFinite(copy.x)) copy.x = 0;
          if (!Number.isFinite(copy.y)) copy.y = 0;
          if (!Number.isFinite(copy.w) || copy.w <= 0)
            copy.w = Number(base.w) || 1;
          if (!Number.isFinite(copy.h) || copy.h <= 0)
            copy.h = Number(base.h) || 1;

          if (copy.type === "measurement") {
            copy.dimensionRef = copy.dimensionRef || importedState.dimensionRef;
            copy.fill = "none";
            copy.stroke = copy.stroke || "#3d6cdf";
          }

          if (copy.type === "room") ensureRoomWalls(copy);
          normalizeObject(copy);
          return copy;
        })
        .filter(Boolean);

      // Commit only after the complete file has parsed successfully.
      state = importedState;

      // v15 saved a camera object. Restore it exactly when present;
      // otherwise use the normal working view.
      if (
        payload &&
        payload.camera &&
        Number.isFinite(Number(payload.camera.x)) &&
        Number.isFinite(Number(payload.camera.y)) &&
        Number.isFinite(Number(payload.camera.w)) &&
        Number.isFinite(Number(payload.camera.h))
      ) {
        camera = {
          x: Number(payload.camera.x),
          y: Number(payload.camera.y),
          w: Number(payload.camera.w),
          h: Number(payload.camera.h),
        };
      } else {
        camera = { x: -20, y: -12, w: 40, h: 30 };
      }

      undoStack = [];
      redoStack = [];
      clipboardObject = null;
      drag = null;
      pan = null;
      measureDraft = null;
      measurementResize = null;
      measureMode = false;
      distancePickMode = false;

      syncControls();
      render();
      flash(`Imported ${state.objects.length} objects`);
    } catch (err) {
      console.error("FloorPlan import error:", err);
      alert(
        "Could not import this design. " +
          "The file format is invalid or not a FloorPlan Canvas JSON file.",
      );
    } finally {
      e.target.value = "";
    }
  };

  reader.onerror = () => {
    alert("Could not read the design file.");
    e.target.value = "";
  };

  reader.readAsText(file);
}

function getContentBounds() {
  if (!state.objects.length) {
    return { x: -20, y: -12, w: 40, h: 30 };
  }

  const pad = 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const o of state.objects) {
    const pts = rotatedCorners(o);

    for (const p of pts) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }

  return {
    x: minX - pad,
    y: minY - pad,
    w: Math.max(1, maxX - minX + pad * 2),
    h: Math.max(1, maxY - minY + pad * 2),
  };
}

function exportSVG() {
  const clone = planSvg.cloneNode(true);
  const bounds = getContentBounds();
  clone.setAttribute(
    "viewBox",
    `${bounds.x * canvas.scale} ${bounds.y * canvas.scale} ${bounds.w * canvas.scale} ${bounds.h * canvas.scale}`,
  );
  clone.querySelector("#overlayLayer")?.remove();

  const xml = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([xml], { type: "image/svg+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "floorplan.svg";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
  flash("SVG exported");
}

function exportPNG() {
  const clone = planSvg.cloneNode(true);
  const bounds = getContentBounds();
  clone.setAttribute(
    "viewBox",
    `${bounds.x * canvas.scale} ${bounds.y * canvas.scale} ${bounds.w * canvas.scale} ${bounds.h * canvas.scale}`,
  );
  clone.querySelector("#overlayLayer")?.remove();

  const xml = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));
  const img = new Image();

  img.onload = () => {
    const c = document.createElement("canvas");
    const outW = Math.max(
      800,
      Math.min(4000, Math.round(bounds.w * canvas.scale)),
    );
    const outH = Math.max(
      600,
      Math.min(4000, Math.round(bounds.h * canvas.scale)),
    );
    c.width = outW;
    c.height = outH;

    const ctx = c.getContext("2d");
    ctx.fillStyle = state.background;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, outW, outH);

    URL.revokeObjectURL(url);

    c.toBlob((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "floorplan.png";
      a.click();
      flash("PNG exported");
    });
  };

  img.src = url;
}

function syncControls() {
  gridToggle.checked = state.showGrid;
  measureToggle.checked = state.showMeasurements;

  dimensionRefSelect.value = state.dimensionRef || "inner";
  smartAlignToggle.checked = state.smartAlign !== false;
  bgColor.value = state.background;
}

function addStarter() {
  // A simple, bounded demo that can be deleted with New.
  addObject("wall", 5, 4);
  addObject("wall", 5, 18);
  addObject("wall", 17, 4);
  addObject("room", 7, 7);

  const room = selected();
  if (room) room.label = "BED ROOM";

  addObject("bed", 8, 8);
  addObject("door", 12, 17.4);

  state.selectedId = null;
}

function flash(message) {
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 1500);
}

function updateStatus() {
  const o = selected();
  selectionText.textContent = o
    ? `${objectName(o)} • ${ftIn(o.w)} × ${ftIn(o.h)}${o.locked ? " • Locked" : ""}`
    : "Nothing selected";

  statusText.textContent = o ? "Editing" : "Ready";
}

planSvg.addEventListener(
  "pointerdown",
  (e) => {
    if (measureMode && e.button === 0) {
      beginMeasurement(e);
      e.stopImmediatePropagation();
    }
  },
  true,
);

planSvg.addEventListener("pointerdown", (e) => {
  if (e.button === 1 || e.button === 2 || spaceDown) {
    beginPan(e);
    return;
  }

  // Dragging the empty canvas pans it just like a normal 2D editor.
  if (
    e.button === 0 &&
    (e.target === planSvg ||
      e.target === canvasBg ||
      e.target === gridRect ||
      e.target === overlayGrid ||
      e.target === svgViewport)
  ) {
    state.selectedId = null;
    state.distancePair = null;
    distancePickMode = false;
    measureSecondHint.classList.add("hidden");
    render();
    pan = { clientX: e.clientX, clientY: e.clientY };
    try {
      planSvg.setPointerCapture(e.pointerId);
    } catch {}
    return;
  }
});

planSvg.addEventListener("contextmenu", (e) => e.preventDefault());

svgViewport.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();

    if (e.ctrlKey || e.metaKey || e.altKey) {
      // Fine-grained zoom.
      const factor = Math.exp(e.deltaY * 0.0018);
      zoomAt(e.clientX, e.clientY, clamp(factor, 0.95, 1.05));
      return;
    }

    const rect = svgViewport.getBoundingClientRect();
    const worldPerPixelX = camera.w / rect.width;
    const worldPerPixelY = camera.h / rect.height;

    // Standard wheel = vertical scroll. Shift/wheel or trackpad deltaX = horizontal.
    const dx = (e.shiftKey ? e.deltaY : e.deltaX) * worldPerPixelX;
    const dy = (e.shiftKey ? 0 : e.deltaY) * worldPerPixelY;

    camera.x += dx;
    camera.y += dy;
    updateCamera();
  },
  { passive: false },
);

svgViewport.addEventListener("dragover", (e) => e.preventDefault());

svgViewport.addEventListener("drop", (e) => {
  e.preventDefault();

  const type = e.dataTransfer.getData("text/floorplan-type");
  if (!type) return;

  const p = screenToWorld(e);
  addObject(type, Math.max(0, p.x), Math.max(0, p.y));
});

document.addEventListener("keydown", (e) => {
  if (
    (e.ctrlKey || e.metaKey) &&
    e.key.toLowerCase() === "c" &&
    selected() &&
    !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)
  ) {
    e.preventDefault();
    clipboardObject = JSON.parse(JSON.stringify(selected()));
    return;
  }

  if (
    (e.ctrlKey || e.metaKey) &&
    e.key.toLowerCase() === "v" &&
    clipboardObject &&
    !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)
  ) {
    e.preventDefault();
    pushHistory();
    const c = JSON.parse(JSON.stringify(clipboardObject));
    c.id = uid();
    c.x += 1;
    c.y += 1;
    normalizeObject(c);
    state.objects.push(c);
    state.selectedId = c.id;
    render();
    return;
  }

  if (e.code === "Space") {
    spaceDown = true;
    document.body.classList.add("space-pan");
    e.preventDefault();
  }

  if (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    return;
  }

  const o = selected();
  if (!o) return;

  if (
    e.key.toLowerCase() === "r" &&
    !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)
  ) {
    e.preventDefault();
    rotateSelected(90);
  }

  if (
    (e.key === "Delete" || e.key === "Backspace") &&
    !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)
  ) {
    e.preventDefault();
    removeSelected();
  }

  if (o.locked) return;

  if (e.key === "ArrowLeft") {
    e.preventDefault();
    pushHistory();
    o.x -= 0.5;
    normalizeObject(o);
    render();
  }
  if (e.key === "ArrowRight") {
    e.preventDefault();
    pushHistory();
    o.x += 0.5;
    normalizeObject(o);
    render();
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    pushHistory();
    o.y -= 0.5;
    normalizeObject(o);
    render();
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    pushHistory();
    o.y += 0.5;
    normalizeObject(o);
    render();
  }
});

document.addEventListener("keyup", (e) => {
  if (e.code === "Space") {
    spaceDown = false;
    document.body.classList.remove("space-pan");
  }
});

[
  ["propX", "x"],
  ["propY", "y"],
  ["propW", "w"],
  ["propH", "h"],
].forEach(([id, key]) => {
  document
    .getElementById(id)
    .addEventListener("change", () => setPropNum(id, key));
});

function setRoomWallThickness(inputEl, key) {
  const o = selected();
  if (!o || o.type !== "room") return;
  const value = parseFtIn(inputEl.value);
  if (!Number.isFinite(value) || value < 0) return;
  pushHistory();
  ensureRoomWalls(o);
  o[key] = value;
  render();
}

roomTopWall.addEventListener("change", () =>
  setRoomWallThickness(roomTopWall, "topWall"),
);
roomRightWall.addEventListener("change", () =>
  setRoomWallThickness(roomRightWall, "rightWall"),
);
roomBottomWall.addEventListener("change", () =>
  setRoomWallThickness(roomBottomWall, "bottomWall"),
);
roomLeftWall.addEventListener("change", () =>
  setRoomWallThickness(roomLeftWall, "leftWall"),
);

propRotation.addEventListener("change", () => {
  const o = selected();
  if (!o) return;

  pushHistory();
  o.rotation = Number(propRotation.value.replace("°", "")) || 0;
  render();
});

propLabel.addEventListener("input", () => {
  const o = selected();
  if (!o) return;
  o.label = propLabel.value;
  render();
});

// propFill.addEventListener("input", () => {
//   const o = selected();
//   if (!o) return;
//   o.fill = propFill.value;
//   render();
// });

// propStroke.addEventListener("input", () => {
//   const o = selected();
//   if (!o) return;
//   o.stroke = propStroke.value;
//   render();
// });

rotateLeftBtn.onclick = () => rotateSelected(-90);
rotateRightBtn.onclick = () => rotateSelected(90);

measureToolBtn.onclick = () => {
  measureMode = !measureMode;
  measureToolBtn.classList.toggle("active", measureMode);
  if (measureMode) {
    state.selectedId = null;
    render();
    flash("Drag on the canvas to draw a measurement");
  }
};

lockToggleBtn.onclick = () => {
  const o = selected();
  if (!o) return;
  pushHistory();
  o.locked = !o.locked;
  render();
};

measureBetweenBtn.onclick = () => {
  enterDistancePickMode();
  measureSecondHint.classList.remove("hidden");
};
deleteBtn.onclick = removeSelected;
duplicateBtn.onclick = duplicateSelected;
frontBtn.onclick = bringFront;
backBtn.onclick = sendBack;
undoBtn.onclick = undo;
redoBtn.onclick = redo;

zoomInBtn.onclick = zoomIn;
zoomOutBtn.onclick = zoomOut;
fitBtn.onclick = fitView;

gridToggle.onchange = () => {
  state.showGrid = gridToggle.checked;
  render();
};

measureToggle.onchange = () => {
  state.showMeasurements = measureToggle.checked;
  render();
};

smartAlignToggle.onchange = () => {
  state.smartAlign = smartAlignToggle.checked;
  renderSnapGuides([]);
};

dimensionRefSelect.onchange = () => {
  state.dimensionRef = dimensionRefSelect.value;
  // Existing measurement lines follow the global reference unless explicitly overridden.
  state.objects.forEach((o) => {
    if (o.type === "measurement") o.dimensionRef = state.dimensionRef;
  });
  render();
};

bgColor.oninput = () => {
  state.background = bgColor.value;
  render();
};

newBtn.onclick = () => {
  if (!confirm("Start a new plan? Unsaved changes will be replaced.")) return;

  undoStack = [];
  redoStack = [];
  state = {
    objects: [],
    selectedId: null,
    showGrid: true,
    showMeasurements: true,
    snap: 0,
    background: "#ffffff",
    dimensionRef: "inner",
    smartAlign: true,
    distancePair: null,
  };

  fitView();
  syncControls();
  render();
};

saveBtn.onclick = () => {
  saveFile();
  saveAutoState();
};
loadBtn.onclick = () => fileInput.click();
templateBtn.onclick = async () => {
  if (
    state.objects.length &&
    !confirm("Load the built-in template? Your current plan will be replaced.")
  ) {
    return;
  }

  try {
    await loadDefaultPlan();
    flash("Template loaded");
  } catch (error) {
    console.error("Template load failed:", error);
    flash("Template unavailable");
  }
};
fileInput.onchange = loadFile;
// exportSvgBtn.onclick = exportSVG;
exportPngBtn.onclick = exportPNG;

const DEFAULT_PLAN = "./floorplan.json";

async function loadDefaultPlan() {
  try {
    const response = await fetch(DEFAULT_PLAN);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const incomingState = payload.state || payload;

    state = {
      ...state,
      ...incomingState,
      selectedId: null,
      snap: 0,
    };

    state.objects = (state.objects || []).map((o) => {
      const base = defaults[o.type] || defaults.rect;
      const obj = { ...base, ...o };
      if (obj.type === "room") ensureRoomWalls(obj);
      normalizeObject(obj);
      return obj;
    });

    if (payload.camera) {
      camera = { ...camera, ...payload.camera };
    }

    syncControls();
    render();
    return true;
  } catch (error) {
    console.error("Failed to load default floor plan:", error);

    addStarter();
    render();
    return false;
  }
}

buildPalette();
if (!restoreAutoState()) {
  loadDefaultPlan();
}
