/**
 * Building energy model tool for openclaw-mini.
 *
 * Runs a simplified annual energy simulation using the degree-day method with
 * monthly calculations. Returns monthly/annual energy consumption by end use,
 * energy cost, and carbon emissions. Generates a stacked bar chart as SVG.
 *
 * Pure TypeScript -- only `fs` and `path` dependencies.
 */
import fs from "node:fs";
import path from "node:path";

// ─── Climate database types ────────────────────────────────────────────────

interface ClimateCity {
  latitude: number;
  longitude: number;
  elevation_m: number;
  hdd_18c: number;
  cdd_18c: number;
  summer_design_db_c: number;
  winter_design_db_c: number;
  summer_daily_range_c: number;
  avg_wind_speed_ms: number;
  annual_solar_kwh_per_sqm: number;
  monthly_temps_c: number[];
  monthly_solar_kwh_per_sqm: number[];
  climate_zone: string;
}

interface ClimateDatabase {
  version: string;
  cities: Record<string, ClimateCity>;
}

// ─── Input types ──────────────────────────────────────────────────────────

type BuildingType =
  | "residential"
  | "commercial_office"
  | "commercial_retail"
  | "education"
  | "healthcare";

type HeatingType =
  | "gas_furnace"
  | "heat_pump"
  | "electric_resistance"
  | "boiler_gas"
  | "boiler_electric";

type CoolingType =
  | "split_ac"
  | "central_chiller"
  | "heat_pump"
  | "window_ac"
  | "none";

type DhwType = "gas" | "electric" | "heat_pump";

interface EnvelopeInput {
  wall_u_value?: number;
  roof_u_value?: number;
  floor_u_value?: number;
  window_u_value?: number;
}

interface BuildingInput {
  area_sqm: number;
  stories?: number;
  building_type: BuildingType;
  envelope?: EnvelopeInput;
  window_to_wall_ratio?: number;
  infiltration_ach?: number;
  wall_area_sqm?: number;
  roof_area_sqm?: number;
}

interface SystemsInput {
  heating_type: HeatingType;
  cooling_type: CoolingType;
  heating_efficiency?: number;
  cooling_cop?: number;
  dhw_type?: DhwType;
  dhw_efficiency?: number;
}

interface ClimateInput {
  location?: string;
  hdd_18c?: number;
  cdd_18c?: number;
  monthly_temps_c?: number[];
}

interface OccupancyInput {
  people_density_per_sqm?: number;
  lighting_w_per_sqm?: number;
  equipment_w_per_sqm?: number;
  operating_hours_per_day?: number;
  operating_days_per_year?: number;
}

interface EnergyCostInput {
  electricity_per_kwh?: number;
  gas_per_therm?: number;
}

interface EnergyModelArgs {
  building: BuildingInput;
  systems: SystemsInput;
  climate: ClimateInput;
  occupancy?: OccupancyInput;
  energy_cost?: EnergyCostInput;
  output_path?: string;
}

// ─── Output types ──────────────────────────────────────────────────────────

interface MonthlyResult {
  month: string;
  heating_kwh: number;
  cooling_kwh: number;
  lighting_kwh: number;
  equipment_kwh: number;
  dhw_kwh: number;
  fans_kwh: number;
  total_kwh: number;
  avg_temp_c: number;
}

interface AnnualResult {
  total_kwh: number;
  total_kwh_per_sqm: number;
  total_cost_usd: number;
  total_co2_kg: number;
  by_end_use: {
    heating_kwh: number;
    cooling_kwh: number;
    lighting_kwh: number;
    equipment_kwh: number;
    dhw_kwh: number;
    fans_kwh: number;
  };
}

interface BenchmarkResult {
  ashrae_90_1_target_kwh_per_sqm: number;
  energy_star_target: number;
  comparison: string;
}

interface EnergyModelResult {
  building_summary: Record<string, unknown>;
  annual: AnnualResult;
  monthly: MonthlyResult[];
  benchmarks: BenchmarkResult;
  output_path?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Air density at sea level, kg/m^3 */
const AIR_DENSITY = 1.2;
/** Specific heat of air, kJ/(kg*K) */
const AIR_SPECIFIC_HEAT = 1.005;
/** Solar heat gain coefficient for standard double-pane glazing */
const DEFAULT_SHGC = 0.40;
/** Average orientation factor (accounts for different facade orientations) */
const ORIENTATION_FACTOR = 0.55;

/** Carbon emission factors */
const ELECTRICITY_CO2_KG_PER_KWH = 0.42;
const GAS_CO2_KG_PER_THERM = 5.3;
/** 1 therm = 29.3 kWh */
const KWH_PER_THERM = 29.3;

/** Default heating efficiencies (COP or AFUE as fraction) */
const DEFAULT_HEATING_EFFICIENCY: Record<HeatingType, number> = {
  gas_furnace: 0.92,
  heat_pump: 3.0,
  electric_resistance: 1.0,
  boiler_gas: 0.85,
  boiler_electric: 0.98,
};

/** Default cooling COP */
const DEFAULT_COOLING_COP: Record<CoolingType, number> = {
  split_ac: 3.5,
  central_chiller: 5.0,
  heat_pump: 3.2,
  window_ac: 2.8,
  none: 1.0,
};

/** Default DHW efficiency */
const DEFAULT_DHW_EFFICIENCY: Record<DhwType, number> = {
  gas: 0.82,
  electric: 0.95,
  heat_pump: 3.0,
};

/** Whether heating system uses gas */
const HEATING_USES_GAS: Record<HeatingType, boolean> = {
  gas_furnace: true,
  heat_pump: false,
  electric_resistance: false,
  boiler_gas: true,
  boiler_electric: false,
};

/** Default occupancy values by building type */
const OCCUPANCY_DEFAULTS: Record<
  BuildingType,
  {
    people_density_per_sqm: number;
    lighting_w_per_sqm: number;
    equipment_w_per_sqm: number;
    operating_hours_per_day: number;
    operating_days_per_year: number;
    dhw_liters_per_sqm_per_day: number;
  }
> = {
  residential: {
    people_density_per_sqm: 0.04,
    lighting_w_per_sqm: 5,
    equipment_w_per_sqm: 3,
    operating_hours_per_day: 16,
    operating_days_per_year: 365,
    dhw_liters_per_sqm_per_day: 1.5,
  },
  commercial_office: {
    people_density_per_sqm: 0.1,
    lighting_w_per_sqm: 10,
    equipment_w_per_sqm: 15,
    operating_hours_per_day: 10,
    operating_days_per_year: 260,
    dhw_liters_per_sqm_per_day: 0.5,
  },
  commercial_retail: {
    people_density_per_sqm: 0.15,
    lighting_w_per_sqm: 15,
    equipment_w_per_sqm: 5,
    operating_hours_per_day: 12,
    operating_days_per_year: 360,
    dhw_liters_per_sqm_per_day: 0.3,
  },
  education: {
    people_density_per_sqm: 0.25,
    lighting_w_per_sqm: 12,
    equipment_w_per_sqm: 5,
    operating_hours_per_day: 8,
    operating_days_per_year: 200,
    dhw_liters_per_sqm_per_day: 0.4,
  },
  healthcare: {
    people_density_per_sqm: 0.1,
    lighting_w_per_sqm: 12,
    equipment_w_per_sqm: 20,
    operating_hours_per_day: 24,
    operating_days_per_year: 365,
    dhw_liters_per_sqm_per_day: 2.0,
  },
};

/** ASHRAE 90.1 approximate EUI targets (kWh/m^2/yr) by building type */
const ASHRAE_EUI_TARGETS: Record<BuildingType, number> = {
  residential: 130,
  commercial_office: 150,
  commercial_retail: 170,
  education: 140,
  healthcare: 300,
};

/** Energy Star approximate EUI targets (kWh/m^2/yr) */
const ENERGY_STAR_TARGETS: Record<BuildingType, number> = {
  residential: 100,
  commercial_office: 120,
  commercial_retail: 140,
  education: 110,
  healthcare: 250,
};

// ─── Climate database loading ──────────────────────────────────────────────

let cachedClimateDb: ClimateDatabase | null = null;

function loadClimateDatabase(): ClimateDatabase {
  if (cachedClimateDb) return cachedClimateDb;
  const dbPath = path.resolve(__dirname, "..", "..", "..", "data", "climate-data.json");
  const raw = fs.readFileSync(dbPath, "utf-8");
  cachedClimateDb = JSON.parse(raw) as ClimateDatabase;
  return cachedClimateDb;
}

function resolveClimate(input: ClimateInput): {
  monthly_temps_c: number[];
  monthly_solar_kwh_per_sqm: number[];
  hdd_18c: number;
  cdd_18c: number;
  location_name: string;
  climate_zone: string;
} {
  if (input.location) {
    const db = loadClimateDatabase();
    // Try exact match first
    let city = db.cities[input.location];
    let matchedName = input.location;

    if (!city) {
      // Case-insensitive partial match
      const lower = input.location.toLowerCase();
      for (const [name, data] of Object.entries(db.cities)) {
        if (name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase().split(",")[0].trim())) {
          city = data;
          matchedName = name;
          break;
        }
      }
    }

    if (city) {
      return {
        monthly_temps_c: city.monthly_temps_c,
        monthly_solar_kwh_per_sqm: city.monthly_solar_kwh_per_sqm,
        hdd_18c: city.hdd_18c,
        cdd_18c: city.cdd_18c,
        location_name: matchedName,
        climate_zone: city.climate_zone,
      };
    }
    throw new Error(
      `Location "${input.location}" not found in climate database. ` +
      `Available cities: ${Object.keys(db.cities).join(", ")}`
    );
  }

  // Explicit climate data
  if (!input.monthly_temps_c || input.monthly_temps_c.length !== 12) {
    throw new Error("climate.monthly_temps_c must be a 12-element array when not using location.");
  }
  const hdd = input.hdd_18c ?? computeHDD(input.monthly_temps_c);
  const cdd = input.cdd_18c ?? computeCDD(input.monthly_temps_c);

  // Estimate solar from latitude (simple model)
  const monthSolar = estimateMonthlySolar(40); // default latitude

  return {
    monthly_temps_c: input.monthly_temps_c,
    monthly_solar_kwh_per_sqm: monthSolar,
    hdd_18c: hdd,
    cdd_18c: cdd,
    location_name: "Custom",
    climate_zone: "Unknown",
  };
}

/** Approximate HDD from monthly average temps */
function computeHDD(temps: number[]): number {
  let hdd = 0;
  for (let i = 0; i < 12; i++) {
    if (temps[i] < 18) {
      hdd += (18 - temps[i]) * DAYS_IN_MONTH[i];
    }
  }
  return Math.round(hdd);
}

/** Approximate CDD from monthly average temps */
function computeCDD(temps: number[]): number {
  let cdd = 0;
  for (let i = 0; i < 12; i++) {
    if (temps[i] > 18) {
      cdd += (temps[i] - 18) * DAYS_IN_MONTH[i];
    }
  }
  return Math.round(cdd);
}

/** Simple estimate of monthly solar radiation for a given latitude */
function estimateMonthlySolar(lat: number): number[] {
  // Rough sinusoidal model based on latitude
  const base = 180 - lat * 1.5;
  const amplitude = 60 + lat * 0.8;
  const result: number[] = [];
  for (let m = 0; m < 12; m++) {
    const angle = ((m - 5.5) / 12) * 2 * Math.PI; // peak in June/July
    result.push(Math.max(20, Math.round(base + amplitude * Math.cos(angle))));
  }
  return result;
}

// ─── Core energy model ──────────────────────────────────────────────────────

function runEnergyModel(args: EnergyModelArgs): EnergyModelResult {
  const { building, systems, climate: climateInput, occupancy: occInput, energy_cost, output_path } = args;

  // ── Resolve climate data ──
  const climate = resolveClimate(climateInput);

  // ── Building geometry ──
  const area = building.area_sqm;
  const stories = building.stories ?? 1;
  const floorArea = area; // total conditioned floor area
  const areaPerFloor = area / stories;
  const perimeter = 4 * Math.sqrt(areaPerFloor); // approximate square footprint
  const storyHeight = 3.0; // m, assumed floor-to-floor

  const wallAreaTotal =
    building.wall_area_sqm ?? perimeter * storyHeight * stories;
  const roofArea = building.roof_area_sqm ?? areaPerFloor;

  const wwr = Math.max(0, Math.min(1, building.window_to_wall_ratio ?? 0.3));
  const windowArea = wallAreaTotal * wwr;
  const opaqueWallArea = wallAreaTotal - windowArea;

  const infiltrationAch = building.infiltration_ach ?? 0.5;
  const volume = floorArea * storyHeight; // approximate conditioned volume

  // ── Envelope U-values (W/m^2K) ──
  const env = building.envelope ?? {};
  const wallU = env.wall_u_value ?? 0.5;
  const roofU = env.roof_u_value ?? 0.3;
  const floorU = env.floor_u_value ?? 0.5;
  const windowU = env.window_u_value ?? 2.5;

  // ── Overall UA (W/K) ──
  const UA_wall = opaqueWallArea * wallU;
  const UA_roof = roofArea * roofU;
  const UA_floor = areaPerFloor * floorU;
  const UA_window = windowArea * windowU;
  const UA_total = UA_wall + UA_roof + UA_floor + UA_window;

  // ── Infiltration conductance (W/K) ──
  // Q_inf = rho * cp * V * ACH / 3600 (W/K when multiplied by dT)
  const infiltration_conductance = AIR_DENSITY * AIR_SPECIFIC_HEAT * 1000 * volume * infiltrationAch / 3600;

  // ── Ventilation conductance (W/K) ──
  // Outdoor air requirement: ~0.3 ACH for offices, 0.35 ACH for residential
  const ventAch = building.building_type === "residential" ? 0.35 : 0.3;
  const ventilation_conductance = AIR_DENSITY * AIR_SPECIFIC_HEAT * 1000 * volume * ventAch / 3600;

  // Total conductance
  const totalConductance = UA_total + infiltration_conductance + ventilation_conductance;

  // ── Systems ──
  const heatingEff = systems.heating_efficiency ?? DEFAULT_HEATING_EFFICIENCY[systems.heating_type];
  const coolingCop = systems.cooling_cop ?? DEFAULT_COOLING_COP[systems.cooling_type];
  const dhwType = systems.dhw_type ?? "gas";
  const dhwEff = systems.dhw_efficiency ?? DEFAULT_DHW_EFFICIENCY[dhwType];
  const heatingUsesGas = HEATING_USES_GAS[systems.heating_type];
  const dhwUsesGas = dhwType === "gas";

  // ── Occupancy ──
  const bType = building.building_type;
  const defaults = OCCUPANCY_DEFAULTS[bType];
  const occ = {
    people_density: occInput?.people_density_per_sqm ?? defaults.people_density_per_sqm,
    lighting_w: occInput?.lighting_w_per_sqm ?? defaults.lighting_w_per_sqm,
    equipment_w: occInput?.equipment_w_per_sqm ?? defaults.equipment_w_per_sqm,
    hours_per_day: occInput?.operating_hours_per_day ?? defaults.operating_hours_per_day,
    days_per_year: occInput?.operating_days_per_year ?? defaults.operating_days_per_year,
    dhw_liters: defaults.dhw_liters_per_sqm_per_day,
  };

  // Compute days per month proportionally from operating_days_per_year
  const daysPerMonth = DAYS_IN_MONTH.map(d => d * (occ.days_per_year / 365));

  // ── Internal gains (W) ──
  const peopleSensibleW = occ.people_density * floorArea * 75; // 75W sensible per person
  const lightingW = occ.lighting_w * floorArea;
  const equipmentW = occ.equipment_w * floorArea;
  const totalInternalGainsW = peopleSensibleW + lightingW + equipmentW;

  // Internal gains offset (kWh per month) -- only during occupied hours
  // Gains reduce heating load but increase cooling load

  // ── Energy cost ──
  const elecRate = energy_cost?.electricity_per_kwh ?? 0.13;
  const gasRate = energy_cost?.gas_per_therm ?? 1.20;

  // ── Monthly calculations ──
  const monthly: MonthlyResult[] = [];
  let annualHeating = 0;
  let annualCooling = 0;
  let annualLighting = 0;
  let annualEquipment = 0;
  let annualDhw = 0;
  let annualFans = 0;

  for (let m = 0; m < 12; m++) {
    const avgTemp = climate.monthly_temps_c[m];
    const days = DAYS_IN_MONTH[m];
    const operatingDays = daysPerMonth[m];
    const operatingHoursMonth = occ.hours_per_day * operatingDays;
    const monthSolar = climate.monthly_solar_kwh_per_sqm[m];

    // ── Heating degree-day contribution for this month ──
    // Monthly HDD approximation
    const monthHDD = avgTemp < 18 ? (18 - avgTemp) * days : 0;

    // ── Cooling degree-day contribution for this month ──
    const monthCDD = avgTemp > 18 ? (avgTemp - 18) * days : 0;

    // ── Envelope heating load (kWh) ──
    // Q = totalConductance * HDD * 24 / 1000
    const envelopeHeatingKwh = totalConductance * monthHDD * 24 / 1000;

    // ── Internal gains offset during heating (kWh) ──
    // Internal gains only offset heating during occupied hours in heating months
    const internalGainsKwh = totalInternalGainsW * operatingHoursMonth / 1000;

    // ── Solar gains through windows (kWh) ──
    // Q_solar = window_area * SHGC * monthly_solar * orientation_factor
    const solarGainsKwh = windowArea * DEFAULT_SHGC * monthSolar * ORIENTATION_FACTOR / 1000;

    // ── Net heating load (kWh) ──
    let netHeatingKwh = Math.max(0, envelopeHeatingKwh - internalGainsKwh - solarGainsKwh);
    // Apply heating efficiency
    let heatingEnergyKwh = netHeatingKwh / heatingEff;

    // ── Cooling load (kWh) ──
    // Envelope cooling load
    const envelopeCoolingKwh = totalConductance * monthCDD * 24 / 1000;
    // During cooling, internal gains and solar gains ADD to cooling load
    // But envelope provides some relief when outdoor temp > indoor temp
    const coolingInternalKwh = totalInternalGainsW * operatingHoursMonth / 1000;
    const coolingTotal = envelopeCoolingKwh + coolingInternalKwh + solarGainsKwh;
    // Net cooling: subtract envelope losses during mild months
    let netCoolingKwh = Math.max(0, coolingTotal - envelopeHeatingKwh * 0.1);
    // In heating-dominated months, cooling should be minimal
    if (monthHDD > monthCDD * 2) {
      netCoolingKwh = Math.max(0, netCoolingKwh * 0.15);
    }
    let coolingEnergyKwh = systems.cooling_type === "none" ? 0 : netCoolingKwh / coolingCop;

    // ── Lighting (kWh) ──
    const lightingKwh = occ.lighting_w * floorArea * operatingHoursMonth / 1000;

    // ── Equipment / plug loads (kWh) ──
    const equipmentKwh = occ.equipment_w * floorArea * operatingHoursMonth / 1000;

    // ── Domestic hot water (kWh) ──
    // Energy = volume * density * Cp * dT / efficiency
    // dT = delivery temp (50C) - cold water temp (approx: avgTemp * 0.6 + 5)
    const coldWaterTemp = Math.max(5, avgTemp * 0.6 + 5);
    const dhwDeltaT = 50 - coldWaterTemp;
    const dhwLitersMonth = occ.dhw_liters * floorArea * days;
    // Energy (kWh) = liters * 1 kg/L * 4.186 kJ/(kg*K) * dT / 3600 / efficiency
    const dhwKwh = (dhwLitersMonth * 4.186 * dhwDeltaT) / 3600 / dhwEff;

    // ── Fan/pump energy ──
    // Estimate as 30% of HVAC energy
    const hvacKwh = heatingEnergyKwh + coolingEnergyKwh;
    const fansKwh = hvacKwh * 0.30;

    const totalKwh = heatingEnergyKwh + coolingEnergyKwh + lightingKwh + equipmentKwh + dhwKwh + fansKwh;

    monthly.push({
      month: MONTH_NAMES[m],
      heating_kwh: round1(heatingEnergyKwh),
      cooling_kwh: round1(coolingEnergyKwh),
      lighting_kwh: round1(lightingKwh),
      equipment_kwh: round1(equipmentKwh),
      dhw_kwh: round1(dhwKwh),
      fans_kwh: round1(fansKwh),
      total_kwh: round1(totalKwh),
      avg_temp_c: round1(avgTemp),
    });

    annualHeating += heatingEnergyKwh;
    annualCooling += coolingEnergyKwh;
    annualLighting += lightingKwh;
    annualEquipment += equipmentKwh;
    annualDhw += dhwKwh;
    annualFans += fansKwh;
  }

  const totalAnnualKwh = annualHeating + annualCooling + annualLighting + annualEquipment + annualDhw + annualFans;
  const eui = totalAnnualKwh / floorArea;

  // ── Energy cost ──
  // Split electricity vs gas usage
  let electricKwh = annualCooling + annualLighting + annualEquipment + annualFans;
  let gasKwh = 0;

  if (heatingUsesGas) {
    gasKwh += annualHeating;
  } else {
    electricKwh += annualHeating;
  }

  if (dhwUsesGas) {
    gasKwh += annualDhw;
  } else {
    electricKwh += annualDhw;
  }

  const electricCost = electricKwh * elecRate;
  const gasTherms = gasKwh / KWH_PER_THERM;
  const gasCost = gasTherms * gasRate;
  const totalCost = electricCost + gasCost;

  // ── Carbon emissions ──
  const electricCO2 = electricKwh * ELECTRICITY_CO2_KG_PER_KWH;
  const gasCO2 = gasTherms * GAS_CO2_KG_PER_THERM;
  const totalCO2 = electricCO2 + gasCO2;

  // ── Benchmarks ──
  const ashraeTarget = ASHRAE_EUI_TARGETS[bType];
  const energyStarTarget = ENERGY_STAR_TARGETS[bType];
  let comparison: string;
  if (eui <= energyStarTarget) {
    comparison = `Excellent: EUI of ${round1(eui)} kWh/m2 is below Energy Star target (${energyStarTarget} kWh/m2).`;
  } else if (eui <= ashraeTarget) {
    comparison = `Good: EUI of ${round1(eui)} kWh/m2 meets ASHRAE 90.1 target (${ashraeTarget} kWh/m2) but exceeds Energy Star (${energyStarTarget} kWh/m2).`;
  } else if (eui <= ashraeTarget * 1.3) {
    comparison = `Fair: EUI of ${round1(eui)} kWh/m2 is within 30% above ASHRAE 90.1 target (${ashraeTarget} kWh/m2). Consider envelope or systems improvements.`;
  } else {
    comparison = `Poor: EUI of ${round1(eui)} kWh/m2 significantly exceeds ASHRAE 90.1 target (${ashraeTarget} kWh/m2). Major improvements recommended.`;
  }

  // ── SVG chart ──
  let savedPath: string | undefined;
  if (output_path) {
    const svg = generateEnergySVG(monthly, climate.monthly_temps_c, bType, climate.location_name, eui);
    const resolvedPath = path.resolve(output_path);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, svg, "utf-8");
    savedPath = resolvedPath;
  }

  return {
    building_summary: {
      building_type: bType,
      area_sqm: floorArea,
      stories,
      location: climate.location_name,
      climate_zone: climate.climate_zone,
      hdd_18c: climate.hdd_18c,
      cdd_18c: climate.cdd_18c,
      wall_area_sqm: round1(wallAreaTotal),
      window_area_sqm: round1(windowArea),
      roof_area_sqm: round1(roofArea),
      ua_total_w_per_k: round1(UA_total),
      infiltration_conductance_w_per_k: round1(infiltration_conductance),
      heating_system: systems.heating_type,
      heating_efficiency: heatingEff,
      cooling_system: systems.cooling_type,
      cooling_cop: coolingCop,
      dhw_system: dhwType,
    },
    annual: {
      total_kwh: round1(totalAnnualKwh),
      total_kwh_per_sqm: round1(eui),
      total_cost_usd: round2(totalCost),
      total_co2_kg: round1(totalCO2),
      by_end_use: {
        heating_kwh: round1(annualHeating),
        cooling_kwh: round1(annualCooling),
        lighting_kwh: round1(annualLighting),
        equipment_kwh: round1(annualEquipment),
        dhw_kwh: round1(annualDhw),
        fans_kwh: round1(annualFans),
      },
    },
    monthly,
    benchmarks: {
      ashrae_90_1_target_kwh_per_sqm: ashraeTarget,
      energy_star_target: energyStarTarget,
      comparison,
    },
    output_path: savedPath,
  };
}

// ─── SVG Chart Generation ──────────────────────────────────────────────────

function generateEnergySVG(
  monthly: MonthlyResult[],
  monthlyTemps: number[],
  buildingType: BuildingType,
  location: string,
  eui: number,
): string {
  const width = 800;
  const height = 400;
  const margin = { top: 50, right: 80, bottom: 55, left: 65 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  // Find max stacked value for scaling
  let maxTotal = 0;
  for (const m of monthly) {
    if (m.total_kwh > maxTotal) maxTotal = m.total_kwh;
  }
  maxTotal = maxTotal * 1.1; // 10% headroom
  if (maxTotal === 0) maxTotal = 1;

  // Temperature range for right axis
  let tempMin = Infinity;
  let tempMax = -Infinity;
  for (const t of monthlyTemps) {
    if (t < tempMin) tempMin = t;
    if (t > tempMax) tempMax = t;
  }
  const tempRange = Math.max(1, tempMax - tempMin) * 1.2;
  const tempMid = (tempMax + tempMin) / 2;
  const tempAxisMin = tempMid - tempRange / 2;
  const tempAxisMax = tempMid + tempRange / 2;

  const barWidth = plotWidth / 12 * 0.7;
  const barGap = plotWidth / 12 * 0.3;

  const colors = {
    heating: "#E53935",
    cooling: "#1E88E5",
    lighting: "#FDD835",
    equipment: "#43A047",
    dhw: "#FF8F00",
    fans: "#8E24AA",
  };

  const lines: string[] = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Arial, sans-serif" font-size="11">`);
  lines.push(`<rect width="${width}" height="${height}" fill="#fafafa" rx="4"/>`);

  // Title
  const typeLabel = buildingType.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  lines.push(`<text x="${width / 2}" y="20" text-anchor="middle" font-size="14" font-weight="bold">Monthly Energy Consumption - ${typeLabel} - ${location}</text>`);
  lines.push(`<text x="${width / 2}" y="36" text-anchor="middle" font-size="11" fill="#666">EUI: ${round1(eui)} kWh/m\u00b2/yr</text>`);

  // Plot area background
  lines.push(`<rect x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}" fill="white" stroke="#ddd"/>`);

  // Y-axis gridlines
  const nGridY = 5;
  for (let i = 0; i <= nGridY; i++) {
    const y = margin.top + plotHeight - (i / nGridY) * plotHeight;
    const val = (i / nGridY) * maxTotal;
    lines.push(`<line x1="${margin.left}" y1="${y}" x2="${margin.left + plotWidth}" y2="${y}" stroke="#eee" stroke-width="0.5"/>`);
    lines.push(`<text x="${margin.left - 5}" y="${y + 4}" text-anchor="end" font-size="9" fill="#666">${Math.round(val)}</text>`);
  }

  // Y-axis label (left)
  lines.push(`<text x="15" y="${margin.top + plotHeight / 2}" text-anchor="middle" font-size="11" fill="#333" transform="rotate(-90, 15, ${margin.top + plotHeight / 2})">Energy (kWh)</text>`);

  // Y-axis label (right - temperature)
  lines.push(`<text x="${width - 10}" y="${margin.top + plotHeight / 2}" text-anchor="middle" font-size="11" fill="#d32f2f" transform="rotate(90, ${width - 10}, ${margin.top + plotHeight / 2})">Temperature (\u00b0C)</text>`);

  // Right axis temperature gridlines and labels
  for (let i = 0; i <= nGridY; i++) {
    const y = margin.top + plotHeight - (i / nGridY) * plotHeight;
    const tVal = tempAxisMin + (i / nGridY) * (tempAxisMax - tempAxisMin);
    lines.push(`<text x="${margin.left + plotWidth + 5}" y="${y + 4}" text-anchor="start" font-size="9" fill="#d32f2f">${Math.round(tVal)}\u00b0</text>`);
  }

  // Stacked bars
  const endUseKeys: Array<keyof typeof colors> = ["heating", "cooling", "lighting", "equipment", "dhw", "fans"];

  for (let m = 0; m < 12; m++) {
    const xCenter = margin.left + (m + 0.5) * (plotWidth / 12);
    const xLeft = xCenter - barWidth / 2;
    let yBase = margin.top + plotHeight;

    const values: Record<string, number> = {
      heating: monthly[m].heating_kwh,
      cooling: monthly[m].cooling_kwh,
      lighting: monthly[m].lighting_kwh,
      equipment: monthly[m].equipment_kwh,
      dhw: monthly[m].dhw_kwh,
      fans: monthly[m].fans_kwh,
    };

    for (const key of endUseKeys) {
      const val = values[key];
      if (val <= 0) continue;
      const barH = (val / maxTotal) * plotHeight;
      const yTop = yBase - barH;
      lines.push(`<rect x="${xLeft}" y="${yTop}" width="${barWidth}" height="${barH}" fill="${colors[key]}" opacity="0.85"/>`);
      yBase = yTop;
    }

    // Month label
    lines.push(`<text x="${xCenter}" y="${margin.top + plotHeight + 15}" text-anchor="middle" font-size="10" fill="#333">${MONTH_NAMES[m]}</text>`);
  }

  // Temperature line overlay
  const tempToY = (t: number) => margin.top + plotHeight - ((t - tempAxisMin) / (tempAxisMax - tempAxisMin)) * plotHeight;
  let tempPath = "";
  for (let m = 0; m < 12; m++) {
    const x = margin.left + (m + 0.5) * (plotWidth / 12);
    const y = tempToY(monthlyTemps[m]);
    tempPath += m === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`;
  }
  lines.push(`<path d="${tempPath}" fill="none" stroke="#d32f2f" stroke-width="2" stroke-dasharray="6,3"/>`);
  // Temperature dots
  for (let m = 0; m < 12; m++) {
    const x = margin.left + (m + 0.5) * (plotWidth / 12);
    const y = tempToY(monthlyTemps[m]);
    lines.push(`<circle cx="${x}" cy="${y}" r="3" fill="#d32f2f"/>`);
  }

  // Legend
  const legendX = margin.left + 10;
  const legendY = height - 18;
  const legendItems = [
    { label: "Heating", color: colors.heating },
    { label: "Cooling", color: colors.cooling },
    { label: "Lighting", color: colors.lighting },
    { label: "Equipment", color: colors.equipment },
    { label: "DHW", color: colors.dhw },
    { label: "Fans", color: colors.fans },
    { label: "Temp", color: "#d32f2f" },
  ];

  let lx = legendX;
  for (const item of legendItems) {
    if (item.label === "Temp") {
      lines.push(`<line x1="${lx}" y1="${legendY - 4}" x2="${lx + 15}" y2="${legendY - 4}" stroke="${item.color}" stroke-width="2" stroke-dasharray="4,2"/>`);
    } else {
      lines.push(`<rect x="${lx}" y="${legendY - 9}" width="12" height="12" fill="${item.color}" opacity="0.85" rx="1"/>`);
    }
    lines.push(`<text x="${lx + 17}" y="${legendY}" font-size="9" fill="#333">${item.label}</text>`);
    lx += item.label.length * 6 + 30;
  }

  lines.push(`</svg>`);
  return lines.join("\n");
}

// ─── Utility ──────────────────────────────────────────────────────────────

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Tool definition ──────────────────────────────────────────────────────

export function createEnergyModelToolDefinition() {
  return {
    name: "energy_model",
    label: "Energy Model",
    description:
      "Run a simplified annual energy simulation for a building using the degree-day method " +
      "with monthly calculations. Returns monthly and annual energy consumption by end use " +
      "(heating, cooling, lighting, equipment, DHW, fans), energy cost, carbon emissions, " +
      "and comparison against ASHRAE 90.1 and Energy Star benchmarks. Can generate a stacked " +
      "bar chart SVG showing monthly energy breakdown with temperature overlay.",
    parameters: {
      type: "object",
      properties: {
        building: {
          type: "object",
          description: "Building geometry and envelope properties.",
          properties: {
            area_sqm: {
              type: "number",
              description: "Total conditioned floor area in square meters.",
              exclusiveMinimum: 0,
            },
            stories: {
              type: "number",
              description: "Number of stories (default: 1).",
              minimum: 1,
              default: 1,
            },
            building_type: {
              type: "string",
              enum: ["residential", "commercial_office", "commercial_retail", "education", "healthcare"],
              description:
                "Building use type. Determines default occupancy, lighting, equipment densities. " +
                "'residential' = houses/apartments, 'commercial_office' = office buildings, " +
                "'commercial_retail' = stores/malls, 'education' = schools/universities, " +
                "'healthcare' = hospitals/clinics.",
            },
            envelope: {
              type: "object",
              description: "Thermal envelope U-values in W/(m^2*K). Lower values = better insulation.",
              properties: {
                wall_u_value: { type: "number", description: "Wall U-value W/(m^2*K). Default: 0.5.", default: 0.5 },
                roof_u_value: { type: "number", description: "Roof U-value W/(m^2*K). Default: 0.3.", default: 0.3 },
                floor_u_value: { type: "number", description: "Floor U-value W/(m^2*K). Default: 0.5.", default: 0.5 },
                window_u_value: { type: "number", description: "Window U-value W/(m^2*K). Default: 2.5.", default: 2.5 },
              },
            },
            window_to_wall_ratio: {
              type: "number",
              description: "Window-to-wall area ratio, 0 to 1. Default: 0.3.",
              minimum: 0,
              maximum: 1,
              default: 0.3,
            },
            infiltration_ach: {
              type: "number",
              description: "Air infiltration rate in air changes per hour. Default: 0.5.",
              minimum: 0,
              default: 0.5,
            },
            wall_area_sqm: {
              type: "number",
              description: "Total wall area in m^2. If omitted, calculated from building footprint assuming square plan.",
            },
            roof_area_sqm: {
              type: "number",
              description: "Roof area in m^2. Defaults to floor area / stories.",
            },
          },
          required: ["area_sqm", "building_type"],
        },
        systems: {
          type: "object",
          description: "HVAC and DHW system types and efficiencies.",
          properties: {
            heating_type: {
              type: "string",
              enum: ["gas_furnace", "heat_pump", "electric_resistance", "boiler_gas", "boiler_electric"],
              description:
                "Heating system type. 'gas_furnace' (AFUE ~0.92), 'heat_pump' (COP ~3.0), " +
                "'electric_resistance' (COP 1.0), 'boiler_gas' (AFUE ~0.85), 'boiler_electric' (eff ~0.98).",
            },
            cooling_type: {
              type: "string",
              enum: ["split_ac", "central_chiller", "heat_pump", "window_ac", "none"],
              description:
                "Cooling system type. 'split_ac' (COP ~3.5), 'central_chiller' (COP ~5.0), " +
                "'heat_pump' (COP ~3.2), 'window_ac' (COP ~2.8), 'none' for uncooled buildings.",
            },
            heating_efficiency: {
              type: "number",
              description: "Heating COP or AFUE. Overrides default for heating_type.",
              exclusiveMinimum: 0,
            },
            cooling_cop: {
              type: "number",
              description: "Cooling coefficient of performance. Overrides default for cooling_type.",
              exclusiveMinimum: 0,
            },
            dhw_type: {
              type: "string",
              enum: ["gas", "electric", "heat_pump"],
              description: "Domestic hot water heater type. Default: 'gas'.",
              default: "gas",
            },
            dhw_efficiency: {
              type: "number",
              description: "DHW heater efficiency or COP. Overrides default for dhw_type.",
              exclusiveMinimum: 0,
            },
          },
          required: ["heating_type", "cooling_type"],
        },
        climate: {
          type: "object",
          description:
            "Climate data. Provide either 'location' to look up from the built-in database " +
            "(30+ US cities), or provide explicit 'monthly_temps_c' (12-element array) and " +
            "optionally 'hdd_18c'/'cdd_18c'.",
          properties: {
            location: {
              type: "string",
              description:
                "City name from climate database, e.g. 'New York, NY', 'Phoenix, AZ'. " +
                "Supports partial matching.",
            },
            hdd_18c: {
              type: "number",
              description: "Annual heating degree-days base 18C. Used if location not specified.",
            },
            cdd_18c: {
              type: "number",
              description: "Annual cooling degree-days base 18C. Used if location not specified.",
            },
            monthly_temps_c: {
              type: "array",
              items: { type: "number" },
              description:
                "Array of 12 monthly average temperatures in Celsius (Jan-Dec). Required if location not specified.",
              minItems: 12,
              maxItems: 12,
            },
          },
        },
        occupancy: {
          type: "object",
          description: "Override default occupancy and load assumptions for the building type.",
          properties: {
            people_density_per_sqm: {
              type: "number",
              description: "Occupant density in people per m^2. Default varies by building type.",
            },
            lighting_w_per_sqm: {
              type: "number",
              description: "Lighting power density in W/m^2. Default: 5-15 by type.",
            },
            equipment_w_per_sqm: {
              type: "number",
              description: "Equipment/plug load power density in W/m^2. Default: 3-20 by type.",
            },
            operating_hours_per_day: {
              type: "number",
              description: "Daily operating hours. Default: 8-24 by type.",
            },
            operating_days_per_year: {
              type: "number",
              description: "Annual operating days. Default: 200-365 by type.",
            },
          },
        },
        energy_cost: {
          type: "object",
          description: "Utility rates for cost calculation.",
          properties: {
            electricity_per_kwh: {
              type: "number",
              description: "Electricity rate in USD/kWh. Default: 0.13.",
              default: 0.13,
            },
            gas_per_therm: {
              type: "number",
              description: "Natural gas rate in USD/therm. Default: 1.20.",
              default: 1.20,
            },
          },
        },
        output_path: {
          type: "string",
          description:
            "File path to save monthly energy chart as SVG. If omitted, no chart is generated.",
        },
      },
      required: ["building", "systems", "climate"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }> => {
      const params = (args ?? {}) as Record<string, unknown>;

      // ── Parse building ──
      const rawBuilding = params.building as Record<string, unknown> | undefined;
      if (!rawBuilding || typeof rawBuilding !== "object") {
        throw new Error("'building' parameter is required and must be an object.");
      }
      const areaSqm = Number(rawBuilding.area_sqm);
      if (!Number.isFinite(areaSqm) || areaSqm <= 0) {
        throw new Error("building.area_sqm must be a positive number.");
      }
      const bType = String(rawBuilding.building_type ?? "") as BuildingType;
      const validTypes: BuildingType[] = ["residential", "commercial_office", "commercial_retail", "education", "healthcare"];
      if (!validTypes.includes(bType)) {
        throw new Error(`Invalid building_type "${bType}". Must be one of: ${validTypes.join(", ")}`);
      }
      const rawEnvelope = (rawBuilding.envelope ?? {}) as Record<string, unknown>;
      const building: BuildingInput = {
        area_sqm: areaSqm,
        stories: rawBuilding.stories != null ? Math.max(1, Math.round(Number(rawBuilding.stories))) : undefined,
        building_type: bType,
        envelope: {
          wall_u_value: rawEnvelope.wall_u_value != null ? Number(rawEnvelope.wall_u_value) : undefined,
          roof_u_value: rawEnvelope.roof_u_value != null ? Number(rawEnvelope.roof_u_value) : undefined,
          floor_u_value: rawEnvelope.floor_u_value != null ? Number(rawEnvelope.floor_u_value) : undefined,
          window_u_value: rawEnvelope.window_u_value != null ? Number(rawEnvelope.window_u_value) : undefined,
        },
        window_to_wall_ratio: rawBuilding.window_to_wall_ratio != null ? Number(rawBuilding.window_to_wall_ratio) : undefined,
        infiltration_ach: rawBuilding.infiltration_ach != null ? Number(rawBuilding.infiltration_ach) : undefined,
        wall_area_sqm: rawBuilding.wall_area_sqm != null ? Number(rawBuilding.wall_area_sqm) : undefined,
        roof_area_sqm: rawBuilding.roof_area_sqm != null ? Number(rawBuilding.roof_area_sqm) : undefined,
      };

      // ── Parse systems ──
      const rawSystems = params.systems as Record<string, unknown> | undefined;
      if (!rawSystems || typeof rawSystems !== "object") {
        throw new Error("'systems' parameter is required and must be an object.");
      }
      const hType = String(rawSystems.heating_type ?? "") as HeatingType;
      const validHeating: HeatingType[] = ["gas_furnace", "heat_pump", "electric_resistance", "boiler_gas", "boiler_electric"];
      if (!validHeating.includes(hType)) {
        throw new Error(`Invalid heating_type "${hType}". Must be one of: ${validHeating.join(", ")}`);
      }
      const cType = String(rawSystems.cooling_type ?? "") as CoolingType;
      const validCooling: CoolingType[] = ["split_ac", "central_chiller", "heat_pump", "window_ac", "none"];
      if (!validCooling.includes(cType)) {
        throw new Error(`Invalid cooling_type "${cType}". Must be one of: ${validCooling.join(", ")}`);
      }
      const systems: SystemsInput = {
        heating_type: hType,
        cooling_type: cType,
        heating_efficiency: rawSystems.heating_efficiency != null ? Number(rawSystems.heating_efficiency) : undefined,
        cooling_cop: rawSystems.cooling_cop != null ? Number(rawSystems.cooling_cop) : undefined,
        dhw_type: rawSystems.dhw_type != null ? String(rawSystems.dhw_type) as DhwType : undefined,
        dhw_efficiency: rawSystems.dhw_efficiency != null ? Number(rawSystems.dhw_efficiency) : undefined,
      };

      // ── Parse climate ──
      const rawClimate = params.climate as Record<string, unknown> | undefined;
      if (!rawClimate || typeof rawClimate !== "object") {
        throw new Error("'climate' parameter is required and must be an object.");
      }
      const climateInput: ClimateInput = {
        location: rawClimate.location != null ? String(rawClimate.location) : undefined,
        hdd_18c: rawClimate.hdd_18c != null ? Number(rawClimate.hdd_18c) : undefined,
        cdd_18c: rawClimate.cdd_18c != null ? Number(rawClimate.cdd_18c) : undefined,
        monthly_temps_c: Array.isArray(rawClimate.monthly_temps_c)
          ? (rawClimate.monthly_temps_c as number[]).map(Number)
          : undefined,
      };

      // ── Parse occupancy (optional) ──
      let occupancy: OccupancyInput | undefined;
      if (params.occupancy && typeof params.occupancy === "object") {
        const rawOcc = params.occupancy as Record<string, unknown>;
        occupancy = {
          people_density_per_sqm: rawOcc.people_density_per_sqm != null ? Number(rawOcc.people_density_per_sqm) : undefined,
          lighting_w_per_sqm: rawOcc.lighting_w_per_sqm != null ? Number(rawOcc.lighting_w_per_sqm) : undefined,
          equipment_w_per_sqm: rawOcc.equipment_w_per_sqm != null ? Number(rawOcc.equipment_w_per_sqm) : undefined,
          operating_hours_per_day: rawOcc.operating_hours_per_day != null ? Number(rawOcc.operating_hours_per_day) : undefined,
          operating_days_per_year: rawOcc.operating_days_per_year != null ? Number(rawOcc.operating_days_per_year) : undefined,
        };
      }

      // ── Parse energy cost (optional) ──
      let energyCost: EnergyCostInput | undefined;
      if (params.energy_cost && typeof params.energy_cost === "object") {
        const rawCost = params.energy_cost as Record<string, unknown>;
        energyCost = {
          electricity_per_kwh: rawCost.electricity_per_kwh != null ? Number(rawCost.electricity_per_kwh) : undefined,
          gas_per_therm: rawCost.gas_per_therm != null ? Number(rawCost.gas_per_therm) : undefined,
        };
      }

      // ── Output path ──
      const outputPath = typeof params.output_path === "string" ? params.output_path.trim() || undefined : undefined;

      // ── Run model ──
      const result = runEnergyModel({
        building,
        systems,
        climate: climateInput,
        occupancy,
        energy_cost: energyCost,
        output_path: outputPath,
      });

      // ── Format summary text ──
      const a = result.annual;
      const b = result.building_summary;
      const summary = [
        `Energy Model Results: ${b.building_type} | ${b.area_sqm} m\u00b2 | ${b.location}`,
        `Climate Zone: ${b.climate_zone} | HDD: ${b.hdd_18c} | CDD: ${b.cdd_18c}`,
        ``,
        `Annual Energy:`,
        `  Total: ${a.total_kwh.toLocaleString()} kWh (EUI: ${a.total_kwh_per_sqm} kWh/m\u00b2)`,
        `  Heating: ${a.by_end_use.heating_kwh.toLocaleString()} kWh`,
        `  Cooling: ${a.by_end_use.cooling_kwh.toLocaleString()} kWh`,
        `  Lighting: ${a.by_end_use.lighting_kwh.toLocaleString()} kWh`,
        `  Equipment: ${a.by_end_use.equipment_kwh.toLocaleString()} kWh`,
        `  DHW: ${a.by_end_use.dhw_kwh.toLocaleString()} kWh`,
        `  Fans/Pumps: ${a.by_end_use.fans_kwh.toLocaleString()} kWh`,
        ``,
        `Cost: $${a.total_cost_usd.toLocaleString()} USD/yr`,
        `CO\u2082 Emissions: ${a.total_co2_kg.toLocaleString()} kg/yr`,
        ``,
        `Benchmark: ${result.benchmarks.comparison}`,
      ];

      if (result.output_path) {
        summary.push(`Chart saved to: ${result.output_path}`);
      }

      return {
        content: [
          { type: "text", text: summary.join("\n") },
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
        details: {
          building_type: b.building_type,
          area_sqm: b.area_sqm,
          location: b.location,
          eui_kwh_per_sqm: a.total_kwh_per_sqm,
          total_cost_usd: a.total_cost_usd,
          total_co2_kg: a.total_co2_kg,
        },
      };
    },
  };
}
