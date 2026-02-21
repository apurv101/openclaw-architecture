/**
 * ADA Compliance Check tool for civilclaw.
 *
 * Checks a building design against ADA (Americans with Disabilities Act)
 * Standards for Accessible Design requirements including accessible routes,
 * doors, ramps, restrooms, parking, and elevators.
 *
 * No external dependencies beyond standard TypeScript.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

type BuildingType =
  | "commercial"
  | "residential_common_area"
  | "public"
  | "healthcare"
  | "educational";

type SpaceType =
  | "corridor"
  | "restroom"
  | "entrance"
  | "parking"
  | "elevator_lobby"
  | "stairway"
  | "dining"
  | "assembly"
  | "office"
  | "retail"
  | "custom";

type HardwareType = "lever" | "knob" | "push_pull" | "automatic";

type CheckStatus = "PASS" | "FAIL" | "WARNING" | "NOT_CHECKED";

interface Space {
  name: string;
  type: SpaceType;
  width_mm?: number;
  length_mm?: number;
}

interface Door {
  location: string;
  clear_width_mm: number;
  threshold_height_mm?: number;
  maneuvering_clearance_mm?: number;
  closing_speed_seconds?: number;
  hardware_type?: HardwareType;
}

interface Corridor {
  location: string;
  width_mm: number;
  length_m?: number;
  has_passing_space?: boolean;
}

interface Ramp {
  location: string;
  rise_mm: number;
  run_mm: number;
  width_mm: number;
  has_handrails: boolean;
  has_landings: boolean;
}

interface Restroom {
  name: string;
  is_accessible: boolean;
  clear_floor_space_mm?: { width: number; depth: number };
  toilet_centerline_mm?: number;
  grab_bars?: boolean;
  lavatory_knee_clearance_mm?: number;
  mirror_height_mm?: number;
  turning_radius_mm?: number;
}

interface ParkingData {
  total_spaces: number;
  accessible_spaces: number;
  van_accessible_spaces: number;
  access_aisle_width_mm: number;
}

interface ElevatorData {
  cab_width_mm: number;
  cab_depth_mm: number;
  door_width_mm: number;
  has_braille_buttons: boolean;
  has_audible_signals: boolean;
}

interface CheckResult {
  category: string;
  item: string;
  requirement: string;
  provided: string;
  status: CheckStatus;
  reference: string;
}

interface AdaCheckParams {
  building_type: BuildingType;
  stories: number;
  total_area_sqm?: number;
  spaces?: Space[];
  doors?: Door[];
  corridors?: Corridor[];
  ramps?: Ramp[];
  restrooms?: Restroom[];
  parking?: ParkingData;
  elevator_present: boolean;
  elevator_data?: ElevatorData;
}

// ─── ADA Standards Constants ─────────────────────────────────────────────────

const ADA = {
  // Accessible Route (Section 402-405)
  ROUTE_MIN_WIDTH_MM: 915, // 36 inches
  ROUTE_CORRIDOR_HIGH_OCCUPANCY_MM: 1118, // 44 inches
  PASSING_SPACE_MM: 1524, // 60 inches
  PASSING_SPACE_INTERVAL_M: 61, // 200 feet
  MAX_RUNNING_SLOPE_RATIO: 1 / 20, // 5%
  MAX_CROSS_SLOPE_RATIO: 1 / 48, // ~2%

  // Doors (Section 404)
  DOOR_MIN_CLEAR_WIDTH_MM: 815, // 32 inches
  DOOR_MAX_THRESHOLD_MM: 13, // 1/2 inch
  DOOR_MAX_THRESHOLD_SLIDING_MM: 19, // 3/4 inch
  DOOR_MANEUVERING_CLEARANCE_PULL_MM: 457, // 18 inches
  DOOR_MANEUVERING_DEPTH_MM: 1524, // 60 inches
  DOOR_MIN_CLOSING_SPEED_SEC: 5, // 5 seconds from 90 to 12 degrees

  // Ramps (Section 405)
  RAMP_MAX_SLOPE_RATIO: 1 / 12, // 8.33%
  RAMP_MAX_RISE_PER_RUN_MM: 760, // 30 inches
  RAMP_MIN_WIDTH_MM: 915, // 36 inches
  RAMP_HANDRAIL_REQUIRED_RISE_MM: 150, // 6 inches

  // Restrooms (Section 603-606)
  RESTROOM_CLEAR_FLOOR_WIDTH_MM: 760, // 30 inches
  RESTROOM_CLEAR_FLOOR_DEPTH_MM: 1220, // 48 inches
  TOILET_CENTERLINE_MIN_MM: 405, // 16 inches
  TOILET_CENTERLINE_MAX_MM: 455, // 18 inches
  GRAB_BAR_SIDE_MIN_MM: 1067, // 42 inches
  GRAB_BAR_REAR_MIN_MM: 915, // 36 inches
  TURNING_SPACE_MM: 1524, // 60 inches diameter
  LAVATORY_KNEE_CLEARANCE_MM: 685, // 27 inches
  MIRROR_MAX_HEIGHT_MM: 1016, // 40 inches

  // Parking (Section 502)
  PARKING_ACCESS_AISLE_MM: 1524, // 60 inches
  PARKING_VAN_ACCESS_AISLE_MM: 2438, // 96 inches

  // Elevators (Section 407)
  ELEVATOR_MIN_CAB_WIDTH_MM: 1372, // 54 inches
  ELEVATOR_MIN_CAB_DEPTH_MM: 2032, // 80 inches
  ELEVATOR_MIN_DOOR_WIDTH_MM: 915, // 36 inches
  ELEVATOR_REQUIRED_STORIES: 3,
  ELEVATOR_REQUIRED_AREA_SQM: 279, // ~3000 sqft per story
};

// ─── Parking Space Requirement Table ─────────────────────────────────────────

function requiredAccessibleSpaces(total: number): number {
  if (total <= 0) return 0;
  if (total <= 25) return 1;
  if (total <= 50) return 2;
  if (total <= 75) return 3;
  if (total <= 100) return 4;
  if (total <= 150) return 5;
  if (total <= 200) return 6;
  if (total <= 300) return 7;
  if (total <= 400) return 8;
  if (total <= 500) return 9;
  if (total <= 1000) return Math.ceil(total * 0.02);
  return 20 + Math.ceil((total - 1000) / 100);
}

// ─── Check Functions ─────────────────────────────────────────────────────────

function checkCorridors(corridors: Corridor[]): CheckResult[] {
  const results: CheckResult[] = [];

  for (const corridor of corridors) {
    // Minimum width check
    const minWidth = ADA.ROUTE_MIN_WIDTH_MM;
    results.push({
      category: "Accessible Route",
      item: `Corridor width at ${corridor.location}`,
      requirement: `Minimum clear width: ${minWidth}mm (36")`,
      provided: `${corridor.width_mm}mm`,
      status: corridor.width_mm >= minWidth ? "PASS" : "FAIL",
      reference: "ADA Section 403.5.1",
    });

    // High-occupancy corridor width check (44")
    if (corridor.width_mm >= minWidth && corridor.width_mm < ADA.ROUTE_CORRIDOR_HIGH_OCCUPANCY_MM) {
      results.push({
        category: "Accessible Route",
        item: `Corridor width for high-occupancy at ${corridor.location}`,
        requirement: `44" (${ADA.ROUTE_CORRIDOR_HIGH_OCCUPANCY_MM}mm) required if occupant load >10`,
        provided: `${corridor.width_mm}mm`,
        status: "WARNING",
        reference: "ADA Section 403.5.1",
      });
    }

    // Passing space check
    if (corridor.length_m != null && corridor.length_m > ADA.PASSING_SPACE_INTERVAL_M) {
      const hasPassingSpace = corridor.has_passing_space ?? false;
      results.push({
        category: "Accessible Route",
        item: `Passing spaces in corridor at ${corridor.location}`,
        requirement: `60"x60" (${ADA.PASSING_SPACE_MM}mm) passing space every 200 ft for corridors > 200 ft`,
        provided: hasPassingSpace ? "Passing spaces provided" : "No passing spaces indicated",
        status: hasPassingSpace ? "PASS" : "FAIL",
        reference: "ADA Section 403.5.3",
      });
    }
  }

  return results;
}

function checkDoors(doors: Door[]): CheckResult[] {
  const results: CheckResult[] = [];

  for (const door of doors) {
    // Clear width check
    results.push({
      category: "Doors",
      item: `Door clear width at ${door.location}`,
      requirement: `Minimum clear width: ${ADA.DOOR_MIN_CLEAR_WIDTH_MM}mm (32")`,
      provided: `${door.clear_width_mm}mm`,
      status: door.clear_width_mm >= ADA.DOOR_MIN_CLEAR_WIDTH_MM ? "PASS" : "FAIL",
      reference: "ADA Section 404.2.3",
    });

    // Threshold height check
    if (door.threshold_height_mm != null) {
      results.push({
        category: "Doors",
        item: `Door threshold height at ${door.location}`,
        requirement: `Maximum threshold: ${ADA.DOOR_MAX_THRESHOLD_MM}mm (1/2")`,
        provided: `${door.threshold_height_mm}mm`,
        status: door.threshold_height_mm <= ADA.DOOR_MAX_THRESHOLD_MM ? "PASS" : "FAIL",
        reference: "ADA Section 404.2.5",
      });
    }

    // Maneuvering clearance check
    if (door.maneuvering_clearance_mm != null) {
      results.push({
        category: "Doors",
        item: `Door maneuvering clearance at ${door.location}`,
        requirement: `Minimum 18" (${ADA.DOOR_MANEUVERING_CLEARANCE_PULL_MM}mm) on pull side`,
        provided: `${door.maneuvering_clearance_mm}mm`,
        status: door.maneuvering_clearance_mm >= ADA.DOOR_MANEUVERING_CLEARANCE_PULL_MM ? "PASS" : "FAIL",
        reference: "ADA Section 404.2.4",
      });
    }

    // Closing speed check
    if (door.closing_speed_seconds != null) {
      results.push({
        category: "Doors",
        item: `Door closing speed at ${door.location}`,
        requirement: `Minimum ${ADA.DOOR_MIN_CLOSING_SPEED_SEC} seconds from 90deg to 12deg`,
        provided: `${door.closing_speed_seconds} seconds`,
        status: door.closing_speed_seconds >= ADA.DOOR_MIN_CLOSING_SPEED_SEC ? "PASS" : "FAIL",
        reference: "ADA Section 404.2.8.1",
      });
    }

    // Hardware type check
    if (door.hardware_type != null) {
      const isCompliant = door.hardware_type !== "knob";
      results.push({
        category: "Doors",
        item: `Door hardware at ${door.location}`,
        requirement: "Operable with one hand, no tight grasping/pinching (knobs FAIL)",
        provided: door.hardware_type,
        status: isCompliant ? "PASS" : "FAIL",
        reference: "ADA Section 404.2.7",
      });
    }
  }

  return results;
}

function checkRamps(ramps: Ramp[]): CheckResult[] {
  const results: CheckResult[] = [];

  for (const ramp of ramps) {
    // Slope check
    const actualSlope = ramp.rise_mm / ramp.run_mm;
    const maxSlope = ADA.RAMP_MAX_SLOPE_RATIO;
    const slopePercent = (actualSlope * 100).toFixed(2);
    const maxSlopePercent = (maxSlope * 100).toFixed(2);
    results.push({
      category: "Ramps",
      item: `Ramp slope at ${ramp.location}`,
      requirement: `Maximum slope 1:12 (${maxSlopePercent}%)`,
      provided: `1:${ramp.run_mm > 0 ? (ramp.run_mm / ramp.rise_mm).toFixed(1) : "0"} (${slopePercent}%)`,
      status: actualSlope <= maxSlope ? "PASS" : "FAIL",
      reference: "ADA Section 405.2",
    });

    // Maximum rise per run check
    results.push({
      category: "Ramps",
      item: `Ramp rise at ${ramp.location}`,
      requirement: `Maximum rise per run: ${ADA.RAMP_MAX_RISE_PER_RUN_MM}mm (30")`,
      provided: `${ramp.rise_mm}mm`,
      status: ramp.rise_mm <= ADA.RAMP_MAX_RISE_PER_RUN_MM ? "PASS" : "FAIL",
      reference: "ADA Section 405.6",
    });

    // Width check
    results.push({
      category: "Ramps",
      item: `Ramp width at ${ramp.location}`,
      requirement: `Minimum width: ${ADA.RAMP_MIN_WIDTH_MM}mm (36")`,
      provided: `${ramp.width_mm}mm`,
      status: ramp.width_mm >= ADA.RAMP_MIN_WIDTH_MM ? "PASS" : "FAIL",
      reference: "ADA Section 405.5",
    });

    // Handrail check
    if (ramp.rise_mm > ADA.RAMP_HANDRAIL_REQUIRED_RISE_MM) {
      results.push({
        category: "Ramps",
        item: `Ramp handrails at ${ramp.location}`,
        requirement: `Handrails required when rise > ${ADA.RAMP_HANDRAIL_REQUIRED_RISE_MM}mm (6")`,
        provided: ramp.has_handrails ? "Handrails present" : "No handrails",
        status: ramp.has_handrails ? "PASS" : "FAIL",
        reference: "ADA Section 405.8",
      });
    }

    // Landings check
    results.push({
      category: "Ramps",
      item: `Ramp landings at ${ramp.location}`,
      requirement: "Landings required at top, bottom, and every 30\" of rise",
      provided: ramp.has_landings ? "Landings present" : "No landings indicated",
      status: ramp.has_landings ? "PASS" : "FAIL",
      reference: "ADA Section 405.7",
    });
  }

  return results;
}

function checkRestrooms(restrooms: Restroom[]): CheckResult[] {
  const results: CheckResult[] = [];

  for (const restroom of restrooms) {
    if (!restroom.is_accessible) {
      results.push({
        category: "Restrooms",
        item: `${restroom.name} - accessibility designation`,
        requirement: "At least one restroom per cluster must be accessible",
        provided: "Not designated as accessible",
        status: "WARNING",
        reference: "ADA Section 213.2",
      });
      continue;
    }

    // Clear floor space check
    if (restroom.clear_floor_space_mm != null) {
      const widthOk = restroom.clear_floor_space_mm.width >= ADA.RESTROOM_CLEAR_FLOOR_WIDTH_MM;
      const depthOk = restroom.clear_floor_space_mm.depth >= ADA.RESTROOM_CLEAR_FLOOR_DEPTH_MM;
      results.push({
        category: "Restrooms",
        item: `${restroom.name} - clear floor space`,
        requirement: `Minimum ${ADA.RESTROOM_CLEAR_FLOOR_WIDTH_MM}mm x ${ADA.RESTROOM_CLEAR_FLOOR_DEPTH_MM}mm (30"x48")`,
        provided: `${restroom.clear_floor_space_mm.width}mm x ${restroom.clear_floor_space_mm.depth}mm`,
        status: widthOk && depthOk ? "PASS" : "FAIL",
        reference: "ADA Section 604.3",
      });
    } else {
      results.push({
        category: "Restrooms",
        item: `${restroom.name} - clear floor space`,
        requirement: `Minimum ${ADA.RESTROOM_CLEAR_FLOOR_WIDTH_MM}mm x ${ADA.RESTROOM_CLEAR_FLOOR_DEPTH_MM}mm (30"x48")`,
        provided: "Not specified",
        status: "NOT_CHECKED",
        reference: "ADA Section 604.3",
      });
    }

    // Toilet centerline check
    if (restroom.toilet_centerline_mm != null) {
      const inRange =
        restroom.toilet_centerline_mm >= ADA.TOILET_CENTERLINE_MIN_MM &&
        restroom.toilet_centerline_mm <= ADA.TOILET_CENTERLINE_MAX_MM;
      results.push({
        category: "Restrooms",
        item: `${restroom.name} - toilet centerline`,
        requirement: `${ADA.TOILET_CENTERLINE_MIN_MM}-${ADA.TOILET_CENTERLINE_MAX_MM}mm (16"-18") from side wall`,
        provided: `${restroom.toilet_centerline_mm}mm`,
        status: inRange ? "PASS" : "FAIL",
        reference: "ADA Section 604.2",
      });
    } else {
      results.push({
        category: "Restrooms",
        item: `${restroom.name} - toilet centerline`,
        requirement: `${ADA.TOILET_CENTERLINE_MIN_MM}-${ADA.TOILET_CENTERLINE_MAX_MM}mm (16"-18") from side wall`,
        provided: "Not specified",
        status: "NOT_CHECKED",
        reference: "ADA Section 604.2",
      });
    }

    // Grab bars check
    if (restroom.grab_bars != null) {
      results.push({
        category: "Restrooms",
        item: `${restroom.name} - grab bars`,
        requirement: "Required: 42\" min on side wall, 36\" min on rear wall",
        provided: restroom.grab_bars ? "Grab bars present" : "No grab bars",
        status: restroom.grab_bars ? "PASS" : "FAIL",
        reference: "ADA Section 604.5",
      });
    } else {
      results.push({
        category: "Restrooms",
        item: `${restroom.name} - grab bars`,
        requirement: "Required: 42\" min on side wall, 36\" min on rear wall",
        provided: "Not specified",
        status: "NOT_CHECKED",
        reference: "ADA Section 604.5",
      });
    }

    // Turning space check
    if (restroom.turning_radius_mm != null) {
      results.push({
        category: "Restrooms",
        item: `${restroom.name} - turning space`,
        requirement: `Minimum ${ADA.TURNING_SPACE_MM}mm (60") diameter turning space`,
        provided: `${restroom.turning_radius_mm}mm`,
        status: restroom.turning_radius_mm >= ADA.TURNING_SPACE_MM ? "PASS" : "FAIL",
        reference: "ADA Section 603.2.1",
      });
    } else {
      results.push({
        category: "Restrooms",
        item: `${restroom.name} - turning space`,
        requirement: `Minimum ${ADA.TURNING_SPACE_MM}mm (60") diameter turning space`,
        provided: "Not specified",
        status: "NOT_CHECKED",
        reference: "ADA Section 603.2.1",
      });
    }

    // Lavatory knee clearance check
    if (restroom.lavatory_knee_clearance_mm != null) {
      results.push({
        category: "Restrooms",
        item: `${restroom.name} - lavatory knee clearance`,
        requirement: `Minimum ${ADA.LAVATORY_KNEE_CLEARANCE_MM}mm (27") knee clearance`,
        provided: `${restroom.lavatory_knee_clearance_mm}mm`,
        status: restroom.lavatory_knee_clearance_mm >= ADA.LAVATORY_KNEE_CLEARANCE_MM ? "PASS" : "FAIL",
        reference: "ADA Section 606.2",
      });
    } else {
      results.push({
        category: "Restrooms",
        item: `${restroom.name} - lavatory knee clearance`,
        requirement: `Minimum ${ADA.LAVATORY_KNEE_CLEARANCE_MM}mm (27") knee clearance`,
        provided: "Not specified",
        status: "NOT_CHECKED",
        reference: "ADA Section 606.2",
      });
    }

    // Mirror height check
    if (restroom.mirror_height_mm != null) {
      results.push({
        category: "Restrooms",
        item: `${restroom.name} - mirror height`,
        requirement: `Maximum ${ADA.MIRROR_MAX_HEIGHT_MM}mm (40") to reflective surface`,
        provided: `${restroom.mirror_height_mm}mm`,
        status: restroom.mirror_height_mm <= ADA.MIRROR_MAX_HEIGHT_MM ? "PASS" : "FAIL",
        reference: "ADA Section 603.3",
      });
    } else {
      results.push({
        category: "Restrooms",
        item: `${restroom.name} - mirror height`,
        requirement: `Maximum ${ADA.MIRROR_MAX_HEIGHT_MM}mm (40") to reflective surface`,
        provided: "Not specified",
        status: "NOT_CHECKED",
        reference: "ADA Section 603.3",
      });
    }
  }

  return results;
}

function checkParking(parking: ParkingData): CheckResult[] {
  const results: CheckResult[] = [];
  const required = requiredAccessibleSpaces(parking.total_spaces);

  // Total accessible spaces
  results.push({
    category: "Parking",
    item: "Accessible parking spaces",
    requirement: `${required} accessible space(s) required for ${parking.total_spaces} total spaces`,
    provided: `${parking.accessible_spaces} accessible space(s)`,
    status: parking.accessible_spaces >= required ? "PASS" : "FAIL",
    reference: "ADA Section 502.2, Table 208.2",
  });

  // Van-accessible spaces (1 in 6 accessible must be van-accessible)
  const requiredVan = Math.max(1, Math.ceil(parking.accessible_spaces / 6));
  results.push({
    category: "Parking",
    item: "Van-accessible parking spaces",
    requirement: `At least 1 in 6 accessible spaces must be van-accessible (minimum ${requiredVan})`,
    provided: `${parking.van_accessible_spaces} van-accessible space(s)`,
    status: parking.van_accessible_spaces >= requiredVan ? "PASS" : "FAIL",
    reference: "ADA Section 502.2, 208.2.4",
  });

  // Access aisle width
  results.push({
    category: "Parking",
    item: "Access aisle width",
    requirement: `Minimum ${ADA.PARKING_ACCESS_AISLE_MM}mm (60") access aisle`,
    provided: `${parking.access_aisle_width_mm}mm`,
    status: parking.access_aisle_width_mm >= ADA.PARKING_ACCESS_AISLE_MM ? "PASS" : "FAIL",
    reference: "ADA Section 502.3",
  });

  // Van access aisle width check
  if (parking.van_accessible_spaces > 0) {
    results.push({
      category: "Parking",
      item: "Van-accessible access aisle width",
      requirement: `${ADA.PARKING_VAN_ACCESS_AISLE_MM}mm (96") recommended for van spaces`,
      provided: `${parking.access_aisle_width_mm}mm`,
      status: parking.access_aisle_width_mm >= ADA.PARKING_VAN_ACCESS_AISLE_MM ? "PASS" : "WARNING",
      reference: "ADA Section 502.3.1",
    });
  }

  return results;
}

function checkElevator(
  elevatorPresent: boolean,
  elevatorData: ElevatorData | undefined,
  stories: number,
  totalAreaSqm: number | undefined,
): CheckResult[] {
  const results: CheckResult[] = [];

  // Determine if elevator is required
  const areaPerStory = totalAreaSqm != null && stories > 0 ? totalAreaSqm / stories : undefined;
  const requiredByStories = stories > ADA.ELEVATOR_REQUIRED_STORIES;
  const requiredByArea = areaPerStory != null && areaPerStory > ADA.ELEVATOR_REQUIRED_AREA_SQM;
  const elevatorRequired = requiredByStories || requiredByArea;

  if (elevatorRequired) {
    results.push({
      category: "Elevators",
      item: "Elevator presence",
      requirement: `Elevator required (building has ${stories} stories${areaPerStory != null ? `, ${Math.round(areaPerStory)} sqm/story` : ""})`,
      provided: elevatorPresent ? "Elevator present" : "No elevator",
      status: elevatorPresent ? "PASS" : "FAIL",
      reference: "ADA Section 206.2.3",
    });
  } else if (stories > 1) {
    results.push({
      category: "Elevators",
      item: "Elevator presence",
      requirement: `Elevator may not be required (${stories} stories, ≤3 stories threshold)`,
      provided: elevatorPresent ? "Elevator present" : "No elevator",
      status: elevatorPresent ? "PASS" : "WARNING",
      reference: "ADA Section 206.2.3",
    });
  }

  if (elevatorPresent && elevatorData != null) {
    // Cab width
    results.push({
      category: "Elevators",
      item: "Elevator cab width",
      requirement: `Minimum ${ADA.ELEVATOR_MIN_CAB_WIDTH_MM}mm (54") interior width`,
      provided: `${elevatorData.cab_width_mm}mm`,
      status: elevatorData.cab_width_mm >= ADA.ELEVATOR_MIN_CAB_WIDTH_MM ? "PASS" : "FAIL",
      reference: "ADA Section 407.4.1",
    });

    // Cab depth
    results.push({
      category: "Elevators",
      item: "Elevator cab depth",
      requirement: `Minimum ${ADA.ELEVATOR_MIN_CAB_DEPTH_MM}mm (80") interior depth`,
      provided: `${elevatorData.cab_depth_mm}mm`,
      status: elevatorData.cab_depth_mm >= ADA.ELEVATOR_MIN_CAB_DEPTH_MM ? "PASS" : "FAIL",
      reference: "ADA Section 407.4.1",
    });

    // Door width
    results.push({
      category: "Elevators",
      item: "Elevator door width",
      requirement: `Minimum ${ADA.ELEVATOR_MIN_DOOR_WIDTH_MM}mm (36") door width`,
      provided: `${elevatorData.door_width_mm}mm`,
      status: elevatorData.door_width_mm >= ADA.ELEVATOR_MIN_DOOR_WIDTH_MM ? "PASS" : "FAIL",
      reference: "ADA Section 407.3.6",
    });

    // Braille buttons
    results.push({
      category: "Elevators",
      item: "Elevator Braille buttons",
      requirement: "Braille designations required on hoistway entrances and car controls",
      provided: elevatorData.has_braille_buttons ? "Braille buttons present" : "No Braille buttons",
      status: elevatorData.has_braille_buttons ? "PASS" : "FAIL",
      reference: "ADA Section 407.4.7",
    });

    // Audible signals
    results.push({
      category: "Elevators",
      item: "Elevator audible signals",
      requirement: "Audible and visible signals required at each hoistway entrance",
      provided: elevatorData.has_audible_signals ? "Audible signals present" : "No audible signals",
      status: elevatorData.has_audible_signals ? "PASS" : "FAIL",
      reference: "ADA Section 407.2.2",
    });
  }

  return results;
}

// ─── Recommendation Generation ───────────────────────────────────────────────

function generateRecommendations(checks: CheckResult[]): string[] {
  const recommendations: string[] = [];
  const failedCategories = new Set<string>();
  const warningCategories = new Set<string>();

  for (const check of checks) {
    if (check.status === "FAIL") {
      failedCategories.add(check.category);
    }
    if (check.status === "WARNING") {
      warningCategories.add(check.category);
    }
  }

  // Category-specific recommendations
  if (failedCategories.has("Accessible Route")) {
    recommendations.push(
      "Widen corridors to meet minimum 36\" (915mm) clear width requirement. For high-occupancy areas, provide 44\" (1118mm) width.",
    );
    recommendations.push(
      "Ensure 60\"x60\" passing spaces are provided at intervals not exceeding 200 feet in long corridors.",
    );
  }

  if (failedCategories.has("Doors")) {
    const doorFailures = checks.filter((c) => c.category === "Doors" && c.status === "FAIL");
    const hasHardwareFailure = doorFailures.some((c) => c.item.includes("hardware"));
    const hasWidthFailure = doorFailures.some((c) => c.item.includes("clear width"));
    const hasThresholdFailure = doorFailures.some((c) => c.item.includes("threshold"));
    const hasClosingSpeedFailure = doorFailures.some((c) => c.item.includes("closing speed"));

    if (hasWidthFailure) {
      recommendations.push(
        "Increase door clear opening widths to minimum 32\" (815mm). Consider 36\" doors for improved accessibility.",
      );
    }
    if (hasHardwareFailure) {
      recommendations.push(
        "Replace round door knobs with lever handles, push/pull hardware, or automatic operators that do not require tight grasping or pinching.",
      );
    }
    if (hasThresholdFailure) {
      recommendations.push(
        "Reduce door thresholds to maximum 1/2\" (13mm). Use beveled thresholds where height changes are necessary.",
      );
    }
    if (hasClosingSpeedFailure) {
      recommendations.push(
        "Adjust door closers to provide minimum 5-second closing time from 90 degrees to 12 degrees from the latch.",
      );
    }
  }

  if (failedCategories.has("Ramps")) {
    recommendations.push(
      "Redesign ramps to not exceed 1:12 slope (8.33%). Maximum 30\" rise per run segment with landings at top, bottom, and every 30\" of rise.",
    );
    recommendations.push(
      "Provide handrails on both sides of ramps with rise greater than 6\" (150mm). Handrails must extend 12\" beyond the top and bottom of the ramp.",
    );
  }

  if (failedCategories.has("Restrooms")) {
    recommendations.push(
      "Ensure accessible restrooms provide: 60\" turning space, toilet centerline 16-18\" from side wall, grab bars on side and rear walls, and minimum 27\" knee clearance at lavatories.",
    );
    recommendations.push(
      "Mount mirrors with bottom edge of reflective surface at maximum 40\" above floor in accessible restrooms.",
    );
  }

  if (failedCategories.has("Parking")) {
    recommendations.push(
      "Provide the required number of accessible parking spaces per ADA Table 208.2. At least 1 in 6 accessible spaces must be van-accessible with 96\" access aisle.",
    );
  }

  if (failedCategories.has("Elevators")) {
    recommendations.push(
      "Provide an accessible elevator with minimum 54\"x80\" cab, 36\" door width, Braille buttons, and audible/visible signals at each hoistway entrance.",
    );
  }

  // Warning-level recommendations
  if (warningCategories.has("Elevators") && !failedCategories.has("Elevators")) {
    recommendations.push(
      "Consider providing an elevator even if not strictly required. Elevator access improves usability for all occupants.",
    );
  }

  if (recommendations.length === 0) {
    const allPassed = checks.every((c) => c.status === "PASS" || c.status === "NOT_CHECKED");
    if (allPassed) {
      recommendations.push(
        "All checked items meet ADA Standards. Ensure on-site conditions match submitted design data. Consider commissioning an accessibility audit before occupancy.",
      );
    }
  }

  return recommendations;
}

// ─── Main Execution ──────────────────────────────────────────────────────────

function runAdaComplianceCheck(params: AdaCheckParams): {
  overall_status: "COMPLIANT" | "NON-COMPLIANT" | "PARTIAL";
  checks: CheckResult[];
  summary: {
    total_checks: number;
    passed: number;
    failed: number;
    warnings: number;
    not_checked: number;
  };
  recommendations: string[];
} {
  const checks: CheckResult[] = [];

  // Check corridors
  if (params.corridors && params.corridors.length > 0) {
    checks.push(...checkCorridors(params.corridors));
  }

  // Check doors
  if (params.doors && params.doors.length > 0) {
    checks.push(...checkDoors(params.doors));
  }

  // Check ramps
  if (params.ramps && params.ramps.length > 0) {
    checks.push(...checkRamps(params.ramps));
  }

  // Check restrooms
  if (params.restrooms && params.restrooms.length > 0) {
    checks.push(...checkRestrooms(params.restrooms));
  }

  // Check parking
  if (params.parking != null) {
    checks.push(...checkParking(params.parking));
  }

  // Check elevators
  checks.push(
    ...checkElevator(
      params.elevator_present,
      params.elevator_data,
      params.stories,
      params.total_area_sqm,
    ),
  );

  // Build summary
  const passed = checks.filter((c) => c.status === "PASS").length;
  const failed = checks.filter((c) => c.status === "FAIL").length;
  const warnings = checks.filter((c) => c.status === "WARNING").length;
  const notChecked = checks.filter((c) => c.status === "NOT_CHECKED").length;

  let overallStatus: "COMPLIANT" | "NON-COMPLIANT" | "PARTIAL";
  if (failed === 0 && warnings === 0) {
    overallStatus = "COMPLIANT";
  } else if (failed === 0) {
    overallStatus = "PARTIAL";
  } else {
    overallStatus = "NON-COMPLIANT";
  }

  const recommendations = generateRecommendations(checks);

  return {
    overall_status: overallStatus,
    checks,
    summary: {
      total_checks: checks.length,
      passed,
      failed,
      warnings,
      not_checked: notChecked,
    },
    recommendations,
  };
}

// ─── Tool Definition ─────────────────────────────────────────────────────────

export function createAdaCheckToolDefinition() {
  return {
    name: "ada_compliance_check",
    label: "ADA Compliance Check",
    description:
      "Check a building design against ADA (Americans with Disabilities Act) Standards for " +
      "Accessible Design requirements. Evaluates accessible routes, doors, ramps, restrooms, " +
      "parking, and elevators against ADA Sections 402-407, 502, and 603-606.",
    parameters: {
      type: "object",
      properties: {
        building_type: {
          type: "string",
          enum: ["commercial", "residential_common_area", "public", "healthcare", "educational"],
          description: "Type of building being evaluated.",
        },
        stories: {
          type: "number",
          description: "Number of stories in the building. Default: 1.",
          default: 1,
        },
        total_area_sqm: {
          type: "number",
          description: "Total building area in square meters (optional).",
        },
        spaces: {
          type: "array",
          description: "Rooms/spaces in the building (optional).",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Space name." },
              type: {
                type: "string",
                enum: [
                  "corridor",
                  "restroom",
                  "entrance",
                  "parking",
                  "elevator_lobby",
                  "stairway",
                  "dining",
                  "assembly",
                  "office",
                  "retail",
                  "custom",
                ],
                description: "Space type.",
              },
              width_mm: { type: "number", description: "Width in millimeters (optional)." },
              length_mm: { type: "number", description: "Length in millimeters (optional)." },
            },
            required: ["name", "type"],
          },
        },
        doors: {
          type: "array",
          description: "Door specifications for accessibility checks (optional).",
          items: {
            type: "object",
            properties: {
              location: { type: "string", description: "Where the door is located." },
              clear_width_mm: { type: "number", description: "Clear opening width in mm." },
              threshold_height_mm: { type: "number", description: "Threshold height in mm (optional)." },
              maneuvering_clearance_mm: {
                type: "number",
                description: "Clearance on pull side in mm (optional).",
              },
              closing_speed_seconds: {
                type: "number",
                description: "Time to close from 90 degrees to 12 degrees in seconds (optional).",
              },
              hardware_type: {
                type: "string",
                enum: ["lever", "knob", "push_pull", "automatic"],
                description: "Door hardware type (optional).",
              },
            },
            required: ["location", "clear_width_mm"],
          },
        },
        corridors: {
          type: "array",
          description: "Corridor specifications (optional).",
          items: {
            type: "object",
            properties: {
              location: { type: "string", description: "Corridor location." },
              width_mm: { type: "number", description: "Corridor width in mm." },
              length_m: { type: "number", description: "Corridor length in meters (optional)." },
              has_passing_space: {
                type: "boolean",
                description: "60\"x60\" passing space every 200 ft (optional).",
              },
            },
            required: ["location", "width_mm"],
          },
        },
        ramps: {
          type: "array",
          description: "Ramp specifications (optional).",
          items: {
            type: "object",
            properties: {
              location: { type: "string", description: "Ramp location." },
              rise_mm: { type: "number", description: "Total rise in mm." },
              run_mm: { type: "number", description: "Total horizontal run in mm." },
              width_mm: { type: "number", description: "Ramp width in mm." },
              has_handrails: { type: "boolean", description: "Whether handrails are present." },
              has_landings: {
                type: "boolean",
                description: "Whether landings are at top, bottom, and every 30\" of rise.",
              },
            },
            required: ["location", "rise_mm", "run_mm", "width_mm", "has_handrails", "has_landings"],
          },
        },
        restrooms: {
          type: "array",
          description: "Restroom specifications (optional).",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Restroom name/identifier." },
              is_accessible: { type: "boolean", description: "Whether designated as accessible." },
              clear_floor_space_mm: {
                type: "object",
                description: "Clear floor space dimensions (optional).",
                properties: {
                  width: { type: "number", description: "Width in mm." },
                  depth: { type: "number", description: "Depth in mm." },
                },
                required: ["width", "depth"],
              },
              toilet_centerline_mm: {
                type: "number",
                description: "Distance from side wall to toilet centerline in mm (optional).",
              },
              grab_bars: { type: "boolean", description: "Whether grab bars are installed (optional)." },
              lavatory_knee_clearance_mm: {
                type: "number",
                description: "Knee clearance under lavatory in mm (optional).",
              },
              mirror_height_mm: {
                type: "number",
                description: "Height to bottom of reflective surface in mm (optional).",
              },
              turning_radius_mm: {
                type: "number",
                description: "Diameter of turning space in mm (optional).",
              },
            },
            required: ["name", "is_accessible"],
          },
        },
        parking: {
          type: "object",
          description: "Parking lot specifications (optional).",
          properties: {
            total_spaces: { type: "number", description: "Total parking spaces." },
            accessible_spaces: { type: "number", description: "Number of accessible spaces." },
            van_accessible_spaces: { type: "number", description: "Number of van-accessible spaces." },
            access_aisle_width_mm: { type: "number", description: "Access aisle width in mm." },
          },
          required: ["total_spaces", "accessible_spaces", "van_accessible_spaces", "access_aisle_width_mm"],
        },
        elevator_present: {
          type: "boolean",
          description: "Whether an elevator is present. Default: false.",
          default: false,
        },
        elevator_data: {
          type: "object",
          description: "Elevator specifications (optional, required if elevator_present is true).",
          properties: {
            cab_width_mm: { type: "number", description: "Interior cab width in mm." },
            cab_depth_mm: { type: "number", description: "Interior cab depth in mm." },
            door_width_mm: { type: "number", description: "Door opening width in mm." },
            has_braille_buttons: { type: "boolean", description: "Whether Braille buttons are present." },
            has_audible_signals: { type: "boolean", description: "Whether audible signals are present." },
          },
          required: [
            "cab_width_mm",
            "cab_depth_mm",
            "door_width_mm",
            "has_braille_buttons",
            "has_audible_signals",
          ],
        },
      },
      required: ["building_type"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details?: unknown;
    }> => {
      const params = (args ?? {}) as Record<string, unknown>;

      // ── Validate building_type ──────────────────────────────────────────
      const validBuildingTypes = new Set<string>([
        "commercial",
        "residential_common_area",
        "public",
        "healthcare",
        "educational",
      ]);
      const buildingType = String(params.building_type ?? "");
      if (!validBuildingTypes.has(buildingType)) {
        throw new Error(
          `building_type is required and must be one of: ${[...validBuildingTypes].join(", ")}`,
        );
      }

      // ── Parse stories ──────────────────────────────────────────────────
      const stories =
        typeof params.stories === "number" && Number.isFinite(params.stories) && params.stories > 0
          ? Math.round(params.stories)
          : 1;

      // ── Parse total_area_sqm ───────────────────────────────────────────
      const totalAreaSqm =
        typeof params.total_area_sqm === "number" && Number.isFinite(params.total_area_sqm) && params.total_area_sqm > 0
          ? params.total_area_sqm
          : undefined;

      // ── Parse spaces ───────────────────────────────────────────────────
      const validSpaceTypes = new Set<string>([
        "corridor",
        "restroom",
        "entrance",
        "parking",
        "elevator_lobby",
        "stairway",
        "dining",
        "assembly",
        "office",
        "retail",
        "custom",
      ]);
      let spaces: Space[] | undefined;
      if (Array.isArray(params.spaces)) {
        spaces = (params.spaces as any[]).map((s: any, i: number) => {
          if (!s.name || typeof s.name !== "string") {
            throw new Error(`spaces[${i}].name is required.`);
          }
          const spaceType = String(s.type ?? "custom");
          if (!validSpaceTypes.has(spaceType)) {
            throw new Error(`spaces[${i}].type "${spaceType}" is invalid.`);
          }
          return {
            name: s.name,
            type: spaceType as SpaceType,
            width_mm: typeof s.width_mm === "number" ? s.width_mm : undefined,
            length_mm: typeof s.length_mm === "number" ? s.length_mm : undefined,
          };
        });
      }

      // ── Parse doors ────────────────────────────────────────────────────
      let doors: Door[] | undefined;
      if (Array.isArray(params.doors)) {
        const validHardwareTypes = new Set<string>(["lever", "knob", "push_pull", "automatic"]);
        doors = (params.doors as any[]).map((d: any, i: number) => {
          if (!d.location || typeof d.location !== "string") {
            throw new Error(`doors[${i}].location is required.`);
          }
          if (typeof d.clear_width_mm !== "number" || !Number.isFinite(d.clear_width_mm)) {
            throw new Error(`doors[${i}].clear_width_mm is required and must be a number.`);
          }
          const hw = d.hardware_type != null ? String(d.hardware_type) : undefined;
          if (hw != null && !validHardwareTypes.has(hw)) {
            throw new Error(`doors[${i}].hardware_type "${hw}" is invalid.`);
          }
          return {
            location: d.location,
            clear_width_mm: d.clear_width_mm,
            threshold_height_mm: typeof d.threshold_height_mm === "number" ? d.threshold_height_mm : undefined,
            maneuvering_clearance_mm: typeof d.maneuvering_clearance_mm === "number" ? d.maneuvering_clearance_mm : undefined,
            closing_speed_seconds: typeof d.closing_speed_seconds === "number" ? d.closing_speed_seconds : undefined,
            hardware_type: hw as HardwareType | undefined,
          };
        });
      }

      // ── Parse corridors ────────────────────────────────────────────────
      let corridors: Corridor[] | undefined;
      if (Array.isArray(params.corridors)) {
        corridors = (params.corridors as any[]).map((c: any, i: number) => {
          if (!c.location || typeof c.location !== "string") {
            throw new Error(`corridors[${i}].location is required.`);
          }
          if (typeof c.width_mm !== "number" || !Number.isFinite(c.width_mm)) {
            throw new Error(`corridors[${i}].width_mm is required and must be a number.`);
          }
          return {
            location: c.location,
            width_mm: c.width_mm,
            length_m: typeof c.length_m === "number" ? c.length_m : undefined,
            has_passing_space: typeof c.has_passing_space === "boolean" ? c.has_passing_space : undefined,
          };
        });
      }

      // ── Parse ramps ────────────────────────────────────────────────────
      let ramps: Ramp[] | undefined;
      if (Array.isArray(params.ramps)) {
        ramps = (params.ramps as any[]).map((r: any, i: number) => {
          if (!r.location || typeof r.location !== "string") {
            throw new Error(`ramps[${i}].location is required.`);
          }
          if (typeof r.rise_mm !== "number") throw new Error(`ramps[${i}].rise_mm is required.`);
          if (typeof r.run_mm !== "number") throw new Error(`ramps[${i}].run_mm is required.`);
          if (typeof r.width_mm !== "number") throw new Error(`ramps[${i}].width_mm is required.`);
          if (typeof r.has_handrails !== "boolean") throw new Error(`ramps[${i}].has_handrails is required.`);
          if (typeof r.has_landings !== "boolean") throw new Error(`ramps[${i}].has_landings is required.`);
          return {
            location: r.location,
            rise_mm: r.rise_mm,
            run_mm: r.run_mm,
            width_mm: r.width_mm,
            has_handrails: r.has_handrails,
            has_landings: r.has_landings,
          };
        });
      }

      // ── Parse restrooms ────────────────────────────────────────────────
      let restrooms: Restroom[] | undefined;
      if (Array.isArray(params.restrooms)) {
        restrooms = (params.restrooms as any[]).map((r: any, i: number) => {
          if (!r.name || typeof r.name !== "string") {
            throw new Error(`restrooms[${i}].name is required.`);
          }
          if (typeof r.is_accessible !== "boolean") {
            throw new Error(`restrooms[${i}].is_accessible is required.`);
          }
          let clearFloorSpace: { width: number; depth: number } | undefined;
          if (r.clear_floor_space_mm && typeof r.clear_floor_space_mm === "object") {
            const w = Number(r.clear_floor_space_mm.width);
            const d = Number(r.clear_floor_space_mm.depth);
            if (Number.isFinite(w) && Number.isFinite(d)) {
              clearFloorSpace = { width: w, depth: d };
            }
          }
          return {
            name: r.name,
            is_accessible: r.is_accessible,
            clear_floor_space_mm: clearFloorSpace,
            toilet_centerline_mm: typeof r.toilet_centerline_mm === "number" ? r.toilet_centerline_mm : undefined,
            grab_bars: typeof r.grab_bars === "boolean" ? r.grab_bars : undefined,
            lavatory_knee_clearance_mm:
              typeof r.lavatory_knee_clearance_mm === "number" ? r.lavatory_knee_clearance_mm : undefined,
            mirror_height_mm: typeof r.mirror_height_mm === "number" ? r.mirror_height_mm : undefined,
            turning_radius_mm: typeof r.turning_radius_mm === "number" ? r.turning_radius_mm : undefined,
          };
        });
      }

      // ── Parse parking ──────────────────────────────────────────────────
      let parking: ParkingData | undefined;
      if (params.parking && typeof params.parking === "object") {
        const p = params.parking as Record<string, unknown>;
        if (
          typeof p.total_spaces === "number" &&
          typeof p.accessible_spaces === "number" &&
          typeof p.van_accessible_spaces === "number" &&
          typeof p.access_aisle_width_mm === "number"
        ) {
          parking = {
            total_spaces: p.total_spaces,
            accessible_spaces: p.accessible_spaces,
            van_accessible_spaces: p.van_accessible_spaces,
            access_aisle_width_mm: p.access_aisle_width_mm,
          };
        }
      }

      // ── Parse elevator ─────────────────────────────────────────────────
      const elevatorPresent = params.elevator_present === true;
      let elevatorData: ElevatorData | undefined;
      if (params.elevator_data && typeof params.elevator_data === "object") {
        const e = params.elevator_data as Record<string, unknown>;
        if (
          typeof e.cab_width_mm === "number" &&
          typeof e.cab_depth_mm === "number" &&
          typeof e.door_width_mm === "number" &&
          typeof e.has_braille_buttons === "boolean" &&
          typeof e.has_audible_signals === "boolean"
        ) {
          elevatorData = {
            cab_width_mm: e.cab_width_mm,
            cab_depth_mm: e.cab_depth_mm,
            door_width_mm: e.door_width_mm,
            has_braille_buttons: e.has_braille_buttons,
            has_audible_signals: e.has_audible_signals,
          };
        }
      }

      // ── Run checks ─────────────────────────────────────────────────────
      const result = runAdaComplianceCheck({
        building_type: buildingType as BuildingType,
        stories,
        total_area_sqm: totalAreaSqm,
        spaces,
        doors,
        corridors,
        ramps,
        restrooms,
        parking,
        elevator_present: elevatorPresent,
        elevator_data: elevatorData,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: {
          building_type: buildingType,
          overall_status: result.overall_status,
          total_checks: result.summary.total_checks,
          passed: result.summary.passed,
          failed: result.summary.failed,
        },
      };
    },
  };
}
