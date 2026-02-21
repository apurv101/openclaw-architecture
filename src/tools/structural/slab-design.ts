/**
 * Structural Slab Design tool for civilclaw.
 *
 * Designs/checks a reinforced concrete slab for flexure, shear, and deflection
 * per ACI 318. Supports one-way and two-way slabs with various support conditions.
 *
 * No external dependencies beyond Node.js built-ins.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/** Unit weight of reinforced concrete (kN/m^3) */
const CONCRETE_UNIT_WEIGHT = 24;

/** Standard rebar diameters (mm) and areas (mm^2) */
const REBAR_SIZES: Array<{ name: string; diameter_mm: number; area_mm2: number }> = [
  { name: "#3 (10M)", diameter_mm: 9.5, area_mm2: 71 },
  { name: "#4 (13M)", diameter_mm: 12.7, area_mm2: 129 },
  { name: "#5 (16M)", diameter_mm: 15.9, area_mm2: 199 },
  { name: "#6 (19M)", diameter_mm: 19.1, area_mm2: 284 },
  { name: "#7 (22M)", diameter_mm: 22.2, area_mm2: 387 },
  { name: "#8 (25M)", diameter_mm: 25.4, area_mm2: 510 },
];

// ─── Types ───────────────────────────────────────────────────────────────────

type SlabType = "one_way" | "two_way";
type SupportCondition = "simply_supported" | "fixed" | "continuous";

interface SlabLoads {
  dead_kpa: number;
  live_kpa: number;
  additional_kpa?: number;
}

interface SupportConditions {
  x_left: SupportCondition;
  x_right: SupportCondition;
  y_left?: SupportCondition;
  y_right?: SupportCondition;
}

interface SlabParams {
  slab_type: SlabType;
  span_x_m: number;
  span_y_m?: number;
  thickness_mm: number;
  loads: SlabLoads;
  concrete_fc_mpa: number;
  rebar_fy_mpa: number;
  cover_mm: number;
  support_conditions: SupportConditions;
  design_code: string;
}

interface ReinforcementResult {
  main_bar_size: string;
  main_bar_diameter_mm: number;
  main_bar_spacing_mm: number;
  As_required_mm2_per_m: number;
  As_provided_mm2_per_m: number;
  distribution_bar_size: string;
  distribution_bar_diameter_mm: number;
  distribution_bar_spacing_mm: number;
  As_dist_required_mm2_per_m: number;
  As_dist_provided_mm2_per_m: number;
}

interface ShearCheck {
  Vu_kn_per_m: number;
  phi_Vc_kn_per_m: number;
  utilization: number;
  status: "PASS" | "FAIL";
}

interface DeflectionCheck {
  immediate_mm: number;
  long_term_mm: number;
  allowable_total_mm: number;
  allowable_live_mm: number;
  status: "PASS" | "FAIL";
  note: string;
}

interface SlabResult {
  slab_type: SlabType;
  spans: { x_m: number; y_m?: number };
  thickness_mm: number;
  self_weight_kpa: number;
  factored_load_kpa: number;
  moment_knm_per_m: number;
  negative_moment_knm_per_m?: number;
  required_reinforcement: ReinforcementResult;
  shear_check: ShearCheck;
  deflection_check: DeflectionCheck;
  min_thickness_check: {
    min_thickness_mm: number;
    provided_mm: number;
    status: "PASS" | "FAIL";
  };
  two_way_details?: {
    total_static_moment_knm: number;
    column_strip_positive_knm: number;
    column_strip_negative_knm: number;
    middle_strip_positive_knm: number;
    middle_strip_negative_knm: number;
  };
  overall_status: "PASS" | "FAIL";
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

// ─── ACI moment coefficients ─────────────────────────────────────────────────

/**
 * Return the ACI 318 moment coefficient denominator for wu*L^2 / coeff.
 * The moment = wu * L^2 / coeff, so larger coeff = smaller moment.
 *
 * For simply supported: coeff = 8 (positive moment only)
 * For one end continuous: coeff = 14 (positive), 10 (negative at continuous end)
 * For both ends continuous: coeff = 16 (positive), 11 (negative at face of support)
 * For fixed: coeff = 24 (positive), 12 (negative at support)
 */
function getMomentCoefficients(
  left: SupportCondition,
  right: SupportCondition,
): { positive_coeff: number; negative_coeff: number } {
  const isLeftFixed = left === "fixed" || left === "continuous";
  const isRightFixed = right === "fixed" || right === "continuous";

  if (!isLeftFixed && !isRightFixed) {
    // Simply supported both ends
    return { positive_coeff: 8, negative_coeff: Infinity }; // no negative moment
  } else if (isLeftFixed && isRightFixed) {
    // Fixed/continuous both ends
    if (left === "fixed" && right === "fixed") {
      return { positive_coeff: 24, negative_coeff: 12 };
    }
    return { positive_coeff: 16, negative_coeff: 11 };
  } else {
    // One end continuous/fixed, other simply supported
    return { positive_coeff: 14, negative_coeff: 10 };
  }
}

// ─── ACI minimum slab thickness ──────────────────────────────────────────────

/**
 * ACI 318-19 Table 7.3.1.1 minimum thickness for one-way slabs.
 * Returns minimum thickness in mm.
 */
function getMinThicknessOneWay(span_mm: number, left: SupportCondition, right: SupportCondition): number {
  const isLeftFixed = left === "fixed" || left === "continuous";
  const isRightFixed = right === "fixed" || right === "continuous";

  if (!isLeftFixed && !isRightFixed) {
    // Simply supported: L/20
    return span_mm / 20;
  } else if (isLeftFixed && isRightFixed) {
    // Both ends continuous: L/28
    return span_mm / 28;
  } else if ((left === "fixed" && right === "fixed")) {
    // Both ends fixed (integral): L/28 is conservative
    return span_mm / 28;
  } else {
    // One end continuous: L/24
    return span_mm / 24;
  }
}

/**
 * ACI 318-19 Table 8.3.1.1 minimum thickness for two-way slabs.
 * Simplified: uses Ln/30 for slabs without beams.
 */
function getMinThicknessTwoWay(longer_span_mm: number): number {
  return Math.max(longer_span_mm / 30, 125); // ACI minimum 125 mm
}

// ─── Reinforcement selection ─────────────────────────────────────────────────

/**
 * Select reinforcement bar size and spacing to provide at least As_required
 * per meter width of slab.
 */
function selectReinforcement(
  As_required_mm2_per_m: number,
  preferred_min_spacing_mm: number = 100,
): { bar: typeof REBAR_SIZES[0]; spacing_mm: number; As_provided_mm2_per_m: number } {
  // Try each bar size from smallest to largest
  for (const bar of REBAR_SIZES) {
    // Spacing = 1000 * Ab / As_required
    const spacing = (1000 * bar.area_mm2) / As_required_mm2_per_m;

    if (spacing >= preferred_min_spacing_mm) {
      // Round down to nearest 5 mm (more conservative)
      const spacingRounded = Math.floor(spacing / 5) * 5;
      // Ensure spacing does not exceed max per ACI (3h or 450 mm)
      const finalSpacing = Math.min(Math.max(spacingRounded, preferred_min_spacing_mm), 450);
      const As_provided = (1000 * bar.area_mm2) / finalSpacing;
      return { bar, spacing_mm: finalSpacing, As_provided_mm2_per_m: As_provided };
    }
  }

  // If no single bar works at reasonable spacing, use the largest bar at minimum spacing
  const largest = REBAR_SIZES[REBAR_SIZES.length - 1]!;
  const As_provided = (1000 * largest.area_mm2) / preferred_min_spacing_mm;
  return { bar: largest, spacing_mm: preferred_min_spacing_mm, As_provided_mm2_per_m: As_provided };
}

// ─── Required reinforcement using quadratic formula ──────────────────────────

/**
 * Calculate required steel area per meter width for a given moment.
 *
 * From equilibrium:  Mu = phi * As * fy * (d - a/2)
 * where a = As * fy / (0.85 * fc * b)
 *
 * Rearranging into quadratic in As:
 *   As^2 * (fy / (1.7 * fc * b)) - As * d + Mu / (phi * fy) = 0
 *
 * Using quadratic formula: As = [d - sqrt(d^2 - 2*Mu/(phi*0.85*fc*b))] * (0.85*fc*b) / fy
 */
function calcRequiredAs(
  Mu_knm_per_m: number,
  d_mm: number,
  fc_mpa: number,
  fy_mpa: number,
  phi: number = 0.9,
  b_mm: number = 1000,
): number {
  // Mu in N*mm (convert from kN*m/m: *1e6)
  const Mu_Nmm = Math.abs(Mu_knm_per_m) * 1e6;

  // Coefficient
  const coeff = 2 * Mu_Nmm / (phi * 0.85 * fc_mpa * b_mm);
  const discriminant = d_mm * d_mm - coeff;

  if (discriminant < 0) {
    // Section is too small for the given moment (compression failure)
    // Return a large value to indicate the section needs to be increased
    return 0.04 * b_mm * d_mm; // ACI max reinforcement ratio as fallback
  }

  const As = (0.85 * fc_mpa * b_mm / fy_mpa) * (d_mm - Math.sqrt(discriminant));
  return Math.max(As, 0);
}

// ─── One-way slab design ─────────────────────────────────────────────────────

function designOneWaySlab(params: SlabParams): SlabResult {
  const { span_x_m, thickness_mm, loads, concrete_fc_mpa: fc, rebar_fy_mpa: fy, cover_mm, support_conditions } = params;
  const b = 1000; // per meter width (mm)
  const h = thickness_mm;

  // Assume main bar diameter for effective depth calculation (start with #5 bar = 15.9 mm)
  const assumed_db = 15.9;
  const d = h - cover_mm - assumed_db / 2; // effective depth (mm)

  // Self-weight (kPa)
  const self_weight_kpa = (thickness_mm / 1000) * CONCRETE_UNIT_WEIGHT;

  // Total service loads
  const dead_total = loads.dead_kpa + self_weight_kpa + (loads.additional_kpa ?? 0);
  const live_total = loads.live_kpa;

  // Factored load per ACI 318: wu = 1.2D + 1.6L (kPa = kN/m^2)
  const wu = 1.2 * dead_total + 1.6 * live_total;

  // Span in mm
  const L_mm = span_x_m * 1000;

  // Moment coefficients based on support conditions
  const { positive_coeff, negative_coeff } = getMomentCoefficients(
    support_conditions.x_left,
    support_conditions.x_right,
  );

  // Positive moment: Mu+ = wu * L^2 / coeff (kN*m/m)
  const Mu_pos = (wu * Math.pow(span_x_m, 2)) / positive_coeff;

  // Negative moment (if applicable)
  const Mu_neg = Number.isFinite(negative_coeff)
    ? (wu * Math.pow(span_x_m, 2)) / negative_coeff
    : 0;

  // Governing moment for main reinforcement design
  const Mu_design = Math.max(Mu_pos, Mu_neg);

  // ── Required flexural reinforcement ────────────────────────────────────
  const As_required = calcRequiredAs(Mu_design, d, fc, fy, 0.9, b);

  // Minimum reinforcement per ACI 318-19, Section 7.6.1.1
  // For Grade 420 (fy >= 420): As_min = 0.0018 * b * h
  // For Grade 300: As_min = 0.0020 * b * h
  // General: As_min = max(0.0014*b*h, 0.0018*b*h for fy=420)
  const As_min = fy >= 420 ? 0.0018 * b * h : 0.0020 * b * h;
  const As_final = Math.max(As_required, As_min);

  // Select main reinforcement
  const mainReinf = selectReinforcement(As_final);

  // ── Temperature & shrinkage reinforcement (perpendicular direction) ────
  // ACI 318-19, Section 7.6.4.1: 0.0018 * b * h for Grade 420
  const As_temp = fy >= 420 ? 0.0018 * b * h : 0.0020 * b * h;
  const distReinf = selectReinforcement(As_temp);

  // ── Shear check ────────────────────────────────────────────────────────
  // Vu at d from face of support for simply supported; at face for continuous
  const isSimplySupported =
    support_conditions.x_left === "simply_supported" &&
    support_conditions.x_right === "simply_supported";

  let Vu_kn_per_m: number;
  if (isSimplySupported) {
    // Vu = wu * (L/2 - d) at distance d from support
    Vu_kn_per_m = wu * (span_x_m / 2 - d / 1000);
  } else {
    // Vu = 1.15 * wu * L / 2 for continuous end (ACI coefficient)
    Vu_kn_per_m = 1.15 * wu * span_x_m / 2;
  }

  // Concrete shear capacity: phi*Vc = phi * 0.17 * sqrt(fc) * b * d  (ACI 318-19, Section 22.5.5.1)
  // phi = 0.75 for shear
  // Units: 0.17 * sqrt(MPa) * mm * mm = N -> convert to kN
  const phi_Vc_kn_per_m = 0.75 * 0.17 * Math.sqrt(fc) * b * d / 1000;

  const shearUtilization = Math.abs(Vu_kn_per_m) / phi_Vc_kn_per_m;
  const shearCheck: ShearCheck = {
    Vu_kn_per_m: round(Math.abs(Vu_kn_per_m), 2),
    phi_Vc_kn_per_m: round(phi_Vc_kn_per_m, 2),
    utilization: round(shearUtilization, 4),
    status: shearUtilization <= 1.0 ? "PASS" : "FAIL",
  };

  // ── Deflection check ───────────────────────────────────────────────────
  // Modulus of elasticity of concrete: Ec = 4700 * sqrt(fc) (MPa)
  const Ec = 4700 * Math.sqrt(fc);

  // Gross moment of inertia: Ig = b * h^3 / 12
  const Ig = b * Math.pow(h, 3) / 12; // mm^4

  // Cracking moment: Mcr = fr * Ig / yt
  // Modulus of rupture: fr = 0.62 * sqrt(fc) (MPa)
  const fr = 0.62 * Math.sqrt(fc);
  const yt = h / 2;
  const Mcr = fr * Ig / yt / 1e6; // kN*m/m

  // Service moment (unfactored)
  const ws = dead_total + live_total; // service load (kPa)
  const Ma_service = (ws * Math.pow(span_x_m, 2)) / positive_coeff; // kN*m/m

  // Effective moment of inertia (ACI 318 Branson's equation)
  // Ie = (Mcr/Ma)^3 * Ig + (1 - (Mcr/Ma)^3) * Icr <= Ig
  // Cracked moment of inertia (approximate): Icr ~ b*d^3/3 * (n*rho) * (some factor)
  // Simplified: Icr ~ 0.35 * Ig for typical slabs
  const Icr = 0.35 * Ig;

  let Ie: number;
  if (Ma_service <= 0 || Ma_service <= Mcr) {
    Ie = Ig; // uncracked
  } else {
    const ratio3 = Math.pow(Mcr / Ma_service, 3);
    Ie = ratio3 * Ig + (1 - ratio3) * Icr;
    Ie = Math.min(Ie, Ig);
  }

  // Immediate deflection: delta = 5 * w * L^4 / (384 * E * I) for simply supported
  // For other conditions, adjust by factor:
  //   Simply supported: 5/384
  //   One end continuous: 1/185 (approx 0.0054)
  //   Both ends continuous: 1/384
  //   Both ends fixed: 1/384
  let deflCoeff: number;
  if (isSimplySupported) {
    deflCoeff = 5 / 384;
  } else if (
    (support_conditions.x_left === "fixed" || support_conditions.x_left === "continuous") &&
    (support_conditions.x_right === "fixed" || support_conditions.x_right === "continuous")
  ) {
    deflCoeff = 1 / 384;
  } else {
    deflCoeff = 0.0054; // one end continuous
  }

  // w in N/mm (service load): ws (kN/m^2) * 1 m width * 1000 mm/m / 1e6...
  // Actually: ws in kPa = kN/m^2. For 1m strip: w = ws kN/m = ws N/mm
  const w_service_N_per_mm = ws; // kN/m per m width = N/mm (numerically the same)
  const w_live_N_per_mm = live_total;

  // Immediate deflection from total service load
  const delta_immediate_total = deflCoeff * w_service_N_per_mm * Math.pow(L_mm, 4) / (Ec * Ie);

  // Immediate deflection from live load only
  const delta_immediate_live = deflCoeff * w_live_N_per_mm * Math.pow(L_mm, 4) / (Ec * Ie);

  // Long-term deflection multiplier (ACI 318-19, Section 24.2.4.1)
  // lambda_delta = xi / (1 + 50*rho') where xi = 2.0 for 5+ years, rho' = compression reinforcement ratio
  // For slabs, typically rho' ~ 0, so lambda_delta ~ 2.0
  const lambda_delta = 2.0;
  const delta_long_term = delta_immediate_total * lambda_delta;

  // Total deflection
  const delta_total = delta_immediate_total + delta_long_term;

  // Allowable deflections per ACI 318-19, Table 24.2.2
  const allowable_total = L_mm / 240; // floor construction, total
  const allowable_live = L_mm / 360; // live load only (more conservative for partitions: L/480)

  const deflectionPass = delta_total <= allowable_total && delta_immediate_live <= allowable_live;

  const deflectionCheck: DeflectionCheck = {
    immediate_mm: round(delta_immediate_total, 2),
    long_term_mm: round(delta_long_term, 2),
    allowable_total_mm: round(allowable_total, 2),
    allowable_live_mm: round(allowable_live, 2),
    status: deflectionPass ? "PASS" : "FAIL",
    note: `Immediate (total service): ${round(delta_immediate_total, 2)} mm, ` +
      `Immediate (live only): ${round(delta_immediate_live, 2)} mm, ` +
      `Long-term (total): ${round(delta_total, 2)} mm`,
  };

  // ── Minimum thickness check ────────────────────────────────────────────
  const minThickness = getMinThicknessOneWay(L_mm, support_conditions.x_left, support_conditions.x_right);

  // ── Assemble result ────────────────────────────────────────────────────
  const reinforcement: ReinforcementResult = {
    main_bar_size: mainReinf.bar.name,
    main_bar_diameter_mm: mainReinf.bar.diameter_mm,
    main_bar_spacing_mm: mainReinf.spacing_mm,
    As_required_mm2_per_m: round(As_final, 1),
    As_provided_mm2_per_m: round(mainReinf.As_provided_mm2_per_m, 1),
    distribution_bar_size: distReinf.bar.name,
    distribution_bar_diameter_mm: distReinf.bar.diameter_mm,
    distribution_bar_spacing_mm: distReinf.spacing_mm,
    As_dist_required_mm2_per_m: round(As_temp, 1),
    As_dist_provided_mm2_per_m: round(distReinf.As_provided_mm2_per_m, 1),
  };

  const minThickCheck = {
    min_thickness_mm: round(minThickness, 1),
    provided_mm: thickness_mm,
    status: (thickness_mm >= minThickness ? "PASS" : "FAIL") as "PASS" | "FAIL",
  };

  const overallStatus =
    shearCheck.status === "PASS" &&
    deflectionCheck.status === "PASS" &&
    minThickCheck.status === "PASS"
      ? "PASS"
      : "FAIL";

  return {
    slab_type: "one_way",
    spans: { x_m: span_x_m },
    thickness_mm,
    self_weight_kpa: round(self_weight_kpa, 2),
    factored_load_kpa: round(wu, 2),
    moment_knm_per_m: round(Mu_pos, 3),
    negative_moment_knm_per_m: Mu_neg > 0 ? round(Mu_neg, 3) : undefined,
    required_reinforcement: reinforcement,
    shear_check: shearCheck,
    deflection_check: deflectionCheck,
    min_thickness_check: minThickCheck,
    overall_status: overallStatus,
  };
}

// ─── Two-way slab design (Direct Design Method) ──────────────────────────────

function designTwoWaySlab(params: SlabParams): SlabResult {
  const {
    span_x_m,
    span_y_m,
    thickness_mm,
    loads,
    concrete_fc_mpa: fc,
    rebar_fy_mpa: fy,
    cover_mm,
    support_conditions,
  } = params;

  if (!span_y_m || span_y_m <= 0) {
    throw new Error("span_y_m is required for two-way slab design.");
  }

  const b = 1000; // per meter width (mm)
  const h = thickness_mm;
  const assumed_db = 15.9;
  const d = h - cover_mm - assumed_db / 2;

  // Self-weight (kPa)
  const self_weight_kpa = (thickness_mm / 1000) * CONCRETE_UNIT_WEIGHT;

  // Total service loads
  const dead_total = loads.dead_kpa + self_weight_kpa + (loads.additional_kpa ?? 0);
  const live_total = loads.live_kpa;

  // Factored load
  const wu = 1.2 * dead_total + 1.6 * live_total;

  // Determine longer and shorter spans
  const L1 = Math.max(span_x_m, span_y_m); // longer span
  const L2 = Math.min(span_x_m, span_y_m); // shorter span

  // Clear span: Ln = L1 (approximation, assuming face-to-face distance ~ span)
  const Ln = L1;

  // ── Direct Design Method (ACI 318-19 Section 8.10) ─────────────────────
  // Total static moment: Mo = wu * L2 * Ln^2 / 8 (kN*m)
  const Mo = (wu * L2 * Math.pow(Ln, 2)) / 8;

  // Distribution of total static moment to negative and positive regions
  // For interior span: 65% negative, 35% positive
  // For end span: varies; use simplified values
  const isInterior =
    (support_conditions.x_left === "continuous" || support_conditions.x_left === "fixed") &&
    (support_conditions.x_right === "continuous" || support_conditions.x_right === "fixed");

  let neg_fraction: number;
  let pos_fraction: number;

  if (isInterior) {
    neg_fraction = 0.65;
    pos_fraction = 0.35;
  } else {
    // End span with one edge simply supported
    neg_fraction = 0.70; // at continuous edge
    pos_fraction = 0.52; // note: fractions don't sum to 1.0 for end span
    // At the simply supported edge, negative moment ~ 0
  }

  const Mu_neg_total = neg_fraction * Mo;
  const Mu_pos_total = pos_fraction * Mo;

  // Distribution between column strip and middle strip
  // Column strip width = min(0.25*L1, 0.25*L2) on each side = total 0.5*L2 (approx)
  // ACI factors (for slabs without beams, alpha = 0):
  //   Column strip takes: 75% of negative moment, 60% of positive moment
  //   Middle strip takes the remainder
  const cs_neg = 0.75 * Mu_neg_total;
  const ms_neg = Mu_neg_total - cs_neg;
  const cs_pos = 0.60 * Mu_pos_total;
  const ms_pos = Mu_pos_total - cs_pos;

  // Column strip width (m)
  const cs_width = Math.min(0.25 * L1, 0.25 * L2) * 2;
  // Middle strip width (m)
  const ms_width = L2 - cs_width;

  // Moment per meter width for reinforcement design (use column strip negative as governing)
  const Mu_cs_neg_per_m = cs_neg / cs_width;
  const Mu_cs_pos_per_m = cs_pos / cs_width;
  const Mu_ms_neg_per_m = ms_width > 0 ? ms_neg / ms_width : 0;
  const Mu_ms_pos_per_m = ms_width > 0 ? ms_pos / ms_width : 0;

  // Governing moment for design (worst case)
  const Mu_design = Math.max(Mu_cs_neg_per_m, Mu_cs_pos_per_m, Mu_ms_neg_per_m, Mu_ms_pos_per_m);

  // ── Required flexural reinforcement ────────────────────────────────────
  const As_required = calcRequiredAs(Mu_design, d, fc, fy, 0.9, b);

  // Minimum reinforcement: 0.0018*b*h for Grade 420
  const As_min = fy >= 420 ? 0.0018 * b * h : 0.0020 * b * h;
  const As_final = Math.max(As_required, As_min);

  const mainReinf = selectReinforcement(As_final);

  // Distribution (perpendicular) reinforcement
  const As_temp = fy >= 420 ? 0.0018 * b * h : 0.0020 * b * h;
  const distReinf = selectReinforcement(As_temp);

  // ── Shear check ────────────────────────────────────────────────────────
  // For two-way slab, punching shear is typically checked at columns.
  // For a distributed load, one-way shear check:
  const Vu_kn_per_m = wu * (L1 / 2 - d / 1000);
  const phi_Vc_kn_per_m = 0.75 * 0.17 * Math.sqrt(fc) * b * d / 1000;
  const shearUtilization = Math.abs(Vu_kn_per_m) / phi_Vc_kn_per_m;

  const shearCheck: ShearCheck = {
    Vu_kn_per_m: round(Math.abs(Vu_kn_per_m), 2),
    phi_Vc_kn_per_m: round(phi_Vc_kn_per_m, 2),
    utilization: round(shearUtilization, 4),
    status: shearUtilization <= 1.0 ? "PASS" : "FAIL",
  };

  // ── Deflection check ───────────────────────────────────────────────────
  const Ec = 4700 * Math.sqrt(fc);
  const Ig = b * Math.pow(h, 3) / 12;
  const fr = 0.62 * Math.sqrt(fc);
  const Mcr = fr * Ig / (h / 2) / 1e6;
  const ws = dead_total + live_total;

  // Service moment (approximate, use shorter span)
  const Ma_service = (ws * Math.pow(L2, 2)) / 8;

  const Icr = 0.35 * Ig;
  let Ie: number;
  if (Ma_service <= Mcr) {
    Ie = Ig;
  } else {
    const ratio3 = Math.pow(Mcr / Ma_service, 3);
    Ie = ratio3 * Ig + (1 - ratio3) * Icr;
    Ie = Math.min(Ie, Ig);
  }

  // Use shorter span for deflection (two-way plate bending reduces deflection)
  // Apply two-way reduction factor ~ 0.5-0.7 compared to one-way
  const L_defl_mm = L2 * 1000;
  const twoWayFactor = 0.6; // approximate reduction for two-way action
  const deflCoeff = 5 / 384;

  const w_service_N_per_mm = ws;
  const delta_immediate = twoWayFactor * deflCoeff * w_service_N_per_mm * Math.pow(L_defl_mm, 4) / (Ec * Ie);
  const delta_live = twoWayFactor * deflCoeff * live_total * Math.pow(L_defl_mm, 4) / (Ec * Ie);

  const lambda_delta = 2.0;
  const delta_long_term = delta_immediate * lambda_delta;
  const delta_total = delta_immediate + delta_long_term;

  const allowable_total = L_defl_mm / 240;
  const allowable_live = L_defl_mm / 360;

  const deflectionPass = delta_total <= allowable_total && delta_live <= allowable_live;

  const deflectionCheck: DeflectionCheck = {
    immediate_mm: round(delta_immediate, 2),
    long_term_mm: round(delta_long_term, 2),
    allowable_total_mm: round(allowable_total, 2),
    allowable_live_mm: round(allowable_live, 2),
    status: deflectionPass ? "PASS" : "FAIL",
    note: `Two-way slab deflection (shorter span ${L2} m). ` +
      `Total: ${round(delta_total, 2)} mm vs allowable ${round(allowable_total, 2)} mm. ` +
      `Live: ${round(delta_live, 2)} mm vs allowable ${round(allowable_live, 2)} mm.`,
  };

  // ── Minimum thickness check ────────────────────────────────────────────
  const longerSpan_mm = L1 * 1000;
  const minThickness = getMinThicknessTwoWay(longerSpan_mm);

  const minThickCheck = {
    min_thickness_mm: round(minThickness, 1),
    provided_mm: thickness_mm,
    status: (thickness_mm >= minThickness ? "PASS" : "FAIL") as "PASS" | "FAIL",
  };

  // ── Reinforcement result ───────────────────────────────────────────────
  const reinforcement: ReinforcementResult = {
    main_bar_size: mainReinf.bar.name,
    main_bar_diameter_mm: mainReinf.bar.diameter_mm,
    main_bar_spacing_mm: mainReinf.spacing_mm,
    As_required_mm2_per_m: round(As_final, 1),
    As_provided_mm2_per_m: round(mainReinf.As_provided_mm2_per_m, 1),
    distribution_bar_size: distReinf.bar.name,
    distribution_bar_diameter_mm: distReinf.bar.diameter_mm,
    distribution_bar_spacing_mm: distReinf.spacing_mm,
    As_dist_required_mm2_per_m: round(As_temp, 1),
    As_dist_provided_mm2_per_m: round(distReinf.As_provided_mm2_per_m, 1),
  };

  const overallStatus =
    shearCheck.status === "PASS" &&
    deflectionCheck.status === "PASS" &&
    minThickCheck.status === "PASS"
      ? "PASS"
      : "FAIL";

  return {
    slab_type: "two_way",
    spans: { x_m: span_x_m, y_m: span_y_m },
    thickness_mm,
    self_weight_kpa: round(self_weight_kpa, 2),
    factored_load_kpa: round(wu, 2),
    moment_knm_per_m: round(Mu_design, 3),
    required_reinforcement: reinforcement,
    shear_check: shearCheck,
    deflection_check: deflectionCheck,
    min_thickness_check: minThickCheck,
    two_way_details: {
      total_static_moment_knm: round(Mo, 3),
      column_strip_positive_knm: round(cs_pos, 3),
      column_strip_negative_knm: round(cs_neg, 3),
      middle_strip_positive_knm: round(ms_pos, 3),
      middle_strip_negative_knm: round(ms_neg, 3),
    },
    overall_status: overallStatus,
  };
}

// ─── Tool definition ─────────────────────────────────────────────────────────

export function createSlabDesignToolDefinition() {
  return {
    name: "structural_slab",
    label: "Structural Slab Design",
    description:
      "Design/check a reinforced concrete slab for flexure, shear, and deflection per ACI 318. " +
      "Supports one-way and two-way slabs with various support conditions. Calculates required " +
      "reinforcement, checks shear capacity, evaluates deflections using Branson's equation, " +
      "and verifies minimum thickness requirements.",
    parameters: {
      type: "object",
      properties: {
        slab_type: {
          type: "string",
          enum: ["one_way", "two_way"],
          description: "Type of slab: one-way or two-way.",
        },
        span_x_m: {
          type: "number",
          description: "Span in the x-direction in meters.",
        },
        span_y_m: {
          type: "number",
          description: "Span in the y-direction in meters (required for two-way slabs).",
        },
        thickness_mm: {
          type: "number",
          description: "Slab thickness in mm.",
        },
        loads: {
          type: "object",
          description: "Applied loads on the slab.",
          properties: {
            dead_kpa: {
              type: "number",
              description: "Superimposed dead load in kPa (excluding self-weight, which is calculated automatically).",
            },
            live_kpa: {
              type: "number",
              description: "Live load in kPa.",
            },
            additional_kpa: {
              type: "number",
              description: "Additional loads in kPa (e.g., partitions, MEP) (optional).",
            },
          },
          required: ["dead_kpa", "live_kpa"],
        },
        concrete_fc_mpa: {
          type: "number",
          description: "Concrete compressive strength f'c in MPa (default 30).",
        },
        rebar_fy_mpa: {
          type: "number",
          description: "Rebar yield strength fy in MPa (default 420).",
        },
        cover_mm: {
          type: "number",
          description: "Clear cover to reinforcement in mm (default 20).",
        },
        support_conditions: {
          type: "object",
          description: "Support conditions at each edge.",
          properties: {
            x_left: {
              type: "string",
              enum: ["simply_supported", "fixed", "continuous"],
              description: 'Support at left edge in x-direction (default "simply_supported").',
            },
            x_right: {
              type: "string",
              enum: ["simply_supported", "fixed", "continuous"],
              description: 'Support at right edge in x-direction (default "simply_supported").',
            },
            y_left: {
              type: "string",
              enum: ["simply_supported", "fixed", "continuous"],
              description: 'Support at left edge in y-direction (for two-way, default "simply_supported").',
            },
            y_right: {
              type: "string",
              enum: ["simply_supported", "fixed", "continuous"],
              description: 'Support at right edge in y-direction (for two-way, default "simply_supported").',
            },
          },
        },
        design_code: {
          type: "string",
          enum: ["ACI318"],
          description: 'Design code to use (default "ACI318").',
        },
      },
      required: ["slab_type", "span_x_m", "thickness_mm", "loads"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details?: unknown;
    }> => {
      const params = (args ?? {}) as Record<string, unknown>;

      // ── Validate slab_type ──────────────────────────────────────────────
      const slabType = String(params.slab_type ?? "one_way") as SlabType;
      if (slabType !== "one_way" && slabType !== "two_way") {
        throw new Error('slab_type must be "one_way" or "two_way".');
      }

      // ── Validate spans ──────────────────────────────────────────────────
      const span_x_m = Number(params.span_x_m);
      if (!Number.isFinite(span_x_m) || span_x_m <= 0) {
        throw new Error("span_x_m must be a positive number.");
      }

      let span_y_m: number | undefined;
      if (slabType === "two_way") {
        span_y_m = Number(params.span_y_m);
        if (!Number.isFinite(span_y_m) || span_y_m <= 0) {
          throw new Error("span_y_m is required and must be a positive number for two-way slabs.");
        }
      } else if (params.span_y_m !== undefined && params.span_y_m !== null) {
        span_y_m = Number(params.span_y_m);
      }

      // ── Validate thickness ──────────────────────────────────────────────
      const thickness_mm = Number(params.thickness_mm);
      if (!Number.isFinite(thickness_mm) || thickness_mm <= 0) {
        throw new Error("thickness_mm must be a positive number.");
      }

      // ── Validate loads ──────────────────────────────────────────────────
      if (!params.loads || typeof params.loads !== "object") {
        throw new Error("loads is required and must be an object with dead_kpa and live_kpa.");
      }
      const rawLoads = params.loads as Record<string, unknown>;
      const dead_kpa = Number(rawLoads.dead_kpa);
      const live_kpa = Number(rawLoads.live_kpa);
      if (!Number.isFinite(dead_kpa) || dead_kpa < 0) {
        throw new Error("loads.dead_kpa must be a non-negative number.");
      }
      if (!Number.isFinite(live_kpa) || live_kpa < 0) {
        throw new Error("loads.live_kpa must be a non-negative number.");
      }
      const additional_kpa =
        rawLoads.additional_kpa !== undefined && rawLoads.additional_kpa !== null
          ? Number(rawLoads.additional_kpa)
          : undefined;

      const loads: SlabLoads = { dead_kpa, live_kpa, additional_kpa };

      // ── Optional parameters with defaults ───────────────────────────────
      const concrete_fc_mpa =
        typeof params.concrete_fc_mpa === "number" && Number.isFinite(params.concrete_fc_mpa)
          ? params.concrete_fc_mpa
          : 30;

      const rebar_fy_mpa =
        typeof params.rebar_fy_mpa === "number" && Number.isFinite(params.rebar_fy_mpa)
          ? params.rebar_fy_mpa
          : 420;

      const cover_mm =
        typeof params.cover_mm === "number" && Number.isFinite(params.cover_mm)
          ? params.cover_mm
          : 20;

      // ── Support conditions ──────────────────────────────────────────────
      const rawSupport = (params.support_conditions ?? {}) as Record<string, unknown>;
      const validSupports = new Set(["simply_supported", "fixed", "continuous"]);

      const parseSupport = (val: unknown, def: SupportCondition): SupportCondition => {
        if (typeof val === "string" && validSupports.has(val)) return val as SupportCondition;
        return def;
      };

      const support_conditions: SupportConditions = {
        x_left: parseSupport(rawSupport.x_left, "simply_supported"),
        x_right: parseSupport(rawSupport.x_right, "simply_supported"),
        y_left: parseSupport(rawSupport.y_left, "simply_supported"),
        y_right: parseSupport(rawSupport.y_right, "simply_supported"),
      };

      const design_code = String(params.design_code ?? "ACI318");

      // ── Build params and execute ────────────────────────────────────────
      const slabParams: SlabParams = {
        slab_type: slabType,
        span_x_m,
        span_y_m,
        thickness_mm,
        loads,
        concrete_fc_mpa,
        rebar_fy_mpa,
        cover_mm,
        support_conditions,
        design_code,
      };

      let result: SlabResult;
      if (slabType === "one_way") {
        result = designOneWaySlab(slabParams);
      } else {
        result = designTwoWaySlab(slabParams);
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: {
          slab_type: slabType,
          overall_status: result.overall_status,
        },
      };
    },
  };
}
