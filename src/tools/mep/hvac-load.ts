/**
 * HVAC Load Calculation tool for civilclaw.
 *
 * Calculates heating and cooling loads for spaces using simplified ASHRAE
 * methods (CLTD/SCL/CLF). Returns peak loads, component breakdowns, and
 * equipment sizing guidance.
 *
 * Pure TypeScript -- no external dependencies.
 */

// ── Climate Data ──────────────────────────────────────────────────────────────

interface ClimateRecord {
  summer_db: number;   // Summer design dry-bulb temperature (C)
  winter_db: number;   // Winter design dry-bulb temperature (C)
  daily_range: number; // Mean daily range (C)
  lat: number;         // Latitude (degrees)
}

const CLIMATE_DATA: Record<string, ClimateRecord> = {
  "New York":       { summer_db: 34, winter_db: -12, daily_range: 9,  lat: 40.7 },
  "Los Angeles":    { summer_db: 36, winter_db: 4,   daily_range: 14, lat: 34.0 },
  "Chicago":        { summer_db: 35, winter_db: -18, daily_range: 10, lat: 41.9 },
  "Houston":        { summer_db: 37, winter_db: 0,   daily_range: 10, lat: 29.8 },
  "Phoenix":        { summer_db: 43, winter_db: 2,   daily_range: 14, lat: 33.4 },
  "Philadelphia":   { summer_db: 34, winter_db: -10, daily_range: 10, lat: 40.0 },
  "San Antonio":    { summer_db: 38, winter_db: -1,  daily_range: 12, lat: 29.4 },
  "San Diego":      { summer_db: 33, winter_db: 5,   daily_range: 10, lat: 32.7 },
  "Dallas":         { summer_db: 39, winter_db: -5,  daily_range: 12, lat: 32.8 },
  "San Francisco":  { summer_db: 28, winter_db: 3,   daily_range: 10, lat: 37.8 },
  "Austin":         { summer_db: 38, winter_db: -2,  daily_range: 12, lat: 30.3 },
  "Denver":         { summer_db: 35, winter_db: -17, daily_range: 15, lat: 39.7 },
  "Seattle":        { summer_db: 30, winter_db: -3,  daily_range: 11, lat: 47.6 },
  "Boston":         { summer_db: 33, winter_db: -13, daily_range: 10, lat: 42.4 },
  "Miami":          { summer_db: 34, winter_db: 8,   daily_range: 8,  lat: 25.8 },
  "Atlanta":        { summer_db: 35, winter_db: -5,  daily_range: 11, lat: 33.7 },
  "Minneapolis":    { summer_db: 33, winter_db: -23, daily_range: 12, lat: 44.9 },
  "Las Vegas":      { summer_db: 43, winter_db: -1,  daily_range: 16, lat: 36.2 },
  "Portland":       { summer_db: 34, winter_db: -3,  daily_range: 13, lat: 45.5 },
  "Detroit":        { summer_db: 33, winter_db: -15, daily_range: 11, lat: 42.3 },
  "Washington DC":  { summer_db: 35, winter_db: -8,  daily_range: 10, lat: 38.9 },
  "Nashville":      { summer_db: 35, winter_db: -8,  daily_range: 11, lat: 36.2 },
  "St. Louis":      { summer_db: 36, winter_db: -13, daily_range: 11, lat: 38.6 },
  "Salt Lake City": { summer_db: 37, winter_db: -12, daily_range: 17, lat: 40.8 },
};

// ── Simplified CLTD by Orientation (C) ────────────────────────────────────────

type Orientation = "N" | "S" | "E" | "W" | "NE" | "NW" | "SE" | "SW";

const WALL_CLTD: Record<Orientation, number> = {
  N: 8, NE: 12, E: 16, SE: 14, S: 12, SW: 16, W: 18, NW: 14,
};

const ROOF_CLTD = 30; // simplified peak for dark roof

// Solar Heat Gain Factors by orientation (W/m^2, peak, simplified from ASHRAE)
const SHGF: Record<Orientation, number> = {
  N: 150, NE: 350, E: 470, SE: 380, S: 280, SW: 380, W: 470, NW: 350,
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface SpaceInput {
  name: string;
  area_sqm: number;
  height_m?: number;
  occupants: number;
  lighting_w_per_sqm?: number;
  equipment_w_per_sqm?: number;
}

interface WallInput {
  orientation: Orientation;
  area_sqm: number;
  u_value_w_per_sqm_k?: number;
}

interface RoofInput {
  area_sqm: number;
  u_value_w_per_sqm_k?: number;
}

interface FloorInput {
  area_sqm: number;
  u_value_w_per_sqm_k?: number;
  type?: "slab_on_grade" | "over_unconditioned" | "over_outside";
}

interface WindowInput {
  orientation: Orientation;
  area_sqm: number;
  u_value_w_per_sqm_k?: number;
  shgc?: number;
}

interface EnvelopeInput {
  walls: WallInput[];
  roof?: RoofInput;
  floor?: FloorInput;
  windows: WindowInput[];
}

interface ClimateInput {
  location?: string;
  summer_design_temp_c?: number;
  winter_design_temp_c?: number;
  summer_daily_range_c?: number;
  latitude_deg?: number;
}

interface IndoorConditions {
  cooling_setpoint_c?: number;
  heating_setpoint_c?: number;
  relative_humidity_percent?: number;
}

interface HvacLoadArgs {
  spaces: SpaceInput[];
  envelope: EnvelopeInput;
  climate: ClimateInput;
  indoor_conditions?: IndoorConditions;
  ventilation_l_per_s_per_person?: number;
  safety_factor?: number;
}

// ── Result types ──────────────────────────────────────────────────────────────

interface CoolingComponents {
  walls: number;
  roof: number;
  windows_conduction: number;
  windows_solar: number;
  people_sensible: number;
  people_latent: number;
  lighting: number;
  equipment: number;
  ventilation_sensible: number;
  ventilation_latent: number;
  infiltration: number;
}

interface HeatingComponents {
  walls: number;
  roof: number;
  windows: number;
  floor: number;
  ventilation: number;
  infiltration: number;
}

interface SpaceCoolingResult {
  name: string;
  area_sqm: number;
  sensible_kw: number;
  latent_kw: number;
  total_kw: number;
}

interface HvacLoadResult {
  cooling_load: {
    total_kw: number;
    total_tons: number;
    components: CoolingComponents;
    per_space: SpaceCoolingResult[];
  };
  heating_load: {
    total_kw: number;
    total_btu_hr: number;
    components: HeatingComponents;
  };
  equipment_sizing: {
    cooling_tons_recommended: number;
    heating_kw_recommended: number;
    airflow_cfm: number;
  };
  design_conditions: {
    outdoor_summer_c: number;
    outdoor_winter_c: number;
    indoor_cooling_c: number;
    indoor_heating_c: number;
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const AIR_DENSITY = 1.2;            // kg/m^3
const AIR_CP = 1.006;               // kJ/(kg*K)
const LATENT_HEAT_VAPOR = 2450;     // kJ/kg (approximate hfg at indoor conditions)
const KW_PER_TON = 3.517;
const BTU_PER_KW = 3412.14;
const CFM_PER_TON = 400;            // typical airflow

// Typical humidity ratio difference (summer outdoor vs indoor) in kg/kg
const DELTA_W_SUMMER = 0.005;       // ~ 5 g/kg
const DELTA_W_WINTER = 0.003;       // winter is drier, lower latent contribution

// Infiltration: 0.5 ACH for typical construction
const INFILTRATION_ACH = 0.5;

// People heat gains (ASHRAE typical office/moderate activity)
const PEOPLE_SENSIBLE_W = 75;
const PEOPLE_LATENT_W = 55;

// Equipment usage factor
const EQUIPMENT_USAGE_FACTOR = 0.85;

// ── Utility ───────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ── Climate resolution ────────────────────────────────────────────────────────

function resolveClimate(input: ClimateInput): {
  summer_db: number;
  winter_db: number;
  daily_range: number;
  lat: number;
  location_name: string;
} {
  // If explicit values are provided, use them
  if (
    input.summer_design_temp_c !== undefined &&
    input.winter_design_temp_c !== undefined
  ) {
    return {
      summer_db: input.summer_design_temp_c,
      winter_db: input.winter_design_temp_c,
      daily_range: input.summer_daily_range_c ?? 11,
      lat: input.latitude_deg ?? 40,
      location_name: "Custom",
    };
  }

  // Look up by location name
  const loc = input.location ?? "New York";
  const lower = loc.toLowerCase();

  for (const [city, data] of Object.entries(CLIMATE_DATA)) {
    if (city.toLowerCase() === lower || lower.includes(city.toLowerCase())) {
      return { ...data, location_name: city };
    }
  }

  // Partial match
  for (const [city, data] of Object.entries(CLIMATE_DATA)) {
    const cityWords = city.toLowerCase().split(/\s+/);
    const locWords = lower.split(/\s+/);
    if (cityWords.some((w) => locWords.includes(w))) {
      return { ...data, location_name: city };
    }
  }

  // Default to New York
  return { ...CLIMATE_DATA["New York"]!, location_name: "New York (default)" };
}

// ── CLTD correction ──────────────────────────────────────────────────────────

/**
 * Apply CLTD corrections per ASHRAE simplified method:
 * CLTD_corrected = CLTD + (78 - Ti_F) + (Tm - 85)
 * where Ti_F is indoor temp in F and Tm = outdoor mean temp in F
 * Tm = To_design - daily_range/2
 */
function correctCLTD(
  baseCLTD: number,
  outdoorDesign_c: number,
  indoorSetpoint_c: number,
  dailyRange_c: number,
): number {
  const Ti_F = indoorSetpoint_c * 1.8 + 32;
  const To_F = outdoorDesign_c * 1.8 + 32;
  const DR_F = dailyRange_c * 1.8;
  const Tm = To_F - DR_F / 2;
  const corrected = baseCLTD + (78 - Ti_F) + (Tm - 85);
  return Math.max(corrected, 0); // CLTD should not be negative for cooling
}

// ── Core calculation ──────────────────────────────────────────────────────────

function calculateHvacLoads(args: HvacLoadArgs): HvacLoadResult {
  const { spaces, envelope, climate: climateInput } = args;

  // Resolve parameters with defaults
  const coolingSetpoint = args.indoor_conditions?.cooling_setpoint_c ?? 24;
  const heatingSetpoint = args.indoor_conditions?.heating_setpoint_c ?? 21;
  const ventRate = args.ventilation_l_per_s_per_person ?? 10; // L/s per person
  const safetyFactor = args.safety_factor ?? 1.1;

  // Resolve climate
  const climate = resolveClimate(climateInput);
  const deltaT_cooling = climate.summer_db - coolingSetpoint;
  const deltaT_heating = heatingSetpoint - climate.winter_db;

  // Total building volume, area, and occupants
  let totalArea = 0;
  let totalVolume = 0;
  let totalOccupants = 0;
  let totalLightingW = 0;
  let totalEquipmentW = 0;

  for (const space of spaces) {
    const height = space.height_m ?? 3.0;
    const lightingWpSqm = space.lighting_w_per_sqm ?? 10;
    const equipWpSqm = space.equipment_w_per_sqm ?? 15;

    totalArea += space.area_sqm;
    totalVolume += space.area_sqm * height;
    totalOccupants += space.occupants;
    totalLightingW += space.area_sqm * lightingWpSqm;
    totalEquipmentW += space.area_sqm * equipWpSqm;
  }

  // ── COOLING LOAD CALCULATION ──

  // 1. Walls: Q = U * A * CLTD_corrected
  let coolingWalls = 0;
  for (const wall of envelope.walls) {
    const U = wall.u_value_w_per_sqm_k ?? 0.5;
    const baseCLTD = WALL_CLTD[wall.orientation] ?? 12;
    const cltd = correctCLTD(baseCLTD, climate.summer_db, coolingSetpoint, climate.daily_range);
    coolingWalls += U * wall.area_sqm * cltd;
  }

  // 2. Roof: Q = U * A * CLTD_corrected
  let coolingRoof = 0;
  if (envelope.roof) {
    const U = envelope.roof.u_value_w_per_sqm_k ?? 0.3;
    const cltd = correctCLTD(ROOF_CLTD, climate.summer_db, coolingSetpoint, climate.daily_range);
    coolingRoof = U * envelope.roof.area_sqm * cltd;
  }

  // 3. Windows - Conduction: Q = U * A * (To - Ti)
  let coolingWindowsCond = 0;
  for (const win of envelope.windows) {
    const U = win.u_value_w_per_sqm_k ?? 2.5;
    coolingWindowsCond += U * win.area_sqm * deltaT_cooling;
  }

  // 4. Windows - Solar: Q = A * SHGC * SHGF
  let coolingWindowsSolar = 0;
  for (const win of envelope.windows) {
    const shgc = win.shgc ?? 0.4;
    const shgf = SHGF[win.orientation] ?? 280;
    coolingWindowsSolar += win.area_sqm * shgc * shgf;
  }

  // 5. People
  const coolingPeopleSensible = totalOccupants * PEOPLE_SENSIBLE_W;
  const coolingPeopleLatent = totalOccupants * PEOPLE_LATENT_W;

  // 6. Lighting: Q = watts * CLF (CLF ~ 1.0 for conservative estimate)
  const coolingLighting = totalLightingW * 1.0;

  // 7. Equipment: Q = watts * usage_factor
  const coolingEquipment = totalEquipmentW * EQUIPMENT_USAGE_FACTOR;

  // 8. Ventilation
  // Volume flow = ventRate (L/s/person) * occupants => m^3/s = L/s / 1000
  const ventFlowM3s = (ventRate * totalOccupants) / 1000;
  const ventMassFlow = ventFlowM3s * AIR_DENSITY; // kg/s

  // Sensible: Q = m_dot * cp * deltaT (W = kJ/s * 1000)
  const coolingVentSensible = ventMassFlow * AIR_CP * deltaT_cooling * 1000;
  // Latent: Q = m_dot * hfg * deltaW
  const coolingVentLatent = ventMassFlow * LATENT_HEAT_VAPOR * DELTA_W_SUMMER * 1000;

  // 9. Infiltration (0.5 ACH)
  const infiltrationFlowM3s = (totalVolume * INFILTRATION_ACH) / 3600;
  const infiltrationMassFlow = infiltrationFlowM3s * AIR_DENSITY;
  const coolingInfiltration =
    infiltrationMassFlow * AIR_CP * deltaT_cooling * 1000 +
    infiltrationMassFlow * LATENT_HEAT_VAPOR * DELTA_W_SUMMER * 1000;

  // Total cooling load (in watts)
  const totalCoolingW =
    (coolingWalls +
      coolingRoof +
      coolingWindowsCond +
      coolingWindowsSolar +
      coolingPeopleSensible +
      coolingPeopleLatent +
      coolingLighting +
      coolingEquipment +
      coolingVentSensible +
      coolingVentLatent +
      coolingInfiltration) *
    safetyFactor;

  const totalCoolingKW = totalCoolingW / 1000;
  const totalCoolingTons = totalCoolingKW / KW_PER_TON;

  // ── HEATING LOAD CALCULATION (conservative: no solar or internal gains) ──

  // Envelope losses
  let heatingWalls = 0;
  for (const wall of envelope.walls) {
    const U = wall.u_value_w_per_sqm_k ?? 0.5;
    heatingWalls += U * wall.area_sqm * deltaT_heating;
  }

  let heatingRoof = 0;
  if (envelope.roof) {
    const U = envelope.roof.u_value_w_per_sqm_k ?? 0.3;
    heatingRoof = U * envelope.roof.area_sqm * deltaT_heating;
  }

  let heatingWindows = 0;
  for (const win of envelope.windows) {
    const U = win.u_value_w_per_sqm_k ?? 2.5;
    heatingWindows += U * win.area_sqm * deltaT_heating;
  }

  let heatingFloor = 0;
  if (envelope.floor) {
    const U = envelope.floor.u_value_w_per_sqm_k ?? 0.5;
    const floorType = envelope.floor.type ?? "slab_on_grade";
    // For slab-on-grade, use a reduced delta-T (ground ~10C); for over
    // unconditioned, use ~50% delta-T; for over outside, use full delta-T
    let floorDeltaT: number;
    switch (floorType) {
      case "slab_on_grade":
        floorDeltaT = heatingSetpoint - 10; // ground ~10C
        break;
      case "over_unconditioned":
        floorDeltaT = deltaT_heating * 0.5;
        break;
      case "over_outside":
        floorDeltaT = deltaT_heating;
        break;
    }
    heatingFloor = U * envelope.floor.area_sqm * floorDeltaT;
  }

  // Heating ventilation
  const heatingVent = ventMassFlow * AIR_CP * deltaT_heating * 1000;

  // Heating infiltration
  const heatingInfiltration = infiltrationMassFlow * AIR_CP * deltaT_heating * 1000;

  const totalHeatingW =
    (heatingWalls + heatingRoof + heatingWindows + heatingFloor + heatingVent + heatingInfiltration) *
    safetyFactor;

  const totalHeatingKW = totalHeatingW / 1000;
  const totalHeatingBTU = totalHeatingKW * BTU_PER_KW;

  // ── PER-SPACE COOLING BREAKDOWN ──
  // Distribute proportionally to internal gains (people + lighting + equipment)
  const perSpace: SpaceCoolingResult[] = [];
  for (const space of spaces) {
    const height = space.height_m ?? 3.0;
    const lightWpSqm = space.lighting_w_per_sqm ?? 10;
    const equipWpSqm = space.equipment_w_per_sqm ?? 15;

    const spaceInternalW =
      space.occupants * (PEOPLE_SENSIBLE_W + PEOPLE_LATENT_W) +
      space.area_sqm * lightWpSqm +
      space.area_sqm * equipWpSqm * EQUIPMENT_USAGE_FACTOR;

    // Envelope contribution proportional to floor area
    const areaFraction = totalArea > 0 ? space.area_sqm / totalArea : 0;
    const envelopeContribW =
      (coolingWalls + coolingRoof + coolingWindowsCond + coolingWindowsSolar) * areaFraction;

    // Ventilation/infiltration proportional to volume
    const volFraction = totalVolume > 0 ? (space.area_sqm * height) / totalVolume : 0;
    const ventContribW =
      (coolingVentSensible + coolingVentLatent + coolingInfiltration) * volFraction;

    const spaceSensibleW = spaceInternalW + envelopeContribW + ventContribW -
      space.occupants * PEOPLE_LATENT_W;
    const spaceLatentW = space.occupants * PEOPLE_LATENT_W +
      (coolingVentLatent * volFraction);
    const spaceTotalW = (spaceSensibleW + spaceLatentW) * safetyFactor;

    perSpace.push({
      name: space.name,
      area_sqm: space.area_sqm,
      sensible_kw: round3(spaceSensibleW * safetyFactor / 1000),
      latent_kw: round3(spaceLatentW * safetyFactor / 1000),
      total_kw: round3(spaceTotalW / 1000),
    });
  }

  // ── EQUIPMENT SIZING ──

  // Round up cooling to nearest 0.5-ton increment
  const coolingTonsRaw = totalCoolingTons;
  const coolingTonsRecommended = Math.ceil(coolingTonsRaw * 2) / 2;

  // Heating: round up to nearest 5 kW
  const heatingKwRecommended = Math.ceil(totalHeatingKW / 5) * 5;

  // Airflow: roughly 400 CFM per ton
  const airflowCFM = Math.round(coolingTonsRecommended * CFM_PER_TON);

  return {
    cooling_load: {
      total_kw: round2(totalCoolingKW),
      total_tons: round2(totalCoolingTons),
      components: {
        walls: round2(coolingWalls * safetyFactor / 1000),
        roof: round2(coolingRoof * safetyFactor / 1000),
        windows_conduction: round2(coolingWindowsCond * safetyFactor / 1000),
        windows_solar: round2(coolingWindowsSolar * safetyFactor / 1000),
        people_sensible: round2(coolingPeopleSensible * safetyFactor / 1000),
        people_latent: round2(coolingPeopleLatent * safetyFactor / 1000),
        lighting: round2(coolingLighting * safetyFactor / 1000),
        equipment: round2(coolingEquipment * safetyFactor / 1000),
        ventilation_sensible: round2(coolingVentSensible * safetyFactor / 1000),
        ventilation_latent: round2(coolingVentLatent * safetyFactor / 1000),
        infiltration: round2(coolingInfiltration * safetyFactor / 1000),
      },
      per_space: perSpace,
    },
    heating_load: {
      total_kw: round2(totalHeatingKW),
      total_btu_hr: round2(totalHeatingBTU),
      components: {
        walls: round2(heatingWalls * safetyFactor / 1000),
        roof: round2(heatingRoof * safetyFactor / 1000),
        windows: round2(heatingWindows * safetyFactor / 1000),
        floor: round2(heatingFloor * safetyFactor / 1000),
        ventilation: round2(heatingVent * safetyFactor / 1000),
        infiltration: round2(heatingInfiltration * safetyFactor / 1000),
      },
    },
    equipment_sizing: {
      cooling_tons_recommended: coolingTonsRecommended,
      heating_kw_recommended: heatingKwRecommended,
      airflow_cfm: airflowCFM,
    },
    design_conditions: {
      outdoor_summer_c: climate.summer_db,
      outdoor_winter_c: climate.winter_db,
      indoor_cooling_c: coolingSetpoint,
      indoor_heating_c: heatingSetpoint,
    },
  };
}

// ── Tool definition ───────────────────────────────────────────────────────────

export function createHvacLoadToolDefinition() {
  return {
    name: "hvac_load_calc",
    label: "HVAC Load Calculator",
    description:
      "Calculate heating and cooling loads for spaces using simplified ASHRAE methods. " +
      "Returns peak loads, component breakdowns, and equipment sizing guidance. " +
      "Supports 20+ US cities for climate data or custom design conditions.",
    parameters: {
      type: "object",
      properties: {
        spaces: {
          type: "array",
          description: "Array of spaces (rooms/zones) in the building.",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Space or room name (e.g. 'Open Office', 'Conference Room').",
              },
              area_sqm: {
                type: "number",
                description: "Floor area of the space in square meters.",
                exclusiveMinimum: 0,
              },
              height_m: {
                type: "number",
                description: "Ceiling height in meters. Default: 3.0.",
                default: 3.0,
              },
              occupants: {
                type: "number",
                description: "Number of occupants in the space.",
                minimum: 0,
              },
              lighting_w_per_sqm: {
                type: "number",
                description: "Lighting power density in W/m^2. Default: 10.",
                default: 10,
              },
              equipment_w_per_sqm: {
                type: "number",
                description: "Equipment (plug load) power density in W/m^2. Default: 15.",
                default: 15,
              },
            },
            required: ["name", "area_sqm", "occupants"],
          },
        },
        envelope: {
          type: "object",
          description: "Building envelope (walls, roof, floor, windows).",
          properties: {
            walls: {
              type: "array",
              description: "Exterior wall segments.",
              items: {
                type: "object",
                properties: {
                  orientation: {
                    type: "string",
                    enum: ["N", "S", "E", "W", "NE", "NW", "SE", "SW"],
                    description: "Cardinal or intercardinal direction the wall faces.",
                  },
                  area_sqm: {
                    type: "number",
                    description: "Gross wall area in m^2 (excluding windows).",
                    exclusiveMinimum: 0,
                  },
                  u_value_w_per_sqm_k: {
                    type: "number",
                    description: "Thermal transmittance in W/(m^2*K). Default: 0.5.",
                    default: 0.5,
                  },
                },
                required: ["orientation", "area_sqm"],
              },
            },
            roof: {
              type: "object",
              description: "Roof (optional, for top-floor or single-story buildings).",
              properties: {
                area_sqm: {
                  type: "number",
                  description: "Roof area in m^2.",
                  exclusiveMinimum: 0,
                },
                u_value_w_per_sqm_k: {
                  type: "number",
                  description: "Thermal transmittance in W/(m^2*K). Default: 0.3.",
                  default: 0.3,
                },
              },
              required: ["area_sqm"],
            },
            floor: {
              type: "object",
              description: "Ground floor or exposed floor (optional).",
              properties: {
                area_sqm: {
                  type: "number",
                  description: "Floor area in m^2.",
                  exclusiveMinimum: 0,
                },
                u_value_w_per_sqm_k: {
                  type: "number",
                  description: "Thermal transmittance in W/(m^2*K). Default: 0.5.",
                  default: 0.5,
                },
                type: {
                  type: "string",
                  enum: ["slab_on_grade", "over_unconditioned", "over_outside"],
                  description:
                    "Floor construction type. Affects effective temperature difference. Default: slab_on_grade.",
                  default: "slab_on_grade",
                },
              },
              required: ["area_sqm"],
            },
            windows: {
              type: "array",
              description: "Window/glazing elements.",
              items: {
                type: "object",
                properties: {
                  orientation: {
                    type: "string",
                    enum: ["N", "S", "E", "W", "NE", "NW", "SE", "SW"],
                    description: "Direction the window faces.",
                  },
                  area_sqm: {
                    type: "number",
                    description: "Window area in m^2.",
                    exclusiveMinimum: 0,
                  },
                  u_value_w_per_sqm_k: {
                    type: "number",
                    description: "Window U-value in W/(m^2*K). Default: 2.5.",
                    default: 2.5,
                  },
                  shgc: {
                    type: "number",
                    description:
                      "Solar Heat Gain Coefficient (0-1). Default: 0.4.",
                    default: 0.4,
                    minimum: 0,
                    maximum: 1,
                  },
                },
                required: ["orientation", "area_sqm"],
              },
            },
          },
          required: ["walls", "windows"],
        },
        climate: {
          type: "object",
          description:
            "Climate data. Provide a 'location' name (US city) or explicit design temperatures.",
          properties: {
            location: {
              type: "string",
              description:
                "City name for climate lookup (e.g. 'Phoenix', 'Chicago'). " +
                "Supported: New York, Los Angeles, Chicago, Houston, Phoenix, Philadelphia, " +
                "San Antonio, San Diego, Dallas, San Francisco, Austin, Denver, Seattle, " +
                "Boston, Miami, Atlanta, Minneapolis, Las Vegas, Portland, Detroit, " +
                "Washington DC, Nashville, St. Louis, Salt Lake City.",
            },
            summer_design_temp_c: {
              type: "number",
              description: "Summer design dry-bulb temperature in Celsius (overrides location lookup).",
            },
            winter_design_temp_c: {
              type: "number",
              description: "Winter design dry-bulb temperature in Celsius (overrides location lookup).",
            },
            summer_daily_range_c: {
              type: "number",
              description: "Mean daily temperature range in Celsius. Default: 11.",
            },
            latitude_deg: {
              type: "number",
              description: "Latitude in degrees (for solar calculations). Default: 40.",
            },
          },
        },
        indoor_conditions: {
          type: "object",
          description: "Indoor design conditions (optional).",
          properties: {
            cooling_setpoint_c: {
              type: "number",
              description: "Cooling thermostat setpoint in Celsius. Default: 24.",
              default: 24,
            },
            heating_setpoint_c: {
              type: "number",
              description: "Heating thermostat setpoint in Celsius. Default: 21.",
              default: 21,
            },
            relative_humidity_percent: {
              type: "number",
              description: "Indoor design relative humidity. Default: 50.",
              default: 50,
            },
          },
        },
        ventilation_l_per_s_per_person: {
          type: "number",
          description: "Outdoor air ventilation rate in L/s per person. Default: 10 (ASHRAE 62.1 office).",
          default: 10,
        },
        safety_factor: {
          type: "number",
          description: "Safety multiplier applied to final loads. Default: 1.1 (10% margin).",
          default: 1.1,
          minimum: 1.0,
          maximum: 2.0,
        },
      },
      required: ["spaces", "envelope", "climate"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }> => {
      const params = (args ?? {}) as Record<string, unknown>;

      // ── Parse spaces ──
      if (!Array.isArray(params.spaces) || params.spaces.length === 0) {
        throw new Error("spaces must be a non-empty array.");
      }
      const spaces: SpaceInput[] = (params.spaces as any[]).map((s: any) => {
        if (!s.name || typeof s.name !== "string") {
          throw new Error("Each space must have a 'name' string.");
        }
        const area = Number(s.area_sqm);
        if (!Number.isFinite(area) || area <= 0) {
          throw new Error(`Space '${s.name}': area_sqm must be a positive number.`);
        }
        const occupants = Number(s.occupants ?? 0);
        if (!Number.isFinite(occupants) || occupants < 0) {
          throw new Error(`Space '${s.name}': occupants must be a non-negative number.`);
        }
        return {
          name: s.name,
          area_sqm: area,
          height_m: s.height_m !== undefined ? Number(s.height_m) : undefined,
          occupants,
          lighting_w_per_sqm:
            s.lighting_w_per_sqm !== undefined ? Number(s.lighting_w_per_sqm) : undefined,
          equipment_w_per_sqm:
            s.equipment_w_per_sqm !== undefined ? Number(s.equipment_w_per_sqm) : undefined,
        };
      });

      // ── Parse envelope ──
      const rawEnv = params.envelope as Record<string, unknown> | undefined;
      if (!rawEnv || typeof rawEnv !== "object") {
        throw new Error("envelope is required and must be an object.");
      }

      const validOrientations: Orientation[] = ["N", "S", "E", "W", "NE", "NW", "SE", "SW"];

      const walls: WallInput[] = (Array.isArray(rawEnv.walls) ? rawEnv.walls : []).map(
        (w: any) => {
          const orient = String(w.orientation ?? "").toUpperCase() as Orientation;
          if (!validOrientations.includes(orient)) {
            throw new Error(
              `Wall orientation '${w.orientation}' is invalid. Must be one of: ${validOrientations.join(", ")}`,
            );
          }
          return {
            orientation: orient,
            area_sqm: Number(w.area_sqm),
            u_value_w_per_sqm_k:
              w.u_value_w_per_sqm_k !== undefined ? Number(w.u_value_w_per_sqm_k) : undefined,
          };
        },
      );

      const windows: WindowInput[] = (Array.isArray(rawEnv.windows) ? rawEnv.windows : []).map(
        (w: any) => {
          const orient = String(w.orientation ?? "").toUpperCase() as Orientation;
          if (!validOrientations.includes(orient)) {
            throw new Error(
              `Window orientation '${w.orientation}' is invalid. Must be one of: ${validOrientations.join(", ")}`,
            );
          }
          return {
            orientation: orient,
            area_sqm: Number(w.area_sqm),
            u_value_w_per_sqm_k:
              w.u_value_w_per_sqm_k !== undefined ? Number(w.u_value_w_per_sqm_k) : undefined,
            shgc: w.shgc !== undefined ? Number(w.shgc) : undefined,
          };
        },
      );

      let roof: RoofInput | undefined;
      if (rawEnv.roof && typeof rawEnv.roof === "object") {
        const r = rawEnv.roof as any;
        roof = {
          area_sqm: Number(r.area_sqm),
          u_value_w_per_sqm_k:
            r.u_value_w_per_sqm_k !== undefined ? Number(r.u_value_w_per_sqm_k) : undefined,
        };
      }

      let floor: FloorInput | undefined;
      if (rawEnv.floor && typeof rawEnv.floor === "object") {
        const f = rawEnv.floor as any;
        floor = {
          area_sqm: Number(f.area_sqm),
          u_value_w_per_sqm_k:
            f.u_value_w_per_sqm_k !== undefined ? Number(f.u_value_w_per_sqm_k) : undefined,
          type: f.type as FloorInput["type"],
        };
      }

      const envelope: EnvelopeInput = { walls, roof, floor, windows };

      // ── Parse climate ──
      const rawClimate = (params.climate ?? {}) as Record<string, unknown>;
      const climateInput: ClimateInput = {
        location: typeof rawClimate.location === "string" ? rawClimate.location : undefined,
        summer_design_temp_c:
          rawClimate.summer_design_temp_c !== undefined
            ? Number(rawClimate.summer_design_temp_c)
            : undefined,
        winter_design_temp_c:
          rawClimate.winter_design_temp_c !== undefined
            ? Number(rawClimate.winter_design_temp_c)
            : undefined,
        summer_daily_range_c:
          rawClimate.summer_daily_range_c !== undefined
            ? Number(rawClimate.summer_daily_range_c)
            : undefined,
        latitude_deg:
          rawClimate.latitude_deg !== undefined ? Number(rawClimate.latitude_deg) : undefined,
      };

      // ── Parse indoor conditions ──
      const rawIndoor = (params.indoor_conditions ?? {}) as Record<string, unknown>;
      const indoorConditions: IndoorConditions = {
        cooling_setpoint_c:
          rawIndoor.cooling_setpoint_c !== undefined
            ? Number(rawIndoor.cooling_setpoint_c)
            : undefined,
        heating_setpoint_c:
          rawIndoor.heating_setpoint_c !== undefined
            ? Number(rawIndoor.heating_setpoint_c)
            : undefined,
        relative_humidity_percent:
          rawIndoor.relative_humidity_percent !== undefined
            ? Number(rawIndoor.relative_humidity_percent)
            : undefined,
      };

      // ── Parse optional scalars ──
      const ventRate =
        params.ventilation_l_per_s_per_person !== undefined
          ? Number(params.ventilation_l_per_s_per_person)
          : undefined;
      const safetyFactor =
        params.safety_factor !== undefined ? Number(params.safety_factor) : undefined;

      // ── Run calculation ──
      const result = calculateHvacLoads({
        spaces,
        envelope,
        climate: climateInput,
        indoor_conditions: indoorConditions,
        ventilation_l_per_s_per_person: ventRate,
        safety_factor: safetyFactor,
      });

      // ── Build summary text ──
      const cl = result.cooling_load;
      const hl = result.heating_load;
      const eq = result.equipment_sizing;
      const dc = result.design_conditions;

      const summary = [
        `HVAC Load Calculation Results`,
        `=============================`,
        ``,
        `Design Conditions:`,
        `  Outdoor Summer: ${dc.outdoor_summer_c} C | Outdoor Winter: ${dc.outdoor_winter_c} C`,
        `  Indoor Cooling: ${dc.indoor_cooling_c} C | Indoor Heating: ${dc.indoor_heating_c} C`,
        ``,
        `COOLING LOAD: ${cl.total_kw} kW (${cl.total_tons} tons)`,
        `  Walls:                ${cl.components.walls} kW`,
        `  Roof:                 ${cl.components.roof} kW`,
        `  Windows (conduction): ${cl.components.windows_conduction} kW`,
        `  Windows (solar):      ${cl.components.windows_solar} kW`,
        `  People (sensible):    ${cl.components.people_sensible} kW`,
        `  People (latent):      ${cl.components.people_latent} kW`,
        `  Lighting:             ${cl.components.lighting} kW`,
        `  Equipment:            ${cl.components.equipment} kW`,
        `  Ventilation (sens.):  ${cl.components.ventilation_sensible} kW`,
        `  Ventilation (lat.):   ${cl.components.ventilation_latent} kW`,
        `  Infiltration:         ${cl.components.infiltration} kW`,
        ``,
        `HEATING LOAD: ${hl.total_kw} kW (${hl.total_btu_hr} BTU/hr)`,
        `  Walls:         ${hl.components.walls} kW`,
        `  Roof:          ${hl.components.roof} kW`,
        `  Windows:       ${hl.components.windows} kW`,
        `  Floor:         ${hl.components.floor} kW`,
        `  Ventilation:   ${hl.components.ventilation} kW`,
        `  Infiltration:  ${hl.components.infiltration} kW`,
        ``,
        `EQUIPMENT SIZING:`,
        `  Cooling: ${eq.cooling_tons_recommended} tons`,
        `  Heating: ${eq.heating_kw_recommended} kW`,
        `  Airflow: ${eq.airflow_cfm} CFM`,
      ];

      if (cl.per_space.length > 1) {
        summary.push(``);
        summary.push(`PER-SPACE COOLING:`);
        for (const sp of cl.per_space) {
          summary.push(
            `  ${sp.name}: ${sp.total_kw} kW (sensible ${sp.sensible_kw} + latent ${sp.latent_kw})`,
          );
        }
      }

      return {
        content: [
          { type: "text", text: summary.join("\n") },
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
        details: {
          cooling_kw: result.cooling_load.total_kw,
          cooling_tons: result.cooling_load.total_tons,
          heating_kw: result.heating_load.total_kw,
          equipment_cooling_tons: result.equipment_sizing.cooling_tons_recommended,
          equipment_heating_kw: result.equipment_sizing.heating_kw_recommended,
        },
      };
    },
  };
}
