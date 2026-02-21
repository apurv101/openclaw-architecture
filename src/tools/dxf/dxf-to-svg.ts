/**
 * DXF to SVG conversion tool for civilclaw.
 *
 * Renders a DXF file as SVG using the ezdxf drawing addon (via Python).
 * Supports layer filtering, scaling, and background color options.
 *
 * Delegates to scripts/dxf_to_svg.py for the actual ezdxf rendering work.
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

export function createDxfToSvgToolDefinition() {
  return {
    name: "dxf_to_svg",
    label: "DXF to SVG",
    description:
      "Convert a DXF (Drawing Exchange Format) file to SVG using the ezdxf drawing addon. " +
      "Supports layer filtering to render only specific layers, custom scaling, and " +
      "background color configuration. Produces a standards-compliant SVG file. " +
      "Requires Python 3 with the ezdxf package (including the drawing addon).",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Absolute or relative path to the DXF file to convert.",
        },
        output_path: {
          type: "string",
          description: "File path where the SVG will be saved.",
        },
        layers: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of layer names to include in the rendering. " +
            "If omitted, all visible layers are rendered.",
        },
        scale: {
          type: "number",
          description:
            "Scale factor for the output SVG. 1.0 = actual size, 2.0 = double size. " +
            "If omitted, auto-fit is used.",
        },
        background_color: {
          type: "string",
          description:
            'Background color for the SVG (CSS color string). Default: "white". ' +
            'Use "none" for transparent, or "#000000" for dark background with light entities.',
        },
      },
      required: ["file_path", "output_path"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details?: unknown;
    }> => {
      // 1. Check Python + ezdxf availability
      if (!checkPythonDep("ezdxf")) {
        return {
          content: [
            {
              type: "text",
              text:
                "This tool requires Python 3 with ezdxf installed.\n" +
                "Install with: pip install ezdxf\n\n" +
                "The ezdxf drawing addon is used for SVG rendering.\n" +
                "If you also need matplotlib-based rendering, install: pip install matplotlib",
            },
          ],
        };
      }

      // 2. Validate args
      const params = (args ?? {}) as Record<string, unknown>;
      const filePath = String(params.file_path ?? "");
      if (!filePath) {
        return {
          content: [{ type: "text", text: "Error: file_path is required." }],
        };
      }

      const outputPath = String(params.output_path ?? "").trim();
      if (!outputPath) {
        return {
          content: [{ type: "text", text: "Error: output_path is required." }],
        };
      }

      const layers = Array.isArray(params.layers)
        ? (params.layers as string[])
        : undefined;
      const scale =
        typeof params.scale === "number" && Number.isFinite(params.scale) && params.scale > 0
          ? params.scale
          : undefined;
      const backgroundColor = String(params.background_color ?? "white");

      // 3. Run Python script
      try {
        const raw = runPythonScript("dxf_to_svg.py", {
          file_path: filePath,
          output_path: outputPath,
          layers: layers ?? null,
          scale: scale ?? null,
          background_color: backgroundColor,
        });

        const result = JSON.parse(raw.trim());

        if (result.error) {
          return {
            content: [{ type: "text", text: `DXF to SVG error: ${result.error}` }],
          };
        }

        // Build summary
        const lines: string[] = [];
        lines.push(`DXF to SVG Conversion Complete`);
        lines.push(`Input: ${filePath}`);
        lines.push(`Output: ${result.output_path}`);
        if (result.layers_rendered !== undefined) {
          lines.push(`Layers Rendered: ${result.layers_rendered}`);
        }
        if (result.svg_width && result.svg_height) {
          lines.push(`SVG Dimensions: ${result.svg_width} x ${result.svg_height}`);
        }
        if (result.file_size_bytes !== undefined) {
          const sizeKb = (result.file_size_bytes / 1024).toFixed(1);
          lines.push(`File Size: ${sizeKb} KB`);
        }
        lines.push(`Background: ${backgroundColor}`);

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
          content: [{ type: "text", text: `DXF to SVG failed: ${msg}` }],
        };
      }
    },
  };
}
