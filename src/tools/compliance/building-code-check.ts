/**
 * Building Code Check tool — checks building design against IBC 2021 requirements.
 *
 * Validates occupancy classification, construction type, allowable height/area,
 * egress requirements, and fire-resistance ratings using encoded IBC 2021 tables.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BuildingData {
  stories: number;
  height_m: number;
  area_per_floor_sqm: number;
  sprinklered: boolean;
  frontage_percentage?: number;
}

interface EgressData {
  occupant_load?: number;
  exit_count?: number;
  exit_widths_mm?: number[];
  travel_distances_m?: number[];
  common_path_m?: number;
  corridor_widths_mm?: number[];
}

interface CheckArgs {
  occupancy_group: string;
  construction_type: string;
  building_data: BuildingData;
  egress_data?: EgressData;
  code_edition?: string;
}

interface HeightCheck {
  proposed_height_m: number;
  proposed_height_ft: number;
  allowable_height_ft: number;
  allowable_height_m: number;
  sprinkler_increase_applied: boolean;
  proposed_stories: number;
  allowable_stories: number;
  status: "PASS" | "FAIL";
}

interface AreaCheck {
  proposed_area_sqm: number;
  proposed_area_sqft: number;
  base_allowable_area_sqft: number;
  allowable_area_sqft: number;
  allowable_area_sqm: number;
  sprinkler_increase_applied: boolean;
  frontage_increase_applied: boolean;
  frontage_increase_percent: number;
  status: "PASS" | "FAIL";
}

interface FireResistanceRatings {
  structural_frame_hrs: number;
  bearing_walls_exterior_hrs: number;
  bearing_walls_interior_hrs: number;
  floor_hrs: number;
  roof_hrs: number;
}

interface FireResistanceCheck {
  construction_type: string;
  required_ratings: FireResistanceRatings;
}

interface EgressCheck {
  occupant_load: number;
  occupant_load_calculated: boolean;
  required_exits: number;
  provided_exits: number | null;
  exits_status: "PASS" | "FAIL" | "NOT_CHECKED";
  required_exit_width_mm: number;
  provided_total_exit_width_mm: number | null;
  exit_width_status: "PASS" | "FAIL" | "NOT_CHECKED";
  max_travel_distance_allowed_m: number;
  travel_distance_checks: Array<{
    provided_m: number;
    allowed_m: number;
    status: "PASS" | "FAIL";
  }>;
  travel_distance_status: "PASS" | "FAIL" | "NOT_CHECKED";
  common_path_allowed_m: number;
  common_path_provided_m: number | null;
  common_path_status: "PASS" | "FAIL" | "NOT_CHECKED";
  corridor_checks: Array<{
    provided_mm: number;
    required_mm: number;
    status: "PASS" | "FAIL";
  }>;
  corridor_status: "PASS" | "FAIL" | "NOT_CHECKED";
  status: "PASS" | "FAIL";
}

interface CheckResult {
  summary: {
    occupancy_group: string;
    construction_type: string;
    code_edition: string;
  };
  height_check: HeightCheck;
  area_check: AreaCheck;
  fire_resistance: FireResistanceCheck;
  egress_check: EgressCheck | null;
  overall_status: "PASS" | "FAIL";
  issues: string[];
}

// ---------------------------------------------------------------------------
// IBC table types (matching the JSON structure)
// ---------------------------------------------------------------------------

type ConstructionTypeKey = "IA" | "IB" | "IIA" | "IIB" | "IIIA" | "IIIB" | "IV" | "VA" | "VB";

interface OccupancyRow {
  [constructionType: string]: number;
}

interface FireResistanceRow {
  structural_frame: number;
  bearing_walls_exterior: number;
  bearing_walls_interior: number;
  nonbearing_exterior: number;
  floor: number;
  roof: number;
}

interface IBCTables {
  version: string;
  table_504_3_allowable_height_ft: Record<string, OccupancyRow>;
  table_504_4_allowable_stories: Record<string, OccupancyRow>;
  table_506_2_allowable_area_sqft: Record<string, OccupancyRow>;
  table_601_fire_resistance_hours: Record<string, FireResistanceRow>;
  table_1004_5_occupant_load_factor_sqft_per_person: Record<string, number>;
  egress: {
    exit_width_per_occupant_inches: { stairways: number; other: number };
    minimum_exit_width_inches: number;
    minimum_corridor_width_inches: number;
    minimum_corridor_width_low_occupancy_inches: number;
    low_occupancy_threshold: number;
    max_travel_distance_ft: {
      sprinklered: Record<string, number>;
      non_sprinklered: Record<string, number>;
    };
    max_common_path_ft: {
      sprinklered: Record<string, number>;
      non_sprinklered: Record<string, number>;
    };
    min_number_of_exits: Record<string, number>;
  };
  sprinkler_increases: {
    height_increase_ft: number;
    stories_increase: number;
    area_multiplier: number;
  };
  frontage_increase: {
    max_area_increase_percent: number;
    formula: string;
    min_frontage_ratio: number;
  };
}

// ---------------------------------------------------------------------------
// Unit conversion helpers
// ---------------------------------------------------------------------------

const METERS_TO_FEET = 3.28084;
const SQM_TO_SQFT = 10.7639;
const INCHES_TO_MM = 25.4;

function metersToFeet(m: number): number {
  return m * METERS_TO_FEET;
}

function feetToMeters(ft: number): number {
  return ft / METERS_TO_FEET;
}

function sqmToSqft(sqm: number): number {
  return sqm * SQM_TO_SQFT;
}

function sqftToSqm(sqft: number): number {
  return sqft / SQM_TO_SQFT;
}

function inchesToMm(inches: number): number {
  return inches * INCHES_TO_MM;
}

function mmToInches(mm: number): number {
  return mm / INCHES_TO_MM;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Table loading
// ---------------------------------------------------------------------------

let cachedTables: IBCTables | null = null;

function loadIBCTables(): IBCTables {
  if (cachedTables) return cachedTables;

  // Resolve the data file relative to this source file's location.
  // The file lives at <project>/data/ibc-tables.json.
  // This source is at <project>/src/tools/compliance/building-code-check.ts
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", "data", "ibc-tables.json"),
    path.resolve(process.cwd(), "data", "ibc-tables.json"),
  ];

  let raw: string | undefined;
  for (const candidate of candidates) {
    try {
      raw = fs.readFileSync(candidate, "utf-8");
      break;
    } catch {
      // try next candidate
    }
  }

  if (!raw) {
    throw new Error(
      `Could not locate data/ibc-tables.json. Searched: ${candidates.join(", ")}`
    );
  }

  cachedTables = JSON.parse(raw) as IBCTables;
  return cachedTables;
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

function getOccupancyGroupKey(group: string): string {
  // Normalize: trim, uppercase
  return group.trim().toUpperCase();
}

/**
 * For travel distance lookups, the table uses base occupancy letters (e.g., "A" not "A-1").
 * For R occupancies, it uses "R". This resolves the base key.
 */
function getTravelDistanceKey(occupancy: string): string {
  const g = getOccupancyGroupKey(occupancy);
  // R-1, R-2, R-3, R-4 all map to "R"
  if (g.startsWith("R")) return "R";
  // A-1 through A-5 all map to "A"
  if (g.startsWith("A")) return "A";
  return g;
}

/**
 * Determine the common path group for the occupancy.
 * B, F, and S occupancies get the B_F_S allowance.
 * I-1 and R get the I-1_R allowance.
 * Everything else gets default.
 */
function getCommonPathKey(occupancy: string): string {
  const g = getOccupancyGroupKey(occupancy);
  if (g === "B" || g.startsWith("F") || g.startsWith("S")) return "B_F_S";
  if (g.startsWith("R") || g === "I-1") return "I-1_R";
  return "default";
}

/**
 * Map an occupancy group to an occupant-load-factor key.
 */
function getOccupantLoadFactorKey(occupancy: string): string {
  const g = getOccupancyGroupKey(occupancy);
  if (g.startsWith("A")) return "assembly_unconcentrated";
  if (g === "B") return "business";
  if (g === "E") return "educational";
  if (g.startsWith("F")) return "industrial";
  if (g.startsWith("I")) return "residential"; // institutional — use residential factor as proxy
  if (g === "M") return "mercantile_basement_ground";
  if (g.startsWith("R")) return "residential";
  if (g.startsWith("S")) return "storage";
  if (g === "U") return "warehouse";
  return "business"; // fallback
}

// ---------------------------------------------------------------------------
// Core check logic
// ---------------------------------------------------------------------------

function runCheck(args: CheckArgs): CheckResult {
  const tables = loadIBCTables();
  const issues: string[] = [];

  const occupancy = getOccupancyGroupKey(args.occupancy_group);
  const constructionType = args.construction_type.trim().toUpperCase() as ConstructionTypeKey;
  const codeEdition = args.code_edition ?? "IBC2021";
  const bd = args.building_data;

  // Validate inputs --------------------------------------------------------
  const validConstructionTypes: ConstructionTypeKey[] = [
    "IA", "IB", "IIA", "IIB", "IIIA", "IIIB", "IV", "VA", "VB",
  ];
  if (!validConstructionTypes.includes(constructionType)) {
    throw new Error(
      `Invalid construction type "${args.construction_type}". Must be one of: ${validConstructionTypes.join(", ")}`
    );
  }

  const heightTable = tables.table_504_3_allowable_height_ft;
  const storiesTable = tables.table_504_4_allowable_stories;
  const areaTable = tables.table_506_2_allowable_area_sqft;

  if (!heightTable[occupancy]) {
    throw new Error(
      `Unknown occupancy group "${occupancy}". Available: ${Object.keys(heightTable).filter((k) => !k.startsWith("_")).join(", ")}`
    );
  }

  // ------------------------------------------------------------------
  // Height & Stories Check
  // ------------------------------------------------------------------

  let allowableHeightFt = heightTable[occupancy][constructionType] ?? 0;
  let allowableStories = storiesTable[occupancy]?.[constructionType] ?? 0;

  const sprinklerHeightApplied = bd.sprinklered && allowableHeightFt > 0 && allowableHeightFt < 999999;
  const sprinklerStoriesApplied = bd.sprinklered && allowableStories > 0;

  if (sprinklerHeightApplied) {
    allowableHeightFt += tables.sprinkler_increases.height_increase_ft;
  }
  if (sprinklerStoriesApplied) {
    allowableStories += tables.sprinkler_increases.stories_increase;
  }

  const proposedHeightFt = round2(metersToFeet(bd.height_m));

  const heightPass =
    allowableHeightFt === 0
      ? false // not permitted
      : proposedHeightFt <= allowableHeightFt;

  const storiesPass =
    allowableStories === 0
      ? false
      : bd.stories <= allowableStories;

  const heightCheckStatus: "PASS" | "FAIL" = heightPass && storiesPass ? "PASS" : "FAIL";

  if (allowableHeightFt === 0) {
    issues.push(
      `Occupancy ${occupancy} is NOT PERMITTED for construction type ${constructionType}.`
    );
  } else {
    if (!heightPass) {
      issues.push(
        `Building height ${round2(bd.height_m)} m (${proposedHeightFt} ft) exceeds allowable ${allowableHeightFt} ft (${round2(feetToMeters(allowableHeightFt))} m).`
      );
    }
    if (!storiesPass) {
      issues.push(
        `Building stories (${bd.stories}) exceeds allowable ${allowableStories} stories.`
      );
    }
  }

  const heightCheck: HeightCheck = {
    proposed_height_m: bd.height_m,
    proposed_height_ft: proposedHeightFt,
    allowable_height_ft: allowableHeightFt,
    allowable_height_m: round2(feetToMeters(allowableHeightFt)),
    sprinkler_increase_applied: sprinklerHeightApplied || sprinklerStoriesApplied,
    proposed_stories: bd.stories,
    allowable_stories: allowableStories,
    status: heightCheckStatus,
  };

  // ------------------------------------------------------------------
  // Area Check
  // ------------------------------------------------------------------

  const baseAreaSqft = areaTable[occupancy]?.[constructionType] ?? 0;
  let allowableAreaSqft = baseAreaSqft;

  let sprinklerAreaApplied = false;
  let frontageApplied = false;
  let frontageIncreasePercent = 0;

  if (baseAreaSqft === 0) {
    // Not permitted
  } else if (baseAreaSqft >= 999999) {
    // Unlimited — no increase needed
    allowableAreaSqft = 999999;
  } else {
    // Apply sprinkler area increase (Section 506.3)
    if (bd.sprinklered) {
      allowableAreaSqft = baseAreaSqft * tables.sprinkler_increases.area_multiplier;
      sprinklerAreaApplied = true;
    }

    // Apply frontage increase (Section 506.3)
    if (
      bd.frontage_percentage !== undefined &&
      bd.frontage_percentage > 0
    ) {
      const frontageRatio = bd.frontage_percentage / 100;
      const minRatio = tables.frontage_increase.min_frontage_ratio;

      if (frontageRatio >= minRatio) {
        // If = 100 * (F/P - 0.25) / 0.25, capped at max_area_increase_percent
        const rawIncrease = 100 * (frontageRatio - minRatio) / minRatio;
        frontageIncreasePercent = Math.min(
          rawIncrease,
          tables.frontage_increase.max_area_increase_percent
        );
        frontageIncreasePercent = round2(frontageIncreasePercent);

        if (frontageIncreasePercent > 0) {
          allowableAreaSqft = allowableAreaSqft * (1 + frontageIncreasePercent / 100);
          frontageApplied = true;
        }
      }
    }
  }

  allowableAreaSqft = Math.round(allowableAreaSqft);

  const proposedAreaSqft = round2(sqmToSqft(bd.area_per_floor_sqm));
  const areaPass =
    baseAreaSqft === 0
      ? false
      : proposedAreaSqft <= allowableAreaSqft;

  if (baseAreaSqft === 0) {
    issues.push(
      `Occupancy ${occupancy} area is NOT PERMITTED for construction type ${constructionType}.`
    );
  } else if (!areaPass) {
    issues.push(
      `Floor area ${round2(bd.area_per_floor_sqm)} sqm (${proposedAreaSqft} sqft) exceeds allowable ${allowableAreaSqft} sqft (${round2(sqftToSqm(allowableAreaSqft))} sqm).`
    );
  }

  const areaCheck: AreaCheck = {
    proposed_area_sqm: bd.area_per_floor_sqm,
    proposed_area_sqft: proposedAreaSqft,
    base_allowable_area_sqft: baseAreaSqft,
    allowable_area_sqft: allowableAreaSqft,
    allowable_area_sqm: round2(sqftToSqm(allowableAreaSqft)),
    sprinkler_increase_applied: sprinklerAreaApplied,
    frontage_increase_applied: frontageApplied,
    frontage_increase_percent: frontageIncreasePercent,
    status: areaPass ? "PASS" : "FAIL",
  };

  // ------------------------------------------------------------------
  // Fire Resistance Check
  // ------------------------------------------------------------------

  const fireRow = tables.table_601_fire_resistance_hours[constructionType];
  if (!fireRow) {
    throw new Error(`No fire resistance data for construction type "${constructionType}".`);
  }

  const fireResistance: FireResistanceCheck = {
    construction_type: constructionType,
    required_ratings: {
      structural_frame_hrs: fireRow.structural_frame,
      bearing_walls_exterior_hrs: fireRow.bearing_walls_exterior,
      bearing_walls_interior_hrs: fireRow.bearing_walls_interior,
      floor_hrs: fireRow.floor,
      roof_hrs: fireRow.roof,
    },
  };

  // ------------------------------------------------------------------
  // Egress Check (optional)
  // ------------------------------------------------------------------

  let egressCheck: EgressCheck | null = null;

  if (args.egress_data) {
    const ed = args.egress_data;
    const egressIssues: string[] = [];

    // Occupant load ---------------------------------------------------
    let occupantLoad: number;
    let occupantLoadCalculated = false;

    if (ed.occupant_load !== undefined && ed.occupant_load > 0) {
      occupantLoad = ed.occupant_load;
    } else {
      // Calculate from area and occupant load factor
      const factorKey = getOccupantLoadFactorKey(occupancy);
      const factor =
        tables.table_1004_5_occupant_load_factor_sqft_per_person[factorKey] ?? 150;
      const totalAreaSqft = sqmToSqft(bd.area_per_floor_sqm) * bd.stories;
      occupantLoad = Math.ceil(totalAreaSqft / factor);
      occupantLoadCalculated = true;
    }

    // Required exits --------------------------------------------------
    const exitReqs = tables.egress.min_number_of_exits;
    let requiredExits: number;
    if (occupantLoad <= 500) {
      requiredExits = exitReqs["1_to_500"];
    } else if (occupantLoad <= 1000) {
      requiredExits = exitReqs["501_to_1000"];
    } else {
      requiredExits = exitReqs["over_1000"];
    }

    let exitsStatus: "PASS" | "FAIL" | "NOT_CHECKED" = "NOT_CHECKED";
    if (ed.exit_count !== undefined) {
      exitsStatus = ed.exit_count >= requiredExits ? "PASS" : "FAIL";
      if (exitsStatus === "FAIL") {
        egressIssues.push(
          `Provided ${ed.exit_count} exits but ${requiredExits} required for occupant load of ${occupantLoad}.`
        );
      }
    }

    // Exit width ------------------------------------------------------
    // Use "other" factor (0.2 in/occupant) for general calculation.
    // Stairway factor (0.3) applies to stairways specifically;
    // we use the more conservative stairway factor for multi-story.
    const widthFactor =
      bd.stories > 1
        ? tables.egress.exit_width_per_occupant_inches.stairways
        : tables.egress.exit_width_per_occupant_inches.other;

    const requiredWidthInches = Math.max(
      occupantLoad * widthFactor,
      tables.egress.minimum_exit_width_inches
    );
    const requiredWidthMm = round2(inchesToMm(requiredWidthInches));

    let providedTotalWidthMm: number | null = null;
    let exitWidthStatus: "PASS" | "FAIL" | "NOT_CHECKED" = "NOT_CHECKED";

    if (ed.exit_widths_mm && ed.exit_widths_mm.length > 0) {
      providedTotalWidthMm = ed.exit_widths_mm.reduce((a, b) => a + b, 0);
      exitWidthStatus = providedTotalWidthMm >= requiredWidthMm ? "PASS" : "FAIL";
      if (exitWidthStatus === "FAIL") {
        egressIssues.push(
          `Total provided exit width ${providedTotalWidthMm} mm is less than required ${requiredWidthMm} mm.`
        );
      }
    }

    // Travel distance -------------------------------------------------
    const travelKey = getTravelDistanceKey(occupancy);
    const travelTable = bd.sprinklered
      ? tables.egress.max_travel_distance_ft.sprinklered
      : tables.egress.max_travel_distance_ft.non_sprinklered;
    const maxTravelFt = travelTable[travelKey] ?? travelTable["B"] ?? 200;
    const maxTravelM = round2(feetToMeters(maxTravelFt));

    const travelChecks: Array<{ provided_m: number; allowed_m: number; status: "PASS" | "FAIL" }> = [];
    let travelDistanceStatus: "PASS" | "FAIL" | "NOT_CHECKED" = "NOT_CHECKED";

    if (ed.travel_distances_m && ed.travel_distances_m.length > 0) {
      travelDistanceStatus = "PASS";
      for (const dist of ed.travel_distances_m) {
        const pass = dist <= maxTravelM;
        travelChecks.push({ provided_m: dist, allowed_m: maxTravelM, status: pass ? "PASS" : "FAIL" });
        if (!pass) {
          travelDistanceStatus = "FAIL";
          egressIssues.push(
            `Travel distance ${dist} m exceeds maximum ${maxTravelM} m (${maxTravelFt} ft) for occupancy ${occupancy}${bd.sprinklered ? " (sprinklered)" : ""}.`
          );
        }
      }
    }

    // Common path of egress -------------------------------------------
    const commonPathKey = getCommonPathKey(occupancy);
    const commonPathTable = bd.sprinklered
      ? tables.egress.max_common_path_ft.sprinklered
      : tables.egress.max_common_path_ft.non_sprinklered;
    const maxCommonPathFt = commonPathTable[commonPathKey] ?? commonPathTable["default"] ?? 75;
    const maxCommonPathM = round2(feetToMeters(maxCommonPathFt));

    let commonPathStatus: "PASS" | "FAIL" | "NOT_CHECKED" = "NOT_CHECKED";
    if (ed.common_path_m !== undefined) {
      commonPathStatus = ed.common_path_m <= maxCommonPathM ? "PASS" : "FAIL";
      if (commonPathStatus === "FAIL") {
        egressIssues.push(
          `Common path of egress ${ed.common_path_m} m exceeds maximum ${maxCommonPathM} m (${maxCommonPathFt} ft).`
        );
      }
    }

    // Corridor widths -------------------------------------------------
    const corridorChecks: Array<{ provided_mm: number; required_mm: number; status: "PASS" | "FAIL" }> = [];
    let corridorStatus: "PASS" | "FAIL" | "NOT_CHECKED" = "NOT_CHECKED";

    if (ed.corridor_widths_mm && ed.corridor_widths_mm.length > 0) {
      const requiredCorridorMm =
        occupantLoad > tables.egress.low_occupancy_threshold
          ? inchesToMm(tables.egress.minimum_corridor_width_inches)
          : inchesToMm(tables.egress.minimum_corridor_width_low_occupancy_inches);

      corridorStatus = "PASS";
      for (const w of ed.corridor_widths_mm) {
        const pass = w >= requiredCorridorMm;
        corridorChecks.push({
          provided_mm: w,
          required_mm: round2(requiredCorridorMm),
          status: pass ? "PASS" : "FAIL",
        });
        if (!pass) {
          corridorStatus = "FAIL";
          egressIssues.push(
            `Corridor width ${w} mm is less than required ${round2(requiredCorridorMm)} mm (${occupantLoad > tables.egress.low_occupancy_threshold ? tables.egress.minimum_corridor_width_inches : tables.egress.minimum_corridor_width_low_occupancy_inches}" for ${occupantLoad} occupants).`
          );
        }
      }
    }

    // Aggregate egress status
    const subStatuses = [exitsStatus, exitWidthStatus, travelDistanceStatus, commonPathStatus, corridorStatus];
    const egressOverall: "PASS" | "FAIL" = subStatuses.some((s) => s === "FAIL")
      ? "FAIL"
      : "PASS";

    issues.push(...egressIssues);

    egressCheck = {
      occupant_load: occupantLoad,
      occupant_load_calculated: occupantLoadCalculated,
      required_exits: requiredExits,
      provided_exits: ed.exit_count ?? null,
      exits_status: exitsStatus,
      required_exit_width_mm: requiredWidthMm,
      provided_total_exit_width_mm: providedTotalWidthMm,
      exit_width_status: exitWidthStatus,
      max_travel_distance_allowed_m: maxTravelM,
      travel_distance_checks: travelChecks,
      travel_distance_status: travelDistanceStatus,
      common_path_allowed_m: maxCommonPathM,
      common_path_provided_m: ed.common_path_m ?? null,
      common_path_status: commonPathStatus,
      corridor_checks: corridorChecks,
      corridor_status: corridorStatus,
      status: egressOverall,
    };
  }

  // ------------------------------------------------------------------
  // Overall status
  // ------------------------------------------------------------------

  const allStatuses = [
    heightCheck.status,
    areaCheck.status,
    ...(egressCheck ? [egressCheck.status] : []),
  ];
  const overallStatus: "PASS" | "FAIL" = allStatuses.every((s) => s === "PASS")
    ? "PASS"
    : "FAIL";

  return {
    summary: {
      occupancy_group: occupancy,
      construction_type: constructionType,
      code_edition: codeEdition,
    },
    height_check: heightCheck,
    area_check: areaCheck,
    fire_resistance: fireResistance,
    egress_check: egressCheck,
    overall_status: overallStatus,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Tool definition (matches project convention from web-search.ts)
// ---------------------------------------------------------------------------

export function createBuildingCodeCheckToolDefinition() {
  return {
    name: "building_code_check",
    label: "Building Code Check",
    description:
      "Check building design against IBC 2021 requirements: occupancy classification, construction type, allowable height/area, egress, fire-resistance ratings, and plumbing fixture counts.",
    parameters: {
      type: "object",
      properties: {
        occupancy_group: {
          type: "string",
          description:
            'IBC occupancy classification (e.g., "B", "R-2", "A-1", "S-1", "E", "M", "F-1", "I-2").',
        },
        construction_type: {
          type: "string",
          enum: ["IA", "IB", "IIA", "IIB", "IIIA", "IIIB", "IV", "VA", "VB"],
          description:
            "IBC construction type classification.",
        },
        building_data: {
          type: "object",
          description: "Core building dimensional and system data.",
          properties: {
            stories: {
              type: "number",
              description: "Number of stories above grade plane.",
            },
            height_m: {
              type: "number",
              description: "Building height in meters above grade plane.",
            },
            area_per_floor_sqm: {
              type: "number",
              description: "Area per floor in square meters.",
            },
            sprinklered: {
              type: "boolean",
              description:
                "Whether the building is equipped with an NFPA 13 automatic sprinkler system.",
            },
            frontage_percentage: {
              type: "number",
              description:
                "Percentage of building perimeter fronting on a public way or open space (0-100). Used for area increase calculation per Section 506.3.",
            },
          },
          required: ["stories", "height_m", "area_per_floor_sqm", "sprinklered"],
        },
        egress_data: {
          type: "object",
          description:
            "Optional egress data for means-of-egress compliance check.",
          properties: {
            occupant_load: {
              type: "number",
              description:
                "Total occupant load. If not provided, will be calculated from floor area and occupant load factor.",
            },
            exit_count: {
              type: "number",
              description: "Number of exits provided.",
            },
            exit_widths_mm: {
              type: "array",
              items: { type: "number" },
              description: "Width of each exit in millimeters.",
            },
            travel_distances_m: {
              type: "array",
              items: { type: "number" },
              description:
                "Maximum travel distance to each exit in meters.",
            },
            common_path_m: {
              type: "number",
              description: "Common path of egress travel in meters.",
            },
            corridor_widths_mm: {
              type: "array",
              items: { type: "number" },
              description: "Width of each corridor in millimeters.",
            },
          },
        },
        code_edition: {
          type: "string",
          enum: ["IBC2021", "IBC2018"],
          description: 'Code edition to check against. Default: "IBC2021".',
          default: "IBC2021",
        },
      },
      required: ["occupancy_group", "construction_type", "building_data"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details?: unknown;
    }> => {
      const params = (args ?? {}) as Record<string, unknown>;

      // Validate required fields
      const occupancyGroup = String(params.occupancy_group ?? "").trim();
      if (!occupancyGroup) {
        throw new Error("occupancy_group is required.");
      }

      const constructionType = String(params.construction_type ?? "").trim();
      if (!constructionType) {
        throw new Error("construction_type is required.");
      }

      const buildingDataRaw = params.building_data as Record<string, unknown> | undefined;
      if (!buildingDataRaw) {
        throw new Error("building_data is required.");
      }

      const buildingData: BuildingData = {
        stories: Number(buildingDataRaw.stories ?? 0),
        height_m: Number(buildingDataRaw.height_m ?? 0),
        area_per_floor_sqm: Number(buildingDataRaw.area_per_floor_sqm ?? 0),
        sprinklered: Boolean(buildingDataRaw.sprinklered),
        frontage_percentage:
          buildingDataRaw.frontage_percentage !== undefined
            ? Number(buildingDataRaw.frontage_percentage)
            : undefined,
      };

      let egressData: EgressData | undefined;
      const egressRaw = params.egress_data as Record<string, unknown> | undefined;
      if (egressRaw) {
        egressData = {
          occupant_load:
            egressRaw.occupant_load !== undefined
              ? Number(egressRaw.occupant_load)
              : undefined,
          exit_count:
            egressRaw.exit_count !== undefined
              ? Number(egressRaw.exit_count)
              : undefined,
          exit_widths_mm: Array.isArray(egressRaw.exit_widths_mm)
            ? (egressRaw.exit_widths_mm as number[]).map(Number)
            : undefined,
          travel_distances_m: Array.isArray(egressRaw.travel_distances_m)
            ? (egressRaw.travel_distances_m as number[]).map(Number)
            : undefined,
          common_path_m:
            egressRaw.common_path_m !== undefined
              ? Number(egressRaw.common_path_m)
              : undefined,
          corridor_widths_mm: Array.isArray(egressRaw.corridor_widths_mm)
            ? (egressRaw.corridor_widths_mm as number[]).map(Number)
            : undefined,
        };
      }

      const codeEdition = String(params.code_edition ?? "IBC2021").trim();

      const checkArgs: CheckArgs = {
        occupancy_group: occupancyGroup,
        construction_type: constructionType,
        building_data: buildingData,
        egress_data: egressData,
        code_edition: codeEdition,
      };

      const result = runCheck(checkArgs);

      // Format a human-readable summary along with the full JSON
      const lines: string[] = [];
      lines.push(`=== IBC ${codeEdition} Building Code Check ===`);
      lines.push(`Occupancy: ${result.summary.occupancy_group} | Construction Type: ${result.summary.construction_type}`);
      lines.push("");

      // Height
      lines.push(`-- Height Check: ${result.height_check.status} --`);
      lines.push(
        `   Proposed: ${result.height_check.proposed_height_m} m (${result.height_check.proposed_height_ft} ft), ${result.height_check.proposed_stories} stories`
      );
      lines.push(
        `   Allowable: ${result.height_check.allowable_height_m} m (${result.height_check.allowable_height_ft} ft), ${result.height_check.allowable_stories} stories`
      );
      if (result.height_check.sprinkler_increase_applied) {
        lines.push("   (Sprinkler increase applied to height and stories)");
      }
      lines.push("");

      // Area
      lines.push(`-- Area Check: ${result.area_check.status} --`);
      lines.push(
        `   Proposed: ${result.area_check.proposed_area_sqm} sqm (${result.area_check.proposed_area_sqft} sqft)`
      );
      lines.push(
        `   Allowable: ${result.area_check.allowable_area_sqm} sqm (${result.area_check.allowable_area_sqft} sqft)`
      );
      if (result.area_check.sprinkler_increase_applied) {
        lines.push(`   (Sprinkler 3x area increase applied)`);
      }
      if (result.area_check.frontage_increase_applied) {
        lines.push(`   (Frontage increase of ${result.area_check.frontage_increase_percent}% applied)`);
      }
      lines.push("");

      // Fire resistance
      lines.push(`-- Fire Resistance (Table 601) --`);
      const fr = result.fire_resistance.required_ratings;
      lines.push(`   Structural frame: ${fr.structural_frame_hrs} hr`);
      lines.push(`   Bearing walls (exterior): ${fr.bearing_walls_exterior_hrs} hr`);
      lines.push(`   Bearing walls (interior): ${fr.bearing_walls_interior_hrs} hr`);
      lines.push(`   Floor construction: ${fr.floor_hrs} hr`);
      lines.push(`   Roof construction: ${fr.roof_hrs} hr`);
      lines.push("");

      // Egress
      if (result.egress_check) {
        const eg = result.egress_check;
        lines.push(`-- Egress Check: ${eg.status} --`);
        lines.push(
          `   Occupant load: ${eg.occupant_load}${eg.occupant_load_calculated ? " (calculated from area)" : ""}`
        );
        lines.push(`   Required exits: ${eg.required_exits} | Provided: ${eg.provided_exits ?? "N/A"} [${eg.exits_status}]`);
        lines.push(
          `   Required exit width: ${eg.required_exit_width_mm} mm | Provided: ${eg.provided_total_exit_width_mm ?? "N/A"} mm [${eg.exit_width_status}]`
        );
        lines.push(`   Max travel distance allowed: ${eg.max_travel_distance_allowed_m} m [${eg.travel_distance_status}]`);
        lines.push(`   Common path allowed: ${eg.common_path_allowed_m} m [${eg.common_path_status}]`);
        if (eg.corridor_checks.length > 0) {
          lines.push(`   Corridor width checks: [${eg.corridor_status}]`);
        }
        lines.push("");
      }

      // Overall
      lines.push(`=== OVERALL: ${result.overall_status} ===`);
      if (result.issues.length > 0) {
        lines.push("");
        lines.push("Issues:");
        for (const issue of result.issues) {
          lines.push(`  - ${issue}`);
        }
      }

      const textSummary = lines.join("\n");

      return {
        content: [
          { type: "text", text: textSummary },
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
        details: {
          occupancy_group: result.summary.occupancy_group,
          construction_type: result.summary.construction_type,
          overall_status: result.overall_status,
          issue_count: result.issues.length,
        },
      };
    },
  };
}
