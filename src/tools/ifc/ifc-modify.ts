/**
 * IFC Modify tool for openclaw-mini.
 *
 * Modifies an existing IFC/BIM file by applying a sequence of operations:
 * set property, add element, remove element, or set material.
 *
 * Delegates to scripts/ifc_modify.py for the actual ifcopenshell work.
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

export function createIfcModifyToolDefinition() {
  return {
    name: "ifc_modify",
    label: "IFC Modify",
    description:
      "Modify an existing IFC (Industry Foundation Classes) BIM file by applying a sequence of " +
      "operations. Supported actions: set_property (set/update property values on elements), " +
      "add_element (add new elements to the model), remove_element (remove elements by GlobalId), " +
      "set_material (assign or change material on elements). " +
      "Saves the modified file to a specified output path. " +
      "Requires Python 3 with the ifcopenshell package.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the input IFC file to modify.",
        },
        output_path: {
          type: "string",
          description:
            "Path where the modified IFC file will be saved. Can be the same as file_path to overwrite.",
        },
        operations: {
          type: "array",
          description: "Ordered list of modification operations to apply.",
          items: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: [
                  "set_property",
                  "add_element",
                  "remove_element",
                  "set_material",
                ],
                description:
                  "The type of modification to perform. " +
                  "'set_property' = set or update a property on a target element. " +
                  "'add_element' = add a new IFC element to the model. " +
                  "'remove_element' = remove an element by GlobalId. " +
                  "'set_material' = assign a material to an element.",
              },
              target: {
                type: "string",
                description:
                  "Target element identifier. For set_property, remove_element, and set_material: " +
                  "the GlobalId of the target element. For add_element: the GlobalId of the parent " +
                  "container (e.g. IfcBuildingStorey) or 'auto' to auto-detect.",
              },
              data: {
                type: "object",
                description:
                  "Operation-specific data. " +
                  "set_property: { pset_name: string, property_name: string, value: any }. " +
                  "add_element: { ifc_type: string, name: string, properties?: object }. " +
                  "remove_element: {} (no extra data needed). " +
                  "set_material: { material_name: string, category?: string }.",
              },
            },
            required: ["action", "target"],
          },
        },
      },
      required: ["file_path", "output_path", "operations"],
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
      const filePath = String(params.file_path ?? "");
      if (!filePath) {
        return {
          content: [{ type: "text", text: "Error: file_path is required." }],
        };
      }

      const outputPath = String(params.output_path ?? "");
      if (!outputPath) {
        return {
          content: [{ type: "text", text: "Error: output_path is required." }],
        };
      }

      const operations = params.operations;
      if (!Array.isArray(operations) || operations.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: operations must be a non-empty array.",
            },
          ],
        };
      }

      // Validate each operation
      const validActions = [
        "set_property",
        "add_element",
        "remove_element",
        "set_material",
      ];
      for (let i = 0; i < operations.length; i++) {
        const op = operations[i] as Record<string, unknown>;
        if (!validActions.includes(String(op.action ?? ""))) {
          return {
            content: [
              {
                type: "text",
                text: `Error: operations[${i}].action must be one of: ${validActions.join(", ")}.`,
              },
            ],
          };
        }
        if (!op.target) {
          return {
            content: [
              {
                type: "text",
                text: `Error: operations[${i}].target is required.`,
              },
            ],
          };
        }
      }

      try {
        const raw = runPythonScript("ifc_modify.py", {
          file_path: filePath,
          output_path: outputPath,
          operations,
        });

        const result = JSON.parse(raw.trim());

        if (result.error) {
          return {
            content: [
              { type: "text", text: `IFC Modify error: ${result.error}` },
            ],
          };
        }

        const lines: string[] = [];
        lines.push("IFC file modified successfully.");
        lines.push(`Input: ${filePath}`);
        lines.push(`Output: ${result.output_path ?? outputPath}`);
        lines.push(
          `Operations applied: ${result.operations_applied ?? operations.length}`,
        );

        if (result.operation_results && Array.isArray(result.operation_results)) {
          lines.push("");
          for (let i = 0; i < result.operation_results.length; i++) {
            const opResult = result.operation_results[i];
            const status = opResult.success ? "OK" : "FAILED";
            lines.push(
              `  [${i + 1}] ${opResult.action}: ${status}${opResult.message ? ` - ${opResult.message}` : ""}`,
            );
          }
        }

        if (result.warnings && result.warnings.length > 0) {
          lines.push("");
          lines.push("Warnings:");
          for (const w of result.warnings) {
            lines.push(`  - ${w}`);
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
          content: [{ type: "text", text: `IFC Modify failed: ${msg}` }],
        };
      }
    },
  };
}
