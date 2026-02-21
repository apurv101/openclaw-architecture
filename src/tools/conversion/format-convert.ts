/**
 * Format Convert tool for civilclaw.
 *
 * Converts between CAD/BIM/3D file formats.  Supported conversions include
 * IFC to OBJ/DXF, OBJ to glTF, STL to OBJ, DXF to SVG, and gbXML to JSON.
 *
 * Delegates to scripts/format_convert.py which dispatches to the appropriate
 * Python library (ifcopenshell, ezdxf, trimesh, xml.etree).
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
    timeout: 300_000, // 5 minutes for large conversions
  });
  return result;
}

// ---- Supported format mappings ----

const SUPPORTED_FORMATS = ["ifc", "dxf", "obj", "stl", "gltf", "glb", "gbxml", "svg"] as const;

const FORMAT_EXTENSIONS: Record<string, string> = {
  ifc: ".ifc",
  dxf: ".dxf",
  obj: ".obj",
  stl: ".stl",
  gltf: ".gltf",
  glb: ".glb",
  gbxml: ".gbxml",
  svg: ".svg",
};

function detectFormat(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  if (ext === "xml" || ext === "gbxml") return "gbxml";
  if (SUPPORTED_FORMATS.includes(ext as any)) return ext;
  return undefined;
}

// ---- Dependency requirements per conversion path ----

const CONVERSION_DEPS: Record<string, string[]> = {
  "ifc->obj": ["ifcopenshell"],
  "ifc->dxf": ["ifcopenshell", "ezdxf"],
  "obj->gltf": ["trimesh"],
  "obj->glb": ["trimesh"],
  "stl->obj": ["trimesh"],
  "stl->gltf": ["trimesh"],
  "stl->glb": ["trimesh"],
  "dxf->svg": ["ezdxf"],
  "gbxml->json": [],
  "gltf->obj": ["trimesh"],
  "glb->obj": ["trimesh"],
  "obj->stl": ["trimesh"],
};

// ---- Tool definition ----

export function createFormatConvertToolDefinition() {
  return {
    name: "format_convert",
    label: "Format Convert",
    description:
      "Convert between CAD, BIM, and 3D model file formats. Supported conversions: " +
      "IFC to OBJ, IFC to DXF (plan section), OBJ to glTF/GLB, STL to OBJ, " +
      "DXF to SVG, gbXML to JSON, glTF to OBJ, and more. " +
      "Automatically detects input/output formats from file extensions when not specified. " +
      "Requires Python 3 with format-specific packages (ifcopenshell, ezdxf, trimesh).",
    parameters: {
      type: "object",
      properties: {
        input_path: {
          type: "string",
          description: "Path to the input file to convert.",
        },
        output_path: {
          type: "string",
          description: "Path where the converted output file will be saved.",
        },
        input_format: {
          type: "string",
          enum: ["ifc", "dxf", "obj", "stl", "gltf", "glb", "gbxml", "svg"],
          description:
            "Input file format. If omitted, auto-detected from the file extension.",
        },
        output_format: {
          type: "string",
          enum: ["ifc", "dxf", "obj", "stl", "gltf", "glb", "gbxml", "svg", "json"],
          description:
            "Output file format. If omitted, auto-detected from the output file extension.",
        },
        options: {
          type: "object",
          description:
            "Format-specific conversion options. Examples:\n" +
            "  IFC to DXF: { section_height_m: 1.2 } - horizontal section cut height\n" +
            "  IFC to OBJ: { include_types: ['IfcWall', 'IfcSlab'] } - filter element types\n" +
            "  OBJ to glTF: { merge_meshes: true } - merge all meshes\n" +
            "  gbXML to JSON: { include_surfaces: true } - include surface geometry",
          properties: {
            section_height_m: {
              type: "number",
              description: "Section cut height in meters for IFC to DXF conversion.",
            },
            include_types: {
              type: "array",
              items: { type: "string" },
              description: "IFC entity types to include.",
            },
            merge_meshes: {
              type: "boolean",
              description: "Whether to merge all meshes into one.",
            },
            include_surfaces: {
              type: "boolean",
              description: "Whether to include surface geometry in gbXML output.",
            },
          },
        },
      },
      required: ["input_path", "output_path"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details?: unknown;
    }> => {
      const params = (args ?? {}) as Record<string, unknown>;
      const inputPath = String(params.input_path ?? "").trim();
      const outputPath = String(params.output_path ?? "").trim();

      if (!inputPath) {
        return { content: [{ type: "text", text: "Error: input_path is required." }] };
      }
      if (!outputPath) {
        return { content: [{ type: "text", text: "Error: output_path is required." }] };
      }

      // Detect formats
      const inputFormat = String(params.input_format ?? detectFormat(inputPath) ?? "").toLowerCase();
      const outputFormat = String(params.output_format ?? detectFormat(outputPath) ?? "").toLowerCase();

      if (!inputFormat) {
        return {
          content: [{ type: "text", text: "Error: Could not auto-detect input format. Please specify input_format." }],
        };
      }
      if (!outputFormat) {
        return {
          content: [{ type: "text", text: "Error: Could not auto-detect output format. Please specify output_format." }],
        };
      }

      // Check if conversion path is supported
      const convKey = `${inputFormat}->${outputFormat}`;
      const requiredDeps = CONVERSION_DEPS[convKey];
      if (requiredDeps === undefined) {
        const supported = Object.keys(CONVERSION_DEPS).join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Error: Conversion from '${inputFormat}' to '${outputFormat}' is not supported.\n` +
                `Supported conversions: ${supported}`,
            },
          ],
        };
      }

      // Check dependencies
      const missingDeps: string[] = [];
      for (const dep of requiredDeps) {
        if (!checkPythonDep(dep)) {
          missingDeps.push(dep);
        }
      }

      if (missingDeps.length > 0) {
        const installCmds = missingDeps.map((d) => `pip install ${d}`).join("\n");
        return {
          content: [
            {
              type: "text",
              text:
                `This conversion (${inputFormat} -> ${outputFormat}) requires the following Python packages:\n` +
                missingDeps.join(", ") +
                "\n\nInstall with:\n" +
                installCmds,
            },
          ],
        };
      }

      // Run conversion
      try {
        const options = (params.options ?? {}) as Record<string, unknown>;
        const raw = runPythonScript("format_convert.py", {
          input_path: inputPath,
          output_path: outputPath,
          input_format: inputFormat,
          output_format: outputFormat,
          options,
        });

        const result = JSON.parse(raw.trim());

        if (result.error) {
          return {
            content: [{ type: "text", text: `Format Convert error: ${result.error}` }],
          };
        }

        // Build summary
        const lines: string[] = [];
        lines.push(`Format Conversion Complete`);
        lines.push(`${inputFormat.toUpperCase()} -> ${outputFormat.toUpperCase()}`);
        lines.push(`Input: ${result.input_path || inputPath}`);
        lines.push(`Output: ${result.output_path || outputPath}`);
        if (result.elements_converted !== undefined) {
          lines.push(`Elements Converted: ${result.elements_converted}`);
        }
        if (result.vertices !== undefined) {
          lines.push(`Vertices: ${result.vertices}`);
        }
        if (result.faces !== undefined) {
          lines.push(`Faces: ${result.faces}`);
        }
        if (result.file_size_bytes !== undefined) {
          const sizeKb = (result.file_size_bytes / 1024).toFixed(1);
          lines.push(`Output Size: ${sizeKb} KB`);
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
          content: [{ type: "text", text: `Format Convert failed: ${msg}` }],
        };
      }
    },
  };
}
