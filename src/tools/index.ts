/**
 * Barrel file — exports all tool definitions for civilclaw.
 *
 * Each tool follows the pattern: createXxxToolDefinition() → ToolDefinition
 */

// ─── Web ────────────────────────────────────────────────────────────────────
import { createWebFetchToolDefinition } from "./web-fetch.js";
import { createWebSearchToolDefinition } from "./web-search.js";

// ─── Structural ─────────────────────────────────────────────────────────────
import { createBeamAnalysisToolDefinition } from "./structural/beam-analysis.js";
import { createColumnCheckToolDefinition } from "./structural/column-check.js";
import { createSlabDesignToolDefinition } from "./structural/slab-design.js";
import { createFoundationDesignToolDefinition } from "./structural/foundation-design.js";

// ─── Cost ───────────────────────────────────────────────────────────────────
import { createCostEstimateToolDefinition } from "./cost/cost-estimate.js";
import { createQuantityTakeoffToolDefinition } from "./cost/quantity-takeoff.js";

// ─── Compliance ─────────────────────────────────────────────────────────────
import { createBuildingCodeCheckToolDefinition } from "./compliance/building-code-check.js";
import { createAdaCheckToolDefinition } from "./compliance/ada-check.js";
import { createSustainabilityCheckToolDefinition } from "./compliance/sustainability-check.js";
import { createZoningLookupToolDefinition } from "./compliance/zoning-lookup.js";

// ─── MEP ────────────────────────────────────────────────────────────────────
import { createHvacLoadToolDefinition } from "./mep/hvac-load.js";
import { createElectricalLoadToolDefinition } from "./mep/electrical-load.js";
import { createPlumbingFixtureToolDefinition } from "./mep/plumbing-fixture.js";

// ─── Energy ─────────────────────────────────────────────────────────────────
import { createEnergyModelToolDefinition } from "./energy/energy-model.js";
import { createDaylightAnalysisToolDefinition } from "./energy/daylight-analysis.js";

// ─── Floorplan ──────────────────────────────────────────────────────────────
import { createFloorplanGenerateToolDefinition } from "./floorplan/floorplan-generate.js";
import { createFloorplanAnalyzeToolDefinition } from "./floorplan/floorplan-analyze.js";

// ─── IFC / BIM ──────────────────────────────────────────────────────────────
import { createIfcParseToolDefinition } from "./ifc/ifc-parse.js";
import { createIfcGenerateToolDefinition } from "./ifc/ifc-generate.js";
import { createIfcModifyToolDefinition } from "./ifc/ifc-modify.js";
import { createIfcQueryToolDefinition } from "./ifc/ifc-query.js";
import { createIfcValidateToolDefinition } from "./ifc/ifc-validate.js";

// ─── DXF / CAD ──────────────────────────────────────────────────────────────
import { createDxfParseToolDefinition } from "./dxf/dxf-parse.js";
import { createDxfGenerateToolDefinition } from "./dxf/dxf-generate.js";
import { createDxfToSvgToolDefinition } from "./dxf/dxf-to-svg.js";

// ─── Conversion / 3D ────────────────────────────────────────────────────────
import { createFormatConvertToolDefinition } from "./conversion/format-convert.js";
import { createModelSectionToolDefinition } from "./conversion/model-section.js";
import { createPointCloudProcessToolDefinition } from "./conversion/point-cloud.js";

// ─── Documentation ──────────────────────────────────────────────────────────
import { createSpecWriterToolDefinition } from "./docs/spec-writer.js";
import { createScheduleGeneratorToolDefinition } from "./docs/schedule-generator.js";
import { createSubmittalLogToolDefinition } from "./docs/submittal-log.js";

// ─── Re-export all individual creators ──────────────────────────────────────
export {
  createWebFetchToolDefinition,
  createWebSearchToolDefinition,
  createBeamAnalysisToolDefinition,
  createColumnCheckToolDefinition,
  createSlabDesignToolDefinition,
  createFoundationDesignToolDefinition,
  createCostEstimateToolDefinition,
  createQuantityTakeoffToolDefinition,
  createBuildingCodeCheckToolDefinition,
  createAdaCheckToolDefinition,
  createSustainabilityCheckToolDefinition,
  createZoningLookupToolDefinition,
  createHvacLoadToolDefinition,
  createElectricalLoadToolDefinition,
  createPlumbingFixtureToolDefinition,
  createEnergyModelToolDefinition,
  createDaylightAnalysisToolDefinition,
  createFloorplanGenerateToolDefinition,
  createFloorplanAnalyzeToolDefinition,
  createIfcParseToolDefinition,
  createIfcGenerateToolDefinition,
  createIfcModifyToolDefinition,
  createIfcQueryToolDefinition,
  createIfcValidateToolDefinition,
  createDxfParseToolDefinition,
  createDxfGenerateToolDefinition,
  createDxfToSvgToolDefinition,
  createFormatConvertToolDefinition,
  createModelSectionToolDefinition,
  createPointCloudProcessToolDefinition,
  createSpecWriterToolDefinition,
  createScheduleGeneratorToolDefinition,
  createSubmittalLogToolDefinition,
};

// ─── Convenience: build all tools at once ───────────────────────────────────

export function createAllToolDefinitions() {
  return [
    // Web
    createWebFetchToolDefinition(),
    createWebSearchToolDefinition(),
    // Structural
    createBeamAnalysisToolDefinition(),
    createColumnCheckToolDefinition(),
    createSlabDesignToolDefinition(),
    createFoundationDesignToolDefinition(),
    // Cost
    createCostEstimateToolDefinition(),
    createQuantityTakeoffToolDefinition(),
    // Compliance
    createBuildingCodeCheckToolDefinition(),
    createAdaCheckToolDefinition(),
    createSustainabilityCheckToolDefinition(),
    createZoningLookupToolDefinition(),
    // MEP
    createHvacLoadToolDefinition(),
    createElectricalLoadToolDefinition(),
    createPlumbingFixtureToolDefinition(),
    // Energy
    createEnergyModelToolDefinition(),
    createDaylightAnalysisToolDefinition(),
    // Floorplan
    createFloorplanGenerateToolDefinition(),
    createFloorplanAnalyzeToolDefinition(),
    // IFC / BIM
    createIfcParseToolDefinition(),
    createIfcGenerateToolDefinition(),
    createIfcModifyToolDefinition(),
    createIfcQueryToolDefinition(),
    createIfcValidateToolDefinition(),
    // DXF / CAD
    createDxfParseToolDefinition(),
    createDxfGenerateToolDefinition(),
    createDxfToSvgToolDefinition(),
    // Conversion / 3D
    createFormatConvertToolDefinition(),
    createModelSectionToolDefinition(),
    createPointCloudProcessToolDefinition(),
    // Documentation
    createSpecWriterToolDefinition(),
    createScheduleGeneratorToolDefinition(),
    createSubmittalLogToolDefinition(),
  ];
}
