/**
 * Structural Foundation Design tool for civilclaw.
 *
 * Designs/checks spread footings and strip footings for bearing capacity,
 * settlement, overturning, sliding, and structural adequacy per ACI 318
 * and Terzaghi's bearing capacity theory.
 *
 * No external dependencies beyond Node.js built-ins.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

type FootingType = "spread_square" | "spread_rectangular" | "strip";

interface ColumnDimensions {
  width_mm: number;
  depth_mm: number;
}

interface SoilProperties {
  unit_weight_kn_m3: number;
  friction_angle_deg?: number;
  cohesion_kpa?: number;
  elastic_modulus_mpa?: number;
  poisson_ratio?: number;
}

interface FoundationParams {
  footing_type: FootingType;
  column_load_kn: number;
  column_moment_knm?: number;
  horizontal_load_kn?: number;
  column_dimensions?: ColumnDimensions;
  soil_bearing_capacity_kpa: number;
  soil_properties: SoilProperties;
  depth_m: number;
  concrete_fc_mpa: number;
  rebar_fy_mpa: number;
  groundwater_depth_m?: number;
}

interface BearingPressureCheck {
  max_pressure_kpa: number;
  min_pressure_kpa: number;
  allowable_kpa: number;
  eccentricity_m?: number;
  kern_limit_m?: number;
  full_contact: boolean;
  factor_of_safety: number;
  status: "PASS" | "FAIL";
}

interface BearingCapacityCheck {
  ultimate_capacity_kpa: number;
  allowable_capacity_kpa: number;
  applied_pressure_kpa: number;
  factor_of_safety: number;
  status: "PASS" | "FAIL";
}

interface OverturningCheck {
  stabilizing_moment_knm: number;
  overturning_moment_knm: number;
  factor_of_safety: number;
  status: "PASS" | "FAIL";
}

interface SlidingCheck {
  resisting_force_kn: number;
  applied_horizontal_kn: number;
  factor_of_safety: number;
  status: "PASS" | "FAIL";
}

interface StructuralDesign {
  footing_depth_mm: number;
  effective_depth_mm: number;
  reinforcement_x: {
    bar_size: string;
    bar_diameter_mm: number;
    spacing_mm: number;
    As_required_mm2_per_m: number;
    As_provided_mm2_per_m: number;
  };
  reinforcement_y: {
    bar_size: string;
    bar_diameter_mm: number;
    spacing_mm: number;
    As_required_mm2_per_m: number;
    As_provided_mm2_per_m: number;
  };
  one_way_shear_check: {
    Vu_kn: number;
    phi_Vc_kn: number;
    utilization: number;
    status: "PASS" | "FAIL";
  };
  punching_shear_check: {
    Vu_kn: number;
    phi_Vc_kn: number;
    utilization: number;
    bo_mm: number;
    status: "PASS" | "FAIL";
  };
}

interface FoundationResult {
  footing_type: FootingType;
  proposed_dimensions: {
    width_m: number;
    length_m: number;
    depth_m: number;
  };
  bearing_pressure_check: BearingPressureCheck;
  bearing_capacity_check?: BearingCapacityCheck;
  overturning_check?: OverturningCheck;
  sliding_check?: SlidingCheck;
  settlement_mm: number;
  structural_design: StructuralDesign;
  overall_status: "PASS" | "FAIL";
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Standard rebar diameters (mm) and areas (mm^2) */
const REBAR_SIZES: Array<{ name: string; diameter_mm: number; area_mm2: number }> = [
  { name: "#4 (13M)", diameter_mm: 12.7, area_mm2: 129 },
  { name: "#5 (16M)", diameter_mm: 15.9, area_mm2: 199 },
  { name: "#6 (19M)", diameter_mm: 19.1, area_mm2: 284 },
  { name: "#7 (22M)", diameter_mm: 22.2, area_mm2: 387 },
  { name: "#8 (25M)", diameter_mm: 25.4, area_mm2: 510 },
];

/** Concrete unit weight (kN/m^3) */
const CONCRETE_UNIT_WEIGHT = 24;

/** Minimum cover for footings per ACI 318 (mm) */
const FOOTING_COVER_MM = 75;

// ─── Utility functions ───────────────────────────────────────────────────────

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/** Convert degrees to radians */
function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

// ─── Terzaghi bearing capacity factors ───────────────────────────────────────

/**
 * Calculate Terzaghi bearing capacity factors Nc, Nq, Ngamma
 * from the soil friction angle (phi in degrees).
 *
 * Nq = e^(2*pi*(0.75 - phi/360)*tan(phi)) / (2*cos^2(45 + phi/2))
 *   Simplified Terzaghi: Nq = exp(pi*tan(phi)) * tan^2(45 + phi/2)
 * Nc = (Nq - 1) * cot(phi)  (or 5.7 when phi = 0)
 * Ngamma = 2*(Nq + 1)*tan(phi)  (Vesic approximation)
 */
function getBearingCapacityFactors(phi_deg: number): { Nc: number; Nq: number; Ngamma: number } {
  if (phi_deg <= 0) {
    // Purely cohesive soil (undrained, phi = 0)
    return { Nc: 5.7, Nq: 1.0, Ngamma: 0.0 };
  }

  const phi_rad = toRad(phi_deg);

  // Nq = exp(pi * tan(phi)) * tan^2(45 + phi/2)
  const Nq = Math.exp(Math.PI * Math.tan(phi_rad)) * Math.pow(Math.tan(toRad(45 + phi_deg / 2)), 2);

  // Nc = (Nq - 1) * cot(phi) = (Nq - 1) / tan(phi)
  const Nc = (Nq - 1) / Math.tan(phi_rad);

  // Ngamma = 2 * (Nq + 1) * tan(phi) (Vesic approximation, widely used)
  const Ngamma = 2 * (Nq + 1) * Math.tan(phi_rad);

  return { Nc, Nq, Ngamma };
}

// ─── Reinforcement selection ─────────────────────────────────────────────────

function selectReinforcement(
  As_required_mm2_per_m: number,
  min_spacing_mm: number = 150,
): { bar: typeof REBAR_SIZES[0]; spacing_mm: number; As_provided_mm2_per_m: number } {
  for (const bar of REBAR_SIZES) {
    const spacing = (1000 * bar.area_mm2) / As_required_mm2_per_m;
    if (spacing >= min_spacing_mm) {
      const spacingRounded = Math.floor(spacing / 25) * 25; // round down to nearest 25 mm
      const finalSpacing = Math.min(Math.max(spacingRounded, min_spacing_mm), 300);
      const As_provided = (1000 * bar.area_mm2) / finalSpacing;
      return { bar, spacing_mm: finalSpacing, As_provided_mm2_per_m: As_provided };
    }
  }

  // Fallback: use largest bar at minimum spacing
  const largest = REBAR_SIZES[REBAR_SIZES.length - 1]!;
  const As_provided = (1000 * largest.area_mm2) / min_spacing_mm;
  return { bar: largest, spacing_mm: min_spacing_mm, As_provided_mm2_per_m: As_provided };
}

// ─── Required reinforcement (quadratic formula) ──────────────────────────────

/**
 * Calculate required steel area per meter width for flexure.
 * Mu = phi * As * fy * (d - a/2), where a = As * fy / (0.85 * fc * b)
 */
function calcRequiredAs(
  Mu_knm_per_m: number,
  d_mm: number,
  fc_mpa: number,
  fy_mpa: number,
  phi: number = 0.9,
  b_mm: number = 1000,
): number {
  const Mu_Nmm = Math.abs(Mu_knm_per_m) * 1e6;
  const coeff = 2 * Mu_Nmm / (phi * 0.85 * fc_mpa * b_mm);
  const discriminant = d_mm * d_mm - coeff;

  if (discriminant < 0) {
    // Section too small; return max ratio as indicator
    return 0.04 * b_mm * d_mm;
  }

  const As = (0.85 * fc_mpa * b_mm / fy_mpa) * (d_mm - Math.sqrt(discriminant));
  return Math.max(As, 0);
}

// ─── Footing sizing ──────────────────────────────────────────────────────────

/**
 * Determine required footing dimensions based on load, bearing capacity,
 * and eccentricity.
 */
function sizeFooting(params: FoundationParams): { B: number; L: number; D_footing: number } {
  const P = params.column_load_kn;
  const qa = params.soil_bearing_capacity_kpa;
  const M = params.column_moment_knm ?? 0;

  // Minimum footing depth based on embedment and practical considerations
  // Use 0.3 m minimum footing thickness
  let D_footing = 0.4; // meters (initial estimate)

  if (params.footing_type === "strip") {
    // Strip footing: width B, length per meter run = 1.0
    // Required area per meter = P / qa
    let B = P / qa;

    if (Math.abs(M) > 1e-6) {
      // Eccentricity: e = M / P
      const e = Math.abs(M) / P;
      // Effective width: B_eff = B - 2e (Meyerhof)
      // So we need B such that P / (B - 2e) <= qa
      // B >= P/qa + 2e
      B = P / qa + 2 * e;
    }

    // Round up to nearest 0.1 m
    B = Math.ceil(B * 10) / 10;
    B = Math.max(B, 0.6); // minimum practical width

    return { B, L: 1.0, D_footing };
  }

  if (params.footing_type === "spread_square") {
    // Square footing: B = L
    let A_req = P / qa;

    if (Math.abs(M) > 1e-6) {
      // Iteratively size to account for eccentricity
      // Start with A_req and increase
      const e = Math.abs(M) / P;
      // Initial B from concentric load
      let B = Math.sqrt(A_req);
      // Check if eccentricity within kern: e < B/6
      // Increase B to keep e < B/6 if possible, otherwise accept partial contact
      for (let iter = 0; iter < 20; iter++) {
        const qmax = (P / (B * B)) * (1 + 6 * e / B);
        if (qmax <= qa) break;
        B += 0.1;
      }
      A_req = B * B;
    }

    let B = Math.sqrt(A_req);
    B = Math.ceil(B * 10) / 10;
    B = Math.max(B, 0.6);

    return { B, L: B, D_footing };
  }

  // spread_rectangular
  // Use aspect ratio ~1.5:1 (L/B), optimize to minimize size
  let A_req = P / qa;

  if (Math.abs(M) > 1e-6) {
    const e = Math.abs(M) / P;
    // Assume moment about the longer direction (L)
    let B = Math.sqrt(A_req / 1.5);
    let L = 1.5 * B;
    for (let iter = 0; iter < 20; iter++) {
      const qmax = (P / (B * L)) * (1 + 6 * e / L);
      if (qmax <= qa) break;
      B += 0.05;
      L = 1.5 * B;
    }
    A_req = B * L;
  }

  let B = Math.sqrt(A_req / 1.5);
  let L = 1.5 * B;
  B = Math.ceil(B * 10) / 10;
  L = Math.ceil(L * 10) / 10;
  B = Math.max(B, 0.6);
  L = Math.max(L, B);

  return { B, L, D_footing };
}

// ─── Main design function ────────────────────────────────────────────────────

function designFoundation(params: FoundationParams): FoundationResult {
  const P = params.column_load_kn; // service-level axial load (kN)
  const M = params.column_moment_knm ?? 0; // service-level moment (kN*m)
  const H = params.horizontal_load_kn ?? 0; // horizontal force (kN)
  const qa = params.soil_bearing_capacity_kpa;
  const fc = params.concrete_fc_mpa;
  const fy = params.rebar_fy_mpa;
  const Df = params.depth_m; // embedment depth (m)

  const soil = params.soil_properties;
  const gamma_soil = soil.unit_weight_kn_m3;
  const phi_deg = soil.friction_angle_deg ?? 0;
  const cohesion = soil.cohesion_kpa ?? 0;
  const Es_soil = soil.elastic_modulus_mpa ?? 20; // default soft soil modulus
  const nu_soil = soil.poisson_ratio ?? 0.3;

  // Column dimensions (default 400x400 mm if not specified)
  const col_w = params.column_dimensions?.width_mm ?? 400;
  const col_d = params.column_dimensions?.depth_mm ?? 400;

  // ── Step 1: Size the footing ───────────────────────────────────────────
  const { B, L, D_footing: D_foot_init } = sizeFooting(params);

  // Footing depth (structural): estimate as B/4 but at least 300 mm
  const D_foot_mm = Math.max(Math.ceil((B * 1000) / 4 / 50) * 50, 300);
  const D_foot_m = D_foot_mm / 1000;
  const d_eff_mm = D_foot_mm - FOOTING_COVER_MM - 8; // effective depth (cover + half bar)

  // Footing self-weight
  const footing_self_weight = B * L * D_foot_m * CONCRETE_UNIT_WEIGHT; // kN
  // Soil overburden above footing
  const soil_overburden = B * L * (Df - D_foot_m) * gamma_soil; // kN (soil above footing base)

  // Total vertical load at base
  const P_total = P + footing_self_weight + soil_overburden;

  // ── Step 2: Bearing pressure check ─────────────────────────────────────
  const A = B * L; // footing area (m^2)
  let qmax: number;
  let qmin: number;
  let eccentricity: number | undefined;
  let kern_limit: number | undefined;
  let fullContact = true;

  if (Math.abs(M) > 1e-6) {
    // Eccentricity: e = M / P_total
    const e = Math.abs(M) / P_total;
    eccentricity = e;

    // Kern limit: B/6 (for rectangular footing about the long dimension)
    // Assume moment about the L dimension
    kern_limit = L / 6;

    if (e <= kern_limit) {
      // Full contact: trapezoidal distribution
      // qmax = P_total/A * (1 + 6e/L)
      // qmin = P_total/A * (1 - 6e/L)
      qmax = (P_total / A) * (1 + (6 * e) / L);
      qmin = (P_total / A) * (1 - (6 * e) / L);
    } else {
      // Partial contact (tension zone develops)
      // Effective contact length: L_eff = 3 * (L/2 - e)
      const L_eff = 3 * (L / 2 - e);
      fullContact = false;
      if (L_eff <= 0) {
        qmax = Infinity; // footing overturns - will fail check
        qmin = 0;
      } else {
        qmax = (2 * P_total) / (B * L_eff);
        qmin = 0;
      }
    }
  } else {
    // Concentric load: uniform pressure
    qmax = P_total / A;
    qmin = P_total / A;
  }

  const bearingFOS = Number.isFinite(qmax) && qmax > 0 ? qa / (P / A) : 0;

  const bearingPressureCheck: BearingPressureCheck = {
    max_pressure_kpa: round(qmax, 2),
    min_pressure_kpa: round(qmin, 2),
    allowable_kpa: round(qa, 2),
    eccentricity_m: eccentricity !== undefined ? round(eccentricity, 4) : undefined,
    kern_limit_m: kern_limit !== undefined ? round(kern_limit, 4) : undefined,
    full_contact: fullContact,
    factor_of_safety: round(bearingFOS, 2),
    status: qmax <= qa ? "PASS" : "FAIL",
  };

  // ── Step 3: Terzaghi bearing capacity check ────────────────────────────
  let bearingCapacityCheck: BearingCapacityCheck | undefined;

  if (phi_deg > 0 || cohesion > 0) {
    const { Nc, Nq, Ngamma } = getBearingCapacityFactors(phi_deg);

    // Effective unit weight (adjusted for groundwater if applicable)
    let gamma_eff = gamma_soil;
    if (params.groundwater_depth_m !== undefined && params.groundwater_depth_m < Df + B) {
      // Submerged unit weight below water table (approximately gamma - 9.81)
      const gamma_sub = gamma_soil - 9.81;
      if (params.groundwater_depth_m <= Df) {
        gamma_eff = gamma_sub; // water table above footing base
      } else {
        // Interpolate between footing base and B below
        const depth_below_base = params.groundwater_depth_m - Df;
        gamma_eff = gamma_sub + (gamma_soil - gamma_sub) * (depth_below_base / B);
      }
    }

    // Terzaghi's bearing capacity equation
    let qu: number;
    if (params.footing_type === "strip") {
      // Strip: qu = c*Nc + gamma*Df*Nq + 0.5*gamma*B*Ngamma
      qu = cohesion * Nc + gamma_eff * Df * Nq + 0.5 * gamma_eff * B * Ngamma;
    } else if (params.footing_type === "spread_square") {
      // Square: qu = 1.3*c*Nc + gamma*Df*Nq + 0.4*gamma*B*Ngamma
      qu = 1.3 * cohesion * Nc + gamma_eff * Df * Nq + 0.4 * gamma_eff * B * Ngamma;
    } else {
      // Rectangular: shape factors applied
      // sc = 1 + 0.3*(B/L), sgamma = 1 - 0.2*(B/L)
      const sc = 1 + 0.3 * (B / L);
      const sgamma = 1 - 0.2 * (B / L);
      qu = cohesion * Nc * sc + gamma_eff * Df * Nq + 0.5 * gamma_eff * B * Ngamma * sgamma;
    }

    const appliedPressure = P_total / A;
    const fos_bc = qu / appliedPressure;

    bearingCapacityCheck = {
      ultimate_capacity_kpa: round(qu, 2),
      allowable_capacity_kpa: round(qu / 3, 2), // FOS = 3.0
      applied_pressure_kpa: round(appliedPressure, 2),
      factor_of_safety: round(fos_bc, 2),
      status: fos_bc >= 3.0 ? "PASS" : "FAIL",
    };
  }

  // ── Step 4: Overturning check ──────────────────────────────────────────
  let overturningCheck: OverturningCheck | undefined;

  if (Math.abs(M) > 1e-6 || Math.abs(H) > 1e-6) {
    // Stabilizing moment: weight * (B or L)/2 from the toe
    const stab_moment = P_total * (L / 2); // about the toe (kN*m)

    // Overturning moment: applied moment + horizontal force * height
    // Assume horizontal load applied at top of footing
    const overturn_moment = Math.abs(M) + Math.abs(H) * Df;

    const fos_ot = overturn_moment > 0 ? stab_moment / overturn_moment : Infinity;

    overturningCheck = {
      stabilizing_moment_knm: round(stab_moment, 2),
      overturning_moment_knm: round(overturn_moment, 2),
      factor_of_safety: round(fos_ot, 2),
      status: fos_ot >= 1.5 ? "PASS" : "FAIL",
    };
  }

  // ── Step 5: Sliding check ──────────────────────────────────────────────
  let slidingCheck: SlidingCheck | undefined;

  if (Math.abs(H) > 1e-6) {
    // Resisting force = mu * V + c * A_base
    // mu = tan(phi) for soil-concrete interface (use 2/3 * phi for conservative)
    const mu = phi_deg > 0 ? Math.tan(toRad(phi_deg * 2 / 3)) : 0;
    const friction_resistance = mu * P_total;
    const cohesion_resistance = cohesion * A; // passive pressure contribution (simplified)
    const total_resistance = friction_resistance + cohesion_resistance;

    const fos_slide = total_resistance / Math.abs(H);

    slidingCheck = {
      resisting_force_kn: round(total_resistance, 2),
      applied_horizontal_kn: round(Math.abs(H), 2),
      factor_of_safety: round(fos_slide, 2),
      status: fos_slide >= 1.5 ? "PASS" : "FAIL",
    };
  }

  // ── Step 6: Settlement calculation ─────────────────────────────────────
  // Elastic settlement: delta = q * B * (1 - nu^2) * Iw / Es
  // Iw = influence factor depending on footing shape
  //   Square: Iw ~ 0.82 (flexible, center), ~0.95 (average)
  //   Rectangular: interpolate based on L/B
  //   Strip (L/B > 10): Iw ~ 1.0
  let Iw: number;
  if (params.footing_type === "strip") {
    Iw = 1.0;
  } else if (params.footing_type === "spread_square") {
    Iw = 0.82;
  } else {
    // Rectangular: interpolate between square (0.82) and strip (1.0)
    const ratio = L / B;
    Iw = 0.82 + (1.0 - 0.82) * Math.min((ratio - 1) / 9, 1.0);
  }

  const q_service = P / A; // service-level bearing pressure (kPa)
  const Es_kpa = Es_soil * 1000; // convert MPa to kPa

  // Settlement in mm: delta = q(kPa) * B(m) * (1 - nu^2) * Iw / Es(kPa) * 1000
  const settlement_mm = (q_service * B * (1 - Math.pow(nu_soil, 2)) * Iw / Es_kpa) * 1000;

  // ── Step 7: Structural design ──────────────────────────────────────────
  // Factored load: Pu = 1.2D + 1.6L
  // Assume load split: 60% dead, 40% live (if not specified separately)
  const P_dead = P * 0.6;
  const P_live = P * 0.4;
  const Pu = 1.2 * (P_dead + footing_self_weight + soil_overburden) + 1.6 * P_live;

  // Factored bearing pressure (net upward pressure for structural design)
  // qu_net = Pu / A  (net factored pressure from column load minus footing weight)
  const qu_factored = Pu / A; // kPa

  // ── One-way shear check ────────────────────────────────────────────────
  // Critical section at d from face of column
  const col_w_m = col_w / 1000;
  const col_d_m = col_d / 1000;
  const d_m = d_eff_mm / 1000;

  // Cantilever length from face of column to edge of footing (in the long direction)
  const cantilever_L = (L - col_d_m) / 2;
  const cantilever_B = (B - col_w_m) / 2;

  // One-way shear at d from column face (use the longer cantilever)
  const shear_dist_L = cantilever_L - d_m;
  const shear_dist_B = cantilever_B - d_m;
  const governing_shear_dist = Math.max(shear_dist_L, shear_dist_B);

  // Vu_one_way = qu * B * shear_dist (for strip along B, or L)
  // Use the width perpendicular to the cantilever
  const Vu_one_way_L = qu_factored * B * Math.max(shear_dist_L, 0); // kN
  const Vu_one_way_B = qu_factored * L * Math.max(shear_dist_B, 0); // kN
  const Vu_one_way = Math.max(Vu_one_way_L, Vu_one_way_B);

  // phi*Vc for one-way shear: phi * 0.17 * sqrt(fc) * b * d
  // b = width of footing (perpendicular to shear direction)
  const b_shear = (Vu_one_way === Vu_one_way_L ? B : L) * 1000; // mm
  const phi_Vc_one_way = 0.75 * 0.17 * Math.sqrt(fc) * b_shear * d_eff_mm / 1000; // kN

  const oneWayShearUtil = phi_Vc_one_way > 0 ? Vu_one_way / phi_Vc_one_way : 0;

  // ── Punching (two-way) shear check ─────────────────────────────────────
  // Critical perimeter at d/2 from face of column
  const bo_w = col_w + d_eff_mm; // mm
  const bo_d = col_d + d_eff_mm; // mm
  const bo = 2 * (bo_w + bo_d); // perimeter (mm)

  // Area within punching perimeter (m^2)
  const A_punch = (bo_w / 1000) * (bo_d / 1000);

  // Vu_punch = Pu - qu * A_punch
  const Vu_punch = Pu - qu_factored * A_punch;

  // phi*Vc for punching shear (ACI 318-19, Section 22.6.5.2)
  // Vc = min of:
  //   (a) 0.33 * sqrt(fc) * bo * d
  //   (b) (0.17 + 0.33/beta) * sqrt(fc) * bo * d, where beta = long_side/short_side of column
  //   (c) (0.17 + 0.083*alpha_s*d/bo) * sqrt(fc) * bo * d, alpha_s = 40 for interior
  const beta_col = Math.max(col_d, col_w) / Math.min(col_d, col_w);
  const alpha_s = 40; // interior column

  const Vc_a = 0.33 * Math.sqrt(fc) * bo * d_eff_mm / 1000; // kN
  const Vc_b = (0.17 + 0.33 / beta_col) * Math.sqrt(fc) * bo * d_eff_mm / 1000;
  const Vc_c = (0.17 + 0.083 * alpha_s * d_eff_mm / bo) * Math.sqrt(fc) * bo * d_eff_mm / 1000;
  const Vc_punch = Math.min(Vc_a, Vc_b, Vc_c);
  const phi_Vc_punch = 0.75 * Vc_punch;

  const punchingUtil = phi_Vc_punch > 0 ? Math.max(Vu_punch, 0) / phi_Vc_punch : 0;

  // ── Flexural design ────────────────────────────────────────────────────
  // Moment at face of column: Mu = qu * B * (cantilever)^2 / 2 per meter width
  // In the L direction:
  const Mu_L_knm_per_m = (qu_factored * Math.pow(cantilever_L, 2)) / 2; // kN*m/m
  // In the B direction:
  const Mu_B_knm_per_m = (qu_factored * Math.pow(cantilever_B, 2)) / 2;

  // Required reinforcement in each direction
  const As_req_L = calcRequiredAs(Mu_L_knm_per_m, d_eff_mm, fc, fy, 0.9, 1000);
  const As_req_B = calcRequiredAs(Mu_B_knm_per_m, d_eff_mm, fc, fy, 0.9, 1000);

  // Minimum reinforcement for footings: 0.0018 * b * h (temperature & shrinkage)
  const As_min = 0.0018 * 1000 * D_foot_mm;

  const As_final_L = Math.max(As_req_L, As_min);
  const As_final_B = Math.max(As_req_B, As_min);

  const reinf_L = selectReinforcement(As_final_L);
  const reinf_B = selectReinforcement(As_final_B);

  const structuralDesign: StructuralDesign = {
    footing_depth_mm: D_foot_mm,
    effective_depth_mm: round(d_eff_mm, 1),
    reinforcement_x: {
      bar_size: reinf_B.bar.name,
      bar_diameter_mm: reinf_B.bar.diameter_mm,
      spacing_mm: reinf_B.spacing_mm,
      As_required_mm2_per_m: round(As_final_B, 1),
      As_provided_mm2_per_m: round(reinf_B.As_provided_mm2_per_m, 1),
    },
    reinforcement_y: {
      bar_size: reinf_L.bar.name,
      bar_diameter_mm: reinf_L.bar.diameter_mm,
      spacing_mm: reinf_L.spacing_mm,
      As_required_mm2_per_m: round(As_final_L, 1),
      As_provided_mm2_per_m: round(reinf_L.As_provided_mm2_per_m, 1),
    },
    one_way_shear_check: {
      Vu_kn: round(Vu_one_way, 2),
      phi_Vc_kn: round(phi_Vc_one_way, 2),
      utilization: round(oneWayShearUtil, 4),
      status: oneWayShearUtil <= 1.0 ? "PASS" : "FAIL",
    },
    punching_shear_check: {
      Vu_kn: round(Math.max(Vu_punch, 0), 2),
      phi_Vc_kn: round(phi_Vc_punch, 2),
      utilization: round(punchingUtil, 4),
      bo_mm: round(bo, 0),
      status: punchingUtil <= 1.0 ? "PASS" : "FAIL",
    },
  };

  // ── Overall status ─────────────────────────────────────────────────────
  const allChecks: Array<"PASS" | "FAIL"> = [
    bearingPressureCheck.status,
    structuralDesign.one_way_shear_check.status,
    structuralDesign.punching_shear_check.status,
  ];
  if (bearingCapacityCheck) allChecks.push(bearingCapacityCheck.status);
  if (overturningCheck) allChecks.push(overturningCheck.status);
  if (slidingCheck) allChecks.push(slidingCheck.status);

  const overallStatus = allChecks.every((s) => s === "PASS") ? "PASS" : "FAIL";

  return {
    footing_type: params.footing_type,
    proposed_dimensions: {
      width_m: round(B, 2),
      length_m: round(L, 2),
      depth_m: round(D_foot_m, 3),
    },
    bearing_pressure_check: bearingPressureCheck,
    bearing_capacity_check: bearingCapacityCheck,
    overturning_check: overturningCheck,
    sliding_check: slidingCheck,
    settlement_mm: round(settlement_mm, 2),
    structural_design: structuralDesign,
    overall_status: overallStatus,
  };
}

// ─── Tool definition ─────────────────────────────────────────────────────────

export function createFoundationDesignToolDefinition() {
  return {
    name: "structural_foundation",
    label: "Structural Foundation Design",
    description:
      "Design/check spread footings and strip footings for bearing capacity, settlement, " +
      "overturning, and sliding. Uses Terzaghi's bearing capacity theory for ultimate capacity, " +
      "elastic settlement estimation, and ACI 318 for structural design including one-way shear, " +
      "punching shear, and flexural reinforcement.",
    parameters: {
      type: "object",
      properties: {
        footing_type: {
          type: "string",
          enum: ["spread_square", "spread_rectangular", "strip"],
          description: "Type of footing: spread_square, spread_rectangular, or strip.",
        },
        column_load_kn: {
          type: "number",
          description: "Service-level axial load on the column in kN.",
        },
        column_moment_knm: {
          type: "number",
          description: "Service-level overturning moment in kN*m (optional).",
        },
        horizontal_load_kn: {
          type: "number",
          description: "Horizontal force at the base of the column in kN (optional).",
        },
        column_dimensions: {
          type: "object",
          description: "Column cross-section dimensions (optional, default 400x400 mm).",
          properties: {
            width_mm: {
              type: "number",
              description: "Column width in mm.",
            },
            depth_mm: {
              type: "number",
              description: "Column depth in mm.",
            },
          },
        },
        soil_bearing_capacity_kpa: {
          type: "number",
          description: "Allowable soil bearing pressure in kPa.",
        },
        soil_properties: {
          type: "object",
          description: "Soil engineering properties.",
          properties: {
            unit_weight_kn_m3: {
              type: "number",
              description: "Soil unit weight in kN/m^3 (default 18).",
            },
            friction_angle_deg: {
              type: "number",
              description: "Soil internal friction angle in degrees (optional, for bearing capacity and sliding checks).",
            },
            cohesion_kpa: {
              type: "number",
              description: "Soil cohesion in kPa (optional).",
            },
            elastic_modulus_mpa: {
              type: "number",
              description: "Soil elastic modulus in MPa (optional, for settlement calculation).",
            },
            poisson_ratio: {
              type: "number",
              description: "Soil Poisson's ratio (optional, default 0.3).",
            },
          },
        },
        depth_m: {
          type: "number",
          description: "Footing embedment depth in meters (default 1.0).",
        },
        concrete_fc_mpa: {
          type: "number",
          description: "Concrete compressive strength f'c in MPa (default 25).",
        },
        rebar_fy_mpa: {
          type: "number",
          description: "Rebar yield strength fy in MPa (default 420).",
        },
        groundwater_depth_m: {
          type: "number",
          description: "Depth to groundwater table in meters (optional, adjusts effective unit weight).",
        },
      },
      required: ["footing_type", "column_load_kn", "soil_bearing_capacity_kpa"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details?: unknown;
    }> => {
      const params = (args ?? {}) as Record<string, unknown>;

      // ── Validate footing_type ───────────────────────────────────────────
      const validFootingTypes: FootingType[] = ["spread_square", "spread_rectangular", "strip"];
      const footingType = String(params.footing_type ?? "") as FootingType;
      if (!validFootingTypes.includes(footingType)) {
        throw new Error(
          `footing_type must be one of: ${validFootingTypes.join(", ")}. Got "${params.footing_type}".`,
        );
      }

      // ── Validate column_load_kn ─────────────────────────────────────────
      const column_load_kn = Number(params.column_load_kn);
      if (!Number.isFinite(column_load_kn) || column_load_kn <= 0) {
        throw new Error("column_load_kn must be a positive number.");
      }

      // ── Validate soil_bearing_capacity_kpa ──────────────────────────────
      const soil_bearing_capacity_kpa = Number(params.soil_bearing_capacity_kpa);
      if (!Number.isFinite(soil_bearing_capacity_kpa) || soil_bearing_capacity_kpa <= 0) {
        throw new Error("soil_bearing_capacity_kpa must be a positive number.");
      }

      // ── Optional numeric parameters ─────────────────────────────────────
      const column_moment_knm =
        params.column_moment_knm !== undefined && params.column_moment_knm !== null
          ? Number(params.column_moment_knm)
          : undefined;
      if (column_moment_knm !== undefined && !Number.isFinite(column_moment_knm)) {
        throw new Error("column_moment_knm must be a finite number if provided.");
      }

      const horizontal_load_kn =
        params.horizontal_load_kn !== undefined && params.horizontal_load_kn !== null
          ? Number(params.horizontal_load_kn)
          : undefined;
      if (horizontal_load_kn !== undefined && !Number.isFinite(horizontal_load_kn)) {
        throw new Error("horizontal_load_kn must be a finite number if provided.");
      }

      // ── Column dimensions ───────────────────────────────────────────────
      let column_dimensions: ColumnDimensions | undefined;
      if (params.column_dimensions && typeof params.column_dimensions === "object") {
        const cd = params.column_dimensions as Record<string, unknown>;
        column_dimensions = {
          width_mm: typeof cd.width_mm === "number" ? cd.width_mm : 400,
          depth_mm: typeof cd.depth_mm === "number" ? cd.depth_mm : 400,
        };
      }

      // ── Soil properties ─────────────────────────────────────────────────
      const rawSoil = (params.soil_properties ?? {}) as Record<string, unknown>;
      const soil_properties: SoilProperties = {
        unit_weight_kn_m3:
          typeof rawSoil.unit_weight_kn_m3 === "number" && Number.isFinite(rawSoil.unit_weight_kn_m3)
            ? rawSoil.unit_weight_kn_m3
            : 18,
        friction_angle_deg:
          typeof rawSoil.friction_angle_deg === "number" && Number.isFinite(rawSoil.friction_angle_deg)
            ? rawSoil.friction_angle_deg
            : undefined,
        cohesion_kpa:
          typeof rawSoil.cohesion_kpa === "number" && Number.isFinite(rawSoil.cohesion_kpa)
            ? rawSoil.cohesion_kpa
            : undefined,
        elastic_modulus_mpa:
          typeof rawSoil.elastic_modulus_mpa === "number" && Number.isFinite(rawSoil.elastic_modulus_mpa)
            ? rawSoil.elastic_modulus_mpa
            : undefined,
        poisson_ratio:
          typeof rawSoil.poisson_ratio === "number" && Number.isFinite(rawSoil.poisson_ratio)
            ? rawSoil.poisson_ratio
            : 0.3,
      };

      // ── Other optional parameters ───────────────────────────────────────
      const depth_m =
        typeof params.depth_m === "number" && Number.isFinite(params.depth_m) && params.depth_m > 0
          ? params.depth_m
          : 1.0;

      const concrete_fc_mpa =
        typeof params.concrete_fc_mpa === "number" && Number.isFinite(params.concrete_fc_mpa)
          ? params.concrete_fc_mpa
          : 25;

      const rebar_fy_mpa =
        typeof params.rebar_fy_mpa === "number" && Number.isFinite(params.rebar_fy_mpa)
          ? params.rebar_fy_mpa
          : 420;

      const groundwater_depth_m =
        params.groundwater_depth_m !== undefined && params.groundwater_depth_m !== null
          ? Number(params.groundwater_depth_m)
          : undefined;

      // ── Execute design ──────────────────────────────────────────────────
      const foundationParams: FoundationParams = {
        footing_type: footingType,
        column_load_kn,
        column_moment_knm,
        horizontal_load_kn,
        column_dimensions,
        soil_bearing_capacity_kpa,
        soil_properties,
        depth_m,
        concrete_fc_mpa,
        rebar_fy_mpa,
        groundwater_depth_m,
      };

      const result = designFoundation(foundationParams);

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: {
          footing_type: footingType,
          overall_status: result.overall_status,
          settlement_mm: result.settlement_mm,
        },
      };
    },
  };
}
