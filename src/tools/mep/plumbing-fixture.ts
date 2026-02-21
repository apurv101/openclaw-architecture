/**
 * Plumbing Fixture Calculation tool for civilclaw.
 *
 * Calculates plumbing fixture requirements, pipe sizing, and water supply
 * demand per IPC (International Plumbing Code). Includes minimum fixture
 * counts, water supply fixture unit (WSFU) sizing via Hunter's Method,
 * drainage fixture unit (DFU) sizing, and water heater sizing.
 *
 * Pure TypeScript -- no external dependencies.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

type PlumbingBuildingType =
  | "residential"
  | "commercial_office"
  | "commercial_retail"
  | "restaurant"
  | "assembly"
  | "educational"
  | "healthcare"
  | "industrial";

type FixtureType =
  | "water_closet"
  | "urinal"
  | "lavatory"
  | "drinking_fountain"
  | "service_sink"
  | "shower"
  | "bathtub"
  | "kitchen_sink"
  | "dishwasher"
  | "clothes_washer";

type FlushType = "tank" | "valve" | "flushometer";

interface FixtureInput {
  type: FixtureType;
  count: number;
  flush_type?: FlushType;
  flow_rate_gpm?: number;
}

interface PlumbingFixtureArgs {
  building_type: PlumbingBuildingType;
  occupant_count: number;
  male_percent?: number;
  floors?: number;
  fixtures?: FixtureInput[];
  water_heater_sizing?: boolean;
  hot_water_temperature_c?: number;
}

// ── Result types ──────────────────────────────────────────────────────────────

interface FixtureCounts {
  water_closets: { male: number; female: number; total: number };
  urinals: number;
  lavatories: number;
  drinking_fountains: number;
  service_sinks: number;
  other: string[];
}

interface WaterSupply {
  total_wsfu: number;
  peak_demand_gpm: number;
  main_pipe_size_inches: number;
}

interface Drainage {
  total_dfu: number;
  building_drain_size_inches: number;
}

interface WaterHeater {
  daily_demand_gallons: number;
  storage_capacity_gallons: number;
  recovery_rate_gph: number;
  input_btu_hr: number;
}

interface PlumbingFixtureResult {
  building_type: PlumbingBuildingType;
  occupant_count: number;
  required_fixtures: FixtureCounts;
  provided_fixtures?: FixtureCounts;
  fixture_compliance_status: "COMPLIANT" | "NON_COMPLIANT" | "OVERRIDE";
  water_supply: WaterSupply;
  drainage: Drainage;
  water_heater?: WaterHeater;
  notes: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

// IPC Table 403.1 - Minimum fixture counts (simplified)
// Format: { wc_male_ratio, wc_female_ratio, urinal_male_ratio, lav_ratio, df_ratio, service_sink_per_floor }
// Ratio = 1 per N occupants
interface FixtureRatios {
  wc_male: number;      // 1 WC per this many male occupants
  wc_female: number;    // 1 WC per this many female occupants
  urinal_male: number;  // 1 urinal per this many male occupants (0 = none)
  lav: number;          // 1 lav per this many total occupants
  df: number;           // 1 drinking fountain per this many occupants (0 = none)
  service_sink: number; // 1 service sink per this many floors
}

const FIXTURE_RATIOS: Record<PlumbingBuildingType, FixtureRatios> = {
  residential:        { wc_male: 1,  wc_female: 1,  urinal_male: 0,   lav: 1,   df: 0,   service_sink: 0 },
  commercial_office:  { wc_male: 50, wc_female: 25, urinal_male: 50,  lav: 40,  df: 100, service_sink: 1 },
  commercial_retail:  { wc_male: 500, wc_female: 500, urinal_male: 0, lav: 750, df: 1000, service_sink: 1 },
  restaurant:         { wc_male: 75, wc_female: 40, urinal_male: 75,  lav: 200, df: 500, service_sink: 1 },
  assembly:           { wc_male: 75, wc_female: 40, urinal_male: 200, lav: 200, df: 500, service_sink: 1 },
  educational:        { wc_male: 50, wc_female: 50, urinal_male: 50,  lav: 50,  df: 100, service_sink: 1 },
  healthcare:         { wc_male: 25, wc_female: 25, urinal_male: 50,  lav: 25,  df: 100, service_sink: 1 },
  industrial:         { wc_male: 50, wc_female: 50, urinal_male: 50,  lav: 40,  df: 100, service_sink: 1 },
};

// Water Supply Fixture Units (WSFU) per IPC Table E103.3
const WSFU_VALUES: Record<FixtureType, { tank: number; valve: number }> = {
  water_closet:       { tank: 2.5, valve: 5.0 },
  urinal:             { tank: 2.5, valve: 5.0 },
  lavatory:           { tank: 1.0, valve: 1.0 },
  drinking_fountain:  { tank: 0.5, valve: 0.5 },
  service_sink:       { tank: 1.5, valve: 1.5 },
  shower:             { tank: 2.0, valve: 2.0 },
  bathtub:            { tank: 2.0, valve: 2.0 },
  kitchen_sink:       { tank: 1.5, valve: 1.5 },
  dishwasher:         { tank: 1.5, valve: 1.5 },
  clothes_washer:     { tank: 2.0, valve: 2.0 },
};

// Drainage Fixture Units (DFU) per IPC Table 709.1
const DFU_VALUES: Record<FixtureType, number> = {
  water_closet:       4,
  urinal:             2,
  lavatory:           1,
  drinking_fountain:  0.5,
  service_sink:       3,
  shower:             2,
  bathtub:            2,
  kitchen_sink:       2,
  dishwasher:         2,
  clothes_washer:     2,
};

// Hunter's Method: WSFU to GPM lookup table (IPC Table E103.3(2))
const WSFU_TO_GPM: Array<{ wsfu: number; gpm: number }> = [
  { wsfu: 0,    gpm: 0 },
  { wsfu: 1,    gpm: 3 },
  { wsfu: 2,    gpm: 5 },
  { wsfu: 5,    gpm: 7 },
  { wsfu: 8,    gpm: 8 },
  { wsfu: 10,   gpm: 9 },
  { wsfu: 15,   gpm: 11 },
  { wsfu: 20,   gpm: 12 },
  { wsfu: 25,   gpm: 14 },
  { wsfu: 30,   gpm: 16 },
  { wsfu: 40,   gpm: 20 },
  { wsfu: 50,   gpm: 23 },
  { wsfu: 60,   gpm: 26 },
  { wsfu: 80,   gpm: 30 },
  { wsfu: 100,  gpm: 35 },
  { wsfu: 120,  gpm: 38 },
  { wsfu: 140,  gpm: 42 },
  { wsfu: 160,  gpm: 46 },
  { wsfu: 180,  gpm: 50 },
  { wsfu: 200,  gpm: 58 },
  { wsfu: 250,  gpm: 67 },
  { wsfu: 300,  gpm: 75 },
  { wsfu: 400,  gpm: 90 },
  { wsfu: 500,  gpm: 105 },
  { wsfu: 600,  gpm: 120 },
  { wsfu: 700,  gpm: 135 },
  { wsfu: 800,  gpm: 150 },
  { wsfu: 1000, gpm: 165 },
  { wsfu: 1500, gpm: 215 },
  { wsfu: 2000, gpm: 260 },
  { wsfu: 3000, gpm: 340 },
  { wsfu: 5000, gpm: 460 },
];

// Standard pipe sizes in inches
const STANDARD_PIPE_SIZES = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 6, 8];

// DFU to drain size lookup (IPC Table 710.1 simplified)
const DFU_TO_DRAIN: Array<{ maxDfu: number; size: number }> = [
  { maxDfu: 1,    size: 1.25 },
  { maxDfu: 3,    size: 1.5 },
  { maxDfu: 6,    size: 2 },
  { maxDfu: 12,   size: 2.5 },
  { maxDfu: 20,   size: 3 },
  { maxDfu: 160,  size: 4 },
  { maxDfu: 360,  size: 5 },
  { maxDfu: 620,  size: 6 },
  { maxDfu: 1400, size: 8 },
  { maxDfu: 2500, size: 10 },
  { maxDfu: 3900, size: 12 },
];

// Hot water demand (gallons per person per day) by building type
const HOT_WATER_DEMAND: Record<PlumbingBuildingType, number> = {
  residential: 20,
  commercial_office: 1,
  commercial_retail: 0.5,
  restaurant: 2.4,       // per meal equivalent (1.2x occupants for turnover)
  assembly: 0.5,
  educational: 0.6,
  healthcare: 10,
  industrial: 1,
};

// ── Utility ───────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function ceilTo(n: number): number {
  return Math.max(1, Math.ceil(n));
}

// ── WSFU to GPM interpolation (Hunter's Method) ──────────────────────────────

function wsfuToGpm(wsfu: number): number {
  if (wsfu <= 0) return 0;

  // Find the two bracketing entries
  for (let i = 1; i < WSFU_TO_GPM.length; i++) {
    const lower = WSFU_TO_GPM[i - 1]!;
    const upper = WSFU_TO_GPM[i]!;
    if (wsfu <= upper.wsfu) {
      // Linear interpolation
      const fraction = (wsfu - lower.wsfu) / (upper.wsfu - lower.wsfu);
      return lower.gpm + fraction * (upper.gpm - lower.gpm);
    }
  }

  // Extrapolate beyond table
  const last = WSFU_TO_GPM[WSFU_TO_GPM.length - 1]!;
  const prev = WSFU_TO_GPM[WSFU_TO_GPM.length - 2]!;
  const slope = (last.gpm - prev.gpm) / (last.wsfu - prev.wsfu);
  return last.gpm + slope * (wsfu - last.wsfu);
}

// ── Pipe Sizing ───────────────────────────────────────────────────────────────

/**
 * Calculate minimum pipe diameter based on flow rate and velocity.
 * Using velocity of 5-8 fps (we use 6 fps as design target).
 * q = v * A => A = q / v => d = sqrt(4*A / pi)
 */
function calculatePipeSize(gpm: number): number {
  if (gpm <= 0) return 0.5;

  const designVelocityFps = 6; // ft/s
  // Convert GPM to cubic feet per second
  const cfs = gpm / (7.48 * 60); // 7.48 gal/ft^3, 60 s/min
  // Area needed
  const areaSqFt = cfs / designVelocityFps;
  // Diameter in feet
  const diamFt = Math.sqrt((4 * areaSqFt) / Math.PI);
  // Convert to inches
  const diamIn = diamFt * 12;

  // Round up to nearest standard pipe size
  for (const size of STANDARD_PIPE_SIZES) {
    if (size >= diamIn) return size;
  }
  return STANDARD_PIPE_SIZES[STANDARD_PIPE_SIZES.length - 1]!;
}

/**
 * Determine drain size based on total DFU.
 */
function calculateDrainSize(dfu: number): number {
  for (const entry of DFU_TO_DRAIN) {
    if (dfu <= entry.maxDfu) return entry.size;
  }
  return DFU_TO_DRAIN[DFU_TO_DRAIN.length - 1]!.size;
}

// ── Minimum Fixture Count Calculation ─────────────────────────────────────────

function calculateMinimumFixtures(
  buildingType: PlumbingBuildingType,
  occupants: number,
  malePercent: number,
  floors: number,
): FixtureCounts {
  const ratios = FIXTURE_RATIOS[buildingType];
  const maleCount = Math.round(occupants * (malePercent / 100));
  const femaleCount = occupants - maleCount;

  // For residential, it's based on dwelling units, not ratios
  if (buildingType === "residential") {
    return {
      water_closets: { male: 1, female: 1, total: 1 },
      urinals: 0,
      lavatories: 1,
      drinking_fountains: 0,
      service_sinks: 0,
      other: ["1 bathtub/shower per dwelling unit", "1 kitchen sink per dwelling unit"],
    };
  }

  const wcMale = ratios.wc_male > 0 ? ceilTo(maleCount / ratios.wc_male) : 0;
  const wcFemale = ratios.wc_female > 0 ? ceilTo(femaleCount / ratios.wc_female) : 0;
  const urinals = ratios.urinal_male > 0 ? ceilTo(maleCount / ratios.urinal_male) : 0;
  const lavs = ratios.lav > 0 ? ceilTo(occupants / ratios.lav) : 0;
  const df = ratios.df > 0 ? ceilTo(occupants / ratios.df) : 0;
  const serviceSinks = ratios.service_sink > 0 ? Math.max(1, floors) : 0;

  // Male WC count can be reduced by urinals (up to 67% substitution per IPC)
  // But we report the base requirement; the urinals serve as a supplement
  const other: string[] = [];

  if (buildingType === "restaurant") {
    other.push("1 kitchen sink per kitchen", "1 service sink per kitchen");
  }
  if (buildingType === "healthcare") {
    other.push("Fixtures per patient bed may apply per local code");
  }

  return {
    water_closets: { male: wcMale, female: wcFemale, total: wcMale + wcFemale },
    urinals,
    lavatories: lavs,
    drinking_fountains: df,
    service_sinks: serviceSinks,
    other,
  };
}

// ── Core Calculation ──────────────────────────────────────────────────────────

function calculatePlumbingFixtures(args: PlumbingFixtureArgs): PlumbingFixtureResult {
  const buildingType = args.building_type;
  const occupants = args.occupant_count;
  const malePercent = args.male_percent ?? 50;
  const floors = args.floors ?? 1;
  const includeWaterHeater = args.water_heater_sizing !== false;
  const hotWaterTemp = args.hot_water_temperature_c ?? 60;

  const notes: string[] = [];

  // 1. Calculate minimum required fixtures
  const requiredFixtures = calculateMinimumFixtures(buildingType, occupants, malePercent, floors);

  // 2. Build the actual fixture list
  let fixtureList: Array<{ type: FixtureType; count: number; flushType: FlushType }>;
  let providedFixtures: FixtureCounts | undefined;
  let complianceStatus: PlumbingFixtureResult["fixture_compliance_status"];

  if (args.fixtures && args.fixtures.length > 0) {
    // User provided specific fixtures -- use those
    fixtureList = args.fixtures.map((f) => ({
      type: f.type,
      count: f.count,
      flushType: f.flush_type ?? (buildingType === "residential" ? "tank" : "valve"),
    }));

    // Build provided fixture counts for comparison
    let provWcMale = 0;
    let provWcFemale = 0;
    let provUrinals = 0;
    let provLavs = 0;
    let provDf = 0;
    let provSs = 0;
    const provOther: string[] = [];

    for (const f of fixtureList) {
      switch (f.type) {
        case "water_closet":
          // Split evenly between male/female for comparison
          provWcMale += Math.ceil(f.count / 2);
          provWcFemale += Math.floor(f.count / 2);
          break;
        case "urinal":
          provUrinals += f.count;
          break;
        case "lavatory":
          provLavs += f.count;
          break;
        case "drinking_fountain":
          provDf += f.count;
          break;
        case "service_sink":
          provSs += f.count;
          break;
        default:
          provOther.push(`${f.count}x ${f.type.replace(/_/g, " ")}`);
          break;
      }
    }

    providedFixtures = {
      water_closets: { male: provWcMale, female: provWcFemale, total: provWcMale + provWcFemale },
      urinals: provUrinals,
      lavatories: provLavs,
      drinking_fountains: provDf,
      service_sinks: provSs,
      other: provOther,
    };

    complianceStatus = "OVERRIDE";
    notes.push("Fixture counts are user-provided overrides; verify against IPC Table 403.1.");
  } else {
    // Use calculated minimum fixtures
    const defaultFlush: FlushType = buildingType === "residential" ? "tank" : "valve";

    fixtureList = [];
    if (requiredFixtures.water_closets.total > 0) {
      fixtureList.push({
        type: "water_closet",
        count: requiredFixtures.water_closets.total,
        flushType: defaultFlush,
      });
    }
    if (requiredFixtures.urinals > 0) {
      fixtureList.push({
        type: "urinal",
        count: requiredFixtures.urinals,
        flushType: defaultFlush,
      });
    }
    if (requiredFixtures.lavatories > 0) {
      fixtureList.push({ type: "lavatory", count: requiredFixtures.lavatories, flushType: "tank" });
    }
    if (requiredFixtures.drinking_fountains > 0) {
      fixtureList.push({
        type: "drinking_fountain",
        count: requiredFixtures.drinking_fountains,
        flushType: "tank",
      });
    }
    if (requiredFixtures.service_sinks > 0) {
      fixtureList.push({
        type: "service_sink",
        count: requiredFixtures.service_sinks,
        flushType: "tank",
      });
    }

    // Add residential-specific fixtures
    if (buildingType === "residential") {
      fixtureList.push({ type: "bathtub", count: 1, flushType: "tank" });
      fixtureList.push({ type: "kitchen_sink", count: 1, flushType: "tank" });
    }

    // Add restaurant-specific fixtures
    if (buildingType === "restaurant") {
      fixtureList.push({ type: "kitchen_sink", count: 1, flushType: "tank" });
    }

    complianceStatus = "COMPLIANT";
    notes.push("Fixture counts calculated per IPC Table 403.1 minimum requirements.");
  }

  // 3. Calculate WSFU (Water Supply Fixture Units)
  let totalWSFU = 0;
  for (const fixture of fixtureList) {
    const wsfuEntry = WSFU_VALUES[fixture.type];
    if (!wsfuEntry) continue;

    const wsfu =
      fixture.flushType === "valve" || fixture.flushType === "flushometer"
        ? wsfuEntry.valve
        : wsfuEntry.tank;

    totalWSFU += wsfu * fixture.count;
  }

  // 4. Convert WSFU to GPM using Hunter's Method
  const peakDemandGPM = wsfuToGpm(totalWSFU);

  // 5. Size the main water supply pipe
  const mainPipeSize = calculatePipeSize(peakDemandGPM);

  // 6. Calculate DFU (Drainage Fixture Units)
  let totalDFU = 0;
  for (const fixture of fixtureList) {
    const dfu = DFU_VALUES[fixture.type] ?? 1;
    totalDFU += dfu * fixture.count;
  }

  // 7. Size the building drain
  const drainSize = calculateDrainSize(totalDFU);

  // 8. Water heater sizing
  let waterHeater: WaterHeater | undefined;
  if (includeWaterHeater) {
    const dailyDemandPerPerson = HOT_WATER_DEMAND[buildingType] ?? 1;
    let effectiveOccupants = occupants;

    // Restaurant: consider meal turnover (roughly 2x occupants in a day)
    if (buildingType === "restaurant") {
      effectiveOccupants = occupants * 2;
    }

    const dailyDemandGallons = effectiveOccupants * dailyDemandPerPerson;

    // Storage capacity: typically sized for 70% of peak hour demand
    // Peak hour ~ 40% of daily demand for most building types (ASHRAE)
    const peakHourFraction = buildingType === "residential" ? 0.4 : 0.3;
    const peakHourDemand = dailyDemandGallons * peakHourFraction;

    // Storage = 70% of peak hour demand
    const storageCapacity = Math.ceil(peakHourDemand * 0.7);

    // Recovery rate: need to recover the peak hour demand minus storage in one hour
    const recoveryRate = Math.ceil(peakHourDemand - storageCapacity * 0.3);

    // Input BTU/hr for gas water heater (efficiency ~ 80%)
    // 1 gallon * 8.33 lb/gal * 1 BTU/(lb*F) * delta_T_F / efficiency
    const inletTemp_c = 10; // cold water inlet
    const deltaT_F = (hotWaterTemp - inletTemp_c) * 1.8;
    const efficiency = 0.80;
    const inputBTU = Math.ceil((recoveryRate * 8.33 * deltaT_F) / efficiency);

    waterHeater = {
      daily_demand_gallons: round2(dailyDemandGallons),
      storage_capacity_gallons: storageCapacity,
      recovery_rate_gph: Math.max(recoveryRate, 1),
      input_btu_hr: inputBTU,
    };

    notes.push(
      `Water heater sized for ${round2(dailyDemandPerPerson)} gal/person/day ` +
        `at ${hotWaterTemp} C storage temperature.`,
    );
  }

  // Additional notes
  notes.push(`Fixture units calculated per IPC Table E103.3 (${fixtureList.some((f) => f.flushType === "valve") ? "flush valve" : "tank"} type).`);
  notes.push(`Water supply sized using Hunter's Method (IPC Appendix E).`);
  notes.push(`Building drain sized per IPC Table 710.1(2) at 1/4 in/ft slope.`);

  if (floors > 1) {
    notes.push(
      `Multi-floor building (${floors} floors): consider floor-level sub-mains and risers.`,
    );
  }

  if (buildingType === "commercial_retail") {
    notes.push(
      "Retail: customer fixtures based on gross floor area occupancy; " +
        "employee fixtures may require separate count.",
    );
  }

  return {
    building_type: buildingType,
    occupant_count: occupants,
    required_fixtures: requiredFixtures,
    ...(providedFixtures ? { provided_fixtures: providedFixtures } : {}),
    fixture_compliance_status: complianceStatus,
    water_supply: {
      total_wsfu: round2(totalWSFU),
      peak_demand_gpm: round2(peakDemandGPM),
      main_pipe_size_inches: mainPipeSize,
    },
    drainage: {
      total_dfu: round2(totalDFU),
      building_drain_size_inches: drainSize,
    },
    ...(waterHeater ? { water_heater: waterHeater } : {}),
    notes,
  };
}

// ── Tool definition ───────────────────────────────────────────────────────────

export function createPlumbingFixtureToolDefinition() {
  return {
    name: "plumbing_fixture_calc",
    label: "Plumbing Fixture Calculator",
    description:
      "Calculate plumbing fixture requirements, pipe sizing, and water supply demand per IPC " +
      "(International Plumbing Code). Includes minimum fixture counts, water supply fixture " +
      "unit (WSFU) sizing via Hunter's Method, drainage fixture units, and water heater sizing.",
    parameters: {
      type: "object",
      properties: {
        building_type: {
          type: "string",
          enum: [
            "residential",
            "commercial_office",
            "commercial_retail",
            "restaurant",
            "assembly",
            "educational",
            "healthcare",
            "industrial",
          ],
          description:
            "Building occupancy type. Determines minimum fixture counts per IPC Table 403.1.",
        },
        occupant_count: {
          type: "number",
          description: "Total number of building occupants.",
          minimum: 1,
        },
        male_percent: {
          type: "number",
          description:
            "Percentage of male occupants (0-100). Used to split WC and urinal requirements. Default: 50.",
          default: 50,
          minimum: 0,
          maximum: 100,
        },
        floors: {
          type: "number",
          description:
            "Number of floors in the building. Affects service sink count and riser recommendations. Default: 1.",
          default: 1,
          minimum: 1,
        },
        fixtures: {
          type: "array",
          description:
            "Override with specific fixture counts instead of using IPC minimums. " +
            "Useful for verifying a proposed design.",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: [
                  "water_closet",
                  "urinal",
                  "lavatory",
                  "drinking_fountain",
                  "service_sink",
                  "shower",
                  "bathtub",
                  "kitchen_sink",
                  "dishwasher",
                  "clothes_washer",
                ],
                description: "Fixture type.",
              },
              count: {
                type: "number",
                description: "Number of this fixture type.",
                minimum: 0,
              },
              flush_type: {
                type: "string",
                enum: ["tank", "valve", "flushometer"],
                description:
                  "Flush mechanism type (for water closets and urinals). " +
                  "'valve'/'flushometer' uses higher WSFU. Default: 'tank' for residential, 'valve' for commercial.",
              },
              flow_rate_gpm: {
                type: "number",
                description: "Override flow rate in GPM (if different from standard).",
                exclusiveMinimum: 0,
              },
            },
            required: ["type", "count"],
          },
        },
        water_heater_sizing: {
          type: "boolean",
          description: "Include water heater sizing in results. Default: true.",
          default: true,
        },
        hot_water_temperature_c: {
          type: "number",
          description: "Hot water storage temperature in Celsius. Default: 60.",
          default: 60,
        },
      },
      required: ["building_type", "occupant_count"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }> => {
      const params = (args ?? {}) as Record<string, unknown>;

      // ── Validate building_type ──
      const buildingType = String(params.building_type ?? "").trim() as PlumbingBuildingType;
      const validTypes: PlumbingBuildingType[] = [
        "residential",
        "commercial_office",
        "commercial_retail",
        "restaurant",
        "assembly",
        "educational",
        "healthcare",
        "industrial",
      ];
      if (!validTypes.includes(buildingType)) {
        throw new Error(
          `Invalid building_type '${buildingType}'. Must be one of: ${validTypes.join(", ")}`,
        );
      }

      // ── Validate occupant_count ──
      const occupantCount = Math.max(1, Math.round(Number(params.occupant_count)));
      if (!Number.isFinite(occupantCount)) {
        throw new Error("occupant_count must be a positive number.");
      }

      // ── Optional parameters ──
      const malePercent =
        params.male_percent !== undefined
          ? Math.max(0, Math.min(100, Number(params.male_percent)))
          : undefined;
      const floors =
        params.floors !== undefined ? Math.max(1, Math.round(Number(params.floors))) : undefined;
      const waterHeaterSizing =
        params.water_heater_sizing !== undefined ? Boolean(params.water_heater_sizing) : undefined;
      const hotWaterTemp =
        params.hot_water_temperature_c !== undefined
          ? Number(params.hot_water_temperature_c)
          : undefined;

      // ── Parse fixtures ──
      let fixtures: FixtureInput[] | undefined;
      if (Array.isArray(params.fixtures)) {
        fixtures = (params.fixtures as any[]).map((f: any) => {
          const fixtureType = String(f.type ?? "") as FixtureType;
          const validFixtureTypes: FixtureType[] = [
            "water_closet",
            "urinal",
            "lavatory",
            "drinking_fountain",
            "service_sink",
            "shower",
            "bathtub",
            "kitchen_sink",
            "dishwasher",
            "clothes_washer",
          ];
          if (!validFixtureTypes.includes(fixtureType)) {
            throw new Error(
              `Invalid fixture type '${fixtureType}'. Must be one of: ${validFixtureTypes.join(", ")}`,
            );
          }
          return {
            type: fixtureType,
            count: Math.max(0, Math.round(Number(f.count ?? 0))),
            flush_type: f.flush_type as FlushType | undefined,
            flow_rate_gpm: f.flow_rate_gpm !== undefined ? Number(f.flow_rate_gpm) : undefined,
          };
        });
      }

      // ── Run calculation ──
      const result = calculatePlumbingFixtures({
        building_type: buildingType,
        occupant_count: occupantCount,
        ...(malePercent !== undefined && { male_percent: malePercent }),
        ...(floors !== undefined && { floors }),
        ...(fixtures !== undefined && { fixtures }),
        ...(waterHeaterSizing !== undefined && { water_heater_sizing: waterHeaterSizing }),
        ...(hotWaterTemp !== undefined && { hot_water_temperature_c: hotWaterTemp }),
      });

      // ── Build summary text ──
      const rf = result.required_fixtures;
      const ws = result.water_supply;
      const dr = result.drainage;

      const summary = [
        `Plumbing Fixture Calculation (IPC)`,
        `===================================`,
        `Building Type: ${result.building_type.replace(/_/g, " ")}`,
        `Occupants: ${result.occupant_count}`,
        `Compliance: ${result.fixture_compliance_status}`,
        ``,
        `REQUIRED FIXTURES (IPC Table 403.1):`,
        `  Water Closets: ${rf.water_closets.total} (male: ${rf.water_closets.male}, female: ${rf.water_closets.female})`,
        `  Urinals:       ${rf.urinals}`,
        `  Lavatories:    ${rf.lavatories}`,
        `  Drinking Ftn:  ${rf.drinking_fountains}`,
        `  Service Sinks: ${rf.service_sinks}`,
      ];

      if (rf.other.length > 0) {
        for (const note of rf.other) {
          summary.push(`  + ${note}`);
        }
      }

      if (result.provided_fixtures) {
        const pf = result.provided_fixtures;
        summary.push(``);
        summary.push(`PROVIDED FIXTURES (user override):`);
        summary.push(`  Water Closets: ${pf.water_closets.total}`);
        summary.push(`  Urinals:       ${pf.urinals}`);
        summary.push(`  Lavatories:    ${pf.lavatories}`);
        summary.push(`  Drinking Ftn:  ${pf.drinking_fountains}`);
        summary.push(`  Service Sinks: ${pf.service_sinks}`);
        if (pf.other.length > 0) {
          summary.push(`  Other: ${pf.other.join(", ")}`);
        }
      }

      summary.push(``);
      summary.push(`WATER SUPPLY:`);
      summary.push(`  Total WSFU:       ${ws.total_wsfu}`);
      summary.push(`  Peak Demand:      ${ws.peak_demand_gpm} GPM`);
      summary.push(`  Main Pipe Size:   ${ws.main_pipe_size_inches}" (${ws.main_pipe_size_inches * 25.4} mm)`);

      summary.push(``);
      summary.push(`DRAINAGE:`);
      summary.push(`  Total DFU:         ${dr.total_dfu}`);
      summary.push(`  Building Drain:    ${dr.building_drain_size_inches}" (${dr.building_drain_size_inches * 25.4} mm)`);

      if (result.water_heater) {
        const wh = result.water_heater;
        summary.push(``);
        summary.push(`WATER HEATER:`);
        summary.push(`  Daily Demand:      ${wh.daily_demand_gallons} gal`);
        summary.push(`  Storage Capacity:  ${wh.storage_capacity_gallons} gal`);
        summary.push(`  Recovery Rate:     ${wh.recovery_rate_gph} GPH`);
        summary.push(`  Input Rating:      ${wh.input_btu_hr.toLocaleString()} BTU/hr`);
      }

      if (result.notes.length > 0) {
        summary.push(``);
        summary.push(`NOTES:`);
        for (const note of result.notes) {
          summary.push(`  - ${note}`);
        }
      }

      return {
        content: [
          { type: "text", text: summary.join("\n") },
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
        details: {
          building_type: result.building_type,
          occupant_count: result.occupant_count,
          total_wsfu: result.water_supply.total_wsfu,
          peak_demand_gpm: result.water_supply.peak_demand_gpm,
          main_pipe_inches: result.water_supply.main_pipe_size_inches,
          total_dfu: result.drainage.total_dfu,
          drain_size_inches: result.drainage.building_drain_size_inches,
          compliance: result.fixture_compliance_status,
        },
      };
    },
  };
}
