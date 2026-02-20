#!/usr/bin/env python3
"""
Model section script for openclaw-mini.

Generates 2D section cuts (horizontal or vertical) through 3D IFC or OBJ
models, producing SVG or DXF output with contour lines.

Receives JSON arguments on stdin, writes JSON results to stdout.
"""
import sys
import json
import os
import math


def main():
    args = json.loads(sys.stdin.read())

    file_path = args["file_path"]
    cut_plane = args["cut_plane"]
    output_path = args["output_path"]
    output_format = args.get("output_format", "svg").lower()
    include_below = args.get("include_below", True)

    if not os.path.isfile(file_path):
        print(json.dumps({"error": f"File not found: {file_path}"}))
        return

    abs_output = os.path.abspath(output_path)
    out_dir = os.path.dirname(abs_output)
    if out_dir and not os.path.exists(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    ext = os.path.splitext(file_path)[1].lower()

    # Load mesh
    mesh = _load_mesh(file_path, ext)
    if mesh is None:
        print(json.dumps({"error": "Failed to load 3D model as mesh."}))
        return

    # Perform section cut
    plane_type = cut_plane.get("type", "horizontal")

    if plane_type == "horizontal":
        height = float(cut_plane.get("height_m", 1.2))
        sections = _horizontal_section(mesh, height)
    elif plane_type == "vertical":
        position = float(cut_plane.get("position_m", 0.0))
        direction_deg = float(cut_plane.get("direction_deg", 0.0))
        sections = _vertical_section(mesh, position, direction_deg)
    else:
        print(json.dumps({"error": f"Unknown cut plane type: {plane_type}"}))
        return

    if not sections:
        print(json.dumps({
            "output_path": abs_output,
            "contour_segments": 0,
            "warning": "No intersections found at the specified cut plane.",
        }))
        return

    # Calculate bounding box of section lines
    all_points = []
    for seg in sections:
        all_points.extend(seg)

    import numpy as np
    pts_arr = np.array(all_points)
    bbox = {
        "min_x": float(pts_arr[:, 0].min()),
        "min_y": float(pts_arr[:, 1].min()),
        "max_x": float(pts_arr[:, 0].max()),
        "max_y": float(pts_arr[:, 1].max()),
    }

    # Output
    if output_format == "svg":
        _write_svg(sections, abs_output, bbox)
    elif output_format == "dxf":
        _write_dxf(sections, abs_output)
    else:
        print(json.dumps({"error": f"Unsupported output format: {output_format}"}))
        return

    file_size = os.path.getsize(abs_output) if os.path.isfile(abs_output) else 0

    result = {
        "output_path": abs_output,
        "contour_segments": len(sections),
        "bounding_box": bbox,
        "cut_plane": cut_plane,
        "file_size_bytes": file_size,
    }
    print(json.dumps(result))


def _load_mesh(file_path, ext):
    """Load a 3D model as a trimesh mesh."""
    import trimesh

    if ext == ".ifc":
        return _load_ifc_as_mesh(file_path)
    else:
        try:
            loaded = trimesh.load(file_path, force="mesh")
            if isinstance(loaded, trimesh.Trimesh):
                return loaded
            elif isinstance(loaded, trimesh.Scene):
                # Concatenate all meshes
                meshes = [
                    g for g in loaded.geometry.values()
                    if isinstance(g, trimesh.Trimesh)
                ]
                if meshes:
                    return trimesh.util.concatenate(meshes)
            return None
        except Exception:
            return None


def _load_ifc_as_mesh(file_path):
    """Load an IFC file and convert to a single trimesh mesh."""
    import ifcopenshell
    import ifcopenshell.geom
    import trimesh
    import numpy as np

    ifc_file = ifcopenshell.open(file_path)
    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)

    all_vertices = []
    all_faces = []
    offset = 0

    for product in ifc_file.by_type("IfcProduct"):
        if not product.Representation:
            continue
        try:
            shape = ifcopenshell.geom.create_shape(settings, product)
            verts = shape.geometry.verts
            faces = shape.geometry.faces

            n_v = len(verts) // 3
            for i in range(n_v):
                all_vertices.append([
                    verts[i * 3],
                    verts[i * 3 + 1],
                    verts[i * 3 + 2],
                ])

            n_f = len(faces) // 3
            for i in range(n_f):
                all_faces.append([
                    faces[i * 3] + offset,
                    faces[i * 3 + 1] + offset,
                    faces[i * 3 + 2] + offset,
                ])

            offset += n_v
        except Exception:
            continue

    if not all_vertices or not all_faces:
        return None

    return trimesh.Trimesh(
        vertices=np.array(all_vertices),
        faces=np.array(all_faces),
    )


def _horizontal_section(mesh, height):
    """Cut mesh with a horizontal plane at the given Z height."""
    import trimesh
    import numpy as np

    plane_origin = [0, 0, height]
    plane_normal = [0, 0, 1]

    try:
        lines = trimesh.intersections.mesh_plane(
            mesh,
            plane_normal=plane_normal,
            plane_origin=plane_origin,
        )
    except Exception:
        return []

    if lines is None or len(lines) == 0:
        return []

    # lines is (N, 2, 3) array -- pairs of 3D points
    # For horizontal section, project to XY plane
    segments = []
    for line in lines:
        p0 = [float(line[0][0]), float(line[0][1])]
        p1 = [float(line[1][0]), float(line[1][1])]
        segments.append([p0, p1])

    return segments


def _vertical_section(mesh, position, direction_deg):
    """Cut mesh with a vertical plane at the given position and direction."""
    import trimesh
    import numpy as np

    direction_rad = math.radians(direction_deg)
    # Normal is perpendicular to the cut direction in the XY plane
    # If direction is 0 (along X), normal is along Y
    # If direction is 90 (along Y), normal is along X
    nx = -math.sin(direction_rad)
    ny = math.cos(direction_rad)

    # Origin on the plane: offset along normal
    ox = position * nx
    oy = position * ny

    plane_origin = [ox, oy, 0]
    plane_normal = [nx, ny, 0]

    try:
        lines = trimesh.intersections.mesh_plane(
            mesh,
            plane_normal=plane_normal,
            plane_origin=plane_origin,
        )
    except Exception:
        return []

    if lines is None or len(lines) == 0:
        return []

    # For vertical section, project onto the cut plane
    # Create a 2D coordinate system on the plane:
    #   u = along the cut direction (dx, dy, 0)
    #   v = Z axis (0, 0, 1)
    dx = math.cos(direction_rad)
    dy = math.sin(direction_rad)

    segments = []
    for line in lines:
        pts_2d = []
        for pt in line:
            # Project to local 2D: u = dot(pt - origin, direction), v = pt.z
            rel = [pt[0] - ox, pt[1] - oy, pt[2]]
            u = rel[0] * dx + rel[1] * dy
            v = pt[2]
            pts_2d.append([float(u), float(v)])
        segments.append(pts_2d)

    return segments


def _write_svg(sections, output_path, bbox):
    """Write section lines as SVG."""
    margin = 20
    w = bbox["max_x"] - bbox["min_x"]
    h = bbox["max_y"] - bbox["min_y"]

    if w < 1e-6:
        w = 1.0
    if h < 1e-6:
        h = 1.0

    # Scale to fit in a reasonable SVG size (max 1000px)
    max_dim = max(w, h)
    scale = 800.0 / max_dim if max_dim > 0 else 1.0
    svg_w = w * scale + margin * 2
    svg_h = h * scale + margin * 2

    lines_out = []
    lines_out.append(f'<?xml version="1.0" encoding="UTF-8"?>')
    lines_out.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="0 0 {svg_w:.2f} {svg_h:.2f}" '
        f'width="{svg_w:.2f}" height="{svg_h:.2f}">'
    )
    lines_out.append(f'  <rect width="100%" height="100%" fill="white"/>')
    lines_out.append(f'  <g stroke="black" stroke-width="0.5" fill="none">')

    for seg in sections:
        if len(seg) >= 2:
            x1 = (seg[0][0] - bbox["min_x"]) * scale + margin
            y1 = svg_h - ((seg[0][1] - bbox["min_y"]) * scale + margin)  # flip Y
            x2 = (seg[1][0] - bbox["min_x"]) * scale + margin
            y2 = svg_h - ((seg[1][1] - bbox["min_y"]) * scale + margin)
            lines_out.append(
                f'    <line x1="{x1:.4f}" y1="{y1:.4f}" '
                f'x2="{x2:.4f}" y2="{y2:.4f}"/>'
            )

    lines_out.append(f'  </g>')
    lines_out.append(f'</svg>')

    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines_out))


def _write_dxf(sections, output_path):
    """Write section lines as DXF."""
    import ezdxf

    doc = ezdxf.new(dxfversion="R2010")
    msp = doc.modelspace()

    doc.layers.add("SECTION", color=7)

    for seg in sections:
        if len(seg) >= 2:
            msp.add_line(
                (seg[0][0], seg[0][1]),
                (seg[1][0], seg[1][1]),
                dxfattribs={"layer": "SECTION"},
            )

    doc.saveas(output_path)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
