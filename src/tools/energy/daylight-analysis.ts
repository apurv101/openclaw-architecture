/**
 * Daylight analysis tool for civilclaw.
 *
 * Calculates daylight factor and spatial daylight autonomy estimates per room
 * using the BRE split-flux daylight factor method. Useful for LEED/WELL
 * daylight credit assessment.
 *
 * Pure TypeScript -- only `fs` and `path` dependencies.
 */
import fs from "node:fs";
import path from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────────

type WallDirection = "N" | "S" | "E" | "W";
type SkyCondition = "overcast" | "clear" | "intermediate";

interface WindowInput {
  wall: WallDirection;
  width_m: number;
  height_m: number;
  sill_height_m?: number;
  glazing_transmittance?: number;
}

interface SurfaceReflectances {
  floor?: number;
  walls?: number;
  ceiling?: number;
}

interface RoomInput {
  name: string;
  width_m: number;
  depth_m: number;
  height_m?: number;
  windows: WindowInput[];
  surface_reflectances?: SurfaceReflectances;
  work_plane_height_m?: number;
}

interface ObstructionInput {
  wall: WallDirection;
  angle_deg: number;
  reflectance?: number;
}

interface DaylightAnalysisArgs {
  rooms: RoomInput[];
  obstructions?: ObstructionInput[];
  latitude_deg?: number;
  sky_condition?: SkyCondition;
  target_daylight_factor?: number;
  leed_threshold?: number;
}

// ─── Output types ──────────────────────────────────────────────────────────

interface DFProfilePoint {
  distance_from_window_m: number;
  daylight_factor_percent: number;
  estimated_illuminance_lux: number;
}

interface RoomResult {
  name: string;
  average_daylight_factor_percent: number;
  min_daylight_factor_percent: number;
  max_daylight_factor_percent: number;
  area_above_target_percent: number;
  estimated_sda_300_50_percent: number;
  daylight_factor_profile: DFProfilePoint[];
  status: "PASS" | "FAIL";
  recommendations: string[];
}

interface LEEDAssessment {
  sda_area_percent: number;
  points: number;
  level: "not_achieved" | "partial" | "achieved";
}

interface DaylightAnalysisResult {
  rooms: RoomResult[];
  summary: {
    total_rooms: number;
    rooms_passing: number;
    floor_area_above_target_percent: number;
    leed_daylight_points_possible: number;
  };
  leed_assessment: LEEDAssessment;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maintenance factor for glazing (accounts for dirt, aging) */
const MAINTENANCE_FACTOR = 0.9;

/**
 * CIE standard overcast sky: external diffuse illuminance on unobstructed
 * horizontal plane (lux). Standard value is ~10,000 lux.
 */
const OVERCAST_SKY_ILLUMINANCE = 10000;
const CLEAR_SKY_ILLUMINANCE = 15000;
const INTERMEDIATE_SKY_ILLUMINANCE = 12500;

/** Minimum analysis grid spacing in meters */
const GRID_SPACING_M = 0.5;

/** LEED v4.1 sDA thresholds */
const LEED_SDA_PARTIAL = 55; // 55% area => 2 points
const LEED_SDA_FULL = 75; // 75% area => 3 points

// ─── Utility ──────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

// ─── Sky luminance model ──────────────────────────────────────────────────

function getExternalIlluminance(sky: SkyCondition): number {
  switch (sky) {
    case "overcast":
      return OVERCAST_SKY_ILLUMINANCE;
    case "clear":
      return CLEAR_SKY_ILLUMINANCE;
    case "intermediate":
      return INTERMEDIATE_SKY_ILLUMINANCE;
  }
}

/**
 * CIE overcast sky luminance distribution.
 * L(theta) / L_zenith = (1 + 2 * sin(theta)) / 3
 * where theta = altitude angle from horizontal.
 *
 * For the split-flux method we use the simplified version where the
 * unobstructed external diffuse illuminance is the reference.
 */

// ─── BRE Split-Flux Daylight Factor Calculation ──────────────────────────

/**
 * Calculate the Sky Component (SC) for a single window at a given point
 * in the room using a simplified Waldram / BRE approach.
 *
 * The SC depends on the solid angle subtended by the window as seen from
 * the analysis point, corrected for the CIE sky luminance distribution.
 *
 * For a rectangular window on a vertical wall:
 *   SC = (tau * M) / (2 * pi) * integral over window of (cos(theta) * L(alpha)) dOmega
 *
 * Simplified for a point on the work plane at distance d from window wall:
 *   SC ~ (tau * M * H_eff * W) / (2 * pi * d^2) * correction_factor
 *
 * where correction_factor accounts for the CIE sky distribution and window
 * position relative to the point.
 */
function computeSkyComponent(
  windowWidth: number,
  windowHeight: number,
  sillHeight: number,
  transmittance: number,
  roomHeight: number,
  workPlaneHeight: number,
  distanceFromWindow: number,
  obstructionAngleDeg: number,
): number {
  if (distanceFromWindow <= 0) {
    distanceFromWindow = 0.01; // avoid division by zero
  }

  const tau = transmittance * MAINTENANCE_FACTOR;

  // Effective window dimensions above work plane
  const windowBottom = Math.max(sillHeight, workPlaneHeight);
  const windowTop = sillHeight + windowHeight;
  const effectiveHeight = Math.max(0, windowTop - windowBottom);

  if (effectiveHeight <= 0 || windowWidth <= 0) return 0;

  // Vertical angles from work plane to window bottom and top
  const heightAboveWP_bottom = windowBottom - workPlaneHeight;
  const heightAboveWP_top = windowTop - workPlaneHeight;

  // Angular subtense in the vertical plane
  const angleBottom = Math.atan2(Math.max(0, heightAboveWP_bottom), distanceFromWindow);
  const angleTop = Math.atan2(heightAboveWP_top, distanceFromWindow);
  const verticalAngle = angleTop - angleBottom; // radians

  // Angular subtense in the horizontal plane (half-width from center)
  const halfWidth = windowWidth / 2;
  const horizontalAngle = 2 * Math.atan2(halfWidth, distanceFromWindow);

  // Solid angle approximation
  const solidAngle = verticalAngle * horizontalAngle;

  // Average altitude of the window center as seen from the point
  const avgAltitude = (angleBottom + angleTop) / 2;

  // CIE overcast sky correction: luminance at altitude theta relative to mean
  // L(theta) / L_mean ~ (1 + 2 * sin(theta)) / 3 * (3/2)
  // Normalized so that hemisphere average = 1
  const skyCorrectionFactor = (1 + 2 * Math.sin(avgAltitude)) / 2;

  // Sky component as percentage of external illuminance
  // SC = (solid_angle / (2 * pi)) * tau * sky_correction * 100
  let sc = (solidAngle / (2 * Math.PI)) * tau * skyCorrectionFactor * 100;

  // Apply obstruction reduction
  if (obstructionAngleDeg > 0) {
    // The obstruction blocks a portion of the sky visible from the window
    // Approximate: fraction blocked = obstruction_angle / 90
    const fractionBlocked = Math.min(1, obstructionAngleDeg / 90);
    // Only the portion of the sky above the obstruction contributes
    const remainingFraction = 1 - fractionBlocked;
    sc *= remainingFraction;
  }

  return Math.max(0, sc);
}

/**
 * Calculate the Externally Reflected Component (ERC).
 *
 * ERC accounts for light reflected from external obstructing surfaces
 * into the room. It is typically small (0.1 - 1.0% DF).
 *
 * ERC = (obstruction_angle / 90) * (rho_ext / pi) * SC_blocked_portion
 */
function computeERC(
  obstructionAngleDeg: number,
  obstructionReflectance: number,
  windowWidth: number,
  windowHeight: number,
  transmittance: number,
  distanceFromWindow: number,
): number {
  if (obstructionAngleDeg <= 0) return 0;

  const tau = transmittance * MAINTENANCE_FACTOR;
  const fractionBlocked = Math.min(1, obstructionAngleDeg / 90);

  // The blocked portion of sky is replaced by light reflected from the obstruction
  // Approximate ERC using the luminance of the obstructing surface
  // compared to the sky luminance

  // Solid angle of window (same calculation as SC but simplified)
  const d = Math.max(0.01, distanceFromWindow);
  const angleV = Math.atan2(windowHeight, d);
  const angleH = 2 * Math.atan2(windowWidth / 2, d);
  const solidAngle = angleV * angleH;

  // ERC = fraction_blocked * obstruction_reflectance * tau * solid_angle / (2*pi) * 100
  // The obstruction reflects a fraction of the sky light that hits it
  const erc = fractionBlocked * obstructionReflectance * tau * (solidAngle / (2 * Math.PI)) * 100;

  return Math.max(0, erc);
}

/**
 * Calculate the Internally Reflected Component (IRC).
 *
 * IRC accounts for light that enters through windows and is reflected
 * internally by room surfaces before reaching the analysis point.
 *
 * IRC = (A_glazed * tau * rho_avg) / (A_total * (1 - rho_avg)) * 100
 *
 * where:
 *   A_glazed = total glazed area
 *   A_total = total internal surface area
 *   rho_avg = area-weighted average reflectance
 */
function computeIRC(
  totalGlazedArea: number,
  transmittance: number,
  roomWidth: number,
  roomDepth: number,
  roomHeight: number,
  reflectances: { floor: number; walls: number; ceiling: number },
): number {
  const tau = transmittance * MAINTENANCE_FACTOR;

  // Internal surface areas
  const floorArea = roomWidth * roomDepth;
  const ceilingArea = roomWidth * roomDepth;
  const wallArea = 2 * (roomWidth + roomDepth) * roomHeight;
  const totalArea = floorArea + ceilingArea + wallArea;

  // Area-weighted average reflectance
  const rhoAvg =
    (floorArea * reflectances.floor +
      ceilingArea * reflectances.ceiling +
      wallArea * reflectances.walls) /
    totalArea;

  if (rhoAvg >= 1) return 0; // prevent division by zero

  // IRC formula from BRE method
  // The factor accounts for the interreflection series: rho / (1 - rho)
  const irc =
    ((totalGlazedArea * tau * rhoAvg) / (totalArea * (1 - rhoAvg))) * 100;

  return Math.max(0, irc);
}

/**
 * Analyze a single room and compute daylight factor profile.
 */
function analyzeRoom(
  room: RoomInput,
  obstructions: ObstructionInput[],
  sky: SkyCondition,
  targetDF: number,
  leedThreshold: number,
): RoomResult {
  const roomWidth = room.width_m;
  const roomDepth = room.depth_m;
  const roomHeight = room.height_m ?? 3.0;
  const workPlaneHeight = room.work_plane_height_m ?? 0.85;

  const reflectances = {
    floor: room.surface_reflectances?.floor ?? 0.3,
    walls: room.surface_reflectances?.walls ?? 0.5,
    ceiling: room.surface_reflectances?.ceiling ?? 0.7,
  };

  // External illuminance for the sky condition
  const extIlluminance = getExternalIlluminance(sky);

  // Organize windows by wall
  const windowsByWall: Record<WallDirection, WindowInput[]> = {
    N: [],
    S: [],
    E: [],
    W: [],
  };
  for (const w of room.windows) {
    windowsByWall[w.wall].push(w);
  }

  // Organize obstructions by wall
  const obsByWall: Record<WallDirection, { angle_deg: number; reflectance: number }> = {
    N: { angle_deg: 0, reflectance: 0.2 },
    S: { angle_deg: 0, reflectance: 0.2 },
    E: { angle_deg: 0, reflectance: 0.2 },
    W: { angle_deg: 0, reflectance: 0.2 },
  };
  for (const obs of obstructions) {
    obsByWall[obs.wall] = {
      angle_deg: obs.angle_deg,
      reflectance: obs.reflectance ?? 0.2,
    };
  }

  // Total glazed area (for IRC calculation)
  let totalGlazedArea = 0;
  let avgTransmittance = 0;
  for (const w of room.windows) {
    const area = w.width_m * w.height_m;
    totalGlazedArea += area;
    avgTransmittance += area * (w.glazing_transmittance ?? 0.7);
  }
  avgTransmittance = totalGlazedArea > 0 ? avgTransmittance / totalGlazedArea : 0.7;

  // IRC is constant across the room (simplified BRE method)
  const irc = computeIRC(
    totalGlazedArea,
    avgTransmittance,
    roomWidth,
    roomDepth,
    roomHeight,
    reflectances,
  );

  // ── Build analysis grid along room depth ──
  // For rooms with windows on one wall, the primary axis is depth from that wall.
  // For rooms with windows on multiple walls, we compute contributions from each.
  // Grid points at 0.5m intervals from 0.5m to (depth - 0.5m).

  const numPoints = Math.max(2, Math.floor(roomDepth / GRID_SPACING_M));
  const spacing = roomDepth / numPoints;
  const profile: DFProfilePoint[] = [];

  for (let i = 0; i < numPoints; i++) {
    // Distance from the "primary" window wall
    // For multi-wall windows, we calculate distance from each wall
    const distFromStart = (i + 0.5) * spacing;

    let totalSC = 0;
    let totalERC = 0;

    // For each wall with windows, compute the distance from that wall
    // and the sky component contribution
    for (const wall of (["N", "S", "E", "W"] as WallDirection[])) {
      const windows = windowsByWall[wall];
      if (windows.length === 0) continue;

      const obs = obsByWall[wall];

      // Determine distance from this wall
      // Convention: "S" and "N" walls are at depth=0 and depth=roomDepth
      // "E" and "W" walls are at width=0 and width=roomWidth
      let distFromWall: number;
      if (wall === "S") {
        // South wall at depth = 0
        distFromWall = distFromStart;
      } else if (wall === "N") {
        // North wall at depth = roomDepth
        distFromWall = roomDepth - distFromStart;
      } else if (wall === "W") {
        // West wall: perpendicular distance is roomWidth/2 (center of room)
        // For simplicity, use the average distance
        distFromWall = roomWidth / 2;
      } else {
        // East wall
        distFromWall = roomWidth / 2;
      }

      for (const win of windows) {
        const transmittance = win.glazing_transmittance ?? 0.7;
        const sillHeight = win.sill_height_m ?? 0.9;

        const sc = computeSkyComponent(
          win.width_m,
          win.height_m,
          sillHeight,
          transmittance,
          roomHeight,
          workPlaneHeight,
          distFromWall,
          obs.angle_deg,
        );
        totalSC += sc;

        const erc = computeERC(
          obs.angle_deg,
          obs.reflectance,
          win.width_m,
          win.height_m,
          transmittance,
          distFromWall,
        );
        totalERC += erc;
      }
    }

    // Total daylight factor at this point
    const df = totalSC + totalERC + irc;

    // Estimated illuminance
    const illuminance = (df / 100) * extIlluminance;

    profile.push({
      distance_from_window_m: round2(distFromStart),
      daylight_factor_percent: round2(df),
      estimated_illuminance_lux: Math.round(illuminance),
    });
  }

  // ── Compute statistics ──
  const dfValues = profile.map(p => p.daylight_factor_percent);
  const avgDF = dfValues.reduce((s, v) => s + v, 0) / dfValues.length;
  const minDF = Math.min(...dfValues);
  const maxDF = Math.max(...dfValues);

  // Percentage of area above target DF
  const pointsAboveTarget = dfValues.filter(v => v >= targetDF).length;
  const areaAboveTargetPercent = (pointsAboveTarget / dfValues.length) * 100;

  // ── Estimate sDA 300/50% ──
  // Areas with DF >= 2% typically achieve 300 lux for >= 50% of occupied hours
  // Under overcast sky. For clearer skies, a lower DF threshold might suffice.
  let sdaDFThreshold: number;
  switch (sky) {
    case "overcast":
      sdaDFThreshold = 2.0;
      break;
    case "intermediate":
      sdaDFThreshold = 1.5;
      break;
    case "clear":
      sdaDFThreshold = 1.2;
      break;
  }

  // Also check against illuminance threshold directly
  const pointsAboveSDA = profile.filter(
    p => p.daylight_factor_percent >= sdaDFThreshold || p.estimated_illuminance_lux >= leedThreshold,
  ).length;
  const sdaPercent = (pointsAboveSDA / profile.length) * 100;

  // ── Status ──
  const status: "PASS" | "FAIL" = avgDF >= targetDF ? "PASS" : "FAIL";

  // ── Recommendations ──
  const recommendations: string[] = [];

  if (avgDF < targetDF) {
    recommendations.push(
      `Average daylight factor (${round2(avgDF)}%) is below target (${targetDF}%).`,
    );
  }
  if (minDF < 0.5) {
    recommendations.push(
      "Minimum DF is very low (<0.5%). Back of room may feel dark. Consider light shelves or reflective ceiling.",
    );
  }
  if (maxDF > 0 && maxDF / minDF > 10) {
    recommendations.push(
      "Large variation in daylight (>10:1 ratio). Consider deeper light shelves or translucent glazing to improve uniformity.",
    );
  }
  if (totalGlazedArea / (roomWidth * roomDepth) < 0.1) {
    recommendations.push(
      "Glazing-to-floor-area ratio is below 10%. Consider increasing window size or adding skylights.",
    );
  }
  if (totalGlazedArea / (roomWidth * roomDepth) > 0.3 && maxDF > 5) {
    recommendations.push(
      "High daylight factor near windows may cause glare. Consider external shading, blinds, or fritted glazing.",
    );
  }
  if (roomDepth > 2.5 * roomHeight && minDF < 1.0) {
    recommendations.push(
      `Room depth (${roomDepth}m) exceeds 2.5x ceiling height (${roomHeight}m). ` +
      "Daylight will not penetrate effectively to the back. Consider bilateral daylighting or toplighting.",
    );
  }

  if (recommendations.length === 0) {
    recommendations.push("Daylight levels are adequate across the room.");
  }

  return {
    name: room.name,
    average_daylight_factor_percent: round2(avgDF),
    min_daylight_factor_percent: round2(minDF),
    max_daylight_factor_percent: round2(maxDF),
    area_above_target_percent: round2(areaAboveTargetPercent),
    estimated_sda_300_50_percent: round2(sdaPercent),
    daylight_factor_profile: profile,
    status,
    recommendations,
  };
}

// ─── Main analysis function ──────────────────────────────────────────────

function runDaylightAnalysis(args: DaylightAnalysisArgs): DaylightAnalysisResult {
  const {
    rooms,
    obstructions = [],
    sky_condition = "overcast",
    target_daylight_factor = 2.0,
    leed_threshold = 300,
  } = args;

  if (rooms.length === 0) {
    throw new Error("At least one room must be provided.");
  }

  const roomResults: RoomResult[] = [];
  let totalFloorArea = 0;
  let totalAreaAboveTarget = 0;
  let totalSDAArea = 0;

  for (const room of rooms) {
    if (!room.windows || room.windows.length === 0) {
      // Room with no windows gets 0% DF
      const roomArea = room.width_m * room.depth_m;
      totalFloorArea += roomArea;
      roomResults.push({
        name: room.name,
        average_daylight_factor_percent: 0,
        min_daylight_factor_percent: 0,
        max_daylight_factor_percent: 0,
        area_above_target_percent: 0,
        estimated_sda_300_50_percent: 0,
        daylight_factor_profile: [],
        status: "FAIL",
        recommendations: ["No windows in this room. Add windows or skylights for daylight."],
      });
      continue;
    }

    const result = analyzeRoom(room, obstructions, sky_condition, target_daylight_factor, leed_threshold);
    roomResults.push(result);

    const roomArea = room.width_m * room.depth_m;
    totalFloorArea += roomArea;
    totalAreaAboveTarget += roomArea * (result.area_above_target_percent / 100);
    totalSDAArea += roomArea * (result.estimated_sda_300_50_percent / 100);
  }

  const roomsPassing = roomResults.filter(r => r.status === "PASS").length;
  const overallAreaAboveTarget =
    totalFloorArea > 0 ? (totalAreaAboveTarget / totalFloorArea) * 100 : 0;
  const overallSDA =
    totalFloorArea > 0 ? (totalSDAArea / totalFloorArea) * 100 : 0;

  // LEED assessment
  let leedPoints = 0;
  let leedLevel: "not_achieved" | "partial" | "achieved" = "not_achieved";

  if (overallSDA >= LEED_SDA_FULL) {
    leedPoints = 3;
    leedLevel = "achieved";
  } else if (overallSDA >= LEED_SDA_PARTIAL) {
    leedPoints = 2;
    leedLevel = "partial";
  }

  return {
    rooms: roomResults,
    summary: {
      total_rooms: rooms.length,
      rooms_passing: roomsPassing,
      floor_area_above_target_percent: round2(overallAreaAboveTarget),
      leed_daylight_points_possible: leedPoints,
    },
    leed_assessment: {
      sda_area_percent: round2(overallSDA),
      points: leedPoints,
      level: leedLevel,
    },
  };
}

// ─── Tool definition ──────────────────────────────────────────────────────

export function createDaylightAnalysisToolDefinition() {
  return {
    name: "daylight_analysis",
    label: "Daylight Analysis",
    description:
      "Calculate daylight factor and spatial daylight autonomy (sDA) estimates per room using " +
      "the BRE split-flux daylight factor method. Analyzes sky component, externally reflected " +
      "component, and internally reflected component. Useful for LEED v4.1 Daylight credit " +
      "assessment (EQ Credit: Daylight). Reports daylight factor profiles across room depth, " +
      "average/min/max DF, estimated sDA 300/50%, and LEED points achievable.",
    parameters: {
      type: "object",
      properties: {
        rooms: {
          type: "array",
          description: "Array of rooms to analyze for daylighting.",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Room name or identifier.",
              },
              width_m: {
                type: "number",
                description:
                  "Room width in meters (perpendicular to primary window wall). This is the wall-to-wall dimension parallel to the window.",
                exclusiveMinimum: 0,
              },
              depth_m: {
                type: "number",
                description:
                  "Room depth in meters (distance from window wall to back wall).",
                exclusiveMinimum: 0,
              },
              height_m: {
                type: "number",
                description: "Floor-to-ceiling height in meters. Default: 3.0.",
                exclusiveMinimum: 0,
                default: 3.0,
              },
              windows: {
                type: "array",
                description: "Windows on the room perimeter.",
                items: {
                  type: "object",
                  properties: {
                    wall: {
                      type: "string",
                      enum: ["N", "S", "E", "W"],
                      description: "Which wall the window is on (N/S/E/W).",
                    },
                    width_m: {
                      type: "number",
                      description: "Window width in meters.",
                      exclusiveMinimum: 0,
                    },
                    height_m: {
                      type: "number",
                      description: "Window height in meters.",
                      exclusiveMinimum: 0,
                    },
                    sill_height_m: {
                      type: "number",
                      description: "Height from floor to window sill in meters. Default: 0.9.",
                      minimum: 0,
                      default: 0.9,
                    },
                    glazing_transmittance: {
                      type: "number",
                      description:
                        "Visible light transmittance of the glazing (0-1). Default: 0.7. " +
                        "Standard clear double-pane: 0.7. Low-e: 0.5-0.65. Triple-pane: 0.5.",
                      minimum: 0,
                      maximum: 1,
                      default: 0.7,
                    },
                  },
                  required: ["wall", "width_m", "height_m"],
                },
              },
              surface_reflectances: {
                type: "object",
                description:
                  "Internal surface reflectances (0-1). White walls ~0.7, light grey ~0.5, dark ~0.2. " +
                  "Light floor ~0.4, dark floor ~0.2. White ceiling ~0.8.",
                properties: {
                  floor: {
                    type: "number",
                    description: "Floor reflectance (0-1). Default: 0.3.",
                    minimum: 0,
                    maximum: 1,
                    default: 0.3,
                  },
                  walls: {
                    type: "number",
                    description: "Wall reflectance (0-1). Default: 0.5.",
                    minimum: 0,
                    maximum: 1,
                    default: 0.5,
                  },
                  ceiling: {
                    type: "number",
                    description: "Ceiling reflectance (0-1). Default: 0.7.",
                    minimum: 0,
                    maximum: 1,
                    default: 0.7,
                  },
                },
              },
              work_plane_height_m: {
                type: "number",
                description: "Height of the work plane in meters. Default: 0.85 (standard desk height).",
                minimum: 0,
                default: 0.85,
              },
            },
            required: ["name", "width_m", "depth_m", "windows"],
          },
        },
        obstructions: {
          type: "array",
          description:
            "External obstructions (adjacent buildings, overhangs) that block sky access. " +
            "Specified as the vertical angle of obstruction from horizontal at window center.",
          items: {
            type: "object",
            properties: {
              wall: {
                type: "string",
                enum: ["N", "S", "E", "W"],
                description: "Which wall the obstruction faces.",
              },
              angle_deg: {
                type: "number",
                description:
                  "Angle of obstruction from horizontal at window center in degrees (0-90). " +
                  "0 = no obstruction. 45 = building at 45 deg above horizon. 90 = fully blocked.",
                minimum: 0,
                maximum: 90,
              },
              reflectance: {
                type: "number",
                description:
                  "Reflectance of the obstructing surface (0-1). Default: 0.2. " +
                  "Dark brick: 0.15. Light concrete: 0.4. Glass curtain wall: 0.1.",
                minimum: 0,
                maximum: 1,
                default: 0.2,
              },
            },
            required: ["wall", "angle_deg"],
          },
        },
        latitude_deg: {
          type: "number",
          description: "Site latitude in degrees (for sky luminance model). Default: 40.",
          minimum: -90,
          maximum: 90,
          default: 40,
        },
        sky_condition: {
          type: "string",
          enum: ["overcast", "clear", "intermediate"],
          description:
            "CIE sky model to use. 'overcast' = standard for DF calculations (conservative). " +
            "'clear' = sunny conditions. 'intermediate' = partly cloudy. Default: 'overcast'.",
          default: "overcast",
        },
        target_daylight_factor: {
          type: "number",
          description:
            "Target daylight factor percentage for pass/fail assessment. Default: 2.0%. " +
            "Typical targets: 2% for offices, 1.5% for circulation, 5% for drafting rooms.",
          minimum: 0,
          default: 2.0,
        },
        leed_threshold: {
          type: "number",
          description:
            "Illuminance threshold in lux for LEED daylight credit assessment. Default: 300 lux.",
          minimum: 0,
          default: 300,
        },
      },
      required: ["rooms"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }> => {
      const params = (args ?? {}) as Record<string, unknown>;

      // ── Parse rooms ──
      if (!Array.isArray(params.rooms) || params.rooms.length === 0) {
        throw new Error("'rooms' parameter is required and must be a non-empty array.");
      }

      const rooms: RoomInput[] = (params.rooms as Array<Record<string, unknown>>).map(
        (rawRoom, idx) => {
          const name = String(rawRoom.name ?? `Room ${idx + 1}`);
          const width = Number(rawRoom.width_m);
          const depth = Number(rawRoom.depth_m);
          if (!Number.isFinite(width) || width <= 0) {
            throw new Error(`Room "${name}": width_m must be a positive number.`);
          }
          if (!Number.isFinite(depth) || depth <= 0) {
            throw new Error(`Room "${name}": depth_m must be a positive number.`);
          }

          const height = rawRoom.height_m != null ? Number(rawRoom.height_m) : undefined;
          const workPlane = rawRoom.work_plane_height_m != null ? Number(rawRoom.work_plane_height_m) : undefined;

          // Parse windows
          const rawWindows = Array.isArray(rawRoom.windows) ? rawRoom.windows : [];
          const windows: WindowInput[] = (rawWindows as Array<Record<string, unknown>>).map(
            (rawWin) => {
              const wall = String(rawWin.wall ?? "S") as WallDirection;
              const validWalls: WallDirection[] = ["N", "S", "E", "W"];
              if (!validWalls.includes(wall)) {
                throw new Error(`Room "${name}": window wall must be N, S, E, or W.`);
              }
              const wWidth = Number(rawWin.width_m);
              const wHeight = Number(rawWin.height_m);
              if (!Number.isFinite(wWidth) || wWidth <= 0) {
                throw new Error(`Room "${name}": window width_m must be positive.`);
              }
              if (!Number.isFinite(wHeight) || wHeight <= 0) {
                throw new Error(`Room "${name}": window height_m must be positive.`);
              }
              return {
                wall,
                width_m: wWidth,
                height_m: wHeight,
                sill_height_m: rawWin.sill_height_m != null ? Number(rawWin.sill_height_m) : undefined,
                glazing_transmittance:
                  rawWin.glazing_transmittance != null
                    ? Number(rawWin.glazing_transmittance)
                    : undefined,
              };
            },
          );

          // Parse reflectances
          let reflectances: SurfaceReflectances | undefined;
          if (rawRoom.surface_reflectances && typeof rawRoom.surface_reflectances === "object") {
            const rawRef = rawRoom.surface_reflectances as Record<string, unknown>;
            reflectances = {
              floor: rawRef.floor != null ? Number(rawRef.floor) : undefined,
              walls: rawRef.walls != null ? Number(rawRef.walls) : undefined,
              ceiling: rawRef.ceiling != null ? Number(rawRef.ceiling) : undefined,
            };
          }

          return {
            name,
            width_m: width,
            depth_m: depth,
            height_m: height,
            windows,
            surface_reflectances: reflectances,
            work_plane_height_m: workPlane,
          };
        },
      );

      // ── Parse obstructions ──
      let obstructions: ObstructionInput[] = [];
      if (Array.isArray(params.obstructions)) {
        obstructions = (params.obstructions as Array<Record<string, unknown>>).map((rawObs) => {
          const wall = String(rawObs.wall ?? "S") as WallDirection;
          const angleDeg = Number(rawObs.angle_deg ?? 0);
          const reflectance = rawObs.reflectance != null ? Number(rawObs.reflectance) : undefined;
          return { wall, angle_deg: angleDeg, reflectance };
        });
      }

      // ── Parse optional parameters ──
      const skyCondition = (
        typeof params.sky_condition === "string"
          ? params.sky_condition
          : "overcast"
      ) as SkyCondition;
      const validSkies: SkyCondition[] = ["overcast", "clear", "intermediate"];
      if (!validSkies.includes(skyCondition)) {
        throw new Error(`Invalid sky_condition "${skyCondition}". Must be one of: ${validSkies.join(", ")}`);
      }

      const targetDF =
        params.target_daylight_factor != null
          ? Number(params.target_daylight_factor)
          : 2.0;
      const leedThreshold =
        params.leed_threshold != null
          ? Number(params.leed_threshold)
          : 300;

      // ── Run analysis ──
      const result = runDaylightAnalysis({
        rooms,
        obstructions,
        latitude_deg: params.latitude_deg != null ? Number(params.latitude_deg) : undefined,
        sky_condition: skyCondition,
        target_daylight_factor: targetDF,
        leed_threshold: leedThreshold,
      });

      // ── Format summary text ──
      const summaryLines: string[] = [
        `Daylight Analysis Results (${rooms.length} room${rooms.length > 1 ? "s" : ""})`,
        `Sky condition: ${skyCondition} | Target DF: ${targetDF}% | LEED threshold: ${leedThreshold} lux`,
        ``,
      ];

      for (const r of result.rooms) {
        summaryLines.push(`--- ${r.name} ---`);
        summaryLines.push(`  Average DF: ${r.average_daylight_factor_percent}%`);
        summaryLines.push(`  Min DF: ${r.min_daylight_factor_percent}% | Max DF: ${r.max_daylight_factor_percent}%`);
        summaryLines.push(`  Area above target: ${r.area_above_target_percent}%`);
        summaryLines.push(`  Estimated sDA 300/50%: ${r.estimated_sda_300_50_percent}%`);
        summaryLines.push(`  Status: ${r.status}`);
        if (r.recommendations.length > 0) {
          summaryLines.push(`  Recommendations:`);
          for (const rec of r.recommendations) {
            summaryLines.push(`    - ${rec}`);
          }
        }
        summaryLines.push(``);
      }

      summaryLines.push(`=== Summary ===`);
      summaryLines.push(`Rooms passing: ${result.summary.rooms_passing}/${result.summary.total_rooms}`);
      summaryLines.push(`Overall area above target: ${result.summary.floor_area_above_target_percent}%`);
      summaryLines.push(``);
      summaryLines.push(`=== LEED v4.1 Daylight Credit ===`);
      summaryLines.push(`sDA area: ${result.leed_assessment.sda_area_percent}%`);
      summaryLines.push(`Points: ${result.leed_assessment.points}/3`);
      summaryLines.push(`Level: ${result.leed_assessment.level}`);

      return {
        content: [
          { type: "text", text: summaryLines.join("\n") },
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
        details: {
          total_rooms: result.summary.total_rooms,
          rooms_passing: result.summary.rooms_passing,
          floor_area_above_target_percent: result.summary.floor_area_above_target_percent,
          leed_points: result.leed_assessment.points,
          leed_level: result.leed_assessment.level,
        },
      };
    },
  };
}
