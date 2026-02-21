/**
 * Floor Plan Generator tool for civilclaw.
 *
 * Generates architectural floor plans as SVG from a room program description.
 * Uses a treemap-style binary space partitioning algorithm with architectural
 * heuristics for layout, then renders walls, doors, dimensions, and labels.
 *
 * No external dependencies beyond Node.js `fs`.
 */
import fs from "node:fs";
import path from "node:path";

// ─── Constants ───────────────────────────────────────────────────────────────

const SCALE = 50; // 1 meter = 50 pixels
const EXTERIOR_WALL_PX = 2;
const INTERIOR_WALL_PX = 1;
const DOOR_WIDTH_M = 0.8;
const DOOR_ARC_RADIUS_PX = DOOR_WIDTH_M * SCALE;
const DIMENSION_OFFSET_PX = 30;
const DIMENSION_TEXT_SIZE = 11;
const LABEL_TEXT_SIZE = 13;
const AREA_TEXT_SIZE = 10;
const GRID_COLOR = "#e8e8e8";
const MARGIN_PX = 60; // margin around the building for dimensions / labels

// ─── Types ───────────────────────────────────────────────────────────────────

interface RoomInput {
  name: string;
  type:
    | "bedroom"
    | "bathroom"
    | "kitchen"
    | "living"
    | "dining"
    | "office"
    | "storage"
    | "corridor"
    | "stairs"
    | "garage"
    | "laundry"
    | "custom";
  area_sqm: number;
  min_width_m?: number;
  adjacency?: string[];
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PlacedRoom {
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  area_sqm: number;
}

type Style = "architectural" | "schematic" | "colored";

interface FloorplanParams {
  rooms: RoomInput[];
  building_footprint?: { width_m: number; depth_m: number };
  output_path: string;
  style?: Style;
  include_dimensions?: boolean;
  include_doors?: boolean;
  wall_thickness_m?: number;
}

// ─── Color palette by room type ──────────────────────────────────────────────

const ROOM_COLORS: Record<string, string> = {
  bedroom: "#c8e6c9",   // green
  bathroom: "#bbdefb",  // blue
  kitchen: "#fff9c4",   // yellow
  living: "#ffe0b2",    // orange
  dining: "#f8bbd0",    // pink
  office: "#d1c4e9",    // purple
  storage: "#d7ccc8",   // brown
  corridor: "#eceff1",  // blue-gray
  stairs: "#cfd8dc",    // gray-blue
  garage: "#e0e0e0",    // gray
  laundry: "#b2ebf2",   // cyan
  custom: "#f5f5f5",    // light gray
};

// ─── Layout Algorithm ────────────────────────────────────────────────────────

/**
 * Sort rooms by area descending, then by adjacency constraint count descending
 * so the most constrained / largest rooms get placed first.
 */
function sortRooms(rooms: RoomInput[]): RoomInput[] {
  return [...rooms].sort((a, b) => {
    const adjDiff = (b.adjacency?.length ?? 0) - (a.adjacency?.length ?? 0);
    if (adjDiff !== 0) return adjDiff;
    return b.area_sqm - a.area_sqm;
  });
}

/**
 * Determine the building footprint from total room area if not explicitly given.
 * Targets a roughly 4:3 aspect ratio.
 */
function inferFootprint(
  rooms: RoomInput[],
  given?: { width_m: number; depth_m: number },
): { width_m: number; depth_m: number } {
  if (given && given.width_m > 0 && given.depth_m > 0) return given;

  const totalArea = rooms.reduce((s, r) => s + r.area_sqm, 0);
  // Add ~15% for walls/circulation
  const effectiveArea = totalArea * 1.15;
  const ratio = 4 / 3;
  const depth = Math.sqrt(effectiveArea / ratio);
  const width = effectiveArea / depth;
  return {
    width_m: Math.round(width * 10) / 10,
    depth_m: Math.round(depth * 10) / 10,
  };
}

/**
 * Recursive binary space partition (BSP) layout.
 *
 * Takes an array of rooms (sorted by priority) and a bounding rectangle,
 * splits the rectangle to allocate proportional area to subsets, and recurses
 * until each partition holds exactly one room.
 */
function bspLayout(rooms: RoomInput[], bounds: Rect): PlacedRoom[] {
  if (rooms.length === 0) return [];

  if (rooms.length === 1) {
    const room = rooms[0]!;
    return [
      {
        name: room.name,
        type: room.type,
        x: bounds.x,
        y: bounds.y,
        width: bounds.w,
        height: bounds.h,
        area_sqm: Math.round(bounds.w * bounds.h * 100) / 100,
      },
    ];
  }

  // Find the split point: divide rooms into two groups roughly by area proportion
  const totalArea = rooms.reduce((s, r) => s + r.area_sqm, 0);

  // Determine split direction: prefer to cut the longer axis to keep rooms squarish
  const splitHorizontally = bounds.w >= bounds.h;

  // Find split index: accumulate area until we reach ~half
  let accumulated = 0;
  let splitIdx = 1; // at least one room in the first partition
  for (let i = 0; i < rooms.length - 1; i++) {
    accumulated += rooms[i]!.area_sqm;
    if (accumulated >= totalArea * 0.5) {
      splitIdx = i + 1;
      break;
    }
  }
  // Ensure both partitions are non-empty
  if (splitIdx <= 0) splitIdx = 1;
  if (splitIdx >= rooms.length) splitIdx = rooms.length - 1;

  const groupA = rooms.slice(0, splitIdx);
  const groupB = rooms.slice(splitIdx);

  const areaA = groupA.reduce((s, r) => s + r.area_sqm, 0);
  const ratio = areaA / totalArea;

  let boundsA: Rect;
  let boundsB: Rect;

  if (splitHorizontally) {
    // Split along X axis
    let splitW = bounds.w * ratio;

    // Enforce min_width constraints for groupA rooms
    for (const r of groupA) {
      if (r.min_width_m && splitW < r.min_width_m) {
        splitW = Math.min(r.min_width_m, bounds.w * 0.8);
      }
    }

    boundsA = { x: bounds.x, y: bounds.y, w: splitW, h: bounds.h };
    boundsB = {
      x: bounds.x + splitW,
      y: bounds.y,
      w: bounds.w - splitW,
      h: bounds.h,
    };
  } else {
    // Split along Y axis
    let splitH = bounds.h * ratio;

    for (const r of groupA) {
      if (r.min_width_m && splitH < r.min_width_m) {
        splitH = Math.min(r.min_width_m, bounds.h * 0.8);
      }
    }

    boundsA = { x: bounds.x, y: bounds.y, w: bounds.w, h: splitH };
    boundsB = {
      x: bounds.x,
      y: bounds.y + splitH,
      w: bounds.w,
      h: bounds.h - splitH,
    };
  }

  return [...bspLayout(groupA, boundsA), ...bspLayout(groupB, boundsB)];
}

/**
 * Try to improve adjacency satisfaction by swapping rooms that share an edge.
 * A simple greedy pass: for each unsatisfied adjacency constraint, look for a
 * swap partner that would improve the overall score.
 */
function improveAdjacency(
  placed: PlacedRoom[],
  rooms: RoomInput[],
): PlacedRoom[] {
  const adjacencyMap = new Map<string, Set<string>>();
  for (const r of rooms) {
    if (r.adjacency && r.adjacency.length > 0) {
      adjacencyMap.set(r.name, new Set(r.adjacency));
    }
  }

  if (adjacencyMap.size === 0) return placed;

  function sharesEdge(a: PlacedRoom, b: PlacedRoom): boolean {
    const eps = 0.01;
    // Share vertical edge
    const shareVert =
      (Math.abs(a.x + a.width - b.x) < eps || Math.abs(b.x + b.width - a.x) < eps) &&
      a.y < b.y + b.height - eps &&
      b.y < a.y + a.height - eps;
    // Share horizontal edge
    const shareHoriz =
      (Math.abs(a.y + a.height - b.y) < eps || Math.abs(b.y + b.height - a.y) < eps) &&
      a.x < b.x + b.width - eps &&
      b.x < a.x + a.width - eps;
    return shareVert || shareHoriz;
  }

  function adjacencyScore(layout: PlacedRoom[]): number {
    let score = 0;
    const byName = new Map<string, PlacedRoom>();
    for (const r of layout) byName.set(r.name, r);

    for (const [name, neighbors] of adjacencyMap) {
      const room = byName.get(name);
      if (!room) continue;
      for (const neighbor of neighbors) {
        const other = byName.get(neighbor);
        if (!other) continue;
        if (sharesEdge(room, other)) score++;
      }
    }
    return score;
  }

  let best = [...placed];
  let bestScore = adjacencyScore(best);

  // Try swapping each pair (swap positions, not names)
  const MAX_ITERATIONS = 3;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let improved = false;
    for (let i = 0; i < best.length; i++) {
      for (let j = i + 1; j < best.length; j++) {
        // Swap positions
        const candidate = best.map((r) => ({ ...r }));
        const ri = candidate[i]!;
        const rj = candidate[j]!;

        const tmpX = ri.x,
          tmpY = ri.y,
          tmpW = ri.width,
          tmpH = ri.height;
        ri.x = rj.x;
        ri.y = rj.y;
        ri.width = rj.width;
        ri.height = rj.height;
        ri.area_sqm = Math.round(ri.width * ri.height * 100) / 100;
        rj.x = tmpX;
        rj.y = tmpY;
        rj.width = tmpW;
        rj.height = tmpH;
        rj.area_sqm = Math.round(rj.width * rj.height * 100) / 100;

        const score = adjacencyScore(candidate);
        if (score > bestScore) {
          best = candidate;
          bestScore = score;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }

  return best;
}

// ─── Door placement ──────────────────────────────────────────────────────────

interface Door {
  x: number;
  y: number;
  horizontal: boolean; // true = door along horizontal wall, false = vertical wall
}

function findDoors(placed: PlacedRoom[]): Door[] {
  const doors: Door[] = [];
  const eps = 0.01;

  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!;
      const b = placed[j]!;

      // Check shared vertical edge (a's right = b's left or vice versa)
      if (Math.abs(a.x + a.width - b.x) < eps) {
        const overlapStart = Math.max(a.y, b.y);
        const overlapEnd = Math.min(a.y + a.height, b.y + b.height);
        if (overlapEnd - overlapStart > DOOR_WIDTH_M + eps) {
          const mid = (overlapStart + overlapEnd) / 2;
          doors.push({ x: a.x + a.width, y: mid, horizontal: false });
        }
      } else if (Math.abs(b.x + b.width - a.x) < eps) {
        const overlapStart = Math.max(a.y, b.y);
        const overlapEnd = Math.min(a.y + a.height, b.y + b.height);
        if (overlapEnd - overlapStart > DOOR_WIDTH_M + eps) {
          const mid = (overlapStart + overlapEnd) / 2;
          doors.push({ x: b.x + b.width, y: mid, horizontal: false });
        }
      }

      // Check shared horizontal edge (a's bottom = b's top or vice versa)
      if (Math.abs(a.y + a.height - b.y) < eps) {
        const overlapStart = Math.max(a.x, b.x);
        const overlapEnd = Math.min(a.x + a.width, b.x + b.width);
        if (overlapEnd - overlapStart > DOOR_WIDTH_M + eps) {
          const mid = (overlapStart + overlapEnd) / 2;
          doors.push({ x: mid, y: a.y + a.height, horizontal: true });
        }
      } else if (Math.abs(b.y + b.height - a.y) < eps) {
        const overlapStart = Math.max(a.x, b.x);
        const overlapEnd = Math.min(a.x + a.width, b.x + b.width);
        if (overlapEnd - overlapStart > DOOR_WIDTH_M + eps) {
          const mid = (overlapStart + overlapEnd) / 2;
          doors.push({ x: mid, y: b.y + b.height, horizontal: true });
        }
      }
    }
  }

  return doors;
}

// ─── SVG Rendering ───────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toPixel(meters: number): number {
  return meters * SCALE;
}

function buildSvg(params: {
  placed: PlacedRoom[];
  buildingWidth: number;
  buildingDepth: number;
  doors: Door[];
  style: Style;
  includeDimensions: boolean;
  includeDoors: boolean;
  wallThickness: number;
}): string {
  const {
    placed,
    buildingWidth,
    buildingDepth,
    doors,
    style,
    includeDimensions,
    includeDoors,
    wallThickness,
  } = params;

  const bw = toPixel(buildingWidth);
  const bh = toPixel(buildingDepth);
  const totalW = bw + MARGIN_PX * 2;
  const totalH = bh + MARGIN_PX * 2;

  const lines: string[] = [];

  lines.push(
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} ${totalH}" width="${totalW}" height="${totalH}">`,
    `  <defs>`,
    `    <style>`,
    `      .room-label { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: ${LABEL_TEXT_SIZE}px; font-weight: 600; text-anchor: middle; dominant-baseline: central; }`,
    `      .room-area { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: ${AREA_TEXT_SIZE}px; text-anchor: middle; dominant-baseline: central; fill: #666; }`,
    `      .dim-text { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: ${DIMENSION_TEXT_SIZE}px; text-anchor: middle; dominant-baseline: central; fill: #333; }`,
    `    </style>`,
    `  </defs>`,
  );

  // Background
  lines.push(`  <rect x="0" y="0" width="${totalW}" height="${totalH}" fill="white" />`);

  // Grid (1m intervals)
  lines.push(`  <g id="grid" stroke="${GRID_COLOR}" stroke-width="0.5">`);
  for (let mx = 0; mx <= buildingWidth; mx++) {
    const px = MARGIN_PX + toPixel(mx);
    lines.push(`    <line x1="${px}" y1="${MARGIN_PX}" x2="${px}" y2="${MARGIN_PX + bh}" />`);
  }
  for (let my = 0; my <= buildingDepth; my++) {
    const py = MARGIN_PX + toPixel(my);
    lines.push(`    <line x1="${MARGIN_PX}" y1="${py}" x2="${MARGIN_PX + bw}" y2="${py}" />`);
  }
  lines.push(`  </g>`);

  // Room fills
  const fillColor = (roomType: string): string => {
    switch (style) {
      case "colored":
        return ROOM_COLORS[roomType] ?? ROOM_COLORS.custom!;
      case "schematic":
        return "#f0f0f0";
      case "architectural":
      default:
        return "#ffffff";
    }
  };

  const textColor = (): string => {
    switch (style) {
      case "schematic":
        return "#444";
      default:
        return "#222";
    }
  };

  const wallColor = (): string => {
    switch (style) {
      case "schematic":
        return "#555";
      default:
        return "#000";
    }
  };

  lines.push(`  <g id="rooms">`);
  for (const room of placed) {
    const rx = MARGIN_PX + toPixel(room.x);
    const ry = MARGIN_PX + toPixel(room.y);
    const rw = toPixel(room.width);
    const rh = toPixel(room.height);
    const fill = fillColor(room.type);

    lines.push(
      `    <rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="${fill}" stroke="none" />`,
    );
  }
  lines.push(`  </g>`);

  // Interior walls (between adjacent rooms)
  const interiorWallColor = wallColor();
  lines.push(`  <g id="interior-walls" stroke="${interiorWallColor}" stroke-width="${INTERIOR_WALL_PX}" stroke-linecap="round">`);

  const eps = 0.01;
  const drawnEdges = new Set<string>();

  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!;
      const b = placed[j]!;

      // Shared vertical edge
      if (Math.abs(a.x + a.width - b.x) < eps || Math.abs(b.x + b.width - a.x) < eps) {
        const edgeX = Math.abs(a.x + a.width - b.x) < eps ? a.x + a.width : b.x + b.width;
        const overlapStart = Math.max(a.y, b.y);
        const overlapEnd = Math.min(a.y + a.height, b.y + b.height);
        if (overlapEnd - overlapStart > eps) {
          const key = `v:${edgeX.toFixed(2)}:${overlapStart.toFixed(2)}:${overlapEnd.toFixed(2)}`;
          if (!drawnEdges.has(key)) {
            drawnEdges.add(key);

            // Check if there is a door on this wall segment
            const hasDoor =
              includeDoors &&
              doors.some(
                (d) =>
                  !d.horizontal &&
                  Math.abs(d.x - edgeX) < eps &&
                  d.y > overlapStart + eps &&
                  d.y < overlapEnd - eps,
              );

            if (hasDoor) {
              const door = doors.find(
                (d) =>
                  !d.horizontal &&
                  Math.abs(d.x - edgeX) < eps &&
                  d.y > overlapStart + eps &&
                  d.y < overlapEnd - eps,
              )!;
              const doorHalf = DOOR_WIDTH_M / 2;
              // Draw wall segments on either side of the door
              const px = MARGIN_PX + toPixel(edgeX);
              const py1 = MARGIN_PX + toPixel(overlapStart);
              const pyDoorTop = MARGIN_PX + toPixel(door.y - doorHalf);
              const pyDoorBottom = MARGIN_PX + toPixel(door.y + doorHalf);
              const py2 = MARGIN_PX + toPixel(overlapEnd);
              if (pyDoorTop - py1 > 1) {
                lines.push(`    <line x1="${px}" y1="${py1}" x2="${px}" y2="${pyDoorTop}" />`);
              }
              if (py2 - pyDoorBottom > 1) {
                lines.push(`    <line x1="${px}" y1="${pyDoorBottom}" x2="${px}" y2="${py2}" />`);
              }
            } else {
              const px = MARGIN_PX + toPixel(edgeX);
              const py1 = MARGIN_PX + toPixel(overlapStart);
              const py2 = MARGIN_PX + toPixel(overlapEnd);
              lines.push(`    <line x1="${px}" y1="${py1}" x2="${px}" y2="${py2}" />`);
            }
          }
        }
      }

      // Shared horizontal edge
      if (Math.abs(a.y + a.height - b.y) < eps || Math.abs(b.y + b.height - a.y) < eps) {
        const edgeY = Math.abs(a.y + a.height - b.y) < eps ? a.y + a.height : b.y + b.height;
        const overlapStart = Math.max(a.x, b.x);
        const overlapEnd = Math.min(a.x + a.width, b.x + b.width);
        if (overlapEnd - overlapStart > eps) {
          const key = `h:${edgeY.toFixed(2)}:${overlapStart.toFixed(2)}:${overlapEnd.toFixed(2)}`;
          if (!drawnEdges.has(key)) {
            drawnEdges.add(key);

            const hasDoor =
              includeDoors &&
              doors.some(
                (d) =>
                  d.horizontal &&
                  Math.abs(d.y - edgeY) < eps &&
                  d.x > overlapStart + eps &&
                  d.x < overlapEnd - eps,
              );

            if (hasDoor) {
              const door = doors.find(
                (d) =>
                  d.horizontal &&
                  Math.abs(d.y - edgeY) < eps &&
                  d.x > overlapStart + eps &&
                  d.x < overlapEnd - eps,
              )!;
              const doorHalf = DOOR_WIDTH_M / 2;
              const py = MARGIN_PX + toPixel(edgeY);
              const px1 = MARGIN_PX + toPixel(overlapStart);
              const pxDoorLeft = MARGIN_PX + toPixel(door.x - doorHalf);
              const pxDoorRight = MARGIN_PX + toPixel(door.x + doorHalf);
              const px2 = MARGIN_PX + toPixel(overlapEnd);
              if (pxDoorLeft - px1 > 1) {
                lines.push(`    <line x1="${px1}" y1="${py}" x2="${pxDoorLeft}" y2="${py}" />`);
              }
              if (px2 - pxDoorRight > 1) {
                lines.push(`    <line x1="${pxDoorRight}" y1="${py}" x2="${px2}" y2="${py}" />`);
              }
            } else {
              const py = MARGIN_PX + toPixel(edgeY);
              const px1 = MARGIN_PX + toPixel(overlapStart);
              const px2 = MARGIN_PX + toPixel(overlapEnd);
              lines.push(`    <line x1="${px1}" y1="${py}" x2="${px2}" y2="${py}" />`);
            }
          }
        }
      }
    }
  }
  lines.push(`  </g>`);

  // Exterior walls
  const extColor = wallColor();
  lines.push(`  <g id="exterior-walls">`);
  lines.push(
    `    <rect x="${MARGIN_PX}" y="${MARGIN_PX}" width="${bw}" height="${bh}" fill="none" stroke="${extColor}" stroke-width="${EXTERIOR_WALL_PX}" />`,
  );
  lines.push(`  </g>`);

  // Door arcs
  if (includeDoors && doors.length > 0) {
    lines.push(`  <g id="doors" stroke="${interiorWallColor}" stroke-width="1" fill="none">`);
    for (const door of doors) {
      const doorHalf = DOOR_WIDTH_M / 2;
      if (door.horizontal) {
        // Door on horizontal wall: arc swings downward from the hinge point
        const hingeX = MARGIN_PX + toPixel(door.x - doorHalf);
        const hingeY = MARGIN_PX + toPixel(door.y);
        const arcEndX = MARGIN_PX + toPixel(door.x + doorHalf);
        const radius = DOOR_ARC_RADIUS_PX;

        // Draw the door leaf line
        lines.push(
          `    <line x1="${hingeX}" y1="${hingeY}" x2="${hingeX}" y2="${hingeY + radius}" stroke-width="1.5" />`,
        );
        // Draw 90-degree arc
        lines.push(
          `    <path d="M ${hingeX} ${hingeY + radius} A ${radius} ${radius} 0 0 1 ${arcEndX} ${hingeY}" stroke-dasharray="3,2" />`,
        );
      } else {
        // Door on vertical wall: arc swings rightward from the hinge point
        const hingeX = MARGIN_PX + toPixel(door.x);
        const hingeY = MARGIN_PX + toPixel(door.y - doorHalf);
        const arcEndY = MARGIN_PX + toPixel(door.y + doorHalf);
        const radius = DOOR_ARC_RADIUS_PX;

        // Draw the door leaf line
        lines.push(
          `    <line x1="${hingeX}" y1="${hingeY}" x2="${hingeX + radius}" y2="${hingeY}" stroke-width="1.5" />`,
        );
        // Draw 90-degree arc
        lines.push(
          `    <path d="M ${hingeX + radius} ${hingeY} A ${radius} ${radius} 0 0 1 ${hingeX} ${arcEndY}" stroke-dasharray="3,2" />`,
        );
      }
    }
    lines.push(`  </g>`);
  }

  // Room labels
  const labelColor = textColor();
  lines.push(`  <g id="labels">`);
  for (const room of placed) {
    const cx = MARGIN_PX + toPixel(room.x + room.width / 2);
    const cy = MARGIN_PX + toPixel(room.y + room.height / 2);
    const areaDisplay = room.area_sqm.toFixed(1);

    lines.push(
      `    <text x="${cx}" y="${cy - 8}" class="room-label" fill="${labelColor}">${escapeXml(room.name)}</text>`,
    );
    lines.push(
      `    <text x="${cx}" y="${cy + 10}" class="room-area">${areaDisplay} m\u00B2</text>`,
    );
  }
  lines.push(`  </g>`);

  // Dimensions
  if (includeDimensions) {
    lines.push(`  <g id="dimensions">`);

    // Top dimension (building width)
    const dimTopY = MARGIN_PX - DIMENSION_OFFSET_PX;
    const dimTopX1 = MARGIN_PX;
    const dimTopX2 = MARGIN_PX + bw;
    // Extension lines
    lines.push(
      `    <line x1="${dimTopX1}" y1="${dimTopY - 5}" x2="${dimTopX1}" y2="${MARGIN_PX}" stroke="#666" stroke-width="0.5" />`,
    );
    lines.push(
      `    <line x1="${dimTopX2}" y1="${dimTopY - 5}" x2="${dimTopX2}" y2="${MARGIN_PX}" stroke="#666" stroke-width="0.5" />`,
    );
    // Dimension line
    lines.push(
      `    <line x1="${dimTopX1}" y1="${dimTopY}" x2="${dimTopX2}" y2="${dimTopY}" stroke="#333" stroke-width="0.75" marker-start="url(#arrowStart)" marker-end="url(#arrowEnd)" />`,
    );
    // Dimension text
    const widthLabel = `${buildingWidth.toFixed(2)} m`;
    lines.push(
      `    <text x="${(dimTopX1 + dimTopX2) / 2}" y="${dimTopY - 4}" class="dim-text">${widthLabel}</text>`,
    );

    // Left dimension (building depth)
    const dimLeftX = MARGIN_PX - DIMENSION_OFFSET_PX;
    const dimLeftY1 = MARGIN_PX;
    const dimLeftY2 = MARGIN_PX + bh;
    // Extension lines
    lines.push(
      `    <line x1="${dimLeftX - 5}" y1="${dimLeftY1}" x2="${MARGIN_PX}" y2="${dimLeftY1}" stroke="#666" stroke-width="0.5" />`,
    );
    lines.push(
      `    <line x1="${dimLeftX - 5}" y1="${dimLeftY2}" x2="${MARGIN_PX}" y2="${dimLeftY2}" stroke="#666" stroke-width="0.5" />`,
    );
    // Dimension line
    lines.push(
      `    <line x1="${dimLeftX}" y1="${dimLeftY1}" x2="${dimLeftX}" y2="${dimLeftY2}" stroke="#333" stroke-width="0.75" />`,
    );
    // Dimension text (rotated)
    const depthLabel = `${buildingDepth.toFixed(2)} m`;
    lines.push(
      `    <text x="${dimLeftX - 4}" y="${(dimLeftY1 + dimLeftY2) / 2}" class="dim-text" transform="rotate(-90, ${dimLeftX - 4}, ${(dimLeftY1 + dimLeftY2) / 2})">${depthLabel}</text>`,
    );

    // Per-room width dimensions along the bottom
    const bottomDimY = MARGIN_PX + bh + DIMENSION_OFFSET_PX;
    // Gather unique X splits
    const xSplits = new Set<number>();
    xSplits.add(0);
    xSplits.add(buildingWidth);
    for (const room of placed) {
      xSplits.add(Math.round(room.x * 100) / 100);
      xSplits.add(Math.round((room.x + room.width) * 100) / 100);
    }
    const sortedX = [...xSplits].sort((a, b) => a - b);
    for (let i = 0; i < sortedX.length - 1; i++) {
      const x1 = sortedX[i]!;
      const x2 = sortedX[i + 1]!;
      const span = x2 - x1;
      if (span < 0.01) continue;

      const px1 = MARGIN_PX + toPixel(x1);
      const px2 = MARGIN_PX + toPixel(x2);

      // Tick marks
      lines.push(
        `    <line x1="${px1}" y1="${MARGIN_PX + bh}" x2="${px1}" y2="${bottomDimY + 5}" stroke="#666" stroke-width="0.5" />`,
      );
      lines.push(
        `    <line x1="${px2}" y1="${MARGIN_PX + bh}" x2="${px2}" y2="${bottomDimY + 5}" stroke="#666" stroke-width="0.5" />`,
      );
      // Dimension line segment
      lines.push(
        `    <line x1="${px1}" y1="${bottomDimY}" x2="${px2}" y2="${bottomDimY}" stroke="#333" stroke-width="0.5" />`,
      );
      // Label
      if (px2 - px1 > 20) {
        lines.push(
          `    <text x="${(px1 + px2) / 2}" y="${bottomDimY + 14}" class="dim-text">${span.toFixed(2)}</text>`,
        );
      }
    }

    // Per-room depth dimensions along the right
    const rightDimX = MARGIN_PX + bw + DIMENSION_OFFSET_PX;
    const ySplits = new Set<number>();
    ySplits.add(0);
    ySplits.add(buildingDepth);
    for (const room of placed) {
      ySplits.add(Math.round(room.y * 100) / 100);
      ySplits.add(Math.round((room.y + room.height) * 100) / 100);
    }
    const sortedY = [...ySplits].sort((a, b) => a - b);
    for (let i = 0; i < sortedY.length - 1; i++) {
      const y1 = sortedY[i]!;
      const y2 = sortedY[i + 1]!;
      const span = y2 - y1;
      if (span < 0.01) continue;

      const py1 = MARGIN_PX + toPixel(y1);
      const py2 = MARGIN_PX + toPixel(y2);

      // Tick marks
      lines.push(
        `    <line x1="${MARGIN_PX + bw}" y1="${py1}" x2="${rightDimX + 5}" y2="${py1}" stroke="#666" stroke-width="0.5" />`,
      );
      lines.push(
        `    <line x1="${MARGIN_PX + bw}" y1="${py2}" x2="${rightDimX + 5}" y2="${py2}" stroke="#666" stroke-width="0.5" />`,
      );
      // Dimension line segment
      lines.push(
        `    <line x1="${rightDimX}" y1="${py1}" x2="${rightDimX}" y2="${py2}" stroke="#333" stroke-width="0.5" />`,
      );
      // Label
      if (py2 - py1 > 20) {
        lines.push(
          `    <text x="${rightDimX + 14}" y="${(py1 + py2) / 2}" class="dim-text" transform="rotate(-90, ${rightDimX + 14}, ${(py1 + py2) / 2})">${span.toFixed(2)}</text>`,
        );
      }
    }

    lines.push(`  </g>`);
  }

  lines.push(`</svg>`);

  return lines.join("\n");
}

// ─── Main execution logic ────────────────────────────────────────────────────

function generateFloorplan(params: FloorplanParams): {
  output_path: string;
  room_count: number;
  total_area_sqm: number;
  building_width_m: number;
  building_depth_m: number;
  rooms_placed: Array<{ name: string; x: number; y: number; width: number; height: number }>;
} {
  const {
    rooms,
    building_footprint,
    output_path,
    style = "architectural",
    include_dimensions = true,
    include_doors = true,
    wall_thickness_m = 0.15,
  } = params;

  if (!rooms || rooms.length === 0) {
    throw new Error("At least one room is required.");
  }

  // 1. Determine building footprint
  const footprint = inferFootprint(rooms, building_footprint);

  // 2. Sort rooms by priority
  const sorted = sortRooms(rooms);

  // 3. BSP layout
  const bounds: Rect = { x: 0, y: 0, w: footprint.width_m, h: footprint.depth_m };
  let placed = bspLayout(sorted, bounds);

  // 4. Improve adjacency via swapping
  placed = improveAdjacency(placed, rooms);

  // 5. Find doors between adjacent rooms
  const doors = include_doors ? findDoors(placed) : [];

  // 6. Render SVG
  const svg = buildSvg({
    placed,
    buildingWidth: footprint.width_m,
    buildingDepth: footprint.depth_m,
    doors,
    style,
    includeDimensions: include_dimensions,
    includeDoors: include_doors,
    wallThickness: wall_thickness_m,
  });

  // 7. Write to file
  const resolvedPath = path.resolve(output_path);
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(resolvedPath, svg, "utf-8");

  // 8. Build result
  const totalArea = placed.reduce((s, r) => s + r.area_sqm, 0);

  return {
    output_path: resolvedPath,
    room_count: placed.length,
    total_area_sqm: Math.round(totalArea * 100) / 100,
    building_width_m: footprint.width_m,
    building_depth_m: footprint.depth_m,
    rooms_placed: placed.map((r) => ({
      name: r.name,
      x: Math.round(r.x * 1000) / 1000,
      y: Math.round(r.y * 1000) / 1000,
      width: Math.round(r.width * 1000) / 1000,
      height: Math.round(r.height * 1000) / 1000,
    })),
  };
}

// ─── Tool definition ─────────────────────────────────────────────────────────

export function createFloorplanGenerateToolDefinition() {
  return {
    name: "floorplan_generate_svg",
    label: "Floor Plan Generator",
    description:
      "Generate an architectural floor plan as SVG from a room program description. " +
      "Takes a list of rooms with sizes, types, and adjacency requirements and produces a " +
      "floor plan layout with walls, doors, dimensions, and room labels. " +
      "Supports architectural, schematic, and colored style variants.",
    parameters: {
      type: "object",
      properties: {
        rooms: {
          type: "array",
          description: "List of rooms to include in the floor plan.",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Room name/label (e.g. 'Master Bedroom', 'Kitchen').",
              },
              type: {
                type: "string",
                enum: [
                  "bedroom",
                  "bathroom",
                  "kitchen",
                  "living",
                  "dining",
                  "office",
                  "storage",
                  "corridor",
                  "stairs",
                  "garage",
                  "laundry",
                  "custom",
                ],
                description: "Room type category.",
              },
              area_sqm: {
                type: "number",
                description: "Target area in square meters.",
              },
              min_width_m: {
                type: "number",
                description: "Minimum width constraint in meters (optional).",
              },
              adjacency: {
                type: "array",
                items: { type: "string" },
                description:
                  "Names of other rooms this room should be adjacent to (optional).",
              },
            },
            required: ["name", "type", "area_sqm"],
          },
        },
        building_footprint: {
          type: "object",
          description:
            "Optional bounding rectangle for the building. If omitted, inferred from total room area.",
          properties: {
            width_m: {
              type: "number",
              description: "Building width in meters.",
            },
            depth_m: {
              type: "number",
              description: "Building depth in meters.",
            },
          },
          required: ["width_m", "depth_m"],
        },
        output_path: {
          type: "string",
          description: "File path where the SVG will be saved.",
        },
        style: {
          type: "string",
          enum: ["architectural", "schematic", "colored"],
          description:
            'Visual style: "architectural" (white/black), "schematic" (gray), or "colored" (pastel by room type). Default: "architectural".',
        },
        include_dimensions: {
          type: "boolean",
          description:
            "Whether to render dimension annotations outside the building perimeter. Default: true.",
        },
        include_doors: {
          type: "boolean",
          description:
            "Whether to render door openings and swing arcs between adjacent rooms. Default: true.",
        },
        wall_thickness_m: {
          type: "number",
          description: "Wall thickness in meters. Default: 0.15.",
        },
      },
      required: ["rooms", "output_path"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details?: unknown;
    }> => {
      const params = (args ?? {}) as Record<string, unknown>;

      // ── Validate rooms ─────────────────────────────────────────────────
      const rawRooms = params.rooms;
      if (!Array.isArray(rawRooms) || rawRooms.length === 0) {
        throw new Error("rooms is required and must be a non-empty array.");
      }

      const validTypes = new Set([
        "bedroom",
        "bathroom",
        "kitchen",
        "living",
        "dining",
        "office",
        "storage",
        "corridor",
        "stairs",
        "garage",
        "laundry",
        "custom",
      ]);

      const rooms: RoomInput[] = rawRooms.map((r: any, idx: number) => {
        if (!r.name || typeof r.name !== "string") {
          throw new Error(`rooms[${idx}].name is required and must be a string.`);
        }
        const roomType = String(r.type ?? "custom");
        if (!validTypes.has(roomType)) {
          throw new Error(
            `rooms[${idx}].type "${roomType}" is invalid. Valid types: ${[...validTypes].join(", ")}`,
          );
        }
        const area = Number(r.area_sqm);
        if (!Number.isFinite(area) || area <= 0) {
          throw new Error(
            `rooms[${idx}].area_sqm must be a positive number.`,
          );
        }
        return {
          name: r.name,
          type: roomType as RoomInput["type"],
          area_sqm: area,
          min_width_m:
            typeof r.min_width_m === "number" && Number.isFinite(r.min_width_m) && r.min_width_m > 0
              ? r.min_width_m
              : undefined,
          adjacency: Array.isArray(r.adjacency)
            ? r.adjacency.filter((a: unknown) => typeof a === "string")
            : undefined,
        };
      });

      // ── Validate output_path ───────────────────────────────────────────
      const outputPath = String(params.output_path ?? "").trim();
      if (!outputPath) {
        throw new Error("output_path is required.");
      }

      // ── Validate building_footprint ────────────────────────────────────
      let buildingFootprint: { width_m: number; depth_m: number } | undefined;
      if (params.building_footprint && typeof params.building_footprint === "object") {
        const fp = params.building_footprint as Record<string, unknown>;
        const w = Number(fp.width_m);
        const d = Number(fp.depth_m);
        if (Number.isFinite(w) && Number.isFinite(d) && w > 0 && d > 0) {
          buildingFootprint = { width_m: w, depth_m: d };
        }
      }

      // ── Validate style ─────────────────────────────────────────────────
      let style: Style = "architectural";
      if (params.style === "schematic" || params.style === "colored") {
        style = params.style;
      }

      const includeDimensions = params.include_dimensions !== false;
      const includeDoors = params.include_doors !== false;
      const wallThickness =
        typeof params.wall_thickness_m === "number" &&
        Number.isFinite(params.wall_thickness_m) &&
        params.wall_thickness_m > 0
          ? params.wall_thickness_m
          : 0.15;

      // ── Generate ───────────────────────────────────────────────────────
      const result = generateFloorplan({
        rooms,
        building_footprint: buildingFootprint,
        output_path: outputPath,
        style,
        include_dimensions: includeDimensions,
        include_doors: includeDoors,
        wall_thickness_m: wallThickness,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: {
          output_path: result.output_path,
          room_count: result.room_count,
          style,
        },
      };
    },
  };
}
