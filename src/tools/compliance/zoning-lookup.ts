/**
 * Zoning Lookup tool for civilclaw.
 *
 * Looks up zoning requirements for a US address or zone code. Returns setbacks,
 * FAR, lot coverage, height limits, permitted uses, and parking requirements
 * from a built-in database of common US zoning classifications.
 *
 * If lot_area_sqm is provided, calculates buildable area, maximum floor area,
 * and building envelope after setbacks.
 *
 * No external dependencies beyond standard TypeScript.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

interface Setbacks {
  front_m: number;
  side_m: number;
  rear_m: number;
  corner_side_m?: number;
}

interface ZoneData {
  category: string;
  description: string;
  min_lot_area_sqm: number;
  min_lot_width_m: number;
  setbacks: Setbacks;
  max_height_m: number;
  max_stories: number;
  max_far: number;
  max_lot_coverage: number;
  permitted_uses: string[];
  conditional_uses: string[];
  parking: Record<string, string>;
  notes: string;
}

interface LotAnalysis {
  lot_area_sqm: number;
  lot_area_sqft: number;
  max_building_footprint_sqm: number;
  max_building_footprint_sqft: number;
  max_floor_area_sqm: number;
  max_floor_area_sqft: number;
  buildable_area_after_setbacks_note: string;
  max_lot_coverage_percent: number;
  max_far: number;
  max_stories: number;
  max_height_m: number;
  max_height_ft: number;
}

interface LookupResult {
  zone_code: string;
  zone_data: ZoneData;
  lot_analysis: LotAnalysis | null;
  source: string;
  disclaimer: string;
  suggested_lookup: string;
}

// ─── Unit Conversion ─────────────────────────────────────────────────────────

const SQM_TO_SQFT = 10.7639;
const METERS_TO_FEET = 3.28084;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Built-in Zoning Database ────────────────────────────────────────────────

const COMMON_ZONES: Record<string, ZoneData> = {
  // ── Residential ────────────────────────────────────────────────────────

  "R-1": {
    category: "Single-Family Residential",
    description: "Low-density single-family detached dwellings on large lots",
    min_lot_area_sqm: 560, // ~6,000 sqft
    min_lot_width_m: 18, // ~60 ft
    setbacks: { front_m: 7.6, side_m: 1.5, rear_m: 7.6, corner_side_m: 4.6 }, // 25', 5', 25', 15'
    max_height_m: 10.7, // 35 ft
    max_stories: 2,
    max_far: 0.5,
    max_lot_coverage: 0.40,
    permitted_uses: [
      "single_family_dwelling",
      "home_occupation",
      "accessory_structure",
      "family_daycare",
    ],
    conditional_uses: ["church", "school", "park", "adu", "group_home"],
    parking: { residential: "2 per dwelling unit" },
    notes:
      "Typical R-1 zone for suburban single-family neighborhoods. Check local jurisdiction for variations.",
  },

  "R-2": {
    category: "Two-Family Residential",
    description: "Low-density residential allowing duplexes and two-family dwellings",
    min_lot_area_sqm: 465, // ~5,000 sqft
    min_lot_width_m: 15, // ~50 ft
    setbacks: { front_m: 6.1, side_m: 1.5, rear_m: 6.1, corner_side_m: 3.0 }, // 20', 5', 20', 10'
    max_height_m: 10.7, // 35 ft
    max_stories: 2,
    max_far: 0.6,
    max_lot_coverage: 0.45,
    permitted_uses: [
      "single_family_dwelling",
      "duplex",
      "home_occupation",
      "accessory_structure",
      "family_daycare",
    ],
    conditional_uses: ["church", "school", "park", "adu", "group_home", "bed_and_breakfast"],
    parking: { residential: "2 per dwelling unit" },
    notes:
      "Permits duplexes and single-family homes. Some jurisdictions require larger lots for duplexes.",
  },

  "R-3": {
    category: "Multi-Family Residential (Low Density)",
    description: "Low-density multi-family including townhouses and small apartment buildings",
    min_lot_area_sqm: 370, // ~4,000 sqft
    min_lot_width_m: 12, // ~40 ft
    setbacks: { front_m: 6.1, side_m: 1.5, rear_m: 6.1, corner_side_m: 3.0 }, // 20', 5', 20', 10'
    max_height_m: 10.7, // 35 ft
    max_stories: 3,
    max_far: 0.8,
    max_lot_coverage: 0.50,
    permitted_uses: [
      "single_family_dwelling",
      "duplex",
      "townhouse",
      "apartment_3_to_4_units",
      "home_occupation",
      "accessory_structure",
    ],
    conditional_uses: [
      "church",
      "school",
      "park",
      "adu",
      "group_home",
      "daycare_center",
    ],
    parking: {
      studio_1br: "1.5 per unit",
      "2br_plus": "2 per unit",
      guest: "0.25 per unit",
    },
    notes:
      "Low-density multi-family zone allowing up to 4 units. Townhouse and small apartment developments.",
  },

  "R-4": {
    category: "Multi-Family Residential (Medium Density)",
    description: "Medium-density multi-family residential including apartment buildings",
    min_lot_area_sqm: 280, // ~3,000 sqft
    min_lot_width_m: 9, // ~30 ft
    setbacks: { front_m: 4.6, side_m: 1.5, rear_m: 4.6, corner_side_m: 3.0 }, // 15', 5', 15', 10'
    max_height_m: 13.7, // 45 ft
    max_stories: 4,
    max_far: 1.5,
    max_lot_coverage: 0.55,
    permitted_uses: [
      "single_family_dwelling",
      "duplex",
      "townhouse",
      "apartment_building",
      "home_occupation",
    ],
    conditional_uses: [
      "church",
      "school",
      "park",
      "group_home",
      "daycare_center",
      "live_work",
    ],
    parking: {
      studio_1br: "1 per unit",
      "2br_plus": "1.5 per unit",
      guest: "0.25 per unit",
    },
    notes:
      "Medium-density multi-family zone. Suitable for apartment buildings and medium-density housing.",
  },

  "R-5": {
    category: "Multi-Family Residential (High Density)",
    description: "High-density multi-family residential including high-rise apartments",
    min_lot_area_sqm: 185, // ~2,000 sqft
    min_lot_width_m: 7.6, // ~25 ft
    setbacks: { front_m: 3.0, side_m: 1.5, rear_m: 3.0, corner_side_m: 3.0 }, // 10', 5', 10', 10'
    max_height_m: 22.9, // 75 ft
    max_stories: 7,
    max_far: 3.0,
    max_lot_coverage: 0.65,
    permitted_uses: [
      "apartment_building",
      "condominium",
      "townhouse",
      "senior_housing",
    ],
    conditional_uses: [
      "mixed_use_residential",
      "group_home",
      "daycare_center",
      "live_work",
      "hotel",
    ],
    parking: {
      studio_1br: "1 per unit",
      "2br_plus": "1.5 per unit",
      guest: "0.15 per unit",
    },
    notes:
      "High-density residential zone. Often found near transit corridors and urban centers.",
  },

  RMF: {
    category: "Residential Multi-Family",
    description: "General multi-family residential zone with moderate density allowances",
    min_lot_area_sqm: 370, // ~4,000 sqft
    min_lot_width_m: 12, // ~40 ft
    setbacks: { front_m: 6.1, side_m: 1.5, rear_m: 6.1, corner_side_m: 3.0 }, // 20', 5', 20', 10'
    max_height_m: 12.2, // 40 ft
    max_stories: 3,
    max_far: 1.0,
    max_lot_coverage: 0.50,
    permitted_uses: [
      "single_family_dwelling",
      "duplex",
      "townhouse",
      "apartment_building",
      "accessory_dwelling_unit",
    ],
    conditional_uses: [
      "church",
      "school",
      "daycare_center",
      "group_home",
      "bed_and_breakfast",
    ],
    parking: {
      studio_1br: "1.5 per unit",
      "2br_plus": "2 per unit",
    },
    notes:
      "General multi-family zone. Often used as a transition between single-family and commercial areas.",
  },

  // ── Commercial ─────────────────────────────────────────────────────────

  "C-1": {
    category: "Neighborhood Commercial",
    description: "Small-scale commercial serving immediate neighborhood needs",
    min_lot_area_sqm: 280, // ~3,000 sqft
    min_lot_width_m: 9, // ~30 ft
    setbacks: { front_m: 0, side_m: 0, rear_m: 3.0, corner_side_m: 0 }, // 0', 0', 10', 0'
    max_height_m: 10.7, // 35 ft
    max_stories: 2,
    max_far: 1.0,
    max_lot_coverage: 0.80,
    permitted_uses: [
      "retail_store",
      "restaurant",
      "personal_services",
      "professional_office",
      "bank",
      "pharmacy",
      "bakery",
      "coffee_shop",
    ],
    conditional_uses: [
      "bar_lounge",
      "drive_through",
      "gas_station",
      "residential_upper_floors",
      "daycare_center",
    ],
    parking: {
      retail: "1 per 300 sqft (1 per 28 sqm)",
      restaurant: "1 per 100 sqft (1 per 9.3 sqm)",
      office: "1 per 300 sqft (1 per 28 sqm)",
    },
    notes:
      "Neighborhood-serving commercial. Typically restricts hours and noise levels. No heavy industrial uses.",
  },

  "C-2": {
    category: "Community Commercial",
    description: "General commercial serving a wider community area with varied retail and services",
    min_lot_area_sqm: 465, // ~5,000 sqft
    min_lot_width_m: 15, // ~50 ft
    setbacks: { front_m: 0, side_m: 0, rear_m: 3.0, corner_side_m: 0 }, // 0', 0', 10', 0'
    max_height_m: 13.7, // 45 ft
    max_stories: 3,
    max_far: 2.0,
    max_lot_coverage: 0.85,
    permitted_uses: [
      "retail_store",
      "restaurant",
      "personal_services",
      "professional_office",
      "medical_office",
      "bank",
      "hotel",
      "gym_fitness",
      "entertainment",
      "auto_repair",
    ],
    conditional_uses: [
      "bar_nightclub",
      "drive_through",
      "gas_station",
      "car_wash",
      "residential_upper_floors",
      "outdoor_dining",
    ],
    parking: {
      retail: "1 per 250 sqft (1 per 23 sqm)",
      restaurant: "1 per 100 sqft (1 per 9.3 sqm)",
      office: "1 per 300 sqft (1 per 28 sqm)",
      hotel: "1 per room",
    },
    notes:
      "General commercial zone allowing a wide variety of commercial uses. May allow residential on upper floors.",
  },

  "C-3": {
    category: "Regional Commercial",
    description: "Large-scale commercial for regional shopping centers and major retail",
    min_lot_area_sqm: 929, // ~10,000 sqft
    min_lot_width_m: 24, // ~80 ft
    setbacks: { front_m: 3.0, side_m: 0, rear_m: 3.0, corner_side_m: 3.0 }, // 10', 0', 10', 10'
    max_height_m: 18.3, // 60 ft
    max_stories: 4,
    max_far: 2.5,
    max_lot_coverage: 0.80,
    permitted_uses: [
      "retail_store",
      "department_store",
      "shopping_center",
      "restaurant",
      "hotel",
      "office_building",
      "entertainment_complex",
      "auto_dealership",
      "gym_fitness",
    ],
    conditional_uses: [
      "residential_mixed_use",
      "gas_station",
      "drive_through",
      "outdoor_storage",
      "car_wash",
    ],
    parking: {
      retail: "1 per 250 sqft (1 per 23 sqm)",
      restaurant: "1 per 100 sqft (1 per 9.3 sqm)",
      office: "1 per 250 sqft (1 per 23 sqm)",
      shopping_center: "4.5 per 1000 sqft (4.5 per 93 sqm)",
    },
    notes:
      "Regional commercial centers and large-format retail. Higher parking requirements. Traffic impact analysis may be required.",
  },

  "C-4": {
    category: "Highway Commercial",
    description: "Auto-oriented commercial along major highways and arterials",
    min_lot_area_sqm: 929, // ~10,000 sqft
    min_lot_width_m: 24, // ~80 ft
    setbacks: { front_m: 6.1, side_m: 3.0, rear_m: 6.1, corner_side_m: 6.1 }, // 20', 10', 20', 20'
    max_height_m: 13.7, // 45 ft
    max_stories: 3,
    max_far: 1.0,
    max_lot_coverage: 0.60,
    permitted_uses: [
      "gas_station",
      "auto_repair",
      "auto_dealership",
      "drive_through_restaurant",
      "hotel_motel",
      "car_wash",
      "truck_stop",
      "retail_store",
      "self_storage",
    ],
    conditional_uses: [
      "outdoor_advertising",
      "vehicle_storage",
      "RV_park",
      "heavy_equipment_sales",
    ],
    parking: {
      retail: "1 per 300 sqft (1 per 28 sqm)",
      restaurant: "1 per 100 sqft (1 per 9.3 sqm)",
      hotel: "1 per room",
      gas_station: "2 per service bay",
    },
    notes:
      "Highway-oriented commercial. Larger setbacks for highway frontage. Sign regulations may apply.",
  },

  CR: {
    category: "Commercial-Residential Mixed",
    description: "Mixed commercial and residential zone allowing both uses on the same lot",
    min_lot_area_sqm: 370, // ~4,000 sqft
    min_lot_width_m: 12, // ~40 ft
    setbacks: { front_m: 0, side_m: 0, rear_m: 3.0, corner_side_m: 0 }, // 0', 0', 10', 0'
    max_height_m: 15.2, // 50 ft
    max_stories: 4,
    max_far: 2.5,
    max_lot_coverage: 0.80,
    permitted_uses: [
      "retail_store",
      "restaurant",
      "professional_office",
      "apartment_upper_floors",
      "live_work",
      "personal_services",
      "gallery",
    ],
    conditional_uses: [
      "bar_lounge",
      "hotel",
      "daycare_center",
      "community_center",
      "standalone_residential",
    ],
    parking: {
      retail: "1 per 300 sqft (1 per 28 sqm)",
      office: "1 per 300 sqft (1 per 28 sqm)",
      residential: "1 per unit",
    },
    notes:
      "Mixed-use zone encouraging ground-floor commercial with residential above. Often found in walkable urban districts.",
  },

  // ── Industrial ─────────────────────────────────────────────────────────

  "M-1": {
    category: "Light Industrial",
    description: "Light manufacturing, warehousing, and industrial services in enclosed buildings",
    min_lot_area_sqm: 929, // ~10,000 sqft
    min_lot_width_m: 24, // ~80 ft
    setbacks: { front_m: 6.1, side_m: 0, rear_m: 0, corner_side_m: 6.1 }, // 20', 0', 0', 20'
    max_height_m: 13.7, // 45 ft
    max_stories: 3,
    max_far: 1.5,
    max_lot_coverage: 0.75,
    permitted_uses: [
      "light_manufacturing",
      "warehouse",
      "wholesale",
      "research_laboratory",
      "data_center",
      "printing",
      "food_processing",
      "auto_repair",
      "contractor_yard",
    ],
    conditional_uses: [
      "outdoor_storage",
      "hazardous_materials",
      "recycling_facility",
      "truck_terminal",
      "caretaker_residence",
    ],
    parking: {
      manufacturing: "1 per 500 sqft (1 per 46 sqm)",
      warehouse: "1 per 1000 sqft (1 per 93 sqm)",
      office: "1 per 300 sqft (1 per 28 sqm)",
    },
    notes:
      "Light industrial zone. All activities must be conducted within enclosed buildings unless conditionally permitted. Buffer may be required adjacent to residential.",
  },

  "M-2": {
    category: "Heavy Industrial",
    description: "Heavy manufacturing and industrial operations including outdoor activities",
    min_lot_area_sqm: 1858, // ~20,000 sqft
    min_lot_width_m: 30, // ~100 ft
    setbacks: { front_m: 6.1, side_m: 0, rear_m: 0, corner_side_m: 6.1 }, // 20', 0', 0', 20'
    max_height_m: 18.3, // 60 ft
    max_stories: 4,
    max_far: 2.0,
    max_lot_coverage: 0.80,
    permitted_uses: [
      "heavy_manufacturing",
      "light_manufacturing",
      "warehouse",
      "wholesale",
      "outdoor_storage",
      "truck_terminal",
      "concrete_batch_plant",
      "recycling_facility",
      "auto_salvage",
    ],
    conditional_uses: [
      "hazardous_waste_processing",
      "mining_extraction",
      "power_generation",
      "caretaker_residence",
    ],
    parking: {
      manufacturing: "1 per 500 sqft (1 per 46 sqm)",
      warehouse: "1 per 2000 sqft (1 per 186 sqm)",
      office: "1 per 300 sqft (1 per 28 sqm)",
    },
    notes:
      "Heavy industrial zone. Permits outdoor operations and heavier industrial activities. Environmental permits typically required. May have nuisance standards (noise, odor, vibration).",
  },

  // ── Mixed-Use ──────────────────────────────────────────────────────────

  "MU-1": {
    category: "Mixed Use (Low Intensity)",
    description: "Low-intensity mixed-use development with neighborhood-scale retail and housing",
    min_lot_area_sqm: 280, // ~3,000 sqft
    min_lot_width_m: 9, // ~30 ft
    setbacks: { front_m: 0, side_m: 0, rear_m: 3.0, corner_side_m: 0 }, // 0', 0', 10', 0'
    max_height_m: 12.2, // 40 ft
    max_stories: 3,
    max_far: 1.5,
    max_lot_coverage: 0.75,
    permitted_uses: [
      "retail_store",
      "restaurant",
      "office",
      "residential_upper_floors",
      "live_work",
      "personal_services",
      "coffee_shop",
      "gallery",
    ],
    conditional_uses: [
      "bar_lounge",
      "daycare_center",
      "community_center",
      "standalone_residential",
      "medical_office",
    ],
    parking: {
      retail: "1 per 350 sqft (1 per 33 sqm)",
      office: "1 per 350 sqft (1 per 33 sqm)",
      residential: "1 per unit",
    },
    notes:
      "Low-intensity mixed-use zone. Ground-floor commercial required in some jurisdictions. Reduced parking near transit.",
  },

  "MU-2": {
    category: "Mixed Use (Medium Intensity)",
    description: "Medium-intensity mixed-use development in urban corridors and town centers",
    min_lot_area_sqm: 370, // ~4,000 sqft
    min_lot_width_m: 12, // ~40 ft
    setbacks: { front_m: 0, side_m: 0, rear_m: 3.0, corner_side_m: 0 }, // 0', 0', 10', 0'
    max_height_m: 18.3, // 60 ft
    max_stories: 5,
    max_far: 3.0,
    max_lot_coverage: 0.85,
    permitted_uses: [
      "retail_store",
      "restaurant",
      "office_building",
      "apartment_building",
      "hotel",
      "live_work",
      "personal_services",
      "gym_fitness",
      "entertainment",
    ],
    conditional_uses: [
      "bar_nightclub",
      "daycare_center",
      "community_center",
      "medical_facility",
      "educational_facility",
    ],
    parking: {
      retail: "1 per 400 sqft (1 per 37 sqm)",
      office: "1 per 400 sqft (1 per 37 sqm)",
      residential: "1 per unit",
      hotel: "0.75 per room",
    },
    notes:
      "Medium-intensity mixed-use zone. Suitable for urban corridors and emerging downtown areas. Parking reductions available near transit.",
  },

  "MU-3": {
    category: "Mixed Use (High Intensity)",
    description: "High-intensity mixed-use development in downtown cores and transit-oriented areas",
    min_lot_area_sqm: 465, // ~5,000 sqft
    min_lot_width_m: 15, // ~50 ft
    setbacks: { front_m: 0, side_m: 0, rear_m: 0, corner_side_m: 0 }, // 0', 0', 0', 0'
    max_height_m: 45.7, // 150 ft
    max_stories: 12,
    max_far: 6.0,
    max_lot_coverage: 0.95,
    permitted_uses: [
      "retail_store",
      "restaurant",
      "office_building",
      "high_rise_apartment",
      "hotel",
      "entertainment_complex",
      "cultural_facility",
      "conference_center",
      "live_work",
    ],
    conditional_uses: [
      "bar_nightclub",
      "parking_structure",
      "hospital",
      "educational_facility",
      "transportation_terminal",
    ],
    parking: {
      retail: "1 per 500 sqft (1 per 46 sqm)",
      office: "1 per 500 sqft (1 per 46 sqm)",
      residential: "0.75 per unit",
      hotel: "0.5 per room",
    },
    notes:
      "High-intensity mixed-use zone for downtown cores. Zero-lot-line construction permitted. Significant parking reductions near transit. Design review may be required.",
  },

  // ── Special ────────────────────────────────────────────────────────────

  PD: {
    category: "Planned Development",
    description: "Flexible planned development zone with negotiated standards",
    min_lot_area_sqm: 4047, // ~1 acre (43,560 sqft)
    min_lot_width_m: 30, // ~100 ft
    setbacks: { front_m: 6.1, side_m: 3.0, rear_m: 6.1, corner_side_m: 6.1 }, // 20', 10', 20', 20'
    max_height_m: 15.2, // 50 ft (negotiable)
    max_stories: 4,
    max_far: 1.5,
    max_lot_coverage: 0.60,
    permitted_uses: [
      "residential",
      "commercial",
      "mixed_use",
      "open_space",
      "community_facilities",
    ],
    conditional_uses: [
      "industrial",
      "institutional",
      "all_uses_subject_to_approval",
    ],
    parking: {
      note: "Determined by approved development plan",
      residential: "Per approved plan (typically 1.5-2 per unit)",
      commercial: "Per approved plan (typically 1 per 300 sqft / 28 sqm)",
    },
    notes:
      "Planned Development zone. All standards are negotiable through the PD approval process. " +
      "Requires a development plan, public hearings, and city council/commission approval. " +
      "Values shown are typical starting points for negotiation.",
  },

  OS: {
    category: "Open Space",
    description: "Parks, recreation, conservation, and open space preservation",
    min_lot_area_sqm: 4047, // ~1 acre
    min_lot_width_m: 30, // ~100 ft
    setbacks: { front_m: 9.1, side_m: 6.1, rear_m: 9.1, corner_side_m: 9.1 }, // 30', 20', 30', 30'
    max_height_m: 10.7, // 35 ft
    max_stories: 2,
    max_far: 0.1,
    max_lot_coverage: 0.10,
    permitted_uses: [
      "park",
      "playground",
      "trail",
      "conservation_area",
      "community_garden",
      "passive_recreation",
    ],
    conditional_uses: [
      "recreation_building",
      "restroom_facility",
      "maintenance_building",
      "amphitheater",
      "parking_lot_for_park",
    ],
    parking: { park: "Per facility type and capacity" },
    notes:
      "Open space and recreation zone. Very limited building allowed. Primarily for parks, conservation, and greenways.",
  },

  P: {
    category: "Public/Institutional",
    description: "Government, educational, religious, and other institutional uses",
    min_lot_area_sqm: 929, // ~10,000 sqft
    min_lot_width_m: 24, // ~80 ft
    setbacks: { front_m: 7.6, side_m: 3.0, rear_m: 7.6, corner_side_m: 4.6 }, // 25', 10', 25', 15'
    max_height_m: 15.2, // 50 ft
    max_stories: 3,
    max_far: 1.0,
    max_lot_coverage: 0.50,
    permitted_uses: [
      "government_building",
      "school",
      "library",
      "fire_station",
      "police_station",
      "hospital",
      "church",
      "community_center",
      "museum",
    ],
    conditional_uses: [
      "utility_facility",
      "communication_tower",
      "cemetery",
      "transit_station",
    ],
    parking: {
      school: "1 per classroom + 1 per 4 seats in assembly",
      church: "1 per 4 seats in sanctuary",
      office: "1 per 300 sqft (1 per 28 sqm)",
      hospital: "1 per 2 beds + 1 per employee",
    },
    notes:
      "Public and institutional zone. Larger setbacks to buffer from residential. May require design review.",
  },

  // ── Additional common zones ────────────────────────────────────────────

  "RE": {
    category: "Residential Estate",
    description: "Very low-density estate-style single-family lots (1/2 acre+)",
    min_lot_area_sqm: 2023, // ~0.5 acre (21,780 sqft)
    min_lot_width_m: 30, // ~100 ft
    setbacks: { front_m: 9.1, side_m: 3.0, rear_m: 9.1, corner_side_m: 6.1 }, // 30', 10', 30', 20'
    max_height_m: 10.7, // 35 ft
    max_stories: 2,
    max_far: 0.3,
    max_lot_coverage: 0.25,
    permitted_uses: [
      "single_family_dwelling",
      "home_occupation",
      "accessory_structure",
      "agriculture",
      "equestrian",
    ],
    conditional_uses: ["church", "school", "adu", "kennel", "nursery_greenhouse"],
    parking: { residential: "2 per dwelling unit" },
    notes:
      "Rural/estate residential zone. Very low density with large lot requirements. May allow agricultural uses.",
  },

  "RM": {
    category: "Residential Medium Density",
    description: "Medium-density residential including small-lot single-family and townhouses",
    min_lot_area_sqm: 325, // ~3,500 sqft
    min_lot_width_m: 10, // ~35 ft
    setbacks: { front_m: 4.6, side_m: 1.2, rear_m: 4.6, corner_side_m: 3.0 }, // 15', 4', 15', 10'
    max_height_m: 10.7, // 35 ft
    max_stories: 2,
    max_far: 0.7,
    max_lot_coverage: 0.50,
    permitted_uses: [
      "single_family_dwelling",
      "duplex",
      "townhouse",
      "patio_home",
      "home_occupation",
      "accessory_structure",
    ],
    conditional_uses: ["adu", "group_home", "daycare", "church", "school"],
    parking: { residential: "2 per dwelling unit" },
    notes:
      "Medium-density residential allowing small-lot development and attached housing. Often used in infill and transit-adjacent areas.",
  },

  "CBD": {
    category: "Central Business District",
    description: "Downtown core with maximum development intensity and no use restrictions",
    min_lot_area_sqm: 185, // ~2,000 sqft
    min_lot_width_m: 6.1, // ~20 ft
    setbacks: { front_m: 0, side_m: 0, rear_m: 0, corner_side_m: 0 }, // All zero
    max_height_m: 61, // 200 ft (or unlimited in some cities)
    max_stories: 20,
    max_far: 10.0,
    max_lot_coverage: 1.0,
    permitted_uses: [
      "office_building",
      "retail_store",
      "restaurant",
      "hotel",
      "apartment_building",
      "entertainment",
      "cultural_facility",
      "government_building",
      "parking_structure",
    ],
    conditional_uses: [
      "industrial",
      "auto_oriented_uses",
      "drive_through",
      "surface_parking_lot",
    ],
    parking: {
      note: "Often no minimum parking required in CBD",
      office: "0-1 per 500 sqft (0-1 per 46 sqm)",
      residential: "0-0.5 per unit",
      retail: "0-1 per 500 sqft (0-1 per 46 sqm)",
    },
    notes:
      "Central Business District. Maximum development intensity. Many CBDs have no minimum parking requirements. " +
      "May have maximum parking caps instead. FAR bonuses may be available for public amenities.",
  },

  "TOD": {
    category: "Transit-Oriented Development",
    description: "High-density mixed-use zone within walking distance of transit stations",
    min_lot_area_sqm: 280, // ~3,000 sqft
    min_lot_width_m: 9, // ~30 ft
    setbacks: { front_m: 0, side_m: 0, rear_m: 3.0, corner_side_m: 0 }, // 0', 0', 10', 0'
    max_height_m: 22.9, // 75 ft
    max_stories: 7,
    max_far: 4.0,
    max_lot_coverage: 0.90,
    permitted_uses: [
      "apartment_building",
      "retail_store",
      "restaurant",
      "office",
      "hotel",
      "live_work",
      "daycare_center",
      "civic_uses",
    ],
    conditional_uses: [
      "drive_through",
      "gas_station",
      "auto_oriented_uses",
      "standalone_parking",
    ],
    parking: {
      residential: "0.5-1 per unit",
      retail: "1 per 500 sqft (1 per 46 sqm)",
      office: "1 per 500 sqft (1 per 46 sqm)",
    },
    notes:
      "Transit-Oriented Development zone. Reduced parking requirements. Pedestrian-oriented design standards. " +
      "Typically within 1/4-1/2 mile of a transit station. Auto-oriented uses discouraged.",
  },
};

// ─── Zone Code Normalization ─────────────────────────────────────────────────

/**
 * Normalize a zone code for lookup. Handles common variations:
 * - Case insensitivity: "r-1" -> "R-1"
 * - Space vs dash: "R 1" -> "R-1"
 * - No separator: "R1" -> "R-1"
 */
function normalizeZoneCode(code: string): string {
  let normalized = code.trim().toUpperCase();

  // Replace spaces with dashes
  normalized = normalized.replace(/\s+/g, "-");

  // Insert dash if missing between letter(s) and number
  // e.g., "R1" -> "R-1", "MU2" -> "MU-2"
  normalized = normalized.replace(/^([A-Z]+)(\d)/, "$1-$2");

  return normalized;
}

/**
 * Try to find a matching zone in the database, with fuzzy matching.
 */
function lookupZone(code: string): { code: string; data: ZoneData } | null {
  const normalized = normalizeZoneCode(code);

  // Direct match
  if (COMMON_ZONES[normalized]) {
    return { code: normalized, data: COMMON_ZONES[normalized]! };
  }

  // Try without dashes
  const noDash = normalized.replace(/-/g, "");
  for (const [key, data] of Object.entries(COMMON_ZONES)) {
    if (key.replace(/-/g, "") === noDash) {
      return { code: key, data };
    }
  }

  // Try matching just the prefix (e.g., "R-1A" matches "R-1")
  for (const [key, data] of Object.entries(COMMON_ZONES)) {
    if (normalized.startsWith(key)) {
      return { code: key, data };
    }
  }

  return null;
}

/**
 * Try to infer a zone code from an address string using common patterns.
 * This is a heuristic and may not be accurate.
 */
function inferZoneFromAddress(address: string): string | null {
  // This is intentionally a no-op for production; the tool should recommend
  // a web search for actual address-to-zone lookups. We return null to
  // indicate that the address could not be resolved to a zone code locally.
  return null;
}

// ─── Lot Analysis ────────────────────────────────────────────────────────────

function computeLotAnalysis(
  lotAreaSqm: number,
  zoneData: ZoneData,
): LotAnalysis {
  const lotAreaSqft = round2(lotAreaSqm * SQM_TO_SQFT);

  // Maximum building footprint based on lot coverage
  const maxFootprintSqm = round2(lotAreaSqm * zoneData.max_lot_coverage);
  const maxFootprintSqft = round2(maxFootprintSqm * SQM_TO_SQFT);

  // Maximum floor area based on FAR
  const maxFloorAreaSqm = round2(lotAreaSqm * zoneData.max_far);
  const maxFloorAreaSqft = round2(maxFloorAreaSqm * SQM_TO_SQFT);

  // Note about setbacks - we can't compute the exact buildable area without
  // knowing lot dimensions (width x depth), so we provide the setback values
  // and a note.
  const setbacks = zoneData.setbacks;
  const setbackNote =
    `Setbacks reduce buildable area: front=${setbacks.front_m}m (${round2(setbacks.front_m * METERS_TO_FEET)}ft), ` +
    `each side=${setbacks.side_m}m (${round2(setbacks.side_m * METERS_TO_FEET)}ft), ` +
    `rear=${setbacks.rear_m}m (${round2(setbacks.rear_m * METERS_TO_FEET)}ft). ` +
    `Provide lot width and depth to calculate exact buildable envelope.`;

  return {
    lot_area_sqm: round2(lotAreaSqm),
    lot_area_sqft: lotAreaSqft,
    max_building_footprint_sqm: maxFootprintSqm,
    max_building_footprint_sqft: maxFootprintSqft,
    max_floor_area_sqm: maxFloorAreaSqm,
    max_floor_area_sqft: maxFloorAreaSqft,
    buildable_area_after_setbacks_note: setbackNote,
    max_lot_coverage_percent: round2(zoneData.max_lot_coverage * 100),
    max_far: zoneData.max_far,
    max_stories: zoneData.max_stories,
    max_height_m: zoneData.max_height_m,
    max_height_ft: round2(zoneData.max_height_m * METERS_TO_FEET),
  };
}

// ─── Main Execution ──────────────────────────────────────────────────────────

function performLookup(params: {
  address?: string;
  zone_code?: string;
  jurisdiction?: string;
  lot_area_sqm?: number;
}): LookupResult & { available_zones?: string[] } {
  const { address, zone_code, jurisdiction, lot_area_sqm } = params;

  // Determine zone code from provided inputs
  let resolvedCode: string | null = null;
  let zoneResult: { code: string; data: ZoneData } | null = null;

  if (zone_code) {
    zoneResult = lookupZone(zone_code);
    if (zoneResult) {
      resolvedCode = zoneResult.code;
    }
  }

  if (!zoneResult && address) {
    // Try to infer zone from address (currently returns null)
    resolvedCode = inferZoneFromAddress(address);
    if (resolvedCode) {
      zoneResult = lookupZone(resolvedCode);
    }
  }

  if (!zoneResult) {
    // Zone not found - return helpful error with available zones
    const searchedFor = zone_code
      ? normalizeZoneCode(zone_code)
      : address ?? "unknown";

    const availableZones = Object.entries(COMMON_ZONES).map(
      ([code, data]) => `${code}: ${data.category}`,
    );

    throw new Error(
      `Zone "${searchedFor}" not found in the built-in database.\n\n` +
        `Available zone codes:\n${availableZones.map((z) => `  - ${z}`).join("\n")}\n\n` +
        `If you have a specific zone code from your jurisdiction, try providing it as zone_code. ` +
        `For address-based lookups, check your local planning department's website or GIS portal.`,
    );
  }

  // Compute lot analysis if lot_area_sqm provided
  let lotAnalysis: LotAnalysis | null = null;
  if (lot_area_sqm !== undefined && lot_area_sqm > 0) {
    lotAnalysis = computeLotAnalysis(lot_area_sqm, zoneResult.data);
  }

  // Build suggested search query
  const jurisdictionStr = jurisdiction ? ` ${jurisdiction}` : "";
  const suggestedLookup = address
    ? `Search: "${address}" zoning map${jurisdictionStr}`
    : `Search:${jurisdictionStr} zoning code ${resolvedCode}`;

  return {
    zone_code: resolvedCode!,
    zone_data: zoneResult.data,
    lot_analysis: lotAnalysis,
    source: "built_in_database",
    disclaimer:
      "These are typical parameters for common US zoning classifications. " +
      "Actual requirements vary significantly by jurisdiction. Always verify with " +
      "your local planning department before making design decisions. Zone codes, " +
      "setbacks, FAR, height limits, and permitted uses are subject to local amendments, " +
      "overlay districts, and specific plan areas.",
    suggested_lookup: suggestedLookup,
  };
}

// ─── Tool Definition ─────────────────────────────────────────────────────────

export function createZoningLookupToolDefinition() {
  return {
    name: "zoning_lookup",
    label: "Zoning Lookup",
    description:
      "Look up zoning requirements for a US address or zone code. Returns setbacks, FAR, " +
      "lot coverage, height limits, permitted uses, and parking requirements from a built-in " +
      "database of 20+ common US zoning classifications (R-1 through R-5, C-1 through C-4, " +
      "M-1/M-2, MU-1 through MU-3, PD, OS, P, CBD, TOD, and more). " +
      "If lot_area_sqm is provided, calculates maximum buildable area and building envelope.",
    parameters: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description:
            "Street address to look up (optional). Currently the built-in database matches " +
            "by zone code, not address. A web search suggestion is provided for address-based lookups.",
        },
        zone_code: {
          type: "string",
          description:
            'Known zoning district code, e.g., "R-1", "C-2", "M-1", "MU-2", "CBD". ' +
            "Case-insensitive, handles common variations (R1, R-1, R 1).",
        },
        jurisdiction: {
          type: "string",
          description:
            'City or county name for context (e.g., "San Francisco", "Cook County"). ' +
            "Used in the suggested web search query for verification.",
        },
        lot_area_sqm: {
          type: "number",
          description:
            "Lot area in square meters. If provided, the tool calculates maximum buildable area, " +
            "maximum floor area (FAR), and building envelope constraints.",
        },
      },
      required: [],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details?: unknown;
    }> => {
      const params = (args ?? {}) as Record<string, unknown>;

      // ── Validate that at least one lookup field is provided ────────────
      const address =
        typeof params.address === "string" && params.address.trim()
          ? params.address.trim()
          : undefined;

      const zoneCode =
        typeof params.zone_code === "string" && params.zone_code.trim()
          ? params.zone_code.trim()
          : undefined;

      if (!address && !zoneCode) {
        throw new Error(
          "At least one of 'address' or 'zone_code' must be provided.",
        );
      }

      const jurisdiction =
        typeof params.jurisdiction === "string" && params.jurisdiction.trim()
          ? params.jurisdiction.trim()
          : undefined;

      const lotAreaSqm =
        typeof params.lot_area_sqm === "number" &&
        Number.isFinite(params.lot_area_sqm) &&
        params.lot_area_sqm > 0
          ? params.lot_area_sqm
          : undefined;

      // ── Perform lookup ──────────────────────────────────────────────────
      const result = performLookup({
        address,
        zone_code: zoneCode,
        jurisdiction,
        lot_area_sqm: lotAreaSqm,
      });

      // ── Format human-readable summary ───────────────────────────────────
      const zd = result.zone_data;
      const lines: string[] = [];

      lines.push(`=== Zoning Lookup: ${result.zone_code} ===`);
      lines.push(`Category: ${zd.category}`);
      lines.push(`Description: ${zd.description}`);
      lines.push("");

      lines.push("-- Lot Requirements --");
      lines.push(
        `  Minimum lot area: ${zd.min_lot_area_sqm} sqm (${round2(zd.min_lot_area_sqm * SQM_TO_SQFT)} sqft)`,
      );
      lines.push(
        `  Minimum lot width: ${zd.min_lot_width_m} m (${round2(zd.min_lot_width_m * METERS_TO_FEET)} ft)`,
      );
      lines.push("");

      lines.push("-- Setbacks --");
      lines.push(
        `  Front: ${zd.setbacks.front_m} m (${round2(zd.setbacks.front_m * METERS_TO_FEET)} ft)`,
      );
      lines.push(
        `  Side: ${zd.setbacks.side_m} m (${round2(zd.setbacks.side_m * METERS_TO_FEET)} ft)`,
      );
      lines.push(
        `  Rear: ${zd.setbacks.rear_m} m (${round2(zd.setbacks.rear_m * METERS_TO_FEET)} ft)`,
      );
      if (zd.setbacks.corner_side_m !== undefined) {
        lines.push(
          `  Corner side: ${zd.setbacks.corner_side_m} m (${round2(zd.setbacks.corner_side_m * METERS_TO_FEET)} ft)`,
        );
      }
      lines.push("");

      lines.push("-- Building Envelope --");
      lines.push(
        `  Max height: ${zd.max_height_m} m (${round2(zd.max_height_m * METERS_TO_FEET)} ft)`,
      );
      lines.push(`  Max stories: ${zd.max_stories}`);
      lines.push(`  Max FAR: ${zd.max_far}`);
      lines.push(`  Max lot coverage: ${round2(zd.max_lot_coverage * 100)}%`);
      lines.push("");

      lines.push("-- Permitted Uses --");
      for (const use of zd.permitted_uses) {
        lines.push(`  - ${use.replace(/_/g, " ")}`);
      }
      lines.push("");

      lines.push("-- Conditional Uses (require special approval) --");
      for (const use of zd.conditional_uses) {
        lines.push(`  - ${use.replace(/_/g, " ")}`);
      }
      lines.push("");

      lines.push("-- Parking Requirements --");
      for (const [key, value] of Object.entries(zd.parking)) {
        lines.push(`  ${key.replace(/_/g, " ")}: ${value}`);
      }
      lines.push("");

      if (result.lot_analysis) {
        const la = result.lot_analysis;
        lines.push("-- Lot Analysis --");
        lines.push(`  Lot area: ${la.lot_area_sqm} sqm (${la.lot_area_sqft} sqft)`);
        lines.push(
          `  Max building footprint: ${la.max_building_footprint_sqm} sqm (${la.max_building_footprint_sqft} sqft) [${la.max_lot_coverage_percent}% coverage]`,
        );
        lines.push(
          `  Max total floor area: ${la.max_floor_area_sqm} sqm (${la.max_floor_area_sqft} sqft) [FAR ${la.max_far}]`,
        );
        lines.push(`  Max height: ${la.max_height_m} m (${la.max_height_ft} ft)`);
        lines.push(`  Max stories: ${la.max_stories}`);
        lines.push(`  Note: ${la.buildable_area_after_setbacks_note}`);
        lines.push("");
      }

      lines.push(`Notes: ${zd.notes}`);
      lines.push("");
      lines.push(`Source: ${result.source}`);
      lines.push(`Suggested verification: ${result.suggested_lookup}`);
      lines.push("");
      lines.push(`DISCLAIMER: ${result.disclaimer}`);

      const textSummary = lines.join("\n");

      return {
        content: [
          { type: "text", text: textSummary },
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
        details: {
          zone_code: result.zone_code,
          category: zd.category,
          max_far: zd.max_far,
          max_height_m: zd.max_height_m,
          max_lot_coverage: zd.max_lot_coverage,
          lot_analysis_included: result.lot_analysis !== null,
        },
      };
    },
  };
}
