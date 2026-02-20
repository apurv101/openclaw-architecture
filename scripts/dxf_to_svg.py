#!/usr/bin/env python3
"""
DXF to SVG conversion script for openclaw-mini.

Renders a DXF file as SVG using the ezdxf drawing addon.  Supports layer
filtering, scale control, and background colour configuration.

Receives JSON arguments on stdin, writes JSON results to stdout.
"""
import sys
import json
import os


def main():
    args = json.loads(sys.stdin.read())

    file_path = args["file_path"]
    output_path = args["output_path"]
    filter_layers = args.get("layers")
    scale = args.get("scale")
    background_color = args.get("background_color", "white")

    if not os.path.isfile(file_path):
        print(json.dumps({"error": f"File not found: {file_path}"}))
        return

    import ezdxf
    from ezdxf.addons.drawing import Frontend, RenderContext
    from ezdxf.addons.drawing.svg import SVGBackend
    from ezdxf.addons.drawing.config import Configuration, LinePolicy

    try:
        doc = ezdxf.readfile(file_path)
    except ezdxf.DXFError as exc:
        print(json.dumps({"error": f"Failed to read DXF: {exc}"}))
        return

    msp = doc.modelspace()

    # ---- Determine which layers to render ----
    layers_to_show = set()
    if filter_layers:
        layers_to_show = set(filter_layers)

    # ---- Configure rendering ----
    # Determine background
    bg = background_color.strip().lower()
    if bg in ("none", "transparent"):
        bg_color = "#ffffff"
    elif bg.startswith("#"):
        bg_color = bg
    else:
        # Try common colour names
        color_names = {
            "white": "#ffffff", "black": "#000000",
            "gray": "#808080", "grey": "#808080",
            "lightgray": "#d3d3d3", "lightgrey": "#d3d3d3",
        }
        bg_color = color_names.get(bg, "#ffffff")

    config = Configuration(
        line_policy=LinePolicy.ACCURATE,
        background_policy=ezdxf.addons.drawing.config.BackgroundPolicy.DEFAULT,
    )

    # ---- Set up SVG backend ----
    backend = SVGBackend()
    ctx = RenderContext(doc)

    # If we have layer filters, set non-selected layers as invisible
    if filter_layers:
        for layer in doc.layers:
            if layer.dxf.name not in layers_to_show:
                ctx.set_layer_properties_override(
                    layer.dxf.name,
                    {"is_visible": False},
                )

    frontend = Frontend(ctx, backend, config=config)

    # Render modelspace
    frontend.draw_layout(msp)

    # Finalize SVG
    svg_string = backend.get_string(bg_color)

    # Apply scale if provided
    if scale is not None and scale != 1.0:
        # Modify the SVG viewBox or add a transform
        # Simple approach: wrap content in a scale transform
        svg_string = _apply_scale_to_svg(svg_string, scale)

    # ---- Write output ----
    output_dir = os.path.dirname(os.path.abspath(output_path))
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    abs_path = os.path.abspath(output_path)
    with open(abs_path, "w", encoding="utf-8") as f:
        f.write(svg_string)

    file_size = os.path.getsize(abs_path)

    # Extract SVG dimensions from the string
    svg_width = None
    svg_height = None
    import re
    width_m = re.search(r'width="([^"]+)"', svg_string)
    height_m = re.search(r'height="([^"]+)"', svg_string)
    if width_m:
        svg_width = width_m.group(1)
    if height_m:
        svg_height = height_m.group(1)

    layers_rendered = len(layers_to_show) if filter_layers else len(list(doc.layers))

    result = {
        "output_path": abs_path,
        "input_path": os.path.abspath(file_path),
        "layers_rendered": layers_rendered,
        "svg_width": svg_width,
        "svg_height": svg_height,
        "background_color": background_color,
        "file_size_bytes": file_size,
    }
    print(json.dumps(result))


def _apply_scale_to_svg(svg_string, scale):
    """Apply a scale factor to an SVG by modifying the viewBox."""
    import re

    # Try to modify viewBox
    vb_match = re.search(
        r'viewBox="([0-9.eE+-]+)\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)"',
        svg_string,
    )
    if vb_match:
        x = float(vb_match.group(1))
        y = float(vb_match.group(2))
        w = float(vb_match.group(3))
        h = float(vb_match.group(4))
        # Adjust viewBox so larger scale = larger rendering
        new_w = w / scale
        new_h = h / scale
        new_x = x + (w - new_w) / 2
        new_y = y + (h - new_h) / 2
        old_vb = vb_match.group(0)
        new_vb = f'viewBox="{new_x} {new_y} {new_w} {new_h}"'
        svg_string = svg_string.replace(old_vb, new_vb, 1)

    # Also try to scale width/height attributes
    def scale_attr(match):
        val = float(match.group(1))
        unit = match.group(2) if match.group(2) else ""
        new_val = val * scale
        return f'{match.group(0).split("=")[0]}="{new_val}{unit}"'

    svg_string = re.sub(
        r'width="([0-9.]+)(px|mm|cm|in|pt|)?"',
        lambda m: f'width="{float(m.group(1)) * scale}{m.group(2) or ""}"',
        svg_string,
        count=1,
    )
    svg_string = re.sub(
        r'height="([0-9.]+)(px|mm|cm|in|pt|)?"',
        lambda m: f'height="{float(m.group(1)) * scale}{m.group(2) or ""}"',
        svg_string,
        count=1,
    )

    return svg_string


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
