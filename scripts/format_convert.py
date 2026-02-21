#!/usr/bin/env python3
"""
Format conversion script for civilclaw.

Dispatches to the appropriate conversion routine based on input/output
format pairs.  Supports IFC, DXF, OBJ, STL, glTF/GLB, gbXML, and SVG.

Receives JSON arguments on stdin, writes JSON results to stdout.
"""
import sys
import json
import os


def main():
    args = json.loads(sys.stdin.read())

    input_path = args["input_path"]
    output_path = args["output_path"]
    input_format = args.get("input_format", "").lower()
    output_format = args.get("output_format", "").lower()
    options = args.get("options", {})

    if not os.path.isfile(input_path):
        print(json.dumps({"error": f"Input file not found: {input_path}"}))
        return

    # Ensure output directory exists
    out_dir = os.path.dirname(os.path.abspath(output_path))
    if out_dir and not os.path.exists(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    abs_output = os.path.abspath(output_path)
    abs_input = os.path.abspath(input_path)

    # Dispatch to conversion function
    conv_key = f"{input_format}->{output_format}"
    converters = {
        "ifc->obj": convert_ifc_to_obj,
        "ifc->dxf": convert_ifc_to_dxf,
        "obj->gltf": convert_mesh_to_mesh,
        "obj->glb": convert_mesh_to_mesh,
        "stl->obj": convert_mesh_to_mesh,
        "stl->gltf": convert_mesh_to_mesh,
        "stl->glb": convert_mesh_to_mesh,
        "gltf->obj": convert_mesh_to_mesh,
        "glb->obj": convert_mesh_to_mesh,
        "obj->stl": convert_mesh_to_mesh,
        "dxf->svg": convert_dxf_to_svg,
        "gbxml->json": convert_gbxml_to_json,
    }

    converter = converters.get(conv_key)
    if converter is None:
        print(json.dumps({"error": f"Unsupported conversion: {conv_key}"}))
        return

    result = converter(abs_input, abs_output, options)
    result["input_path"] = abs_input
    result["output_path"] = abs_output
    result["conversion"] = conv_key

    if os.path.isfile(abs_output):
        result["file_size_bytes"] = os.path.getsize(abs_output)

    print(json.dumps(result))


# ─── IFC -> OBJ ──────────────────────────────────────────────────────────────

def convert_ifc_to_obj(input_path, output_path, options):
    """Convert IFC to OBJ using ifcopenshell geometry processing."""
    import ifcopenshell
    import ifcopenshell.geom

    ifc_file = ifcopenshell.open(input_path)
    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)

    include_types = options.get("include_types")

    all_vertices = []
    all_faces = []
    vertex_offset = 0
    elements_converted = 0
    warnings = []

    # Get products to process
    products = ifc_file.by_type("IfcProduct")
    if include_types:
        type_set = set(include_types)
        products = [p for p in products if p.is_a() in type_set]

    for product in products:
        if not product.Representation:
            continue

        try:
            shape = ifcopenshell.geom.create_shape(settings, product)
            verts = shape.geometry.verts
            faces = shape.geometry.faces

            # verts is a flat list: [x1,y1,z1, x2,y2,z2, ...]
            n_verts = len(verts) // 3
            for i in range(n_verts):
                x = verts[i * 3]
                y = verts[i * 3 + 1]
                z = verts[i * 3 + 2]
                all_vertices.append((x, y, z))

            # faces is a flat list of triangle indices
            n_faces = len(faces) // 3
            for i in range(n_faces):
                f0 = faces[i * 3] + vertex_offset + 1  # OBJ is 1-indexed
                f1 = faces[i * 3 + 1] + vertex_offset + 1
                f2 = faces[i * 3 + 2] + vertex_offset + 1
                all_faces.append((f0, f1, f2))

            vertex_offset += n_verts
            elements_converted += 1

        except Exception as exc:
            warnings.append(f"Skipped {product.is_a()} #{product.id()}: {exc}")
            continue

    # Write OBJ
    with open(output_path, "w") as f:
        f.write(f"# Converted from IFC: {os.path.basename(input_path)}\n")
        f.write(f"# Elements: {elements_converted}\n\n")

        for v in all_vertices:
            f.write(f"v {v[0]:.6f} {v[1]:.6f} {v[2]:.6f}\n")

        f.write("\n")
        for face in all_faces:
            f.write(f"f {face[0]} {face[1]} {face[2]}\n")

    return {
        "elements_converted": elements_converted,
        "vertices": len(all_vertices),
        "faces": len(all_faces),
        "warnings": warnings,
    }


# ─── IFC -> DXF ──────────────────────────────────────────────────────────────

def convert_ifc_to_dxf(input_path, output_path, options):
    """Convert IFC to DXF plan view by sectioning at a given height."""
    import ifcopenshell
    import ifcopenshell.geom
    import ezdxf

    section_height = float(options.get("section_height_m", 1.2))
    include_types = options.get("include_types")

    ifc_file = ifcopenshell.open(input_path)
    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)

    doc = ezdxf.new(dxfversion="R2010")
    msp = doc.modelspace()

    products = ifc_file.by_type("IfcProduct")
    if include_types:
        type_set = set(include_types)
        products = [p for p in products if p.is_a() in type_set]

    elements_converted = 0
    warnings = []

    for product in products:
        if not product.Representation:
            continue

        try:
            shape = ifcopenshell.geom.create_shape(settings, product)
            verts = shape.geometry.verts
            faces = shape.geometry.faces

            n_verts = len(verts) // 3
            vertices = []
            for i in range(n_verts):
                vertices.append((
                    verts[i * 3],
                    verts[i * 3 + 1],
                    verts[i * 3 + 2],
                ))

            # Find triangles that intersect the section plane (z = section_height)
            n_faces = len(faces) // 3
            layer_name = product.is_a().replace("Ifc", "")

            if layer_name not in [l.dxf.name for l in doc.layers]:
                doc.layers.add(layer_name, color=7)

            for i in range(n_faces):
                i0, i1, i2 = faces[i * 3], faces[i * 3 + 1], faces[i * 3 + 2]
                v0, v1, v2 = vertices[i0], vertices[i1], vertices[i2]

                # Check if triangle intersects the plane z = section_height
                section_pts = _triangle_plane_intersection(
                    v0, v1, v2, section_height
                )
                if section_pts and len(section_pts) == 2:
                    p0, p1 = section_pts
                    msp.add_line(
                        (p0[0], p0[1]),
                        (p1[0], p1[1]),
                        dxfattribs={"layer": layer_name},
                    )

            elements_converted += 1

        except Exception as exc:
            warnings.append(f"Skipped {product.is_a()} #{product.id()}: {exc}")
            continue

    doc.saveas(output_path)

    return {
        "elements_converted": elements_converted,
        "section_height_m": section_height,
        "warnings": warnings,
    }


def _triangle_plane_intersection(v0, v1, v2, z_plane):
    """Find intersection of a triangle with a horizontal plane at z_plane."""
    edges = [(v0, v1), (v1, v2), (v2, v0)]
    intersection_points = []

    for a, b in edges:
        if (a[2] - z_plane) * (b[2] - z_plane) < 0:
            # Edge crosses the plane
            t = (z_plane - a[2]) / (b[2] - a[2])
            ix = a[0] + t * (b[0] - a[0])
            iy = a[1] + t * (b[1] - a[1])
            intersection_points.append((ix, iy))
        elif abs(a[2] - z_plane) < 1e-9:
            intersection_points.append((a[0], a[1]))

    # Remove duplicates
    unique = []
    for pt in intersection_points:
        is_dup = False
        for u in unique:
            if abs(pt[0] - u[0]) < 1e-9 and abs(pt[1] - u[1]) < 1e-9:
                is_dup = True
                break
        if not is_dup:
            unique.append(pt)

    return unique if len(unique) == 2 else None


# ─── Mesh-to-mesh (OBJ/STL/glTF) via trimesh ────────────────────────────────

def convert_mesh_to_mesh(input_path, output_path, options):
    """Convert between mesh formats using trimesh."""
    import trimesh

    merge = options.get("merge_meshes", False)

    # Load the mesh / scene
    loaded = trimesh.load(input_path, force="scene" if not merge else "mesh")

    warnings = []

    if isinstance(loaded, trimesh.Scene):
        if merge:
            # Merge all geometries into one mesh
            meshes = []
            for name, geom in loaded.geometry.items():
                if isinstance(geom, trimesh.Trimesh):
                    meshes.append(geom)
            if meshes:
                combined = trimesh.util.concatenate(meshes)
                combined.export(output_path)
                return {
                    "vertices": len(combined.vertices),
                    "faces": len(combined.faces),
                    "meshes_merged": len(meshes),
                    "warnings": warnings,
                }
            else:
                warnings.append("No meshes found in scene")
                return {"vertices": 0, "faces": 0, "warnings": warnings}
        else:
            loaded.export(output_path)
            total_v = sum(
                len(g.vertices) for g in loaded.geometry.values()
                if isinstance(g, trimesh.Trimesh)
            )
            total_f = sum(
                len(g.faces) for g in loaded.geometry.values()
                if isinstance(g, trimesh.Trimesh)
            )
            return {
                "vertices": total_v,
                "faces": total_f,
                "geometry_count": len(loaded.geometry),
                "warnings": warnings,
            }
    elif isinstance(loaded, trimesh.Trimesh):
        loaded.export(output_path)
        return {
            "vertices": len(loaded.vertices),
            "faces": len(loaded.faces),
            "warnings": warnings,
        }
    else:
        # Try forced mesh export
        try:
            mesh = trimesh.load(input_path, force="mesh")
            mesh.export(output_path)
            return {
                "vertices": len(mesh.vertices),
                "faces": len(mesh.faces),
                "warnings": warnings,
            }
        except Exception as exc:
            return {"error": f"Could not process mesh: {exc}", "warnings": warnings}


# ─── DXF -> SVG ──────────────────────────────────────────────────────────────

def convert_dxf_to_svg(input_path, output_path, options):
    """Convert DXF to SVG using ezdxf drawing addon."""
    import ezdxf
    from ezdxf.addons.drawing import Frontend, RenderContext
    from ezdxf.addons.drawing.svg import SVGBackend
    from ezdxf.addons.drawing.config import Configuration, LinePolicy

    doc = ezdxf.readfile(input_path)
    msp = doc.modelspace()

    config = Configuration(line_policy=LinePolicy.ACCURATE)
    backend = SVGBackend()
    ctx = RenderContext(doc)
    frontend = Frontend(ctx, backend, config=config)
    frontend.draw_layout(msp)

    bg_color = options.get("background_color", "#ffffff")
    svg_string = backend.get_string(bg_color)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(svg_string)

    return {
        "layers": len(list(doc.layers)),
        "warnings": [],
    }


# ─── gbXML -> JSON ───────────────────────────────────────────────────────────

def convert_gbxml_to_json(input_path, output_path, options):
    """Parse gbXML and extract building geometry data as JSON."""
    import xml.etree.ElementTree as ET

    include_surfaces = options.get("include_surfaces", True)

    tree = ET.parse(input_path)
    root = tree.getroot()

    # Handle namespace
    ns = ""
    if root.tag.startswith("{"):
        ns = root.tag.split("}")[0] + "}"

    result_data = {
        "source": os.path.basename(input_path),
        "buildings": [],
        "spaces": [],
        "surfaces": [],
        "constructions": [],
    }

    warnings = []

    # Extract buildings
    for building in root.iter(f"{ns}Building"):
        bdata = {
            "id": building.get("id", ""),
            "building_type": building.get("buildingType", ""),
        }
        # Area
        area_el = building.find(f"{ns}Area")
        if area_el is not None and area_el.text:
            bdata["area"] = float(area_el.text)
        result_data["buildings"].append(bdata)

    # Extract spaces
    for space in root.iter(f"{ns}Space"):
        sdata = {
            "id": space.get("id", ""),
            "name": space.get("name", space.get("id", "")),
        }
        area_el = space.find(f"{ns}Area")
        if area_el is not None and area_el.text:
            sdata["area"] = float(area_el.text)
        volume_el = space.find(f"{ns}Volume")
        if volume_el is not None and volume_el.text:
            sdata["volume"] = float(volume_el.text)
        result_data["spaces"].append(sdata)

    # Extract surfaces
    if include_surfaces:
        for surface in root.iter(f"{ns}Surface"):
            surf_data = {
                "id": surface.get("id", ""),
                "surface_type": surface.get("surfaceType", ""),
                "construction_id": surface.get("constructionIdRef", ""),
            }
            # Geometry
            planar = surface.find(f".//{ns}PlanarGeometry")
            if planar is not None:
                polyloop = planar.find(f".//{ns}PolyLoop")
                if polyloop is not None:
                    coords = []
                    for cp in polyloop.findall(f"{ns}CartesianPoint"):
                        xyz = []
                        for coord in cp.findall(f"{ns}Coordinate"):
                            if coord.text:
                                xyz.append(float(coord.text))
                        if xyz:
                            coords.append(xyz)
                    surf_data["vertices"] = coords
            # Adjacent spaces
            adj_spaces = []
            for adj in surface.findall(f"{ns}AdjacentSpaceId"):
                adj_spaces.append(adj.get("spaceIdRef", ""))
            surf_data["adjacent_spaces"] = adj_spaces
            result_data["surfaces"].append(surf_data)

    # Extract constructions
    for constr in root.iter(f"{ns}Construction"):
        cdata = {
            "id": constr.get("id", ""),
            "name": constr.get("name", constr.get("id", "")),
        }
        # U-value
        uval = constr.find(f"{ns}UValue")
        if uval is not None and uval.text:
            cdata["u_value"] = float(uval.text)
        # Layers
        layers = []
        for layer_el in constr.iter(f"{ns}LayerId"):
            layers.append(layer_el.get("layerIdRef", ""))
        cdata["layer_ids"] = layers
        result_data["constructions"].append(cdata)

    # Write JSON output
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result_data, f, indent=2)

    return {
        "buildings": len(result_data["buildings"]),
        "spaces": len(result_data["spaces"]),
        "surfaces": len(result_data["surfaces"]),
        "constructions": len(result_data["constructions"]),
        "warnings": warnings,
    }


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
