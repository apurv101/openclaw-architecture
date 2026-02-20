/**
 * IFC Generate tool for openclaw-mini.
 *
 * Generates a new IFC/BIM file from a structured specification describing
 * a project, site, building, stories, spaces, walls, and openings.
 *
 * Delegates to scripts/ifc_generate.py for the actual ifcopenshell work.
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---- Python bridge helpers ----

function checkPythonDep(packageName: string): boolean {
  try {
    execSync(`python3 -c "import ${packageName}"`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function resolveScriptsDir(): string {
  try {
    const currentFile = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(currentFile), "../../../scripts");
  } catch {
    return path.resolve(__dirname, "../../scripts");
  }
}

function runPythonScript(scriptName: string, args: unknown): string {
  const scriptPath = path.join(resolveScriptsDir(), scriptName);
  const input = JSON.stringify(args);
  const result = execSync(`python3 "${scriptPath}"`, {
    input,
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: 120_000,
  });
  return result;
}

// ---- Tool definition ----

export function createIfcGenerateToolDefinition() {
  return {
    name: "ifc_generate",
    label: "IFC Generate",
    description:
      "Generate a new IFC (Industry Foundation Classes) BIM file from a structured specification. " +
      "Creates IfcProject, IfcSite, IfcBuilding, then for each story creates IfcBuildingStorey " +
      "and elements (IfcWall, IfcDoor, IfcWindow, IfcSlab) with proper geometric representations " +
      "(swept solid for walls, extruded area solid). " +
      "Supports IFC2X3 and IFC4 schemas. " +
      "Requires Python 3 with the ifcopenshell package.",
    parameters: {
      type: "object",
      properties: {
        specification: {
          type: "object",
          description:
            "Building specification object describing the project structure.",
          properties: {
            project_name: {
              type: "string",
              description: "Name of the IFC project. Default: 'New Project'.",
            },
            site_name: {
              type: "string",
              description: "Name of the site. Default: 'Default Site'.",
            },
            building_name: {
              type: "string",
              description: "Name of the building. Default: 'Default Building'.",
            },
            stories: {
              type: "array",
              description: "Array of building stories to create.",
              items: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                    description: "Story name (e.g. 'Ground Floor').",
                  },
                  elevation: {
                    type: "number",
                    description: "Story elevation in meters above ground. Default: 0.",
                  },
                  height: {
                    type: "number",
                    description: "Story height in meters. Default: 3.0.",
                  },
                  spaces: {
                    type: "array",
                    description: "Array of spaces (rooms) on this story.",
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string", description: "Space/room name." },
                        long_name: {
                          type: "string",
                          description: "Long descriptive name for the space.",
                        },
                        x: {
                          type: "number",
                          description: "X position in meters.",
                        },
                        y: {
                          type: "number",
                          description: "Y position in meters.",
                        },
                        width: {
                          type: "number",
                          description: "Width (X direction) in meters.",
                        },
                        depth: {
                          type: "number",
                          description: "Depth (Y direction) in meters.",
                        },
                      },
                      required: ["name", "width", "depth"],
                    },
                  },
                  walls: {
                    type: "array",
                    description: "Array of walls on this story.",
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string", description: "Wall name." },
                        start_x: { type: "number", description: "Start X in meters." },
                        start_y: { type: "number", description: "Start Y in meters." },
                        end_x: { type: "number", description: "End X in meters." },
                        end_y: { type: "number", description: "End Y in meters." },
                        height: {
                          type: "number",
                          description: "Wall height in meters. Default: story height.",
                        },
                        thickness: {
                          type: "number",
                          description: "Wall thickness in meters. Default: 0.2.",
                        },
                      },
                      required: ["start_x", "start_y", "end_x", "end_y"],
                    },
                  },
                  openings: {
                    type: "array",
                    description: "Array of openings (doors/windows) on this story.",
                    items: {
                      type: "object",
                      properties: {
                        type: {
                          type: "string",
                          enum: ["door", "window"],
                          description: "Opening type.",
                        },
                        name: { type: "string", description: "Opening name." },
                        wall_name: {
                          type: "string",
                          description: "Name of the wall this opening is in.",
                        },
                        offset: {
                          type: "number",
                          description:
                            "Offset along the wall from its start point in meters.",
                        },
                        width: {
                          type: "number",
                          description: "Opening width in meters.",
                        },
                        height: {
                          type: "number",
                          description: "Opening height in meters.",
                        },
                        sill_height: {
                          type: "number",
                          description:
                            "Height of sill above floor in meters (for windows). Default: 0.9.",
                        },
                      },
                      required: ["type", "width", "height"],
                    },
                  },
                  slabs: {
                    type: "array",
                    description: "Array of floor slabs on this story.",
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string", description: "Slab name." },
                        x: { type: "number", description: "X position in meters." },
                        y: { type: "number", description: "Y position in meters." },
                        width: { type: "number", description: "Width in meters." },
                        depth: { type: "number", description: "Depth in meters." },
                        thickness: {
                          type: "number",
                          description: "Slab thickness in meters. Default: 0.2.",
                        },
                      },
                      required: ["width", "depth"],
                    },
                  },
                },
                required: ["name"],
              },
            },
          },
          required: ["project_name", "stories"],
        },
        output_path: {
          type: "string",
          description: "File path where the generated IFC file will be saved.",
        },
        schema_version: {
          type: "string",
          enum: ["IFC2X3", "IFC4"],
          description: "IFC schema version to use. Default: 'IFC4'.",
        },
      },
      required: ["specification", "output_path"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details?: unknown;
    }> => {
      if (!checkPythonDep("ifcopenshell")) {
        return {
          content: [
            {
              type: "text",
              text:
                "This tool requires Python 3 with ifcopenshell installed.\n" +
                "Install with: pip install ifcopenshell\n\n" +
                "If you are using conda: conda install -c ifcopenshell ifcopenshell",
            },
          ],
        };
      }

      const params = (args ?? {}) as Record<string, unknown>;
      const specification = params.specification as Record<string, unknown> | undefined;
      if (!specification || typeof specification !== "object") {
        return {
          content: [
            {
              type: "text",
              text: "Error: specification is required and must be an object.",
            },
          ],
        };
      }

      const outputPath = String(params.output_path ?? "");
      if (!outputPath) {
        return {
          content: [{ type: "text", text: "Error: output_path is required." }],
        };
      }

      const schemaVersion = String(params.schema_version ?? "IFC4");
      if (!["IFC2X3", "IFC4"].includes(schemaVersion)) {
        return {
          content: [
            {
              type: "text",
              text: "Error: schema_version must be 'IFC2X3' or 'IFC4'.",
            },
          ],
        };
      }

      try {
        const raw = runPythonScript("ifc_generate.py", {
          specification,
          output_path: outputPath,
          schema_version: schemaVersion,
        });

        const result = JSON.parse(raw.trim());

        if (result.error) {
          return {
            content: [
              { type: "text", text: `IFC Generate error: ${result.error}` },
            ],
          };
        }

        const lines: string[] = [];
        lines.push(`IFC file generated successfully.`);
        lines.push(`Output: ${result.output_path ?? outputPath}`);
        lines.push(`Schema: ${result.schema_version ?? schemaVersion}`);
        if (result.project_name) {
          lines.push(`Project: ${result.project_name}`);
        }
        if (result.stories_created !== undefined) {
          lines.push(`Stories created: ${result.stories_created}`);
        }
        if (result.elements_created !== undefined) {
          lines.push(`Total elements created: ${result.elements_created}`);
        }
        if (result.element_summary) {
          lines.push("");
          lines.push("Elements:");
          for (const [type, count] of Object.entries(result.element_summary)) {
            lines.push(`  ${type}: ${count}`);
          }
        }

        return {
          content: [
            { type: "text", text: lines.join("\n") },
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
          details: result,
        };
      } catch (err: any) {
        const msg = err.stderr
          ? String(err.stderr).trim()
          : err.message ?? "Unknown error";
        return {
          content: [{ type: "text", text: `IFC Generate failed: ${msg}` }],
        };
      }
    },
  };
}
