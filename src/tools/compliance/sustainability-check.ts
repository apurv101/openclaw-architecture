/**
 * Sustainability Check tool for civilclaw.
 *
 * Evaluates a building design against LEED v4.1 BD+C (Building Design and
 * Construction) criteria. Estimates achievable credits and certification level
 * based on provided project data.
 *
 * No external dependencies beyond standard TypeScript.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

type RatingSystem = "leed_v4";

type LeedBuildingType = "new_construction" | "core_shell" | "schools" | "healthcare";

type CreditStatus = "achieved" | "partial" | "not_achieved" | "not_evaluated";

type CertificationLevel = "Not Certified" | "Certified" | "Silver" | "Gold" | "Platinum";

interface LocationData {
  is_brownfield?: boolean;
  transit_rides_per_day?: number;
  bicycle_storage_percent?: number;
  preferred_parking_percent?: number;
  reduced_parking?: boolean;
}

interface WaterData {
  indoor_water_reduction_percent?: number;
  outdoor_water_reduction_percent?: number;
  cooling_tower_optimization?: boolean;
  water_metering?: boolean;
}

interface EnergyData {
  energy_cost_reduction_percent?: number;
  on_site_renewable_percent?: number;
  commissioning_performed?: boolean;
  enhanced_commissioning?: boolean;
  energy_metering?: boolean;
  refrigerant_management?: boolean;
  green_power_percent?: number;
}

interface MaterialsData {
  recycled_content_percent?: number;
  regional_materials_percent?: number;
  fsc_certified_wood_percent?: number;
  construction_waste_diverted_percent?: number;
  building_reuse_percent?: number;
  epd_products_count?: number;
  sourcing_raw_materials_count?: number;
  material_ingredients_count?: number;
}

interface IndoorQualityData {
  no_smoking_policy?: boolean;
  outdoor_air_monitoring?: boolean;
  increased_ventilation_percent?: number;
  low_emitting_materials?: boolean;
  construction_iaq_plan?: boolean;
  thermal_comfort_ashrae_55?: boolean;
  daylighting_percent?: number;
  views_percent?: number;
  acoustic_performance?: boolean;
}

interface InnovationData {
  innovation_credits?: number;
  leed_ap?: boolean;
}

interface ProjectData {
  location?: LocationData;
  water?: WaterData;
  energy?: EnergyData;
  materials?: MaterialsData;
  indoor_quality?: IndoorQualityData;
  innovation?: InnovationData;
}

interface CreditResult {
  category: string;
  credit_name: string;
  points_possible: number;
  points_achieved: number;
  status: CreditStatus;
  notes: string;
}

interface SustainabilityCheckParams {
  rating_system: RatingSystem;
  building_type: LeedBuildingType;
  project_data: ProjectData;
}

// ─── Credit Evaluation Functions ─────────────────────────────────────────────

function evaluateIntegrativeProcess(): CreditResult[] {
  // Integrative Process credit is always available as 1 point
  return [
    {
      category: "Integrative Process",
      credit_name: "Integrative Process",
      points_possible: 1,
      points_achieved: 1,
      status: "achieved",
      notes: "Integrative process credit awarded by default when pursuing LEED certification.",
    },
  ];
}

function evaluateLocationTransportation(location?: LocationData): CreditResult[] {
  const credits: CreditResult[] = [];

  // Sensitive Land Protection (1 point)
  credits.push({
    category: "Location & Transportation",
    credit_name: "Sensitive Land Protection",
    points_possible: 1,
    points_achieved: 0,
    status: "not_evaluated",
    notes: "Requires site assessment data for sensitive land. Not evaluated from provided data.",
  });

  // High-Priority Site (2 points)
  if (location?.is_brownfield != null) {
    credits.push({
      category: "Location & Transportation",
      credit_name: "High-Priority Site",
      points_possible: 2,
      points_achieved: location.is_brownfield ? 2 : 0,
      status: location.is_brownfield ? "achieved" : "not_achieved",
      notes: location.is_brownfield
        ? "Brownfield site qualifies for high-priority site credit."
        : "Site is not identified as a brownfield or high-priority site.",
    });
  } else {
    credits.push({
      category: "Location & Transportation",
      credit_name: "High-Priority Site",
      points_possible: 2,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Brownfield status not provided.",
    });
  }

  // Surrounding Density and Diverse Uses (5 points)
  credits.push({
    category: "Location & Transportation",
    credit_name: "Surrounding Density and Diverse Uses",
    points_possible: 5,
    points_achieved: 0,
    status: "not_evaluated",
    notes: "Requires surrounding density analysis and diverse use count. Not evaluated from provided data.",
  });

  // Access to Quality Transit (5 points)
  if (location?.transit_rides_per_day != null) {
    let points = 0;
    let status: CreditStatus = "not_achieved";
    let notes = "";

    if (location.transit_rides_per_day >= 400) {
      points = 5;
      status = "achieved";
      notes = `${location.transit_rides_per_day} weekday transit rides/day within 1/4 mile. Full credit achieved (>=400).`;
    } else if (location.transit_rides_per_day >= 200) {
      points = 3;
      status = "partial";
      notes = `${location.transit_rides_per_day} weekday transit rides/day within 1/4 mile. Partial credit (>=200).`;
    } else if (location.transit_rides_per_day >= 72) {
      points = 1;
      status = "partial";
      notes = `${location.transit_rides_per_day} weekday transit rides/day within 1/4 mile. Minimum credit (>=72).`;
    } else {
      notes = `${location.transit_rides_per_day} weekday transit rides/day is below the 72 minimum threshold.`;
    }

    credits.push({
      category: "Location & Transportation",
      credit_name: "Access to Quality Transit",
      points_possible: 5,
      points_achieved: points,
      status,
      notes,
    });
  } else {
    credits.push({
      category: "Location & Transportation",
      credit_name: "Access to Quality Transit",
      points_possible: 5,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Transit data not provided.",
    });
  }

  // Bicycle Facilities (1 point)
  if (location?.bicycle_storage_percent != null) {
    const achieved = location.bicycle_storage_percent >= 5;
    credits.push({
      category: "Location & Transportation",
      credit_name: "Bicycle Facilities",
      points_possible: 1,
      points_achieved: achieved ? 1 : 0,
      status: achieved ? "achieved" : "not_achieved",
      notes: achieved
        ? `Bicycle storage for ${location.bicycle_storage_percent}% of occupants meets >=5% requirement.`
        : `Bicycle storage for ${location.bicycle_storage_percent}% of occupants is below the 5% threshold.`,
    });
  } else {
    credits.push({
      category: "Location & Transportation",
      credit_name: "Bicycle Facilities",
      points_possible: 1,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Bicycle storage data not provided.",
    });
  }

  // Reduced Parking Footprint (1 point)
  if (location?.reduced_parking != null) {
    credits.push({
      category: "Location & Transportation",
      credit_name: "Reduced Parking Footprint",
      points_possible: 1,
      points_achieved: location.reduced_parking ? 1 : 0,
      status: location.reduced_parking ? "achieved" : "not_achieved",
      notes: location.reduced_parking
        ? "Reduced parking footprint exceeds minimum requirements."
        : "Parking footprint has not been reduced below baseline.",
    });
  } else {
    credits.push({
      category: "Location & Transportation",
      credit_name: "Reduced Parking Footprint",
      points_possible: 1,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Reduced parking data not provided.",
    });
  }

  // Green Vehicles (1 point)
  if (location?.preferred_parking_percent != null) {
    const achieved = location.preferred_parking_percent >= 5;
    credits.push({
      category: "Location & Transportation",
      credit_name: "Green Vehicles",
      points_possible: 1,
      points_achieved: achieved ? 1 : 0,
      status: achieved ? "achieved" : "not_achieved",
      notes: achieved
        ? `${location.preferred_parking_percent}% preferred parking for LEV/carpool meets >=5% requirement.`
        : `${location.preferred_parking_percent}% preferred parking is below the 5% threshold.`,
    });
  } else {
    credits.push({
      category: "Location & Transportation",
      credit_name: "Green Vehicles",
      points_possible: 1,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Preferred parking data not provided.",
    });
  }

  return credits;
}

function evaluateSustainableSites(): CreditResult[] {
  // Most Sustainable Sites credits require detailed site analysis not covered by basic input params
  const credits: CreditResult[] = [
    {
      category: "Sustainable Sites",
      credit_name: "Site Assessment",
      points_possible: 1,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Requires detailed site assessment documentation. Not evaluated from provided data.",
    },
    {
      category: "Sustainable Sites",
      credit_name: "Protect or Restore Habitat",
      points_possible: 2,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Requires habitat restoration plan details. Not evaluated from provided data.",
    },
    {
      category: "Sustainable Sites",
      credit_name: "Open Space",
      points_possible: 1,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Requires open space calculations. Not evaluated from provided data.",
    },
    {
      category: "Sustainable Sites",
      credit_name: "Rainwater Management",
      points_possible: 3,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Requires stormwater management plan. Not evaluated from provided data.",
    },
    {
      category: "Sustainable Sites",
      credit_name: "Heat Island Reduction",
      points_possible: 2,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Requires roof and non-roof surface data. Not evaluated from provided data.",
    },
    {
      category: "Sustainable Sites",
      credit_name: "Light Pollution Reduction",
      points_possible: 1,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Requires exterior lighting analysis. Not evaluated from provided data.",
    },
  ];

  return credits;
}

function evaluateWaterEfficiency(water?: WaterData): CreditResult[] {
  const credits: CreditResult[] = [];

  // Outdoor Water Use Reduction (2 points)
  if (water?.outdoor_water_reduction_percent != null) {
    let points = 0;
    let status: CreditStatus = "not_achieved";
    let notes = "";

    if (water.outdoor_water_reduction_percent >= 100) {
      points = 2;
      status = "achieved";
      notes = `${water.outdoor_water_reduction_percent}% outdoor water reduction (no potable water or irrigation). Full credit.`;
    } else if (water.outdoor_water_reduction_percent >= 50) {
      points = 1;
      status = "partial";
      notes = `${water.outdoor_water_reduction_percent}% outdoor water reduction. Partial credit (>=50%).`;
    } else {
      notes = `${water.outdoor_water_reduction_percent}% outdoor water reduction is below the 50% threshold.`;
    }

    credits.push({
      category: "Water Efficiency",
      credit_name: "Outdoor Water Use Reduction",
      points_possible: 2,
      points_achieved: points,
      status,
      notes,
    });
  } else {
    credits.push({
      category: "Water Efficiency",
      credit_name: "Outdoor Water Use Reduction",
      points_possible: 2,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Outdoor water reduction data not provided.",
    });
  }

  // Indoor Water Use Reduction (6 points)
  if (water?.indoor_water_reduction_percent != null) {
    let points = 0;
    let status: CreditStatus = "not_achieved";
    let notes = "";

    // Prerequisite: 20% reduction
    if (water.indoor_water_reduction_percent < 20) {
      notes = `${water.indoor_water_reduction_percent}% indoor water reduction fails the 20% prerequisite.`;
      status = "not_achieved";
    } else if (water.indoor_water_reduction_percent >= 50) {
      points = 6;
      status = "achieved";
      notes = `${water.indoor_water_reduction_percent}% indoor water reduction. Full 6 points (>=50%).`;
    } else if (water.indoor_water_reduction_percent >= 45) {
      points = 5;
      status = "partial";
      notes = `${water.indoor_water_reduction_percent}% indoor water reduction. 5 points (>=45%).`;
    } else if (water.indoor_water_reduction_percent >= 40) {
      points = 4;
      status = "partial";
      notes = `${water.indoor_water_reduction_percent}% indoor water reduction. 4 points (>=40%).`;
    } else if (water.indoor_water_reduction_percent >= 35) {
      points = 3;
      status = "partial";
      notes = `${water.indoor_water_reduction_percent}% indoor water reduction. 3 points (>=35%).`;
    } else if (water.indoor_water_reduction_percent >= 30) {
      points = 2;
      status = "partial";
      notes = `${water.indoor_water_reduction_percent}% indoor water reduction. 2 points (>=30%).`;
    } else if (water.indoor_water_reduction_percent >= 25) {
      points = 1;
      status = "partial";
      notes = `${water.indoor_water_reduction_percent}% indoor water reduction. 1 point (>=25%).`;
    } else {
      notes = `${water.indoor_water_reduction_percent}% indoor water reduction meets the prerequisite but earns no additional credit points (need >=25%).`;
    }

    credits.push({
      category: "Water Efficiency",
      credit_name: "Indoor Water Use Reduction",
      points_possible: 6,
      points_achieved: points,
      status,
      notes,
    });
  } else {
    credits.push({
      category: "Water Efficiency",
      credit_name: "Indoor Water Use Reduction",
      points_possible: 6,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Indoor water reduction data not provided.",
    });
  }

  // Cooling Tower Water Use (2 points)
  if (water?.cooling_tower_optimization != null) {
    credits.push({
      category: "Water Efficiency",
      credit_name: "Cooling Tower Water Use",
      points_possible: 2,
      points_achieved: water.cooling_tower_optimization ? 2 : 0,
      status: water.cooling_tower_optimization ? "achieved" : "not_achieved",
      notes: water.cooling_tower_optimization
        ? "Cooling tower water optimization measures implemented."
        : "Cooling tower water optimization not implemented.",
    });
  } else {
    credits.push({
      category: "Water Efficiency",
      credit_name: "Cooling Tower Water Use",
      points_possible: 2,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Cooling tower data not provided.",
    });
  }

  // Water Metering (1 point)
  if (water?.water_metering != null) {
    credits.push({
      category: "Water Efficiency",
      credit_name: "Water Metering",
      points_possible: 1,
      points_achieved: water.water_metering ? 1 : 0,
      status: water.water_metering ? "achieved" : "not_achieved",
      notes: water.water_metering
        ? "Building-level water metering installed for all water sources."
        : "Water metering not implemented.",
    });
  } else {
    credits.push({
      category: "Water Efficiency",
      credit_name: "Water Metering",
      points_possible: 1,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Water metering data not provided.",
    });
  }

  return credits;
}

function evaluateEnergyAtmosphere(energy?: EnergyData): CreditResult[] {
  const credits: CreditResult[] = [];

  // Optimize Energy Performance (18 points max)
  if (energy?.energy_cost_reduction_percent != null) {
    let points = 0;
    let status: CreditStatus = "not_achieved";
    let notes = "";

    // Prerequisite: must meet ASHRAE 90.1 baseline (assumed if any reduction)
    if (energy.energy_cost_reduction_percent >= 50) {
      points = 18;
      status = "achieved";
      notes = `${energy.energy_cost_reduction_percent}% energy cost reduction vs ASHRAE 90.1 baseline. Full 18 points (>=50%).`;
    } else if (energy.energy_cost_reduction_percent >= 48) {
      points = 17;
      status = "partial";
      notes = `${energy.energy_cost_reduction_percent}% energy cost reduction. 17 points.`;
    } else if (energy.energy_cost_reduction_percent >= 46) {
      points = 16;
      status = "partial";
      notes = `${energy.energy_cost_reduction_percent}% energy cost reduction. 16 points.`;
    } else if (energy.energy_cost_reduction_percent >= 44) {
      points = 15;
      status = "partial";
      notes = `${energy.energy_cost_reduction_percent}% energy cost reduction. 15 points.`;
    } else if (energy.energy_cost_reduction_percent >= 42) {
      points = 14;
      status = "partial";
      notes = `${energy.energy_cost_reduction_percent}% energy cost reduction. 14 points.`;
    } else if (energy.energy_cost_reduction_percent >= 40) {
      points = 13;
      status = "partial";
      notes = `${energy.energy_cost_reduction_percent}% energy cost reduction. 13 points.`;
    } else if (energy.energy_cost_reduction_percent >= 38) {
      points = 12;
      status = "partial";
      notes = `${energy.energy_cost_reduction_percent}% energy cost reduction. 12 points.`;
    } else if (energy.energy_cost_reduction_percent >= 36) {
      points = 11;
      status = "partial";
      notes = `${energy.energy_cost_reduction_percent}% energy cost reduction. 11 points.`;
    } else if (energy.energy_cost_reduction_percent >= 34) {
      points = 10;
      status = "partial";
      notes = `${energy.energy_cost_reduction_percent}% energy cost reduction. 10 points.`;
    } else if (energy.energy_cost_reduction_percent >= 32) {
      points = 9;
      status = "partial";
      notes = `${energy.energy_cost_reduction_percent}% energy cost reduction. 9 points.`;
    } else if (energy.energy_cost_reduction_percent >= 30) {
      points = 8;
      status = "partial";
      notes = `${energy.energy_cost_reduction_percent}% energy cost reduction. 8 points.`;
    } else if (energy.energy_cost_reduction_percent >= 28) {
      points = 7;
      status = "partial";
      notes = `${energy.energy_cost_reduction_percent}% energy cost reduction. 7 points.`;
    } else if (energy.energy_cost_reduction_percent >= 26) {
      points = 6;
      status = "partial";
      notes = `${energy.energy_cost_reduction_percent}% energy cost reduction. 6 points.`;
    } else if (energy.energy_cost_reduction_percent >= 22) {
      points = 4;
      status = "partial";
      notes = `${energy.energy_cost_reduction_percent}% energy cost reduction. 4 points.`;
    } else if (energy.energy_cost_reduction_percent >= 18) {
      points = 3;
      status = "partial";
      notes = `${energy.energy_cost_reduction_percent}% energy cost reduction. 3 points.`;
    } else if (energy.energy_cost_reduction_percent >= 14) {
      points = 2;
      status = "partial";
      notes = `${energy.energy_cost_reduction_percent}% energy cost reduction. 2 points.`;
    } else if (energy.energy_cost_reduction_percent >= 10) {
      points = 1;
      status = "partial";
      notes = `${energy.energy_cost_reduction_percent}% energy cost reduction. 1 point.`;
    } else if (energy.energy_cost_reduction_percent >= 6) {
      points = 0;
      notes = `${energy.energy_cost_reduction_percent}% energy cost reduction meets prerequisite but earns no optimization points (need >=10%).`;
    } else {
      notes = `${energy.energy_cost_reduction_percent}% energy cost reduction. Below minimum prerequisite threshold.`;
    }

    credits.push({
      category: "Energy & Atmosphere",
      credit_name: "Optimize Energy Performance",
      points_possible: 18,
      points_achieved: points,
      status,
      notes,
    });
  } else {
    credits.push({
      category: "Energy & Atmosphere",
      credit_name: "Optimize Energy Performance",
      points_possible: 18,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Energy cost reduction data not provided.",
    });
  }

  // Renewable Energy Production (5 points)
  if (energy?.on_site_renewable_percent != null) {
    let points = 0;
    let status: CreditStatus = "not_achieved";
    let notes = "";

    if (energy.on_site_renewable_percent >= 10) {
      points = 5;
      status = "achieved";
      notes = `${energy.on_site_renewable_percent}% on-site renewable energy. Full 5 points (>=10%).`;
    } else if (energy.on_site_renewable_percent >= 7.5) {
      points = 4;
      status = "partial";
      notes = `${energy.on_site_renewable_percent}% on-site renewable energy. 4 points.`;
    } else if (energy.on_site_renewable_percent >= 5) {
      points = 3;
      status = "partial";
      notes = `${energy.on_site_renewable_percent}% on-site renewable energy. 3 points.`;
    } else if (energy.on_site_renewable_percent >= 3) {
      points = 2;
      status = "partial";
      notes = `${energy.on_site_renewable_percent}% on-site renewable energy. 2 points.`;
    } else if (energy.on_site_renewable_percent >= 1) {
      points = 1;
      status = "partial";
      notes = `${energy.on_site_renewable_percent}% on-site renewable energy. 1 point (>=1%).`;
    } else {
      notes = `${energy.on_site_renewable_percent}% on-site renewable energy is below the 1% minimum.`;
    }

    credits.push({
      category: "Energy & Atmosphere",
      credit_name: "Renewable Energy Production",
      points_possible: 5,
      points_achieved: points,
      status,
      notes,
    });
  } else {
    credits.push({
      category: "Energy & Atmosphere",
      credit_name: "Renewable Energy Production",
      points_possible: 5,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "On-site renewable energy data not provided.",
    });
  }

  // Enhanced Commissioning (6 points)
  if (energy?.enhanced_commissioning != null || energy?.commissioning_performed != null) {
    let points = 0;
    let status: CreditStatus = "not_achieved";
    let notes = "";

    if (energy.enhanced_commissioning) {
      points = 6;
      status = "achieved";
      notes = "Enhanced commissioning performed. Full 6 points.";
    } else if (energy.commissioning_performed) {
      points = 2;
      status = "partial";
      notes = "Fundamental commissioning performed (prerequisite met). Partial credit (2 points). Consider enhanced commissioning for full 6 points.";
    } else {
      notes = "Neither fundamental nor enhanced commissioning has been performed.";
    }

    credits.push({
      category: "Energy & Atmosphere",
      credit_name: "Enhanced Commissioning",
      points_possible: 6,
      points_achieved: points,
      status,
      notes,
    });
  } else {
    credits.push({
      category: "Energy & Atmosphere",
      credit_name: "Enhanced Commissioning",
      points_possible: 6,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Commissioning data not provided.",
    });
  }

  // Advanced Energy Metering (1 point)
  if (energy?.energy_metering != null) {
    credits.push({
      category: "Energy & Atmosphere",
      credit_name: "Advanced Energy Metering",
      points_possible: 1,
      points_achieved: energy.energy_metering ? 1 : 0,
      status: energy.energy_metering ? "achieved" : "not_achieved",
      notes: energy.energy_metering
        ? "Advanced energy metering installed for all whole-building and end-use energy sources."
        : "Advanced energy metering not implemented.",
    });
  } else {
    credits.push({
      category: "Energy & Atmosphere",
      credit_name: "Advanced Energy Metering",
      points_possible: 1,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Energy metering data not provided.",
    });
  }

  // Demand Response (2 points)
  credits.push({
    category: "Energy & Atmosphere",
    credit_name: "Demand Response",
    points_possible: 2,
    points_achieved: 0,
    status: "not_evaluated",
    notes: "Demand response participation data not provided.",
  });

  // Green Power and Carbon Offsets (2 points)
  if (energy?.green_power_percent != null) {
    let points = 0;
    let status: CreditStatus = "not_achieved";
    let notes = "";

    if (energy.green_power_percent >= 100) {
      points = 2;
      status = "achieved";
      notes = `${energy.green_power_percent}% green power procurement. Full 2 points (>=100%).`;
    } else if (energy.green_power_percent >= 50) {
      points = 1;
      status = "partial";
      notes = `${energy.green_power_percent}% green power procurement. 1 point (>=50%).`;
    } else {
      notes = `${energy.green_power_percent}% green power is below the 50% threshold.`;
    }

    credits.push({
      category: "Energy & Atmosphere",
      credit_name: "Green Power and Carbon Offsets",
      points_possible: 2,
      points_achieved: points,
      status,
      notes,
    });
  } else {
    credits.push({
      category: "Energy & Atmosphere",
      credit_name: "Green Power and Carbon Offsets",
      points_possible: 2,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Green power data not provided.",
    });
  }

  return credits;
}

function evaluateMaterialsResources(materials?: MaterialsData): CreditResult[] {
  const credits: CreditResult[] = [];

  // Building Life-Cycle Impact Reduction (5 points)
  if (materials?.building_reuse_percent != null) {
    let points = 0;
    let status: CreditStatus = "not_achieved";
    let notes = "";

    if (materials.building_reuse_percent >= 75) {
      points = 5;
      status = "achieved";
      notes = `${materials.building_reuse_percent}% building structure reused. Full 5 points (>=75%).`;
    } else if (materials.building_reuse_percent >= 50) {
      points = 3;
      status = "partial";
      notes = `${materials.building_reuse_percent}% building structure reused. 3 points (>=50%).`;
    } else if (materials.building_reuse_percent >= 25) {
      points = 2;
      status = "partial";
      notes = `${materials.building_reuse_percent}% building structure reused. 2 points (>=25%).`;
    } else {
      notes = `${materials.building_reuse_percent}% building reuse is below the 25% threshold.`;
    }

    credits.push({
      category: "Materials & Resources",
      credit_name: "Building Life-Cycle Impact Reduction",
      points_possible: 5,
      points_achieved: points,
      status,
      notes,
    });
  } else {
    credits.push({
      category: "Materials & Resources",
      credit_name: "Building Life-Cycle Impact Reduction",
      points_possible: 5,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Building reuse data not provided.",
    });
  }

  // Environmental Product Declarations (2 points)
  if (materials?.epd_products_count != null) {
    let points = 0;
    let status: CreditStatus = "not_achieved";
    let notes = "";

    if (materials.epd_products_count >= 20) {
      points = 2;
      status = "achieved";
      notes = `${materials.epd_products_count} products with EPDs. Full 2 points (>=20 products).`;
    } else if (materials.epd_products_count >= 10) {
      points = 1;
      status = "partial";
      notes = `${materials.epd_products_count} products with EPDs. 1 point (>=10 products).`;
    } else {
      notes = `${materials.epd_products_count} products with EPDs is below the 10-product threshold.`;
    }

    credits.push({
      category: "Materials & Resources",
      credit_name: "Environmental Product Declarations",
      points_possible: 2,
      points_achieved: points,
      status,
      notes,
    });
  } else {
    credits.push({
      category: "Materials & Resources",
      credit_name: "Environmental Product Declarations",
      points_possible: 2,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "EPD product count not provided.",
    });
  }

  // Sourcing of Raw Materials (2 points)
  if (materials?.sourcing_raw_materials_count != null) {
    let points = 0;
    let status: CreditStatus = "not_achieved";
    let notes = "";

    if (materials.sourcing_raw_materials_count >= 20) {
      points = 2;
      status = "achieved";
      notes = `${materials.sourcing_raw_materials_count} products meet raw material sourcing criteria. Full 2 points (>=20).`;
    } else if (materials.sourcing_raw_materials_count >= 10) {
      points = 1;
      status = "partial";
      notes = `${materials.sourcing_raw_materials_count} products meet raw material sourcing criteria. 1 point (>=10).`;
    } else {
      notes = `${materials.sourcing_raw_materials_count} products is below the 10-product sourcing threshold.`;
    }

    credits.push({
      category: "Materials & Resources",
      credit_name: "Sourcing of Raw Materials",
      points_possible: 2,
      points_achieved: points,
      status,
      notes,
    });
  } else {
    credits.push({
      category: "Materials & Resources",
      credit_name: "Sourcing of Raw Materials",
      points_possible: 2,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Raw material sourcing data not provided.",
    });
  }

  // Material Ingredients (2 points)
  if (materials?.material_ingredients_count != null) {
    let points = 0;
    let status: CreditStatus = "not_achieved";
    let notes = "";

    if (materials.material_ingredients_count >= 20) {
      points = 2;
      status = "achieved";
      notes = `${materials.material_ingredients_count} products with ingredient reporting. Full 2 points (>=20).`;
    } else if (materials.material_ingredients_count >= 10) {
      points = 1;
      status = "partial";
      notes = `${materials.material_ingredients_count} products with ingredient reporting. 1 point (>=10).`;
    } else {
      notes = `${materials.material_ingredients_count} products with ingredient reporting is below the 10-product threshold.`;
    }

    credits.push({
      category: "Materials & Resources",
      credit_name: "Material Ingredients",
      points_possible: 2,
      points_achieved: points,
      status,
      notes,
    });
  } else {
    credits.push({
      category: "Materials & Resources",
      credit_name: "Material Ingredients",
      points_possible: 2,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Material ingredient reporting data not provided.",
    });
  }

  // Construction and Demolition Waste Management (2 points)
  if (materials?.construction_waste_diverted_percent != null) {
    let points = 0;
    let status: CreditStatus = "not_achieved";
    let notes = "";

    if (materials.construction_waste_diverted_percent >= 75) {
      points = 2;
      status = "achieved";
      notes = `${materials.construction_waste_diverted_percent}% construction waste diverted from landfill. Full 2 points (>=75%).`;
    } else if (materials.construction_waste_diverted_percent >= 50) {
      points = 1;
      status = "partial";
      notes = `${materials.construction_waste_diverted_percent}% construction waste diverted. 1 point (>=50%).`;
    } else {
      notes = `${materials.construction_waste_diverted_percent}% waste diversion is below the 50% threshold.`;
    }

    credits.push({
      category: "Materials & Resources",
      credit_name: "Construction and Demolition Waste Management",
      points_possible: 2,
      points_achieved: points,
      status,
      notes,
    });
  } else {
    credits.push({
      category: "Materials & Resources",
      credit_name: "Construction and Demolition Waste Management",
      points_possible: 2,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Construction waste diversion data not provided.",
    });
  }

  return credits;
}

function evaluateIndoorEnvironmentalQuality(indoor?: IndoorQualityData): CreditResult[] {
  const credits: CreditResult[] = [];

  // Enhanced Indoor Air Quality Strategies (2 points)
  if (indoor?.outdoor_air_monitoring != null || indoor?.increased_ventilation_percent != null) {
    let points = 0;
    let notes = "";
    const hasMonitoring = indoor.outdoor_air_monitoring === true;
    const hasIncreasedVent =
      indoor.increased_ventilation_percent != null && indoor.increased_ventilation_percent >= 30;

    if (hasMonitoring && hasIncreasedVent) {
      points = 2;
      notes = "Outdoor air monitoring and increased ventilation (>=30% above ASHRAE 62.1). Full 2 points.";
    } else if (hasMonitoring || hasIncreasedVent) {
      points = 1;
      notes = hasMonitoring
        ? "Outdoor air monitoring installed. 1 point. Consider increasing ventilation >=30% for additional point."
        : `Ventilation increased ${indoor.increased_ventilation_percent}% above ASHRAE 62.1. 1 point. Consider adding outdoor air monitoring.`;
    } else {
      notes = "Neither outdoor air monitoring nor sufficient ventilation increase provided.";
    }

    credits.push({
      category: "Indoor Environmental Quality",
      credit_name: "Enhanced Indoor Air Quality Strategies",
      points_possible: 2,
      points_achieved: points,
      status: points === 2 ? "achieved" : points > 0 ? "partial" : "not_achieved",
      notes,
    });
  } else {
    credits.push({
      category: "Indoor Environmental Quality",
      credit_name: "Enhanced Indoor Air Quality Strategies",
      points_possible: 2,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Indoor air quality strategy data not provided.",
    });
  }

  // Low-Emitting Materials (3 points)
  if (indoor?.low_emitting_materials != null) {
    credits.push({
      category: "Indoor Environmental Quality",
      credit_name: "Low-Emitting Materials",
      points_possible: 3,
      points_achieved: indoor.low_emitting_materials ? 3 : 0,
      status: indoor.low_emitting_materials ? "achieved" : "not_achieved",
      notes: indoor.low_emitting_materials
        ? "Low-emitting materials used for adhesives, sealants, paints, coatings, and flooring. Full 3 points."
        : "Low-emitting materials criteria not fully met.",
    });
  } else {
    credits.push({
      category: "Indoor Environmental Quality",
      credit_name: "Low-Emitting Materials",
      points_possible: 3,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Low-emitting materials data not provided.",
    });
  }

  // Construction Indoor Air Quality Management Plan (1 point)
  if (indoor?.construction_iaq_plan != null) {
    credits.push({
      category: "Indoor Environmental Quality",
      credit_name: "Construction IAQ Management Plan",
      points_possible: 1,
      points_achieved: indoor.construction_iaq_plan ? 1 : 0,
      status: indoor.construction_iaq_plan ? "achieved" : "not_achieved",
      notes: indoor.construction_iaq_plan
        ? "Construction IAQ management plan developed and implemented."
        : "No construction IAQ management plan in place.",
    });
  } else {
    credits.push({
      category: "Indoor Environmental Quality",
      credit_name: "Construction IAQ Management Plan",
      points_possible: 1,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Construction IAQ plan data not provided.",
    });
  }

  // Indoor Air Quality Assessment (2 points)
  credits.push({
    category: "Indoor Environmental Quality",
    credit_name: "Indoor Air Quality Assessment",
    points_possible: 2,
    points_achieved: 0,
    status: "not_evaluated",
    notes: "Requires post-construction IAQ testing data. Not evaluated from provided data.",
  });

  // Thermal Comfort (1 point)
  if (indoor?.thermal_comfort_ashrae_55 != null) {
    credits.push({
      category: "Indoor Environmental Quality",
      credit_name: "Thermal Comfort",
      points_possible: 1,
      points_achieved: indoor.thermal_comfort_ashrae_55 ? 1 : 0,
      status: indoor.thermal_comfort_ashrae_55 ? "achieved" : "not_achieved",
      notes: indoor.thermal_comfort_ashrae_55
        ? "Design meets ASHRAE Standard 55 thermal comfort requirements."
        : "Design does not meet ASHRAE Standard 55 requirements.",
    });
  } else {
    credits.push({
      category: "Indoor Environmental Quality",
      credit_name: "Thermal Comfort",
      points_possible: 1,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Thermal comfort compliance data not provided.",
    });
  }

  // Interior Lighting (2 points)
  credits.push({
    category: "Indoor Environmental Quality",
    credit_name: "Interior Lighting",
    points_possible: 2,
    points_achieved: 0,
    status: "not_evaluated",
    notes: "Requires lighting control and quality data. Not evaluated from provided data.",
  });

  // Daylight (3 points)
  if (indoor?.daylighting_percent != null) {
    let points = 0;
    let status: CreditStatus = "not_achieved";
    let notes = "";

    if (indoor.daylighting_percent >= 90) {
      points = 3;
      status = "achieved";
      notes = `${indoor.daylighting_percent}% of regularly occupied spaces have daylighting. Full 3 points (>=90%).`;
    } else if (indoor.daylighting_percent >= 75) {
      points = 2;
      status = "partial";
      notes = `${indoor.daylighting_percent}% of regularly occupied spaces have daylighting. 2 points (>=75%).`;
    } else if (indoor.daylighting_percent >= 55) {
      points = 1;
      status = "partial";
      notes = `${indoor.daylighting_percent}% of regularly occupied spaces have daylighting. 1 point (>=55%).`;
    } else {
      notes = `${indoor.daylighting_percent}% daylighting is below the 55% threshold.`;
    }

    credits.push({
      category: "Indoor Environmental Quality",
      credit_name: "Daylight",
      points_possible: 3,
      points_achieved: points,
      status,
      notes,
    });
  } else {
    credits.push({
      category: "Indoor Environmental Quality",
      credit_name: "Daylight",
      points_possible: 3,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Daylighting data not provided.",
    });
  }

  // Quality Views (1 point)
  if (indoor?.views_percent != null) {
    const achieved = indoor.views_percent >= 75;
    credits.push({
      category: "Indoor Environmental Quality",
      credit_name: "Quality Views",
      points_possible: 1,
      points_achieved: achieved ? 1 : 0,
      status: achieved ? "achieved" : "not_achieved",
      notes: achieved
        ? `${indoor.views_percent}% of regularly occupied spaces have direct outdoor views. Credit achieved (>=75%).`
        : `${indoor.views_percent}% with outdoor views is below the 75% threshold.`,
    });
  } else {
    credits.push({
      category: "Indoor Environmental Quality",
      credit_name: "Quality Views",
      points_possible: 1,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Views data not provided.",
    });
  }

  // Acoustic Performance (1 point)
  if (indoor?.acoustic_performance != null) {
    credits.push({
      category: "Indoor Environmental Quality",
      credit_name: "Acoustic Performance",
      points_possible: 1,
      points_achieved: indoor.acoustic_performance ? 1 : 0,
      status: indoor.acoustic_performance ? "achieved" : "not_achieved",
      notes: indoor.acoustic_performance
        ? "Acoustic performance criteria met per LEED requirements."
        : "Acoustic performance criteria not met.",
    });
  } else {
    credits.push({
      category: "Indoor Environmental Quality",
      credit_name: "Acoustic Performance",
      points_possible: 1,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Acoustic performance data not provided.",
    });
  }

  return credits;
}

function evaluateInnovation(innovation?: InnovationData): CreditResult[] {
  const credits: CreditResult[] = [];

  // Innovation credits (up to 5 points)
  if (innovation?.innovation_credits != null) {
    const innovPts = Math.min(5, Math.max(0, Math.round(innovation.innovation_credits)));
    credits.push({
      category: "Innovation",
      credit_name: "Innovation",
      points_possible: 5,
      points_achieved: innovPts,
      status: innovPts >= 5 ? "achieved" : innovPts > 0 ? "partial" : "not_achieved",
      notes: `${innovPts} innovation credit(s) claimed for innovative strategies or exemplary performance.`,
    });
  } else {
    credits.push({
      category: "Innovation",
      credit_name: "Innovation",
      points_possible: 5,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Innovation credits not specified.",
    });
  }

  // LEED AP (1 point)
  if (innovation?.leed_ap != null) {
    credits.push({
      category: "Innovation",
      credit_name: "LEED Accredited Professional",
      points_possible: 1,
      points_achieved: innovation.leed_ap ? 1 : 0,
      status: innovation.leed_ap ? "achieved" : "not_achieved",
      notes: innovation.leed_ap
        ? "LEED AP with specialty on project team. 1 point."
        : "No LEED AP with specialty on project team.",
    });
  } else {
    credits.push({
      category: "Innovation",
      credit_name: "LEED Accredited Professional",
      points_possible: 1,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "LEED AP data not provided.",
    });
  }

  return credits;
}

function evaluateRegionalPriority(): CreditResult[] {
  return [
    {
      category: "Regional Priority",
      credit_name: "Regional Priority Credits",
      points_possible: 4,
      points_achieved: 0,
      status: "not_evaluated",
      notes: "Regional priority credits depend on project zip code and are not evaluated from provided data. Up to 4 bonus points available.",
    },
  ];
}

// ─── Certification Level ─────────────────────────────────────────────────────

function determineCertificationLevel(totalPoints: number): CertificationLevel {
  if (totalPoints >= 80) return "Platinum";
  if (totalPoints >= 60) return "Gold";
  if (totalPoints >= 50) return "Silver";
  if (totalPoints >= 40) return "Certified";
  return "Not Certified";
}

// ─── Recommendation Generation ───────────────────────────────────────────────

function generateRecommendations(
  credits: CreditResult[],
  totalAchieved: number,
  certLevel: CertificationLevel,
): string[] {
  const recommendations: string[] = [];

  const notEvaluated = credits.filter((c) => c.status === "not_evaluated");
  const notAchieved = credits.filter((c) => c.status === "not_achieved");
  const partial = credits.filter((c) => c.status === "partial");

  // Next certification level targets
  const nextThresholds: Record<string, number> = {
    "Not Certified": 40,
    Certified: 50,
    Silver: 60,
    Gold: 80,
    Platinum: 110,
  };

  const nextTarget = nextThresholds[certLevel];
  if (nextTarget != null && totalAchieved < nextTarget) {
    const gap = nextTarget - totalAchieved;
    const nextLevel =
      certLevel === "Not Certified"
        ? "Certified"
        : certLevel === "Certified"
          ? "Silver"
          : certLevel === "Silver"
            ? "Gold"
            : certLevel === "Gold"
              ? "Platinum"
              : null;
    if (nextLevel) {
      recommendations.push(
        `You need ${gap} more point(s) to reach ${nextLevel} level (${nextTarget} points). Focus on high-value credits below.`,
      );
    }
  }

  // High-value unevaluated categories
  const unevaluatedPoints = notEvaluated.reduce((sum, c) => sum + c.points_possible, 0);
  if (unevaluatedPoints > 0) {
    recommendations.push(
      `${unevaluatedPoints} potential points across ${notEvaluated.length} credit(s) could not be evaluated due to missing data. Provide more detailed project data for a comprehensive assessment.`,
    );
  }

  // Energy optimization opportunity
  const energyCredit = credits.find((c) => c.credit_name === "Optimize Energy Performance");
  if (energyCredit && energyCredit.points_achieved < energyCredit.points_possible) {
    const remaining = energyCredit.points_possible - energyCredit.points_achieved;
    recommendations.push(
      `Energy optimization has ${remaining} more achievable points (up to 18 total). This is the highest-value single credit in LEED. Consider improved envelope, HVAC efficiency, or lighting upgrades.`,
    );
  }

  // Water efficiency opportunity
  const waterCredits = credits.filter((c) => c.category === "Water Efficiency");
  const waterNotAchieved = waterCredits.filter((c) => c.status === "not_achieved" || c.status === "not_evaluated");
  if (waterNotAchieved.length > 0) {
    const waterPotential = waterNotAchieved.reduce((sum, c) => sum + c.points_possible, 0);
    if (waterPotential > 0) {
      recommendations.push(
        `${waterPotential} potential Water Efficiency points remain. Low-flow fixtures and rainwater harvesting can improve indoor water reduction significantly.`,
      );
    }
  }

  // Materials opportunity
  const wasteCredit = credits.find((c) => c.credit_name === "Construction and Demolition Waste Management");
  if (wasteCredit && wasteCredit.status !== "achieved") {
    recommendations.push(
      "Implement a Construction & Demolition Waste Management plan targeting 75%+ diversion from landfill for full credit (2 points).",
    );
  }

  // Indoor quality opportunities
  const daylightCredit = credits.find((c) => c.credit_name === "Daylight");
  if (daylightCredit && daylightCredit.status !== "achieved" && daylightCredit.status !== "not_evaluated") {
    recommendations.push(
      "Increase daylighting to 90%+ of regularly occupied spaces through improved window placement, light shelves, or skylights for full Daylight credit (3 points).",
    );
  }

  const lowEmitCredit = credits.find((c) => c.credit_name === "Low-Emitting Materials");
  if (lowEmitCredit && lowEmitCredit.status !== "achieved") {
    recommendations.push(
      "Specify low-emitting materials for all adhesives, sealants, paints, coatings, and flooring to earn 3 points in Indoor Environmental Quality.",
    );
  }

  // Innovation opportunity
  const innovCredit = credits.find((c) => c.credit_name === "Innovation");
  if (innovCredit && innovCredit.points_achieved < 5) {
    recommendations.push(
      "Pursue Innovation credits through exemplary performance in existing credits or propose innovative sustainability strategies (up to 5 points).",
    );
  }

  // LEED AP
  const apCredit = credits.find((c) => c.credit_name === "LEED Accredited Professional");
  if (apCredit && apCredit.status !== "achieved") {
    recommendations.push(
      "Include a LEED AP with specialty on the project team for an easy 1-point credit under Innovation.",
    );
  }

  // Commissioning
  const commCredit = credits.find((c) => c.credit_name === "Enhanced Commissioning");
  if (commCredit && commCredit.points_achieved < 6) {
    recommendations.push(
      "Perform enhanced commissioning for up to 6 points in Energy & Atmosphere. This also ensures systems operate as designed.",
    );
  }

  return recommendations;
}

// ─── Main Execution ──────────────────────────────────────────────────────────

function runSustainabilityCheck(params: SustainabilityCheckParams): {
  rating_system: string;
  building_type: string;
  credits: CreditResult[];
  summary: {
    total_possible: number;
    total_achieved: number;
    total_partial: number;
    total_not_evaluated: number;
    certification_level: CertificationLevel;
  };
  recommendations: string[];
} {
  const { project_data } = params;
  const allCredits: CreditResult[] = [];

  // Evaluate all credit categories
  allCredits.push(...evaluateIntegrativeProcess());
  allCredits.push(...evaluateLocationTransportation(project_data.location));
  allCredits.push(...evaluateSustainableSites());
  allCredits.push(...evaluateWaterEfficiency(project_data.water));
  allCredits.push(...evaluateEnergyAtmosphere(project_data.energy));
  allCredits.push(...evaluateMaterialsResources(project_data.materials));
  allCredits.push(...evaluateIndoorEnvironmentalQuality(project_data.indoor_quality));
  allCredits.push(...evaluateInnovation(project_data.innovation));
  allCredits.push(...evaluateRegionalPriority());

  // Calculate summary
  const totalAchieved = allCredits.reduce((sum, c) => sum + c.points_achieved, 0);
  const totalPartial = allCredits.filter((c) => c.status === "partial").length;
  const totalNotEvaluated = allCredits.filter((c) => c.status === "not_evaluated").length;

  const certificationLevel = determineCertificationLevel(totalAchieved);

  const recommendations = generateRecommendations(allCredits, totalAchieved, certificationLevel);

  return {
    rating_system: params.rating_system,
    building_type: params.building_type,
    credits: allCredits,
    summary: {
      total_possible: 110,
      total_achieved: totalAchieved,
      total_partial: totalPartial,
      total_not_evaluated: totalNotEvaluated,
      certification_level: certificationLevel,
    },
    recommendations,
  };
}

// ─── Tool Definition ─────────────────────────────────────────────────────────

export function createSustainabilityCheckToolDefinition() {
  return {
    name: "sustainability_check",
    label: "Sustainability Check (LEED v4.1)",
    description:
      "Evaluate a building design against LEED v4.1 BD+C (Building Design and Construction) criteria. " +
      "Estimates achievable credits and certification level based on provided project data across " +
      "Location & Transportation, Sustainable Sites, Water Efficiency, Energy & Atmosphere, " +
      "Materials & Resources, Indoor Environmental Quality, Innovation, and Regional Priority categories.",
    parameters: {
      type: "object",
      properties: {
        rating_system: {
          type: "string",
          enum: ["leed_v4"],
          description: 'Rating system to evaluate against. Default: "leed_v4".',
          default: "leed_v4",
        },
        building_type: {
          type: "string",
          enum: ["new_construction", "core_shell", "schools", "healthcare"],
          description: "LEED building type classification.",
        },
        project_data: {
          type: "object",
          description: "Available design data organized by LEED category.",
          properties: {
            location: {
              type: "object",
              description: "Location and transportation data.",
              properties: {
                is_brownfield: { type: "boolean", description: "Whether the site is a brownfield." },
                transit_rides_per_day: {
                  type: "number",
                  description: "Number of transit rides per weekday within 1/4 mile.",
                },
                bicycle_storage_percent: {
                  type: "number",
                  description: "Percentage of regular building occupants with bicycle storage.",
                },
                preferred_parking_percent: {
                  type: "number",
                  description: "Percentage of parking spaces for LEV/carpool.",
                },
                reduced_parking: {
                  type: "boolean",
                  description: "Whether parking has been reduced below code minimum.",
                },
              },
            },
            water: {
              type: "object",
              description: "Water efficiency data.",
              properties: {
                indoor_water_reduction_percent: {
                  type: "number",
                  description: "Indoor water use reduction vs baseline (20% = prerequisite).",
                },
                outdoor_water_reduction_percent: {
                  type: "number",
                  description: "Outdoor water use reduction vs baseline.",
                },
                cooling_tower_optimization: {
                  type: "boolean",
                  description: "Whether cooling tower water optimization is implemented.",
                },
                water_metering: {
                  type: "boolean",
                  description: "Whether building-level water metering is installed.",
                },
              },
            },
            energy: {
              type: "object",
              description: "Energy and atmosphere data.",
              properties: {
                energy_cost_reduction_percent: {
                  type: "number",
                  description: "Energy cost reduction vs ASHRAE 90.1 baseline.",
                },
                on_site_renewable_percent: {
                  type: "number",
                  description: "Percentage of total energy from on-site renewable sources.",
                },
                commissioning_performed: {
                  type: "boolean",
                  description: "Whether fundamental commissioning has been performed (prerequisite).",
                },
                enhanced_commissioning: {
                  type: "boolean",
                  description: "Whether enhanced commissioning has been performed.",
                },
                energy_metering: {
                  type: "boolean",
                  description: "Whether advanced energy metering is installed.",
                },
                refrigerant_management: {
                  type: "boolean",
                  description: "Whether refrigerant management plan is in place.",
                },
                green_power_percent: {
                  type: "number",
                  description: "Percentage of energy from green power sources.",
                },
              },
            },
            materials: {
              type: "object",
              description: "Materials and resources data.",
              properties: {
                recycled_content_percent: {
                  type: "number",
                  description: "Recycled content by cost.",
                },
                regional_materials_percent: {
                  type: "number",
                  description: "Regional materials within 500 miles by cost.",
                },
                fsc_certified_wood_percent: {
                  type: "number",
                  description: "Percentage of FSC certified wood.",
                },
                construction_waste_diverted_percent: {
                  type: "number",
                  description: "Percentage of construction waste diverted from landfill.",
                },
                building_reuse_percent: {
                  type: "number",
                  description: "Percentage of existing building structure maintained.",
                },
                epd_products_count: {
                  type: "number",
                  description: "Number of products with Environmental Product Declarations.",
                },
                sourcing_raw_materials_count: {
                  type: "number",
                  description: "Number of products meeting raw material sourcing criteria.",
                },
                material_ingredients_count: {
                  type: "number",
                  description: "Number of products with ingredient reporting.",
                },
              },
            },
            indoor_quality: {
              type: "object",
              description: "Indoor environmental quality data.",
              properties: {
                no_smoking_policy: {
                  type: "boolean",
                  description: "Whether a no-smoking policy is in place (prerequisite).",
                },
                outdoor_air_monitoring: {
                  type: "boolean",
                  description: "Whether outdoor air delivery monitoring is installed.",
                },
                increased_ventilation_percent: {
                  type: "number",
                  description: "Ventilation increase percentage above ASHRAE 62.1.",
                },
                low_emitting_materials: {
                  type: "boolean",
                  description: "Whether low-emitting materials are used for adhesives, sealants, paints, and flooring.",
                },
                construction_iaq_plan: {
                  type: "boolean",
                  description: "Whether a construction IAQ management plan is implemented.",
                },
                thermal_comfort_ashrae_55: {
                  type: "boolean",
                  description: "Whether design meets ASHRAE Standard 55.",
                },
                daylighting_percent: {
                  type: "number",
                  description: "Percentage of regularly occupied spaces with daylighting.",
                },
                views_percent: {
                  type: "number",
                  description: "Percentage of regularly occupied spaces with direct outdoor views.",
                },
                acoustic_performance: {
                  type: "boolean",
                  description: "Whether acoustic performance criteria are met.",
                },
              },
            },
            innovation: {
              type: "object",
              description: "Innovation and design process data.",
              properties: {
                innovation_credits: {
                  type: "number",
                  description: "Number of innovation credits claimed (0-5).",
                },
                leed_ap: {
                  type: "boolean",
                  description: "Whether a LEED AP with specialty is on the project team.",
                },
              },
            },
          },
        },
      },
      required: ["building_type", "project_data"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details?: unknown;
    }> => {
      const params = (args ?? {}) as Record<string, unknown>;

      // ── Validate rating_system ──────────────────────────────────────────
      const ratingSystem = String(params.rating_system ?? "leed_v4");
      if (ratingSystem !== "leed_v4") {
        throw new Error('rating_system must be "leed_v4".');
      }

      // ── Validate building_type ──────────────────────────────────────────
      const validBuildingTypes = new Set<string>([
        "new_construction",
        "core_shell",
        "schools",
        "healthcare",
      ]);
      const buildingType = String(params.building_type ?? "");
      if (!validBuildingTypes.has(buildingType)) {
        throw new Error(
          `building_type is required and must be one of: ${[...validBuildingTypes].join(", ")}`,
        );
      }

      // ── Validate project_data ───────────────────────────────────────────
      if (!params.project_data || typeof params.project_data !== "object") {
        throw new Error("project_data is required and must be an object.");
      }

      const pd = params.project_data as Record<string, unknown>;

      // Parse location data
      let locationData: LocationData | undefined;
      if (pd.location && typeof pd.location === "object") {
        const loc = pd.location as Record<string, unknown>;
        locationData = {
          is_brownfield: typeof loc.is_brownfield === "boolean" ? loc.is_brownfield : undefined,
          transit_rides_per_day: typeof loc.transit_rides_per_day === "number" ? loc.transit_rides_per_day : undefined,
          bicycle_storage_percent: typeof loc.bicycle_storage_percent === "number" ? loc.bicycle_storage_percent : undefined,
          preferred_parking_percent: typeof loc.preferred_parking_percent === "number" ? loc.preferred_parking_percent : undefined,
          reduced_parking: typeof loc.reduced_parking === "boolean" ? loc.reduced_parking : undefined,
        };
      }

      // Parse water data
      let waterData: WaterData | undefined;
      if (pd.water && typeof pd.water === "object") {
        const w = pd.water as Record<string, unknown>;
        waterData = {
          indoor_water_reduction_percent: typeof w.indoor_water_reduction_percent === "number" ? w.indoor_water_reduction_percent : undefined,
          outdoor_water_reduction_percent: typeof w.outdoor_water_reduction_percent === "number" ? w.outdoor_water_reduction_percent : undefined,
          cooling_tower_optimization: typeof w.cooling_tower_optimization === "boolean" ? w.cooling_tower_optimization : undefined,
          water_metering: typeof w.water_metering === "boolean" ? w.water_metering : undefined,
        };
      }

      // Parse energy data
      let energyData: EnergyData | undefined;
      if (pd.energy && typeof pd.energy === "object") {
        const e = pd.energy as Record<string, unknown>;
        energyData = {
          energy_cost_reduction_percent: typeof e.energy_cost_reduction_percent === "number" ? e.energy_cost_reduction_percent : undefined,
          on_site_renewable_percent: typeof e.on_site_renewable_percent === "number" ? e.on_site_renewable_percent : undefined,
          commissioning_performed: typeof e.commissioning_performed === "boolean" ? e.commissioning_performed : undefined,
          enhanced_commissioning: typeof e.enhanced_commissioning === "boolean" ? e.enhanced_commissioning : undefined,
          energy_metering: typeof e.energy_metering === "boolean" ? e.energy_metering : undefined,
          refrigerant_management: typeof e.refrigerant_management === "boolean" ? e.refrigerant_management : undefined,
          green_power_percent: typeof e.green_power_percent === "number" ? e.green_power_percent : undefined,
        };
      }

      // Parse materials data
      let materialsData: MaterialsData | undefined;
      if (pd.materials && typeof pd.materials === "object") {
        const m = pd.materials as Record<string, unknown>;
        materialsData = {
          recycled_content_percent: typeof m.recycled_content_percent === "number" ? m.recycled_content_percent : undefined,
          regional_materials_percent: typeof m.regional_materials_percent === "number" ? m.regional_materials_percent : undefined,
          fsc_certified_wood_percent: typeof m.fsc_certified_wood_percent === "number" ? m.fsc_certified_wood_percent : undefined,
          construction_waste_diverted_percent: typeof m.construction_waste_diverted_percent === "number" ? m.construction_waste_diverted_percent : undefined,
          building_reuse_percent: typeof m.building_reuse_percent === "number" ? m.building_reuse_percent : undefined,
          epd_products_count: typeof m.epd_products_count === "number" ? m.epd_products_count : undefined,
          sourcing_raw_materials_count: typeof m.sourcing_raw_materials_count === "number" ? m.sourcing_raw_materials_count : undefined,
          material_ingredients_count: typeof m.material_ingredients_count === "number" ? m.material_ingredients_count : undefined,
        };
      }

      // Parse indoor quality data
      let indoorQualityData: IndoorQualityData | undefined;
      if (pd.indoor_quality && typeof pd.indoor_quality === "object") {
        const iq = pd.indoor_quality as Record<string, unknown>;
        indoorQualityData = {
          no_smoking_policy: typeof iq.no_smoking_policy === "boolean" ? iq.no_smoking_policy : undefined,
          outdoor_air_monitoring: typeof iq.outdoor_air_monitoring === "boolean" ? iq.outdoor_air_monitoring : undefined,
          increased_ventilation_percent: typeof iq.increased_ventilation_percent === "number" ? iq.increased_ventilation_percent : undefined,
          low_emitting_materials: typeof iq.low_emitting_materials === "boolean" ? iq.low_emitting_materials : undefined,
          construction_iaq_plan: typeof iq.construction_iaq_plan === "boolean" ? iq.construction_iaq_plan : undefined,
          thermal_comfort_ashrae_55: typeof iq.thermal_comfort_ashrae_55 === "boolean" ? iq.thermal_comfort_ashrae_55 : undefined,
          daylighting_percent: typeof iq.daylighting_percent === "number" ? iq.daylighting_percent : undefined,
          views_percent: typeof iq.views_percent === "number" ? iq.views_percent : undefined,
          acoustic_performance: typeof iq.acoustic_performance === "boolean" ? iq.acoustic_performance : undefined,
        };
      }

      // Parse innovation data
      let innovationData: InnovationData | undefined;
      if (pd.innovation && typeof pd.innovation === "object") {
        const inn = pd.innovation as Record<string, unknown>;
        innovationData = {
          innovation_credits: typeof inn.innovation_credits === "number" ? inn.innovation_credits : undefined,
          leed_ap: typeof inn.leed_ap === "boolean" ? inn.leed_ap : undefined,
        };
      }

      // ── Run evaluation ──────────────────────────────────────────────────
      const result = runSustainabilityCheck({
        rating_system: ratingSystem as RatingSystem,
        building_type: buildingType as LeedBuildingType,
        project_data: {
          location: locationData,
          water: waterData,
          energy: energyData,
          materials: materialsData,
          indoor_quality: indoorQualityData,
          innovation: innovationData,
        },
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: {
          rating_system: result.rating_system,
          building_type: result.building_type,
          certification_level: result.summary.certification_level,
          total_achieved: result.summary.total_achieved,
          total_possible: result.summary.total_possible,
        },
      };
    },
  };
}
