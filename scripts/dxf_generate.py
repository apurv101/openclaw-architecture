#!/usr/bin/env python3
"""
DXF Generate script for openclaw-mini.

Creates a new DXF file from a specification object describing layers and
entities.  Supports LINE, LWPOLYLINE, CIRCLE, ARC, TEXT, MTEXT, DIMENSION,
and HATCH entities with optional paper-space templates.

Receives JSON arguments on stdin, writes JSON results to stdout.
"""
import sys
import json
import os
import math


def main():
    args = json.loads(sys.stdin.read())

    specification = args["specification"]
    output_path = args["output_path"]
    units = args.get("units", "mm")
    template = args.get("template", "blank")

    import ezdxf
    from ezdxf.enums import TextEntityAlignment

    # ---- Units mapping ----
    units_map = {
        "in": 1, "ft": 2, "mm": 4, "cm": 5, "m": 6,
    }

    # ---- Create document ----
    doc = ezdxf.new(dxfversion="R2010")
    doc.header["$INSUNITS"] = units_map.get(units, 4)

    msp = doc.modelspace()

    # ---- Create layers ----
    layers_created = 0
    layer_defs = specification.get("layers", [])
    for layer_def in layer_defs:
        name = layer_def.get("name", "0")
        color = layer_def.get("color", 7)
        linetype = layer_def.get("linetype", "CONTINUOUS")
        lineweight = layer_def.get("lineweight", -1)

        # Ensure linetype is loaded
        if linetype.upper() != "CONTINUOUS":
            try:
                doc.linetypes.get(linetype)
            except ezdxf.DXFTableEntryError:
                # Try loading from standard linetypes
                try:
                    doc.linetypes.add(
                        linetype,
                        pattern=_get_linetype_pattern(linetype),
                        description=linetype,
                    )
                except Exception:
                    linetype = "CONTINUOUS"

        doc.layers.add(name, color=color, linetype=linetype)
        if lineweight >= 0:
            doc.layers.get(name).dxf.lineweight = lineweight
        layers_created += 1

    # ---- Add entities ----
    entity_defs = specification.get("entities", [])
    entities_created = 0
    entity_summary = {}

    for edef in entity_defs:
        etype = edef.get("type", "").upper()
        layer = edef.get("layer", "0")
        color = edef.get("color")

        # Common DXF attribs
        dxfattribs = {"layer": layer}
        if color is not None:
            dxfattribs["color"] = int(color)

        try:
            if etype == "LINE":
                start = _to_vec(edef.get("start", [0, 0]))
                end = _to_vec(edef.get("end", [0, 0]))
                msp.add_line(start, end, dxfattribs=dxfattribs)

            elif etype == "LWPOLYLINE":
                vertices = edef.get("vertices", [])
                closed = edef.get("closed", False)
                points = [tuple(v[:2]) for v in vertices]
                pline = msp.add_lwpolyline(points, dxfattribs=dxfattribs)
                if closed:
                    pline.close()

            elif etype == "CIRCLE":
                center = _to_vec(edef.get("center", [0, 0]))
                radius = float(edef.get("radius", 1))
                dxfattribs["radius"] = radius
                msp.add_circle(center, radius, dxfattribs=dxfattribs)

            elif etype == "ARC":
                center = _to_vec(edef.get("center", [0, 0]))
                radius = float(edef.get("radius", 1))
                start_angle = float(edef.get("start_angle", 0))
                end_angle = float(edef.get("end_angle", 360))
                msp.add_arc(
                    center, radius, start_angle, end_angle,
                    dxfattribs=dxfattribs,
                )

            elif etype == "TEXT":
                position = _to_vec(edef.get("position", [0, 0]))
                text = str(edef.get("text", ""))
                height = float(edef.get("height", 2.5))
                rotation = float(edef.get("rotation", 0))
                dxfattribs["height"] = height
                dxfattribs["rotation"] = rotation
                t = msp.add_text(text, dxfattribs=dxfattribs)
                t.set_placement(position, align=TextEntityAlignment.LEFT)

            elif etype == "MTEXT":
                position = _to_vec(edef.get("position", [0, 0]))
                text = str(edef.get("text", ""))
                char_height = float(edef.get("height", 2.5))
                width = float(edef.get("width", 100))
                mt = msp.add_mtext(text, dxfattribs=dxfattribs)
                mt.dxf.insert = position
                mt.dxf.char_height = char_height
                mt.dxf.width = width

            elif etype == "DIMENSION":
                base = _to_vec(edef.get("base", [0, 0]))
                p1 = _to_vec(edef.get("p1", [0, 0]))
                p2 = _to_vec(edef.get("p2", [10, 0]))
                # Create a dimension style if not exists
                if "OPENCLAW" not in doc.dimstyles:
                    doc.dimstyles.new("OPENCLAW", dxfattribs={
                        "dimtxt": float(edef.get("text_height", 2.5)),
                        "dimasz": float(edef.get("arrow_size", 2.5)),
                    })
                dim = msp.add_linear_dim(
                    base=base,
                    p1=p1,
                    p2=p2,
                    dimstyle="OPENCLAW",
                    override=dxfattribs,
                )
                dim.render()

            elif etype == "HATCH":
                pattern = edef.get("pattern", "ANSI31")
                scale = float(edef.get("scale", 1.0))
                vertices = edef.get("vertices", [])
                if not vertices:
                    continue

                hatch = msp.add_hatch(color=dxfattribs.get("color", 7))
                hatch.dxf.layer = layer
                hatch.set_pattern_fill(pattern, scale=scale)

                # Add boundary path
                points = [(v[0], v[1]) for v in vertices]
                hatch.paths.add_polyline_path(points, is_closed=True)

            else:
                # Unknown entity type, skip
                continue

            entities_created += 1
            entity_summary[etype] = entity_summary.get(etype, 0) + 1

        except Exception as exc:
            entity_summary[f"{etype}_ERROR"] = entity_summary.get(f"{etype}_ERROR", 0) + 1
            # Continue with remaining entities

    # ---- Template: add title block border in paperspace ----
    if template != "blank":
        _add_template(doc, template, units)

    # ---- Save ----
    output_dir = os.path.dirname(os.path.abspath(output_path))
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    abs_path = os.path.abspath(output_path)
    doc.saveas(abs_path)

    file_size = os.path.getsize(abs_path)

    result = {
        "output_path": abs_path,
        "layers_created": layers_created,
        "entities_created": entities_created,
        "entity_summary": entity_summary,
        "units": units,
        "template": template,
        "file_size_bytes": file_size,
    }
    print(json.dumps(result))


def _to_vec(arr):
    """Convert a list to a 2D or 3D tuple."""
    if arr is None:
        return (0, 0, 0)
    if len(arr) >= 3:
        return (float(arr[0]), float(arr[1]), float(arr[2]))
    if len(arr) >= 2:
        return (float(arr[0]), float(arr[1]), 0)
    if len(arr) >= 1:
        return (float(arr[0]), 0, 0)
    return (0, 0, 0)


def _get_linetype_pattern(name):
    """Return a simple linetype pattern for common types."""
    patterns = {
        "DASHED": [0.75, 0.5, -0.25],
        "DASHDOT": [1.0, 0.5, -0.25, 0.0, -0.25],
        "CENTER": [1.25, 0.75, -0.25, 0.125, -0.25],
        "HIDDEN": [0.375, 0.25, -0.125],
        "PHANTOM": [1.75, 1.0, -0.25, 0.125, -0.25, 0.125, -0.25],
        "DOT": [0.25, 0.0, -0.25],
    }
    return patterns.get(name.upper(), [0.75, 0.5, -0.25])


def _add_template(doc, template, units):
    """Add a paperspace layout with a title block border."""
    import ezdxf

    # Template dimensions in mm
    templates = {
        "a1_landscape": {"width": 841, "height": 594, "name": "A1 Landscape"},
        "a3_landscape": {"width": 420, "height": 297, "name": "A3 Landscape"},
        "arch_d": {"width": 914, "height": 610, "name": "Arch D"},
    }

    tmpl = templates.get(template)
    if not tmpl:
        return

    w = tmpl["width"]
    h = tmpl["height"]
    margin = 10  # 10mm border margin

    # Create or get layout
    layout_name = tmpl["name"]
    try:
        layout = doc.layouts.new(layout_name)
    except ezdxf.DXFValueError:
        layout = doc.layouts.get(layout_name)

    # Ensure title block layer exists
    if "TITLE_BLOCK" not in doc.layers:
        doc.layers.add("TITLE_BLOCK", color=7)

    attribs = {"layer": "TITLE_BLOCK"}

    # Outer border
    layout.add_lwpolyline(
        [(margin, margin), (w - margin, margin),
         (w - margin, h - margin), (margin, h - margin)],
        close=True,
        dxfattribs=attribs,
    )

    # Title block box (bottom-right corner)
    tb_width = 180
    tb_height = 56
    tb_x = w - margin - tb_width
    tb_y = margin

    layout.add_lwpolyline(
        [(tb_x, tb_y), (tb_x + tb_width, tb_y),
         (tb_x + tb_width, tb_y + tb_height), (tb_x, tb_y + tb_height)],
        close=True,
        dxfattribs=attribs,
    )

    # Horizontal dividers in title block
    for dy in [14, 28, 42]:
        layout.add_line(
            (tb_x, tb_y + dy), (tb_x + tb_width, tb_y + dy),
            dxfattribs=attribs,
        )

    # Vertical divider
    layout.add_line(
        (tb_x + 60, tb_y), (tb_x + 60, tb_y + tb_height),
        dxfattribs=attribs,
    )

    # Title block labels
    label_attribs = {"layer": "TITLE_BLOCK", "height": 3.0}
    layout.add_text("TITLE:", dxfattribs={**label_attribs, "height": 2.5}).set_placement(
        (tb_x + 3, tb_y + 45)
    )
    layout.add_text("PROJECT:", dxfattribs={**label_attribs, "height": 2.5}).set_placement(
        (tb_x + 3, tb_y + 31)
    )
    layout.add_text("DATE:", dxfattribs={**label_attribs, "height": 2.5}).set_placement(
        (tb_x + 3, tb_y + 17)
    )
    layout.add_text("SCALE:", dxfattribs={**label_attribs, "height": 2.5}).set_placement(
        (tb_x + 3, tb_y + 3)
    )
    layout.add_text("DWG NO:", dxfattribs={**label_attribs, "height": 2.5}).set_placement(
        (tb_x + 63, tb_y + 45)
    )
    layout.add_text("REV:", dxfattribs={**label_attribs, "height": 2.5}).set_placement(
        (tb_x + 63, tb_y + 31)
    )
    layout.add_text("SHEET:", dxfattribs={**label_attribs, "height": 2.5}).set_placement(
        (tb_x + 63, tb_y + 17)
    )
    layout.add_text(f"({tmpl['name']})", dxfattribs={**label_attribs, "height": 2.0}).set_placement(
        (tb_x + 63, tb_y + 3)
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
