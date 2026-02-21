#!/usr/bin/env python3
"""
DXF Parse script for civilclaw.

Reads a DXF file using ezdxf and extracts layers, entities, blocks,
and geometric properties.  Receives JSON arguments on stdin and writes
JSON results to stdout.
"""
import sys
import json
import os


def main():
    args = json.loads(sys.stdin.read())

    file_path = args["file_path"]
    filter_layers = args.get("layers")
    filter_entity_types = args.get("entity_types")
    include_blocks = args.get("include_blocks", True)

    if not os.path.isfile(file_path):
        print(json.dumps({"error": f"File not found: {file_path}"}))
        return

    import ezdxf

    try:
        doc = ezdxf.readfile(file_path)
    except ezdxf.DXFError as exc:
        print(json.dumps({"error": f"Failed to read DXF: {exc}"}))
        return

    # ---- Header info ----
    result = {
        "file_path": file_path,
        "dxf_version": doc.dxfversion,
        "encoding": doc.encoding,
    }

    # Units (INSUNITS header variable)
    units_map = {
        0: "unitless", 1: "inches", 2: "feet", 3: "miles",
        4: "mm", 5: "cm", 6: "m", 7: "km",
        8: "microinches", 9: "mils", 10: "yards",
        11: "angstroms", 12: "nanometers", 13: "microns",
        14: "decimeters", 15: "decameters", 16: "hectometers",
        17: "gigameters", 18: "astronomical_units",
        19: "light_years", 20: "parsecs",
    }
    try:
        insunits = doc.header.get("$INSUNITS", 0)
        result["units"] = units_map.get(insunits, f"unknown({insunits})")
    except Exception:
        result["units"] = "unknown"

    # ---- Layers ----
    layers_out = []
    for layer in doc.layers:
        layers_out.append({
            "name": layer.dxf.name,
            "color": layer.dxf.color,
            "linetype": layer.dxf.linetype,
            "is_off": layer.is_off(),
            "is_frozen": layer.is_frozen(),
            "is_locked": layer.is_locked(),
        })
    result["layers"] = layers_out

    # ---- Filter helpers ----
    layer_set = set(filter_layers) if filter_layers else None
    entity_type_set = (
        set(t.upper() for t in filter_entity_types) if filter_entity_types else None
    )

    def passes_filter(entity):
        if layer_set and entity.dxf.layer not in layer_set:
            return False
        if entity_type_set and entity.dxftype().upper() not in entity_type_set:
            return False
        return True

    # ---- Extract entities from modelspace ----
    msp = doc.modelspace()
    entities_out = []
    entity_counts = {}
    extents_min_x = float("inf")
    extents_min_y = float("inf")
    extents_max_x = float("-inf")
    extents_max_y = float("-inf")

    def update_extents(x, y):
        nonlocal extents_min_x, extents_min_y, extents_max_x, extents_max_y
        if x < extents_min_x:
            extents_min_x = x
        if y < extents_min_y:
            extents_min_y = y
        if x > extents_max_x:
            extents_max_x = x
        if y > extents_max_y:
            extents_max_y = y

    for entity in msp:
        if not passes_filter(entity):
            continue

        etype = entity.dxftype()
        entity_counts[etype] = entity_counts.get(etype, 0) + 1

        edata = {
            "type": etype,
            "layer": entity.dxf.layer,
            "color": getattr(entity.dxf, "color", None),
            "handle": entity.dxf.handle,
        }

        try:
            if etype == "LINE":
                start = entity.dxf.start
                end = entity.dxf.end
                edata["start"] = [start.x, start.y, start.z]
                edata["end"] = [end.x, end.y, end.z]
                update_extents(start.x, start.y)
                update_extents(end.x, end.y)

            elif etype == "LWPOLYLINE":
                pts = list(entity.get_points(format="xyseb"))
                vertices = []
                for pt in pts:
                    vertices.append({
                        "x": pt[0], "y": pt[1],
                        "start_width": pt[2], "end_width": pt[3], "bulge": pt[4],
                    })
                    update_extents(pt[0], pt[1])
                edata["vertices"] = vertices
                edata["closed"] = entity.closed
                edata["count"] = len(vertices)

            elif etype == "POLYLINE":
                vertices = []
                for v in entity.vertices:
                    loc = v.dxf.location
                    vertices.append({"x": loc.x, "y": loc.y, "z": loc.z})
                    update_extents(loc.x, loc.y)
                edata["vertices"] = vertices
                edata["closed"] = entity.is_closed
                edata["count"] = len(vertices)

            elif etype == "CIRCLE":
                center = entity.dxf.center
                edata["center"] = [center.x, center.y, center.z]
                edata["radius"] = entity.dxf.radius
                update_extents(center.x - entity.dxf.radius, center.y - entity.dxf.radius)
                update_extents(center.x + entity.dxf.radius, center.y + entity.dxf.radius)

            elif etype == "ARC":
                center = entity.dxf.center
                edata["center"] = [center.x, center.y, center.z]
                edata["radius"] = entity.dxf.radius
                edata["start_angle"] = entity.dxf.start_angle
                edata["end_angle"] = entity.dxf.end_angle
                update_extents(center.x - entity.dxf.radius, center.y - entity.dxf.radius)
                update_extents(center.x + entity.dxf.radius, center.y + entity.dxf.radius)

            elif etype == "ELLIPSE":
                center = entity.dxf.center
                edata["center"] = [center.x, center.y, center.z]
                major = entity.dxf.major_axis
                edata["major_axis"] = [major.x, major.y, major.z]
                edata["ratio"] = entity.dxf.ratio
                edata["start_param"] = entity.dxf.start_param
                edata["end_param"] = entity.dxf.end_param
                update_extents(center.x, center.y)

            elif etype == "TEXT":
                insert = entity.dxf.insert
                edata["insert"] = [insert.x, insert.y, insert.z]
                edata["text"] = entity.dxf.text
                edata["height"] = entity.dxf.height
                edata["rotation"] = getattr(entity.dxf, "rotation", 0)
                update_extents(insert.x, insert.y)

            elif etype == "MTEXT":
                insert = entity.dxf.insert
                edata["insert"] = [insert.x, insert.y, insert.z]
                edata["text"] = entity.text  # plain text content
                edata["char_height"] = entity.dxf.char_height
                edata["width"] = getattr(entity.dxf, "width", None)
                update_extents(insert.x, insert.y)

            elif etype == "INSERT":
                insert_pt = entity.dxf.insert
                edata["insert"] = [insert_pt.x, insert_pt.y, insert_pt.z]
                edata["block_name"] = entity.dxf.name
                edata["xscale"] = getattr(entity.dxf, "xscale", 1.0)
                edata["yscale"] = getattr(entity.dxf, "yscale", 1.0)
                edata["rotation"] = getattr(entity.dxf, "rotation", 0.0)
                # Count attribs
                attribs = []
                if hasattr(entity, "attribs"):
                    for att in entity.attribs:
                        attribs.append({
                            "tag": att.dxf.tag,
                            "text": att.dxf.text,
                        })
                edata["attribs"] = attribs
                update_extents(insert_pt.x, insert_pt.y)

            elif etype == "DIMENSION":
                edata["dimtype"] = getattr(entity.dxf, "dimtype", None)
                if hasattr(entity.dxf, "defpoint"):
                    dp = entity.dxf.defpoint
                    edata["defpoint"] = [dp.x, dp.y, dp.z]
                if hasattr(entity.dxf, "defpoint2"):
                    dp2 = entity.dxf.defpoint2
                    edata["defpoint2"] = [dp2.x, dp2.y, dp2.z]
                if hasattr(entity.dxf, "defpoint3"):
                    dp3 = entity.dxf.defpoint3
                    edata["defpoint3"] = [dp3.x, dp3.y, dp3.z]
                edata["text_override"] = getattr(entity.dxf, "text", "")

            elif etype == "HATCH":
                edata["pattern_name"] = getattr(entity.dxf, "pattern_name", None)
                edata["solid_fill"] = getattr(entity.dxf, "solid_fill", None)
                paths = []
                for bp in entity.paths:
                    if hasattr(bp, "vertices"):
                        paths.append({
                            "type": "polyline",
                            "vertices": [[v[0], v[1]] for v in bp.vertices],
                            "is_closed": getattr(bp, "is_closed", True),
                        })
                    elif hasattr(bp, "edges"):
                        edges = []
                        for edge in bp.edges:
                            edges.append({"type": type(edge).__name__})
                        paths.append({"type": "edge", "edges": edges})
                edata["paths"] = paths

            elif etype == "SPLINE":
                edata["degree"] = entity.dxf.degree
                ctrl_pts = list(entity.control_points)
                edata["control_points"] = [[p.x, p.y, p.z] for p in ctrl_pts]
                fit_pts = list(entity.fit_points)
                edata["fit_points"] = [[p.x, p.y, p.z] for p in fit_pts]
                for pt in ctrl_pts:
                    update_extents(pt.x, pt.y)

            elif etype == "POINT":
                loc = entity.dxf.location
                edata["location"] = [loc.x, loc.y, loc.z]
                update_extents(loc.x, loc.y)

            elif etype == "SOLID" or etype == "3DFACE":
                pts = []
                for attr in ("vtx0", "vtx1", "vtx2", "vtx3"):
                    if hasattr(entity.dxf, attr):
                        v = getattr(entity.dxf, attr)
                        pts.append([v.x, v.y, v.z])
                        update_extents(v.x, v.y)
                edata["vertices"] = pts

        except Exception as exc:
            edata["parse_error"] = str(exc)

        entities_out.append(edata)

    result["entities"] = entities_out
    result["entity_counts"] = entity_counts
    result["total_entities"] = len(entities_out)

    # Extents
    if extents_min_x != float("inf"):
        result["extents"] = {
            "min_x": round(extents_min_x, 6),
            "min_y": round(extents_min_y, 6),
            "max_x": round(extents_max_x, 6),
            "max_y": round(extents_max_y, 6),
        }

    # ---- Blocks ----
    if include_blocks:
        blocks_out = []
        for block in doc.blocks:
            if block.name.startswith("*"):
                continue  # skip anonymous blocks
            block_entities = []
            for bentity in block:
                betype = bentity.dxftype()
                be_data = {
                    "type": betype,
                    "layer": bentity.dxf.layer,
                }
                # Add basic geometry for common types
                try:
                    if betype == "LINE":
                        s = bentity.dxf.start
                        e = bentity.dxf.end
                        be_data["start"] = [s.x, s.y, s.z]
                        be_data["end"] = [e.x, e.y, e.z]
                    elif betype == "LWPOLYLINE":
                        pts = list(bentity.get_points(format="xy"))
                        be_data["vertices"] = [[p[0], p[1]] for p in pts]
                        be_data["closed"] = bentity.closed
                    elif betype == "CIRCLE":
                        c = bentity.dxf.center
                        be_data["center"] = [c.x, c.y, c.z]
                        be_data["radius"] = bentity.dxf.radius
                    elif betype == "ARC":
                        c = bentity.dxf.center
                        be_data["center"] = [c.x, c.y, c.z]
                        be_data["radius"] = bentity.dxf.radius
                        be_data["start_angle"] = bentity.dxf.start_angle
                        be_data["end_angle"] = bentity.dxf.end_angle
                    elif betype == "TEXT":
                        be_data["text"] = bentity.dxf.text
                        ins = bentity.dxf.insert
                        be_data["insert"] = [ins.x, ins.y, ins.z]
                except Exception:
                    pass
                block_entities.append(be_data)

            blocks_out.append({
                "name": block.name,
                "base_point": list(block.base_point) if block.base_point else [0, 0, 0],
                "entity_count": len(block_entities),
                "entities": block_entities,
            })
        result["blocks"] = blocks_out

    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
