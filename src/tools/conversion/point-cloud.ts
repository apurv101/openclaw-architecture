/**
 * Point Cloud Process tool for openclaw-mini.
 *
 * Processes point cloud data (LAS/LAZ/PLY/E57) with operations including
 * info extraction, voxel downsampling, RANSAC plane segmentation,
 * Poisson surface reconstruction, and floor detection.
 *
 * Delegates to scripts/point_cloud_process.py which uses laspy and open3d.
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
    timeout: 600_000, // 10 minutes for large point clouds
  });
  return result;
}

// ---- Tool definition ----

export function createPointCloudProcessToolDefinition() {
  return {
    name: "point_cloud_process",
    label: "Point Cloud Process",
    description:
      "Process point cloud data from LAS, LAZ, PLY, or E57 files. Supports operations: " +
      "'info' (file metadata, point count, bounds), " +
      "'downsample' (voxel grid downsampling), " +
      "'segment_planes' (RANSAC plane detection for walls/floors/ceilings), " +
      "'mesh' (Poisson surface reconstruction to triangle mesh), " +
      "'extract_floors' (detect horizontal planes at different heights). " +
      "Requires Python 3 with laspy (for LAS/LAZ) and open3d for processing.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the point cloud file (LAS, LAZ, PLY, or E57).",
        },
        operation: {
          type: "string",
          enum: ["info", "downsample", "segment_planes", "mesh", "extract_floors"],
          description:
            "Processing operation to perform.\n" +
            "  'info' - Extract header info, point count, bounds, file size.\n" +
            "  'downsample' - Voxel grid downsampling to reduce point count.\n" +
            "  'segment_planes' - RANSAC-based plane detection (walls, floors, ceilings).\n" +
            "  'mesh' - Poisson surface reconstruction to produce a triangle mesh.\n" +
            "  'extract_floors' - Detect horizontal planes at different heights (floor levels).",
        },
        output_path: {
          type: "string",
          description:
            "Path for output file (required for downsample, mesh operations). " +
            "Supported output formats: PLY, LAS, OBJ (for mesh).",
        },
        downsample_voxel_size_m: {
          type: "number",
          description:
            "Voxel size in meters for downsampling. Smaller = more points retained. " +
            "Typical values: 0.01 (1cm) to 0.1 (10cm). Required for 'downsample' operation.",
        },
        plane_distance_threshold_m: {
          type: "number",
          description:
            "Distance threshold in meters for RANSAC plane segmentation. " +
            "Points within this distance from a plane are considered inliers. " +
            "Default: 0.02 (2cm).",
        },
      },
      required: ["file_path", "operation"],
    },
    execute: async (
      _toolCallId: string,
      args: unknown,
    ): Promise<{
      content: Array<{ type: string; text: string }>;
      details?: unknown;
    }> => {
      const params = (args ?? {}) as Record<string, unknown>;
      const filePath = String(params.file_path ?? "").trim();
      if (!filePath) {
        return { content: [{ type: "text", text: "Error: file_path is required." }] };
      }

      const operation = String(params.operation ?? "").toLowerCase();
      const validOps = ["info", "downsample", "segment_planes", "mesh", "extract_floors"];
      if (!validOps.includes(operation)) {
        return {
          content: [{ type: "text", text: `Error: operation must be one of: ${validOps.join(", ")}` }],
        };
      }

      const outputPath =
        typeof params.output_path === "string" ? params.output_path.trim() || undefined : undefined;
      const voxelSize =
        typeof params.downsample_voxel_size_m === "number" ? params.downsample_voxel_size_m : undefined;
      const planeThreshold =
        typeof params.plane_distance_threshold_m === "number"
          ? params.plane_distance_threshold_m
          : 0.02;

      // Check if output_path is needed
      if (["downsample", "mesh"].includes(operation) && !outputPath) {
        return {
          content: [{ type: "text", text: `Error: output_path is required for the '${operation}' operation.` }],
        };
      }

      if (operation === "downsample" && (voxelSize === undefined || voxelSize <= 0)) {
        return {
          content: [{ type: "text", text: "Error: downsample_voxel_size_m must be a positive number for downsample operation." }],
        };
      }

      // Check dependencies based on file extension
      const ext = path.extname(filePath).toLowerCase();
      const missingDeps: string[] = [];

      if ([".las", ".laz"].includes(ext)) {
        if (!checkPythonDep("laspy")) {
          missingDeps.push("laspy");
        }
      }

      if (!checkPythonDep("open3d")) {
        // Check for lighter alternative
        if (!checkPythonDep("numpy")) {
          missingDeps.push("numpy");
        }
        missingDeps.push("open3d");
      }

      if (!checkPythonDep("numpy")) {
        missingDeps.push("numpy");
      }

      // Deduplicate
      const uniqueDeps = [...new Set(missingDeps)];

      if (uniqueDeps.length > 0) {
        const installCmds = uniqueDeps.map((d) => `pip install ${d}`).join("\n");
        return {
          content: [
            {
              type: "text",
              text:
                `This tool requires the following Python packages:\n` +
                uniqueDeps.join(", ") +
                "\n\nInstall with:\n" +
                installCmds +
                "\n\nNote: For LAZ file support, also install: pip install laspy[lazrs]",
            },
          ],
        };
      }

      // Run processing script
      try {
        const raw = runPythonScript("point_cloud_process.py", {
          file_path: filePath,
          operation,
          output_path: outputPath ?? null,
          downsample_voxel_size_m: voxelSize ?? null,
          plane_distance_threshold_m: planeThreshold,
        });

        const result = JSON.parse(raw.trim());

        if (result.error) {
          return {
            content: [{ type: "text", text: `Point Cloud Process error: ${result.error}` }],
          };
        }

        // Build summary based on operation
        const lines: string[] = [];
        lines.push(`Point Cloud Processing: ${operation}`);
        lines.push(`Input: ${filePath}`);

        if (operation === "info") {
          if (result.point_count !== undefined) {
            lines.push(`Point Count: ${result.point_count.toLocaleString()}`);
          }
          if (result.bounds) {
            const b = result.bounds;
            lines.push(`Bounds X: [${b.min_x?.toFixed(3)}, ${b.max_x?.toFixed(3)}]`);
            lines.push(`Bounds Y: [${b.min_y?.toFixed(3)}, ${b.max_y?.toFixed(3)}]`);
            lines.push(`Bounds Z: [${b.min_z?.toFixed(3)}, ${b.max_z?.toFixed(3)}]`);
          }
          if (result.file_size_bytes !== undefined) {
            const sizeMb = (result.file_size_bytes / (1024 * 1024)).toFixed(2);
            lines.push(`File Size: ${sizeMb} MB`);
          }
          if (result.point_format !== undefined) {
            lines.push(`Point Format: ${result.point_format}`);
          }
          if (result.has_color !== undefined) {
            lines.push(`Has Color: ${result.has_color}`);
          }
          if (result.has_normals !== undefined) {
            lines.push(`Has Normals: ${result.has_normals}`);
          }
        } else if (operation === "downsample") {
          lines.push(`Output: ${result.output_path || outputPath}`);
          if (result.original_points !== undefined) {
            lines.push(`Original Points: ${result.original_points.toLocaleString()}`);
          }
          if (result.downsampled_points !== undefined) {
            lines.push(`Downsampled Points: ${result.downsampled_points.toLocaleString()}`);
          }
          if (result.reduction_percent !== undefined) {
            lines.push(`Reduction: ${result.reduction_percent.toFixed(1)}%`);
          }
          lines.push(`Voxel Size: ${voxelSize}m`);
        } else if (operation === "segment_planes") {
          if (result.planes && Array.isArray(result.planes)) {
            lines.push(`Planes Detected: ${result.planes.length}`);
            for (const plane of result.planes) {
              const orientation = plane.orientation || "unknown";
              const inliers = plane.inlier_count || 0;
              lines.push(
                `  Plane: ${orientation}, ${inliers} inliers, ` +
                `normal=[${plane.normal?.map((n: number) => n.toFixed(3)).join(", ")}]`
              );
            }
          }
        } else if (operation === "mesh") {
          lines.push(`Output: ${result.output_path || outputPath}`);
          if (result.vertices !== undefined) {
            lines.push(`Mesh Vertices: ${result.vertices.toLocaleString()}`);
          }
          if (result.triangles !== undefined) {
            lines.push(`Mesh Triangles: ${result.triangles.toLocaleString()}`);
          }
        } else if (operation === "extract_floors") {
          if (result.floors && Array.isArray(result.floors)) {
            lines.push(`Floors Detected: ${result.floors.length}`);
            for (const floor of result.floors) {
              lines.push(
                `  Floor at Z=${floor.height_m?.toFixed(3)}m, ${floor.point_count} points`
              );
            }
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
          content: [{ type: "text", text: `Point Cloud Process failed: ${msg}` }],
        };
      }
    },
  };
}
