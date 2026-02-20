#!/usr/bin/env python3
"""
Point cloud processing script for openclaw-mini.

Processes point cloud data (LAS/LAZ/PLY/E57) with operations including
info extraction, voxel downsampling, RANSAC plane segmentation,
Poisson surface reconstruction, and floor detection.

Receives JSON arguments on stdin, writes JSON results to stdout.
"""
import sys
import json
import os
import math


def main():
    args = json.loads(sys.stdin.read())

    file_path = args["file_path"]
    operation = args["operation"]
    output_path = args.get("output_path")
    voxel_size = args.get("downsample_voxel_size_m")
    plane_threshold = args.get("plane_distance_threshold_m", 0.02)

    if not os.path.isfile(file_path):
        print(json.dumps({"error": f"File not found: {file_path}"}))
        return

    ext = os.path.splitext(file_path)[1].lower()

    # Dispatch to operation handler
    handlers = {
        "info": op_info,
        "downsample": op_downsample,
        "segment_planes": op_segment_planes,
        "mesh": op_mesh,
        "extract_floors": op_extract_floors,
    }

    handler = handlers.get(operation)
    if handler is None:
        print(json.dumps({"error": f"Unknown operation: {operation}"}))
        return

    result = handler(
        file_path=file_path,
        ext=ext,
        output_path=output_path,
        voxel_size=voxel_size,
        plane_threshold=plane_threshold,
    )

    print(json.dumps(result))


# ─── File Loading Helpers ─────────────────────────────────────────────────────

def load_as_open3d(file_path, ext):
    """Load a point cloud file as an Open3D PointCloud."""
    import open3d as o3d
    import numpy as np

    if ext in (".las", ".laz"):
        return _load_las_as_o3d(file_path)
    elif ext == ".ply":
        return o3d.io.read_point_cloud(file_path)
    elif ext == ".e57":
        # open3d supports e57 in some builds
        try:
            return o3d.io.read_point_cloud(file_path)
        except Exception:
            return _load_e57_fallback(file_path)
    elif ext in (".xyz", ".xyzn", ".xyzrgb", ".pts", ".pcd"):
        return o3d.io.read_point_cloud(file_path)
    else:
        # Try generic load
        return o3d.io.read_point_cloud(file_path)


def _load_las_as_o3d(file_path):
    """Load LAS/LAZ via laspy and convert to Open3D PointCloud."""
    import laspy
    import open3d as o3d
    import numpy as np

    las = laspy.read(file_path)

    # Extract XYZ
    points = np.vstack((las.x, las.y, las.z)).transpose()
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(points)

    # Try to extract colors
    try:
        if hasattr(las, "red") and hasattr(las, "green") and hasattr(las, "blue"):
            red = np.array(las.red, dtype=np.float64)
            green = np.array(las.green, dtype=np.float64)
            blue = np.array(las.blue, dtype=np.float64)
            # Normalize: LAS colors can be 0-255 or 0-65535
            max_val = max(red.max(), green.max(), blue.max(), 1.0)
            if max_val > 255:
                max_val = 65535.0
            else:
                max_val = 255.0
            colors = np.vstack((
                red / max_val,
                green / max_val,
                blue / max_val,
            )).transpose()
            pcd.colors = o3d.utility.Vector3dVector(colors)
    except Exception:
        pass

    return pcd


def _load_e57_fallback(file_path):
    """Fallback E57 loader using pye57 if available."""
    try:
        import pye57
        import open3d as o3d
        import numpy as np

        e57 = pye57.E57(file_path)
        data = e57.read_scan(0)
        points = np.column_stack([
            data["cartesianX"],
            data["cartesianY"],
            data["cartesianZ"],
        ])
        pcd = o3d.geometry.PointCloud()
        pcd.points = o3d.utility.Vector3dVector(points)
        return pcd
    except ImportError:
        return None


# ─── Operations ───────────────────────────────────────────────────────────────

def op_info(file_path, ext, output_path, voxel_size, plane_threshold):
    """Extract point cloud file information."""
    import numpy as np

    file_size = os.path.getsize(file_path)
    result = {
        "file_path": os.path.abspath(file_path),
        "file_size_bytes": file_size,
        "file_extension": ext,
    }

    if ext in (".las", ".laz"):
        return _info_las(file_path, result)
    else:
        return _info_o3d(file_path, ext, result)


def _info_las(file_path, result):
    """Get info from LAS/LAZ file using laspy."""
    import laspy
    import numpy as np

    las = laspy.read(file_path)

    result["point_count"] = int(las.header.point_count)
    result["point_format"] = int(las.header.point_format.id)
    result["version"] = f"{las.header.version.major}.{las.header.version.minor}"

    # Bounds
    result["bounds"] = {
        "min_x": float(las.header.mins[0]),
        "min_y": float(las.header.mins[1]),
        "min_z": float(las.header.mins[2]),
        "max_x": float(las.header.maxs[0]),
        "max_y": float(las.header.maxs[1]),
        "max_z": float(las.header.maxs[2]),
    }

    # Scale and offset
    result["scale"] = list(las.header.scales)
    result["offset"] = list(las.header.offsets)

    # Check for color
    result["has_color"] = hasattr(las, "red") and hasattr(las, "green")

    # Check for intensity
    result["has_intensity"] = hasattr(las, "intensity")

    # Classification stats
    if hasattr(las, "classification"):
        classes, counts = np.unique(
            np.array(las.classification), return_counts=True
        )
        result["classifications"] = {
            int(c): int(n) for c, n in zip(classes, counts)
        }

    # Dimensions
    result["dimensions"] = {
        "width_m": float(las.header.maxs[0] - las.header.mins[0]),
        "depth_m": float(las.header.maxs[1] - las.header.mins[1]),
        "height_m": float(las.header.maxs[2] - las.header.mins[2]),
    }

    return result


def _info_o3d(file_path, ext, result):
    """Get info from a generic point cloud file using Open3D."""
    import open3d as o3d
    import numpy as np

    pcd = load_as_open3d(file_path, ext)
    if pcd is None:
        result["error"] = "Could not load point cloud"
        return result

    points = np.asarray(pcd.points)
    result["point_count"] = len(points)

    if len(points) > 0:
        result["bounds"] = {
            "min_x": float(points[:, 0].min()),
            "min_y": float(points[:, 1].min()),
            "min_z": float(points[:, 2].min()),
            "max_x": float(points[:, 0].max()),
            "max_y": float(points[:, 1].max()),
            "max_z": float(points[:, 2].max()),
        }
        result["dimensions"] = {
            "width_m": float(points[:, 0].max() - points[:, 0].min()),
            "depth_m": float(points[:, 1].max() - points[:, 1].min()),
            "height_m": float(points[:, 2].max() - points[:, 2].min()),
        }

    result["has_color"] = pcd.has_colors()
    result["has_normals"] = pcd.has_normals()

    return result


def op_downsample(file_path, ext, output_path, voxel_size, plane_threshold):
    """Voxel grid downsampling."""
    import open3d as o3d
    import numpy as np

    pcd = load_as_open3d(file_path, ext)
    if pcd is None:
        return {"error": "Could not load point cloud"}

    original_count = len(np.asarray(pcd.points))

    # Voxel downsampling
    downsampled = pcd.voxel_down_sample(voxel_size=voxel_size)
    new_count = len(np.asarray(downsampled.points))

    # Ensure output directory exists
    out_dir = os.path.dirname(os.path.abspath(output_path))
    if out_dir and not os.path.exists(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    abs_output = os.path.abspath(output_path)
    out_ext = os.path.splitext(output_path)[1].lower()

    if out_ext in (".las", ".laz"):
        _save_o3d_as_las(downsampled, abs_output)
    else:
        o3d.io.write_point_cloud(abs_output, downsampled)

    reduction = ((original_count - new_count) / original_count * 100) if original_count > 0 else 0

    return {
        "output_path": abs_output,
        "original_points": original_count,
        "downsampled_points": new_count,
        "reduction_percent": round(reduction, 2),
        "voxel_size_m": voxel_size,
        "file_size_bytes": os.path.getsize(abs_output) if os.path.isfile(abs_output) else 0,
    }


def op_segment_planes(file_path, ext, output_path, voxel_size, plane_threshold):
    """RANSAC-based plane segmentation to detect walls, floors, ceilings."""
    import open3d as o3d
    import numpy as np

    pcd = load_as_open3d(file_path, ext)
    if pcd is None:
        return {"error": "Could not load point cloud"}

    # Estimate normals if not present
    if not pcd.has_normals():
        pcd.estimate_normals(
            search_param=o3d.geometry.KDTreeSearchParamHybrid(
                radius=plane_threshold * 5, max_nn=30
            )
        )

    total_points = len(np.asarray(pcd.points))
    remaining = pcd
    planes = []
    max_planes = 10  # Limit number of planes to detect
    min_inliers = max(100, int(total_points * 0.01))  # At least 1% of points

    for i in range(max_planes):
        pts = np.asarray(remaining.points)
        if len(pts) < min_inliers:
            break

        # RANSAC plane segmentation
        plane_model, inlier_indices = remaining.segment_plane(
            distance_threshold=plane_threshold,
            ransac_n=3,
            num_iterations=1000,
        )

        if len(inlier_indices) < min_inliers:
            break

        a, b, c, d = plane_model
        normal = [float(a), float(b), float(c)]

        # Classify plane orientation
        abs_nz = abs(c)
        if abs_nz > 0.8:
            orientation = "horizontal"
            if c > 0:
                sub_type = "floor"
            else:
                sub_type = "ceiling"
        else:
            orientation = "vertical"
            sub_type = "wall"

        # Calculate centroid of inlier points
        inlier_cloud = remaining.select_by_index(inlier_indices)
        inlier_pts = np.asarray(inlier_cloud.points)
        centroid = inlier_pts.mean(axis=0).tolist()

        planes.append({
            "plane_index": i,
            "normal": normal,
            "d": float(d),
            "orientation": orientation,
            "sub_type": sub_type,
            "inlier_count": len(inlier_indices),
            "centroid": [round(c, 4) for c in centroid],
            "inlier_ratio": round(len(inlier_indices) / total_points, 4),
        })

        # Remove inlier points for next iteration
        remaining = remaining.select_by_index(inlier_indices, invert=True)

    # Optionally save segmented planes
    result = {
        "total_points": total_points,
        "planes": planes,
        "remaining_points": len(np.asarray(remaining.points)),
        "plane_distance_threshold_m": plane_threshold,
    }

    if output_path:
        abs_output = os.path.abspath(output_path)
        out_dir = os.path.dirname(abs_output)
        if out_dir and not os.path.exists(out_dir):
            os.makedirs(out_dir, exist_ok=True)
        # Save as JSON with plane info
        with open(abs_output, "w") as f:
            json.dump(result, f, indent=2)
        result["output_path"] = abs_output

    return result


def op_mesh(file_path, ext, output_path, voxel_size, plane_threshold):
    """Poisson surface reconstruction from point cloud."""
    import open3d as o3d
    import numpy as np

    pcd = load_as_open3d(file_path, ext)
    if pcd is None:
        return {"error": "Could not load point cloud"}

    # Estimate normals if not present
    if not pcd.has_normals():
        pcd.estimate_normals(
            search_param=o3d.geometry.KDTreeSearchParamHybrid(
                radius=0.1, max_nn=30
            )
        )
        # Orient normals consistently
        pcd.orient_normals_consistent_tangent_plane(k=15)

    # Poisson surface reconstruction
    mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
        pcd, depth=9, width=0, scale=1.1, linear_fit=False
    )

    # Remove low-density vertices (cleanup)
    densities_arr = np.asarray(densities)
    if len(densities_arr) > 0:
        threshold = np.quantile(densities_arr, 0.01)
        vertices_to_remove = densities_arr < threshold
        mesh.remove_vertices_by_mask(vertices_to_remove)

    # Ensure output directory
    abs_output = os.path.abspath(output_path)
    out_dir = os.path.dirname(abs_output)
    if out_dir and not os.path.exists(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    # Save mesh
    out_ext = os.path.splitext(output_path)[1].lower()
    if out_ext == ".obj":
        o3d.io.write_triangle_mesh(abs_output, mesh, write_vertex_normals=True)
    elif out_ext == ".ply":
        o3d.io.write_triangle_mesh(abs_output, mesh)
    elif out_ext == ".stl":
        o3d.io.write_triangle_mesh(abs_output, mesh)
    else:
        o3d.io.write_triangle_mesh(abs_output, mesh)

    vertices = np.asarray(mesh.vertices)
    triangles = np.asarray(mesh.triangles)

    return {
        "output_path": abs_output,
        "vertices": len(vertices),
        "triangles": len(triangles),
        "input_points": len(np.asarray(pcd.points)),
        "file_size_bytes": os.path.getsize(abs_output) if os.path.isfile(abs_output) else 0,
    }


def op_extract_floors(file_path, ext, output_path, voxel_size, plane_threshold):
    """Detect horizontal planes at different heights (floor levels)."""
    import open3d as o3d
    import numpy as np

    pcd = load_as_open3d(file_path, ext)
    if pcd is None:
        return {"error": "Could not load point cloud"}

    points = np.asarray(pcd.points)
    total_points = len(points)

    if total_points == 0:
        return {"error": "Point cloud is empty", "floors": []}

    # Estimate normals
    if not pcd.has_normals():
        pcd.estimate_normals(
            search_param=o3d.geometry.KDTreeSearchParamHybrid(
                radius=plane_threshold * 5, max_nn=30
            )
        )

    normals = np.asarray(pcd.normals)

    # Filter points with near-vertical normals (horizontal surfaces)
    # A horizontal plane has normal close to [0, 0, +/-1]
    nz_abs = np.abs(normals[:, 2])
    horizontal_mask = nz_abs > 0.8
    horizontal_indices = np.where(horizontal_mask)[0]

    if len(horizontal_indices) == 0:
        return {
            "total_points": total_points,
            "floors": [],
            "message": "No horizontal surfaces detected.",
        }

    horizontal_z = points[horizontal_indices, 2]

    # Cluster Z values to find distinct floor heights
    # Use histogram-based peak detection
    z_min = horizontal_z.min()
    z_max = horizontal_z.max()
    z_range = z_max - z_min

    if z_range < 0.1:
        # All at same height
        floors = [{
            "floor_index": 0,
            "height_m": round(float(np.median(horizontal_z)), 4),
            "point_count": len(horizontal_indices),
        }]
    else:
        # Create histogram with bins of ~10cm
        n_bins = max(10, int(z_range / 0.1))
        hist, bin_edges = np.histogram(horizontal_z, bins=n_bins)

        # Find peaks (local maxima with significant point count)
        min_peak_count = max(50, int(len(horizontal_indices) * 0.02))
        floors = []
        floor_idx = 0

        for i in range(len(hist)):
            if hist[i] < min_peak_count:
                continue

            # Check if this is a local maximum
            is_peak = True
            if i > 0 and hist[i - 1] > hist[i]:
                is_peak = False
            if i < len(hist) - 1 and hist[i + 1] > hist[i]:
                is_peak = False

            if is_peak or (i == 0 and hist[i] >= min_peak_count) or \
               (i == len(hist) - 1 and hist[i] >= min_peak_count):
                bin_center = (bin_edges[i] + bin_edges[i + 1]) / 2

                # Refine height using mean of points in this bin
                mask = (horizontal_z >= bin_edges[i]) & (horizontal_z < bin_edges[i + 1])
                if mask.sum() > 0:
                    refined_height = float(np.mean(horizontal_z[mask]))
                    point_count = int(mask.sum())

                    # Avoid duplicates (floors too close together)
                    if floors and abs(refined_height - floors[-1]["height_m"]) < 0.3:
                        # Merge with previous if this one has more points
                        if point_count > floors[-1]["point_count"]:
                            floors[-1]["height_m"] = round(refined_height, 4)
                            floors[-1]["point_count"] = point_count
                        continue

                    floors.append({
                        "floor_index": floor_idx,
                        "height_m": round(refined_height, 4),
                        "point_count": point_count,
                    })
                    floor_idx += 1

    # Sort floors by height
    floors.sort(key=lambda f: f["height_m"])
    for i, f in enumerate(floors):
        f["floor_index"] = i

    # Calculate floor-to-floor heights
    for i in range(1, len(floors)):
        floors[i]["floor_to_floor_m"] = round(
            floors[i]["height_m"] - floors[i - 1]["height_m"], 4
        )

    result = {
        "total_points": total_points,
        "horizontal_points": len(horizontal_indices),
        "floors": floors,
        "z_range_m": round(float(z_range), 4),
    }

    # Optionally save
    if output_path:
        abs_output = os.path.abspath(output_path)
        out_dir = os.path.dirname(abs_output)
        if out_dir and not os.path.exists(out_dir):
            os.makedirs(out_dir, exist_ok=True)
        with open(abs_output, "w") as f:
            json.dump(result, f, indent=2)
        result["output_path"] = abs_output

    return result


def _save_o3d_as_las(pcd, output_path):
    """Save an Open3D point cloud as LAS file via laspy."""
    import laspy
    import numpy as np

    points = np.asarray(pcd.points)

    # Create LAS file
    header = laspy.LasHeader(point_format=0, version="1.2")
    header.offsets = np.min(points, axis=0)
    header.scales = [0.001, 0.001, 0.001]

    las = laspy.LasData(header)
    las.x = points[:, 0]
    las.y = points[:, 1]
    las.z = points[:, 2]

    # Add colors if available
    if pcd.has_colors():
        colors = (np.asarray(pcd.colors) * 65535).astype(np.uint16)
        # Need point format 2 for color
        header = laspy.LasHeader(point_format=2, version="1.2")
        header.offsets = np.min(points, axis=0)
        header.scales = [0.001, 0.001, 0.001]
        las = laspy.LasData(header)
        las.x = points[:, 0]
        las.y = points[:, 1]
        las.z = points[:, 2]
        las.red = colors[:, 0]
        las.green = colors[:, 1]
        las.blue = colors[:, 2]

    las.write(output_path)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
