#!/usr/bin/env python3
"""
IFC Parse - Parse IFC/BIM files using ifcopenshell.

Reads args from stdin (JSON), outputs result to stdout (JSON).

Supports three detail levels:
  - summary:       counts by type, building info, story names
  - full:          all elements with property sets
  - elements_only: element list with basic props (GlobalId, Name, type)

Optionally extracts bounding box geometry from element placements.
"""
import sys
import json
import os

import ifcopenshell
import ifcopenshell.util.element as element_util


def get_property_sets(element):
    """Extract all property sets and their values for an element."""
    psets = {}
    try:
        # ifcopenshell.util.element.get_psets works across IFC2X3 and IFC4
        raw_psets = element_util.get_psets(element)
        for pset_name, props in raw_psets.items():
            cleaned = {}
            for k, v in props.items():
                if k == "id":
                    continue
                # Convert non-serialisable types to strings
                if isinstance(v, (int, float, bool, str)) or v is None:
                    cleaned[k] = v
                else:
                    cleaned[k] = str(v)
            psets[pset_name] = cleaned
    except Exception:
        pass
    return psets


def get_bounding_box(element):
    """Try to extract a bounding box from an element's object placement."""
    try:
        placement = element.ObjectPlacement
        if placement is None:
            return None

        # Walk up the local placement chain to get world coordinates
        coords = [0.0, 0.0, 0.0]
        current = placement
        while current is not None and current.is_a("IfcLocalPlacement"):
            rel = current.RelativePlacement
            if rel is not None and rel.is_a("IfcAxis2Placement3D"):
                loc = rel.Location
                if loc is not None:
                    c = loc.Coordinates
                    coords[0] += c[0]
                    coords[1] += c[1]
                    coords[2] += c[2]
            current = getattr(current, "PlacementRelTo", None)

        return {"x": round(coords[0], 4), "y": round(coords[1], 4), "z": round(coords[2], 4)}
    except Exception:
        return None


def walk_spatial_hierarchy(ifc_file):
    """Walk the spatial hierarchy and return structured info."""
    hierarchy = {
        "project": None,
        "sites": [],
        "buildings": [],
        "stories": [],
        "spaces": [],
    }

    projects = ifc_file.by_type("IfcProject")
    if projects:
        p = projects[0]
        hierarchy["project"] = {
            "global_id": p.GlobalId,
            "name": p.Name,
            "description": getattr(p, "Description", None),
        }

    for site in ifc_file.by_type("IfcSite"):
        hierarchy["sites"].append({
            "global_id": site.GlobalId,
            "name": site.Name,
        })

    for building in ifc_file.by_type("IfcBuilding"):
        hierarchy["buildings"].append({
            "global_id": building.GlobalId,
            "name": building.Name,
        })

    for storey in ifc_file.by_type("IfcBuildingStorey"):
        elevation = None
        try:
            elevation = float(storey.Elevation) if storey.Elevation is not None else None
        except (TypeError, ValueError):
            pass
        hierarchy["stories"].append({
            "global_id": storey.GlobalId,
            "name": storey.Name,
            "elevation": elevation,
        })

    for space in ifc_file.by_type("IfcSpace"):
        hierarchy["spaces"].append({
            "global_id": space.GlobalId,
            "name": space.Name,
            "long_name": getattr(space, "LongName", None),
        })

    return hierarchy


def extract_element_info(element, include_geometry=False, include_psets=False):
    """Extract information from a single IFC element."""
    info = {
        "global_id": element.GlobalId,
        "ifc_type": element.is_a(),
        "name": element.Name,
        "description": getattr(element, "Description", None),
    }

    # Object type / predefined type
    obj_type = getattr(element, "ObjectType", None)
    if obj_type:
        info["object_type"] = obj_type

    predefined = getattr(element, "PredefinedType", None)
    if predefined:
        info["predefined_type"] = str(predefined)

    if include_psets:
        psets = get_property_sets(element)
        if psets:
            info["property_sets"] = psets

    if include_geometry:
        bbox = get_bounding_box(element)
        if bbox:
            info["placement"] = bbox

    return info


def parse_summary(ifc_file, element_types_filter=None, include_geometry=False):
    """Summary mode: counts by type, building info, story names."""
    hierarchy = walk_spatial_hierarchy(ifc_file)

    # Count elements by type
    element_counts = {}
    all_products = ifc_file.by_type("IfcProduct")

    for product in all_products:
        ifc_type = product.is_a()
        # Skip spatial structure elements from counts (they are in hierarchy)
        if ifc_type in ("IfcProject", "IfcSite", "IfcBuilding",
                        "IfcBuildingStorey", "IfcSpace"):
            continue
        if element_types_filter and ifc_type not in element_types_filter:
            continue
        element_counts[ifc_type] = element_counts.get(ifc_type, 0) + 1

    total = sum(element_counts.values())

    result = {
        "schema": ifc_file.schema,
        "project_name": hierarchy["project"]["name"] if hierarchy["project"] else None,
        "site_name": hierarchy["sites"][0]["name"] if hierarchy["sites"] else None,
        "building_name": hierarchy["buildings"][0]["name"] if hierarchy["buildings"] else None,
        "stories": [s["name"] for s in hierarchy["stories"]],
        "spaces_count": len(hierarchy["spaces"]),
        "element_counts": element_counts,
        "total_elements": total,
        "hierarchy": hierarchy,
    }

    return result


def parse_full(ifc_file, element_types_filter=None, include_geometry=False):
    """Full mode: all elements with property sets."""
    hierarchy = walk_spatial_hierarchy(ifc_file)
    elements = []

    all_products = ifc_file.by_type("IfcProduct")
    for product in all_products:
        ifc_type = product.is_a()
        if element_types_filter and ifc_type not in element_types_filter:
            continue
        info = extract_element_info(
            product,
            include_geometry=include_geometry,
            include_psets=True,
        )
        elements.append(info)

    # Count by type
    element_counts = {}
    for el in elements:
        t = el["ifc_type"]
        element_counts[t] = element_counts.get(t, 0) + 1

    return {
        "schema": ifc_file.schema,
        "project_name": hierarchy["project"]["name"] if hierarchy["project"] else None,
        "hierarchy": hierarchy,
        "element_counts": element_counts,
        "total_elements": len(elements),
        "elements": elements,
    }


def parse_elements_only(ifc_file, element_types_filter=None, include_geometry=False):
    """Elements only mode: element list with basic props."""
    elements = []

    all_products = ifc_file.by_type("IfcProduct")
    for product in all_products:
        ifc_type = product.is_a()
        if element_types_filter and ifc_type not in element_types_filter:
            continue
        info = extract_element_info(
            product,
            include_geometry=include_geometry,
            include_psets=False,
        )
        elements.append(info)

    element_counts = {}
    for el in elements:
        t = el["ifc_type"]
        element_counts[t] = element_counts.get(t, 0) + 1

    return {
        "schema": ifc_file.schema,
        "element_counts": element_counts,
        "total_elements": len(elements),
        "elements": elements,
    }


def main():
    args = json.loads(sys.stdin.read())

    file_path = args["file_path"]
    detail_level = args.get("detail_level", "summary")
    element_types = args.get("element_types", None)
    include_geometry = args.get("include_geometry", False)

    # Resolve relative paths
    if not os.path.isabs(file_path):
        file_path = os.path.abspath(file_path)

    if not os.path.isfile(file_path):
        print(json.dumps({"error": f"File not found: {file_path}"}))
        return

    ifc_file = ifcopenshell.open(file_path)

    # Convert element_types to a set for faster lookups
    element_types_filter = set(element_types) if element_types else None

    if detail_level == "summary":
        result = parse_summary(ifc_file, element_types_filter, include_geometry)
    elif detail_level == "full":
        result = parse_full(ifc_file, element_types_filter, include_geometry)
    elif detail_level == "elements_only":
        result = parse_elements_only(ifc_file, element_types_filter, include_geometry)
    else:
        result = {"error": f"Unknown detail_level: {detail_level}"}

    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
