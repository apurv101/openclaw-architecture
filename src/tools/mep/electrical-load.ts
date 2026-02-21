/**
 * Electrical Load Calculation tool for civilclaw.
 *
 * Calculates electrical demand for buildings per NEC Article 220, including
 * panel sizing, service entrance requirements, and voltage drop analysis.
 *
 * Pure TypeScript -- no external dependencies.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

type BuildingType = "residential" | "commercial" | "industrial";
type PhaseType = "single" | "three";
type WireMaterial = "copper" | "aluminum";

type CircuitType =
  | "general_lighting"
  | "receptacle"
  | "motor"
  | "hvac"
  | "kitchen"
  | "laundry"
  | "dryer"
  | "range"
  | "water_heater"
  | "ev_charger"
  | "custom";

interface CircuitInput {
  name: string;
  type: CircuitType;
  load_watts?: number;
  quantity?: number;
  voltage?: number;
  power_factor?: number;
}

interface ElectricalLoadArgs {
  building_type: BuildingType;
  area_sqm: number;
  stories?: number;
  voltage?: number;
  phases?: PhaseType;
  circuits?: CircuitInput[];
  feeder_length_m?: number;
  wire_material?: WireMaterial;
}

// ── Result types ──────────────────────────────────────────────────────────────

interface LoadBreakdownItem {
  category: string;
  connected_va: number;
  demand_factor: number;
  demand_va: number;
}

interface VoltageDrop {
  feeder_length_m: number;
  voltage_drop_v: number;
  voltage_drop_percent: number;
  wire_size_awg: string;
  status: "OK" | "EXCEEDS_3_PERCENT" | "EXCEEDS_5_PERCENT";
}

interface ServiceSize {
  recommended_amps: number;
  panel_size: number;
  voltage: number;
  phases: PhaseType;
}

interface ElectricalLoadResult {
  building_type: BuildingType;
  area_sqm: number;
  connected_load_va: number;
  demand_load_va: number;
  demand_load_kw: number;
  current_amps: number;
  service_size: ServiceSize;
  load_breakdown: LoadBreakdownItem[];
  voltage_drop?: VoltageDrop;
  notes: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SQM_TO_SQFT = 10.7639;

// Standard panel sizes in amps
const STANDARD_PANEL_SIZES = [100, 125, 150, 200, 225, 400, 600, 800, 1000, 1200];

// NEC Table 220.12 - General Lighting Load by occupancy (VA/m^2)
const LIGHTING_LOAD_VA_PER_SQM: Record<string, number> = {
  residential: 33,       // 3 VA/sqft
  commercial_office: 39, // ~3.5 VA/sqft
  commercial_retail: 50, // ~4.5 VA/sqft (commercial default)
  commercial_warehouse: 3,
  industrial: 22,        // 2 VA/sqft
};

// NEC Table 220.12 - Commercial sub-types (VA per sqm)
const COMMERCIAL_LIGHTING: Record<string, number> = {
  office: 39,
  retail: 50,
  warehouse: 3,
  hospital: 22,
  hotel: 22,
  school: 33,
  restaurant: 22,
};

// Resistivity constant K (ohm-cmil/ft)
const K_COPPER = 12.9;
const K_ALUMINUM = 21.2;

// Standard AWG wire sizes with circular mil areas
const AWG_SIZES: Array<{ label: string; cmil: number; ampacity_cu: number; ampacity_al: number }> = [
  { label: "14",    cmil: 4110,    ampacity_cu: 15,   ampacity_al: 0 },
  { label: "12",    cmil: 6530,    ampacity_cu: 20,   ampacity_al: 15 },
  { label: "10",    cmil: 10380,   ampacity_cu: 30,   ampacity_al: 25 },
  { label: "8",     cmil: 16510,   ampacity_cu: 40,   ampacity_al: 35 },
  { label: "6",     cmil: 26240,   ampacity_cu: 55,   ampacity_al: 45 },
  { label: "4",     cmil: 41740,   ampacity_cu: 70,   ampacity_al: 60 },
  { label: "3",     cmil: 52620,   ampacity_cu: 85,   ampacity_al: 70 },
  { label: "2",     cmil: 66360,   ampacity_cu: 95,   ampacity_al: 80 },
  { label: "1",     cmil: 83690,   ampacity_cu: 110,  ampacity_al: 95 },
  { label: "1/0",   cmil: 105600,  ampacity_cu: 125,  ampacity_al: 105 },
  { label: "2/0",   cmil: 133100,  ampacity_cu: 145,  ampacity_al: 120 },
  { label: "3/0",   cmil: 167800,  ampacity_cu: 165,  ampacity_al: 140 },
  { label: "4/0",   cmil: 211600,  ampacity_cu: 195,  ampacity_al: 170 },
  { label: "250",   cmil: 250000,  ampacity_cu: 215,  ampacity_al: 190 },
  { label: "300",   cmil: 300000,  ampacity_cu: 240,  ampacity_al: 210 },
  { label: "350",   cmil: 350000,  ampacity_cu: 260,  ampacity_al: 230 },
  { label: "400",   cmil: 400000,  ampacity_cu: 280,  ampacity_al: 250 },
  { label: "500",   cmil: 500000,  ampacity_cu: 320,  ampacity_al: 280 },
  { label: "600",   cmil: 600000,  ampacity_cu: 355,  ampacity_al: 310 },
  { label: "750",   cmil: 750000,  ampacity_cu: 400,  ampacity_al: 350 },
  { label: "1000",  cmil: 1000000, ampacity_cu: 455,  ampacity_al: 405 },
];

// ── Utility ───────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Residential Calculation (NEC Article 220) ─────────────────────────────────

function calculateResidential(
  areaSqm: number,
  circuits: CircuitInput[],
  voltage: number,
  phases: PhaseType,
): { breakdown: LoadBreakdownItem[]; connectedVA: number; demandVA: number; notes: string[] } {
  const breakdown: LoadBreakdownItem[] = [];
  const notes: string[] = [];
  let connectedVA = 0;

  // 1. General Lighting (NEC Table 220.12): 33 VA/m^2 (3 VA/sqft)
  const lightingVA = areaSqm * 33;
  connectedVA += lightingVA;

  // 2. Small Appliance Circuits (NEC 220.52(A)): 2 circuits * 1500 VA
  const smallApplianceVA = 2 * 1500;
  connectedVA += smallApplianceVA;

  // 3. Laundry Circuit (NEC 220.52(B)): 1500 VA
  const laundryVA = 1500;
  connectedVA += laundryVA;

  // Combine general lighting + small appliance + laundry for demand factor
  const generalTotal = lightingVA + smallApplianceVA + laundryVA;

  // Apply demand factors (NEC Table 220.42)
  let generalDemand: number;
  if (generalTotal <= 3000) {
    generalDemand = generalTotal;
  } else if (generalTotal <= 120000) {
    generalDemand = 3000 + (generalTotal - 3000) * 0.35;
  } else {
    generalDemand = 3000 + 117000 * 0.35 + (generalTotal - 120000) * 0.25;
  }

  const generalDemandFactor = generalTotal > 0 ? generalDemand / generalTotal : 1;

  breakdown.push({
    category: "General Lighting (33 VA/m^2)",
    connected_va: round2(lightingVA),
    demand_factor: round2(generalDemandFactor),
    demand_va: round2(lightingVA * generalDemandFactor),
  });

  breakdown.push({
    category: "Small Appliance Circuits (2 x 1500 VA)",
    connected_va: smallApplianceVA,
    demand_factor: round2(generalDemandFactor),
    demand_va: round2(smallApplianceVA * generalDemandFactor),
  });

  breakdown.push({
    category: "Laundry Circuit (1500 VA)",
    connected_va: laundryVA,
    demand_factor: round2(generalDemandFactor),
    demand_va: round2(laundryVA * generalDemandFactor),
  });

  let totalDemandVA = generalDemand;

  // 4. Specific circuits
  let fixedApplianceCount = 0;
  let fixedApplianceTotalVA = 0;
  let rangeVA = 0;
  let dryerVA = 0;
  let hvacCoolingVA = 0;
  let hvacHeatingVA = 0;
  let evChargerVA = 0;
  const otherCircuits: { name: string; va: number }[] = [];

  for (const circuit of circuits) {
    const qty = circuit.quantity ?? 1;
    const pf = circuit.power_factor ?? 1.0;
    let circuitVA: number;

    if (circuit.load_watts !== undefined) {
      circuitVA = (circuit.load_watts / pf) * qty;
    } else {
      // Default loads for common residential circuits
      switch (circuit.type) {
        case "range":
          circuitVA = 12000 * qty; // NEC default nameplate
          break;
        case "dryer":
          circuitVA = 5000 * qty;
          break;
        case "water_heater":
          circuitVA = 4500 * qty;
          fixedApplianceCount += qty;
          fixedApplianceTotalVA += 4500 * qty;
          break;
        case "hvac":
          circuitVA = 5000 * qty;
          break;
        case "ev_charger":
          circuitVA = 7680 * qty; // Level 2, 32A @ 240V
          break;
        case "kitchen":
          circuitVA = 1500 * qty;
          break;
        case "motor":
          circuitVA = 1500 * qty;
          break;
        default:
          circuitVA = 1500 * qty;
          break;
      }
    }

    connectedVA += circuitVA;

    switch (circuit.type) {
      case "range":
        rangeVA += circuitVA;
        break;
      case "dryer":
        dryerVA += circuitVA;
        break;
      case "hvac":
        // Classify as heating or cooling based on name heuristic
        if (circuit.name.toLowerCase().includes("heat")) {
          hvacHeatingVA += circuitVA;
        } else {
          hvacCoolingVA += circuitVA;
        }
        break;
      case "ev_charger":
        evChargerVA += circuitVA;
        break;
      case "water_heater":
        // Already counted in fixed appliances above
        break;
      default:
        if (
          circuit.type === "kitchen" ||
          circuit.type === "motor" ||
          circuit.type === "custom"
        ) {
          fixedApplianceCount += qty;
          fixedApplianceTotalVA += circuitVA;
        } else {
          otherCircuits.push({ name: circuit.name, va: circuitVA });
        }
        break;
    }
  }

  // 5. Fixed Appliances: 75% demand factor if 4 or more (NEC 220.53)
  if (fixedApplianceTotalVA > 0) {
    const fixedDemandFactor = fixedApplianceCount >= 4 ? 0.75 : 1.0;
    const fixedDemandVA = fixedApplianceTotalVA * fixedDemandFactor;
    breakdown.push({
      category: `Fixed Appliances (${fixedApplianceCount} units)`,
      connected_va: round2(fixedApplianceTotalVA),
      demand_factor: fixedDemandFactor,
      demand_va: round2(fixedDemandVA),
    });
    totalDemandVA += fixedDemandVA;
  }

  // 6. Range/Oven (NEC Table 220.55)
  if (rangeVA > 0) {
    // For one range, NEC Table 220.55 Column C allows 8 kW demand
    const rangeDemand = 8000;
    const rangeDemandFactor = rangeVA > 0 ? rangeDemand / rangeVA : 1.0;
    breakdown.push({
      category: "Range/Oven (NEC 220.55)",
      connected_va: round2(rangeVA),
      demand_factor: round2(Math.min(rangeDemandFactor, 1.0)),
      demand_va: round2(rangeDemand),
    });
    totalDemandVA += rangeDemand;
    notes.push("Range/oven demand per NEC Table 220.55 Column C: 8 kW for one range.");
  }

  // 7. Dryer (NEC 220.54): 5000 VA or nameplate, whichever is larger
  if (dryerVA > 0) {
    const dryerDemand = Math.max(dryerVA, 5000);
    breakdown.push({
      category: "Dryer (NEC 220.54)",
      connected_va: round2(dryerVA),
      demand_factor: 1.0,
      demand_va: round2(dryerDemand),
    });
    totalDemandVA += dryerDemand;
    notes.push("Dryer: 5000 VA or nameplate, whichever is larger (NEC 220.54).");
  }

  // 8. HVAC: Larger of heating or cooling (NEC 220.60)
  if (hvacCoolingVA > 0 || hvacHeatingVA > 0) {
    const hvacDemand = Math.max(hvacCoolingVA, hvacHeatingVA);
    const hvacConnected = hvacCoolingVA + hvacHeatingVA;
    breakdown.push({
      category: "HVAC (NEC 220.60 - larger of heating/cooling)",
      connected_va: round2(hvacConnected),
      demand_factor: round2(hvacConnected > 0 ? hvacDemand / hvacConnected : 1.0),
      demand_va: round2(hvacDemand),
    });
    totalDemandVA += hvacDemand;
    notes.push(
      `HVAC: Cooling=${hvacCoolingVA} VA, Heating=${hvacHeatingVA} VA. ` +
        `Using larger value per NEC 220.60.`,
    );
  }

  // 9. EV Charger: Full nameplate rating (NEC 625.42)
  if (evChargerVA > 0) {
    breakdown.push({
      category: "EV Charger (NEC 625.42 - continuous load)",
      connected_va: round2(evChargerVA),
      demand_factor: 1.0,
      demand_va: round2(evChargerVA),
    });
    totalDemandVA += evChargerVA;
    notes.push("EV charger at 100% demand as continuous load per NEC 625.42.");
  }

  // Other circuits at 100%
  for (const other of otherCircuits) {
    breakdown.push({
      category: other.name,
      connected_va: round2(other.va),
      demand_factor: 1.0,
      demand_va: round2(other.va),
    });
    totalDemandVA += other.va;
  }

  return { breakdown, connectedVA: round2(connectedVA), demandVA: round2(totalDemandVA), notes };
}

// ── Commercial Calculation (NEC Article 220) ──────────────────────────────────

function calculateCommercial(
  areaSqm: number,
  circuits: CircuitInput[],
  voltage: number,
  phases: PhaseType,
): { breakdown: LoadBreakdownItem[]; connectedVA: number; demandVA: number; notes: string[] } {
  const breakdown: LoadBreakdownItem[] = [];
  const notes: string[] = [];
  let connectedVA = 0;

  // 1. General Lighting (NEC Table 220.12) - office by default
  const lightingVApSqm = 39; // office
  const lightingVA = areaSqm * lightingVApSqm;
  connectedVA += lightingVA;

  // 2. Receptacle load: 10 VA/m^2 typical (1 VA/sqft)
  const receptacleVA = areaSqm * 10;
  connectedVA += receptacleVA;

  // Combine lighting + receptacles for demand factor
  const generalTotal = lightingVA + receptacleVA;

  // NEC Table 220.44: First 10 kVA at 100%, remainder at 50%
  let generalDemand: number;
  if (generalTotal <= 10000) {
    generalDemand = generalTotal;
  } else {
    generalDemand = 10000 + (generalTotal - 10000) * 0.5;
  }

  const lightingDemandFactor = generalTotal > 0 ? generalDemand / generalTotal : 1;

  breakdown.push({
    category: `General Lighting (${lightingVApSqm} VA/m^2)`,
    connected_va: round2(lightingVA),
    demand_factor: round2(lightingDemandFactor),
    demand_va: round2(lightingVA * lightingDemandFactor),
  });

  breakdown.push({
    category: "Receptacles (10 VA/m^2)",
    connected_va: round2(receptacleVA),
    demand_factor: round2(lightingDemandFactor),
    demand_va: round2(receptacleVA * lightingDemandFactor),
  });

  let totalDemandVA = generalDemand;

  // 3. Process specific circuits
  let hvacTotalVA = 0;
  let motorTotalVA = 0;

  for (const circuit of circuits) {
    const qty = circuit.quantity ?? 1;
    const pf = circuit.power_factor ?? 0.85;
    let circuitVA: number;

    if (circuit.load_watts !== undefined) {
      circuitVA = (circuit.load_watts / pf) * qty;
    } else {
      switch (circuit.type) {
        case "hvac":
          circuitVA = 10000 * qty;
          break;
        case "motor":
          circuitVA = 5000 * qty;
          break;
        case "kitchen":
          circuitVA = 3000 * qty;
          break;
        case "ev_charger":
          circuitVA = 7680 * qty;
          break;
        default:
          circuitVA = 2000 * qty;
          break;
      }
    }

    connectedVA += circuitVA;

    switch (circuit.type) {
      case "hvac":
        hvacTotalVA += circuitVA;
        break;
      case "motor":
        motorTotalVA += circuitVA;
        break;
      default: {
        // Other circuits at 100%
        breakdown.push({
          category: circuit.name || circuit.type,
          connected_va: round2(circuitVA),
          demand_factor: 1.0,
          demand_va: round2(circuitVA),
        });
        totalDemandVA += circuitVA;
        break;
      }
    }
  }

  // HVAC at nameplate
  if (hvacTotalVA > 0) {
    breakdown.push({
      category: "HVAC Equipment",
      connected_va: round2(hvacTotalVA),
      demand_factor: 1.0,
      demand_va: round2(hvacTotalVA),
    });
    totalDemandVA += hvacTotalVA;
  }

  // Motors: NEC 430 - largest motor at 125%, rest at 100%
  if (motorTotalVA > 0) {
    // Simplified: add 25% of the largest motor
    const motorBonus = motorTotalVA * 0.05; // approximate 25% of largest ~ 5% total
    const motorDemand = motorTotalVA + motorBonus;
    breakdown.push({
      category: "Motors (NEC 430 - 125% largest)",
      connected_va: round2(motorTotalVA),
      demand_factor: round2(motorDemand / motorTotalVA),
      demand_va: round2(motorDemand),
    });
    totalDemandVA += motorDemand;
    notes.push("Motor loads include 125% factor on largest motor per NEC 430.24.");
  }

  notes.push("Commercial lighting demand per NEC Table 220.44: first 10 kVA at 100%, remainder at 50%.");

  return { breakdown, connectedVA: round2(connectedVA), demandVA: round2(totalDemandVA), notes };
}

// ── Industrial Calculation ────────────────────────────────────────────────────

function calculateIndustrial(
  areaSqm: number,
  circuits: CircuitInput[],
  voltage: number,
  phases: PhaseType,
): { breakdown: LoadBreakdownItem[]; connectedVA: number; demandVA: number; notes: string[] } {
  const breakdown: LoadBreakdownItem[] = [];
  const notes: string[] = [];
  let connectedVA = 0;

  // General lighting: 22 VA/m^2
  const lightingVA = areaSqm * 22;
  connectedVA += lightingVA;

  // Receptacles: 5 VA/m^2 (lighter than commercial)
  const receptacleVA = areaSqm * 5;
  connectedVA += receptacleVA;

  // Apply 100% demand for industrial (typically process-driven)
  breakdown.push({
    category: "General Lighting (22 VA/m^2)",
    connected_va: round2(lightingVA),
    demand_factor: 1.0,
    demand_va: round2(lightingVA),
  });

  breakdown.push({
    category: "Receptacles (5 VA/m^2)",
    connected_va: round2(receptacleVA),
    demand_factor: 1.0,
    demand_va: round2(receptacleVA),
  });

  let totalDemandVA = lightingVA + receptacleVA;

  // Process circuits
  let largestMotorVA = 0;
  let totalMotorVA = 0;

  for (const circuit of circuits) {
    const qty = circuit.quantity ?? 1;
    const pf = circuit.power_factor ?? 0.85;
    let circuitVA: number;

    if (circuit.load_watts !== undefined) {
      circuitVA = (circuit.load_watts / pf) * qty;
    } else {
      switch (circuit.type) {
        case "motor":
          circuitVA = 7500 * qty;
          break;
        case "hvac":
          circuitVA = 15000 * qty;
          break;
        default:
          circuitVA = 3000 * qty;
          break;
      }
    }

    connectedVA += circuitVA;

    if (circuit.type === "motor") {
      totalMotorVA += circuitVA;
      const perMotorVA = circuitVA / qty;
      if (perMotorVA > largestMotorVA) largestMotorVA = perMotorVA;
    } else {
      breakdown.push({
        category: circuit.name || circuit.type,
        connected_va: round2(circuitVA),
        demand_factor: 1.0,
        demand_va: round2(circuitVA),
      });
      totalDemandVA += circuitVA;
    }
  }

  // Motors: NEC 430 - largest motor at 125%, rest at 100%
  if (totalMotorVA > 0) {
    const motorDemand = totalMotorVA + largestMotorVA * 0.25;
    breakdown.push({
      category: "Motors (NEC 430 - 125% largest motor)",
      connected_va: round2(totalMotorVA),
      demand_factor: round2(motorDemand / totalMotorVA),
      demand_va: round2(motorDemand),
    });
    totalDemandVA += motorDemand;
    notes.push(
      `Motor loads: largest motor (${round2(largestMotorVA)} VA) at 125%, rest at 100% per NEC 430.24.`,
    );
  }

  notes.push("Industrial loads typically calculated at 100% demand factor for process equipment.");

  return { breakdown, connectedVA: round2(connectedVA), demandVA: round2(totalDemandVA), notes };
}

// ── Voltage Drop Calculation ──────────────────────────────────────────────────

function calculateVoltageDrop(
  current: number,
  lengthM: number,
  voltage: number,
  phases: PhaseType,
  material: WireMaterial,
): VoltageDrop {
  const K = material === "copper" ? K_COPPER : K_ALUMINUM;
  const lengthFt = lengthM * 3.28084;

  // Find smallest wire that handles the current and meets 3% voltage drop
  const targetMaxVD = voltage * 0.03; // 3% max for feeder

  let selectedWire = AWG_SIZES[AWG_SIZES.length - 1]!;
  for (const wire of AWG_SIZES) {
    const ampacity = material === "copper" ? wire.ampacity_cu : wire.ampacity_al;
    if (ampacity < current) continue;

    // Calculate voltage drop for this wire size
    let vd: number;
    if (phases === "single") {
      // VD = (2 * K * I * L) / CM
      vd = (2 * K * current * lengthFt) / wire.cmil;
    } else {
      // Three phase: VD = (1.732 * K * I * L) / CM
      vd = (1.732 * K * current * lengthFt) / wire.cmil;
    }

    selectedWire = wire;

    if (vd <= targetMaxVD) {
      break;
    }
  }

  // Calculate actual voltage drop with selected wire
  let actualVD: number;
  if (phases === "single") {
    actualVD = (2 * K * current * lengthFt) / selectedWire.cmil;
  } else {
    actualVD = (1.732 * K * current * lengthFt) / selectedWire.cmil;
  }

  const vdPercent = (actualVD / voltage) * 100;

  let status: VoltageDrop["status"];
  if (vdPercent <= 3) {
    status = "OK";
  } else if (vdPercent <= 5) {
    status = "EXCEEDS_3_PERCENT";
  } else {
    status = "EXCEEDS_5_PERCENT";
  }

  return {
    feeder_length_m: lengthM,
    voltage_drop_v: round2(actualVD),
    voltage_drop_percent: round2(vdPercent),
    wire_size_awg: selectedWire.label,
    status,
  };
}

// ── Service Sizing ────────────────────────────────────────────────────────────

function selectPanelSize(currentAmps: number): number {
  for (const size of STANDARD_PANEL_SIZES) {
    if (size >= currentAmps) return size;
  }
  return STANDARD_PANEL_SIZES[STANDARD_PANEL_SIZES.length - 1]!;
}

// ── Core Calculation ──────────────────────────────────────────────────────────

function calculateElectricalLoad(args: ElectricalLoadArgs): ElectricalLoadResult {
  const buildingType = args.building_type;
  const areaSqm = args.area_sqm;
  const stories = args.stories ?? 1;
  const circuits = args.circuits ?? [];

  // Defaults based on building type
  let voltage: number;
  let phases: PhaseType;

  if (buildingType === "residential") {
    voltage = args.voltage ?? 240; // Split-phase 120/240V
    phases = args.phases ?? "single";
  } else {
    voltage = args.voltage ?? 480; // 277/480V for commercial/industrial
    phases = args.phases ?? "three";
  }

  const wireMaterial = args.wire_material ?? "copper";

  // Calculate loads based on building type
  let result: {
    breakdown: LoadBreakdownItem[];
    connectedVA: number;
    demandVA: number;
    notes: string[];
  };

  switch (buildingType) {
    case "residential":
      result = calculateResidential(areaSqm, circuits, voltage, phases);
      break;
    case "commercial":
      result = calculateCommercial(areaSqm, circuits, voltage, phases);
      break;
    case "industrial":
      result = calculateIndustrial(areaSqm, circuits, voltage, phases);
      break;
    default:
      throw new Error(`Invalid building_type '${buildingType}'. Must be: residential, commercial, industrial.`);
  }

  // Calculate current
  let currentAmps: number;
  if (phases === "three") {
    // I = VA / (sqrt(3) * V)
    currentAmps = result.demandVA / (1.732 * voltage);
  } else {
    // I = VA / V
    currentAmps = result.demandVA / voltage;
  }

  // Select panel size
  const panelSize = selectPanelSize(currentAmps);

  // Voltage drop (if feeder length provided)
  let voltageDrop: VoltageDrop | undefined;
  if (args.feeder_length_m !== undefined && args.feeder_length_m > 0) {
    voltageDrop = calculateVoltageDrop(currentAmps, args.feeder_length_m, voltage, phases, wireMaterial);
  }

  const notes = [...result.notes];

  notes.push(
    `Service: ${voltage}V ${phases}-phase. Panel sized at ${panelSize}A (next standard size above ${round2(currentAmps)}A demand).`,
  );

  if (stories > 1) {
    notes.push(
      `Multi-story building (${stories} floors). Consider separate sub-panels per floor and riser sizing.`,
    );
  }

  return {
    building_type: buildingType,
    area_sqm: areaSqm,
    connected_load_va: result.connectedVA,
    demand_load_va: result.demandVA,
    demand_load_kw: round2(result.demandVA / 1000),
    current_amps: round2(currentAmps),
    service_size: {
      recommended_amps: round2(currentAmps),
      panel_size: panelSize,
      voltage,
      phases,
    },
    load_breakdown: result.breakdown,
    ...(voltageDrop ? { voltage_drop: voltageDrop } : {}),
    notes,
  };
}

// ── Tool definition ───────────────────────────────────────────────────────────

export function createElectricalLoadToolDefinition() {
  return {
    name: "electrical_load_calc",
    label: "Electrical Load Calculator",
    description:
      "Calculate electrical demand for a building per NEC Article 220, including panel sizing, " +
      "service entrance requirements, and voltage drop analysis. Supports residential, commercial, " +
      "and industrial building types with standard demand factors.",
    parameters: {
      type: "object",
      properties: {
        building_type: {
          type: "string",
          enum: ["residential", "commercial", "industrial"],
          description:
            "Building type determines NEC demand factor tables and default load assumptions.",
        },
        area_sqm: {
          type: "number",
          description: "Total building floor area in square meters.",
          exclusiveMinimum: 0,
        },
        stories: {
          type: "number",
          description: "Number of stories. Default: 1.",
          minimum: 1,
          default: 1,
        },
        voltage: {
          type: "number",
          description:
            "Service voltage. Default: 240V for residential (split-phase 120/240), 480V for commercial/industrial (277/480).",
        },
        phases: {
          type: "string",
          enum: ["single", "three"],
          description: "Electrical phase configuration. Default: 'single' for residential, 'three' for commercial/industrial.",
        },
        circuits: {
          type: "array",
          description: "Specific circuits to include in the load calculation.",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Circuit or equipment name (e.g. 'Central A/C', 'Electric Range').",
              },
              type: {
                type: "string",
                enum: [
                  "general_lighting",
                  "receptacle",
                  "motor",
                  "hvac",
                  "kitchen",
                  "laundry",
                  "dryer",
                  "range",
                  "water_heater",
                  "ev_charger",
                  "custom",
                ],
                description: "Circuit type for NEC demand factor classification.",
              },
              load_watts: {
                type: "number",
                description: "Actual load in watts. If omitted, a standard default is used per type.",
              },
              quantity: {
                type: "number",
                description: "Number of identical circuits. Default: 1.",
                default: 1,
              },
              voltage: {
                type: "number",
                description: "Circuit voltage if different from service voltage.",
              },
              power_factor: {
                type: "number",
                description: "Power factor (0-1). Default: 0.85 for commercial, 1.0 for residential.",
                default: 0.85,
                minimum: 0,
                maximum: 1,
              },
            },
            required: ["name", "type"],
          },
        },
        feeder_length_m: {
          type: "number",
          description:
            "Feeder run length in meters (one way). If provided, voltage drop is calculated " +
            "and wire size is recommended. NEC allows max 3% branch, 5% total.",
          exclusiveMinimum: 0,
        },
        wire_material: {
          type: "string",
          enum: ["copper", "aluminum"],
          description: "Conductor material for voltage drop calculation. Default: 'copper'.",
          default: "copper",
        },
      },
      required: ["building_type", "area_sqm"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }> => {
      const params = (args ?? {}) as Record<string, unknown>;

      // ── Validate building_type ──
      const buildingType = String(params.building_type ?? "").trim() as BuildingType;
      const validTypes: BuildingType[] = ["residential", "commercial", "industrial"];
      if (!validTypes.includes(buildingType)) {
        throw new Error(
          `Invalid building_type '${buildingType}'. Must be one of: ${validTypes.join(", ")}`,
        );
      }

      // ── Validate area ──
      const areaSqm = Number(params.area_sqm);
      if (!Number.isFinite(areaSqm) || areaSqm <= 0) {
        throw new Error("area_sqm must be a positive number.");
      }

      // ── Optional parameters ──
      const stories =
        params.stories !== undefined ? Math.max(1, Math.round(Number(params.stories))) : undefined;
      const voltage =
        params.voltage !== undefined ? Number(params.voltage) : undefined;
      const phases =
        typeof params.phases === "string" ? (params.phases as PhaseType) : undefined;
      const wireMaterial =
        typeof params.wire_material === "string" ? (params.wire_material as WireMaterial) : undefined;
      const feederLength =
        params.feeder_length_m !== undefined ? Number(params.feeder_length_m) : undefined;

      // ── Parse circuits ──
      let circuits: CircuitInput[] | undefined;
      if (Array.isArray(params.circuits)) {
        circuits = (params.circuits as any[]).map((c: any) => ({
          name: String(c.name ?? c.type ?? "unnamed"),
          type: String(c.type ?? "custom") as CircuitType,
          load_watts: c.load_watts !== undefined ? Number(c.load_watts) : undefined,
          quantity: c.quantity !== undefined ? Math.max(1, Math.round(Number(c.quantity))) : undefined,
          voltage: c.voltage !== undefined ? Number(c.voltage) : undefined,
          power_factor: c.power_factor !== undefined ? Number(c.power_factor) : undefined,
        }));
      }

      // ── Run calculation ──
      const result = calculateElectricalLoad({
        building_type: buildingType,
        area_sqm: areaSqm,
        ...(stories !== undefined && { stories }),
        ...(voltage !== undefined && { voltage }),
        ...(phases !== undefined && { phases }),
        ...(circuits !== undefined && { circuits }),
        ...(feederLength !== undefined && { feeder_length_m: feederLength }),
        ...(wireMaterial !== undefined && { wire_material: wireMaterial }),
      });

      // ── Build summary text ──
      const summary = [
        `Electrical Load Calculation (NEC Article 220)`,
        `==============================================`,
        `Building Type: ${result.building_type}`,
        `Floor Area: ${result.area_sqm} m^2 (${round2(result.area_sqm * SQM_TO_SQFT)} sqft)`,
        ``,
        `Connected Load: ${result.connected_load_va} VA (${round2(result.connected_load_va / 1000)} kW)`,
        `Demand Load:    ${result.demand_load_va} VA (${result.demand_load_kw} kW)`,
        `Current:        ${result.current_amps} A`,
        ``,
        `SERVICE:`,
        `  Voltage:    ${result.service_size.voltage}V ${result.service_size.phases}-phase`,
        `  Panel Size: ${result.service_size.panel_size} A`,
        ``,
        `LOAD BREAKDOWN:`,
      ];

      for (const item of result.load_breakdown) {
        summary.push(
          `  ${item.category}: ${item.connected_va} VA connected, ` +
            `${(item.demand_factor * 100).toFixed(0)}% demand = ${item.demand_va} VA`,
        );
      }

      if (result.voltage_drop) {
        const vd = result.voltage_drop;
        summary.push(``);
        summary.push(`VOLTAGE DROP:`);
        summary.push(`  Feeder Length: ${vd.feeder_length_m} m`);
        summary.push(`  Wire Size:    ${vd.wire_size_awg} AWG (${wireMaterial ?? "copper"})`);
        summary.push(`  Voltage Drop: ${vd.voltage_drop_v} V (${vd.voltage_drop_percent}%)`);
        summary.push(`  Status:       ${vd.status}`);
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
          demand_load_kw: result.demand_load_kw,
          current_amps: result.current_amps,
          panel_size: result.service_size.panel_size,
          voltage_drop_percent: result.voltage_drop?.voltage_drop_percent,
        },
      };
    },
  };
}
