#!/usr/bin/env python3
"""
IFC Query - Query/filter elements in IFC/BIM files using ifcopenshell.

Reads args from stdin (JSON), outputs result to stdout (JSON).

Supports query types:
  - by_type:           filter by IFC entity type (e.g. IfcWall)
  - by_material:       filter by material name (substring match)
  - by_property:       filter by property set value (PsetName.PropName=Value)
  - by_space:          filter by spatial containment (IfcSpace name)
  - by_classification: filter by classification reference
"""
import sys
import json
import os

import ifcopenshell
import ifcopenshell.util.element as element_util


def extract_element_info(element):
    """Extract basic information from an IFC element."""
    info = {
        "global_id": element.GlobalId,
        "ifc_type": element.is_a(),
        "name": element.Name,
        "description": getattr(element, "Description", None),
    }
    obj_type = getattr(element, "ObjectType", None)
    if obj_type:
        info["object_type"] = obj_type
    return info


def get_element_materials(element):
    """Get material names associated with an element."""
    materials = []
    try:
        mat = element_util.get_material(element)
        if mat is None:
            return materials

        if mat.is_a("IfcMaterial"):
            materials.append(mat.Name)
        elif mat.is_a("IfcMaterialLayerSetUsage") or mat.is_a("IfcMaterialLayerSet"):
            layer_set = mat if mat.is_a("IfcMaterialLayerSet") else mat.ForLayerSet
            if layer_set:
                for layer in layer_set.MaterialLayers:
                    if layer.Material:
                        materials.append(layer.Material.Name)
        elif mat.is_a("IfcMaterialConstituentSet"):
            for constituent in mat.MaterialConstituents or []:
                if constituent.Material:
                    materials.append(constituent.Material.Name)
        elif mat.is_a("IfcMaterialProfileSetUsage") or mat.is_a("IfcMaterialProfileSet"):
            profile_set = mat if mat.is_a("IfcMaterialProfileSet") else mat.ForProfileSet
            if profile_set:
                for profile in profile_set.MaterialProfiles or []:
                    if profile.Material:
                        materials.append(profile.Material.Name)
        elif mat.is_a("IfcMaterialList"):
            for m in mat.Materials or []:
                materials.append(m.Name)
    except Exception:
        pass
    return materials


def query_by_type(ifc_file, value, max_results):
    """Filter elements by IFC entity type."""
    elements = []
    total_scanned = 0

    try:
        products = ifc_file.by_type(value)
    except Exception:
        # If the type doesn't exist, try case-insensitive search
        products = []
        value_lower = value.lower()
        for product in ifc_file.by_type("IfcProduct"):
            if product.is_a().lower() == value_lower:
                products.append(product)

    total_scanned = len(products)

    for product in products[:max_results]:
        info = extract_element_info(product)
        # Include property sets for matched elements
        try:
            psets = element_util.get_psets(product)
            if psets:
                simplified = {}
                for pset_name, props in psets.items():
                    simplified[pset_name] = {
                        k: v for k, v in props.items()
                        if k != "id" and isinstance(v, (int, float, bool, str, type(None)))
                    }
                info["property_sets"] = simplified
        except Exception:
            pass
        elements.append(info)

    return {
        "elements": elements,
        "match_count": total_scanned,
        "total_scanned": total_scanned,
        "truncated": total_scanned > max_results,
    }


def query_by_material(ifc_file, value, max_results):
    """Filter elements by material name (substring match)."""
    elements = []
    total_scanned = 0
    value_lower = value.lower()

    for product in ifc_file.by_type("IfcProduct"):
        total_scanned += 1
        materials = get_element_materials(product)
        if any(value_lower in m.lower() for m in materials if m):
            info = extract_element_info(product)
            info["materials"] = materials
            elements.append(info)
            if len(elements) >= max_results:
                break

    return {
        "elements": elements,
        "match_count": len(elements),
        "total_scanned": total_scanned,
        "truncated": len(elements) >= max_results,
    }


def query_by_property(ifc_file, value, max_results):
    """Filter elements by property value.

    Value format: 'PsetName.PropertyName=Value' or 'PropertyName=Value'
    """
    elements = []
    total_scanned = 0

    # Parse the query value
    pset_filter = None
    prop_name = None
    prop_value = None

    if "=" in value:
        left, prop_value = value.split("=", 1)
        prop_value = prop_value.strip()
        if "." in left:
            pset_filter, prop_name = left.rsplit(".", 1)
            pset_filter = pset_filter.strip()
            prop_name = prop_name.strip()
        else:
            prop_name = left.strip()
    else:
        # Just a property name, match any value
        prop_name = value.strip()

    prop_name_lower = prop_name.lower() if prop_name else ""
    prop_value_lower = prop_value.lower() if prop_value else None
    pset_filter_lower = pset_filter.lower() if pset_filter else None

    for product in ifc_file.by_type("IfcProduct"):
        total_scanned += 1
        try:
            psets = element_util.get_psets(product)
        except Exception:
            continue

        matched = False
        matched_props = {}

        for pset_name, props in psets.items():
            if pset_filter_lower and pset_filter_lower not in pset_name.lower():
                continue
            for k, v in props.items():
                if k == "id":
                    continue
                if prop_name_lower and prop_name_lower not in k.lower():
                    continue
                if prop_value_lower is not None:
                    str_v = str(v).lower() if v is not None else ""
                    if prop_value_lower not in str_v:
                        continue
                matched = True
                matched_props[f"{pset_name}.{k}"] = v

        if matched:
            info = extract_element_info(product)
            info["matched_properties"] = {
                k: (v if isinstance(v, (int, float, bool, str, type(None))) else str(v))
                for k, v in matched_props.items()
            }
            elements.append(info)
            if len(elements) >= max_results:
                break

    return {
        "elements": elements,
        "match_count": len(elements),
        "total_scanned": total_scanned,
        "truncated": len(elements) >= max_results,
    }


def query_by_space(ifc_file, value, max_results):
    """Filter elements by spatial containment in an IfcSpace."""
    elements = []
    total_scanned = 0
    value_lower = value.lower()

    # Find matching spaces
    matching_spaces = []
    for space in ifc_file.by_type("IfcSpace"):
        name = space.Name or ""
        long_name = getattr(space, "LongName", "") or ""
        if value_lower in name.lower() or value_lower in long_name.lower():
            matching_spaces.append(space)

    if not matching_spaces:
        return {
            "elements": [],
            "match_count": 0,
            "total_scanned": 0,
            "truncated": False,
            "spaces_found": [],
        }

    # Collect elements contained in matching spaces
    space_names = []
    for space in matching_spaces:
        space_names.append(space.Name)
        # Get elements contained in this space via IfcRelContainedInSpatialStructure
        for rel in getattr(space, "ContainsElements", []):
            for product in rel.RelatedElements:
                total_scanned += 1
                info = extract_element_info(product)
                info["containing_space"] = space.Name
                elements.append(info)
                if len(elements) >= max_results:
                    break
            if len(elements) >= max_results:
                break
        if len(elements) >= max_results:
            break

    return {
        "elements": elements,
        "match_count": len(elements),
        "total_scanned": total_scanned,
        "truncated": len(elements) >= max_results,
        "spaces_found": space_names,
    }


def query_by_classification(ifc_file, value, max_results):
    """Filter elements by classification reference (e.g. OmniClass, UniFormat)."""
    elements = []
    total_scanned = 0
    value_lower = value.lower()

    # Find IfcRelAssociatesClassification relationships
    try:
        rels = ifc_file.by_type("IfcRelAssociatesClassification")
    except Exception:
        rels = []

    classified_elements = {}  # global_id -> classification info

    for rel in rels:
        classification_ref = rel.RelatingClassification
        if classification_ref is None:
            continue

        # Get classification reference details
        ref_name = getattr(classification_ref, "Name", "") or ""
        ref_id = getattr(classification_ref, "Identification",
                         getattr(classification_ref, "ItemReference", "")) or ""
        ref_source = ""
        source_obj = getattr(classification_ref, "ReferencedSource", None)
        if source_obj:
            ref_source = getattr(source_obj, "Name", "") or ""

        combined = f"{ref_id} {ref_name} {ref_source}".lower()
        if value_lower not in combined:
            continue

        classification_info = {
            "identification": ref_id,
            "name": ref_name,
            "source": ref_source,
        }

        for obj in rel.RelatedObjects:
            if hasattr(obj, "GlobalId"):
                classified_elements[obj.GlobalId] = classification_info

    # Now build the result
    total_scanned = len(classified_elements)
    for gid, cls_info in list(classified_elements.items())[:max_results]:
        try:
            element = ifc_file.by_guid(gid)
            info = extract_element_info(element)
            info["classification"] = cls_info
            elements.append(info)
        except Exception:
            pass

    return {
        "elements": elements,
        "match_count": len(classified_elements),
        "total_scanned": total_scanned,
        "truncated": len(classified_elements) > max_results,
    }


def main():
    args = json.loads(sys.stdin.read())

    file_path = args["file_path"]
    query_type = args["query_type"]
    value = args["value"]
    max_results = args.get("max_results", 50)

    # Resolve relative paths
    if not os.path.isabs(file_path):
        file_path = os.path.abspath(file_path)

    if not os.path.isfile(file_path):
        print(json.dumps({"error": f"File not found: {file_path}"}))
        return

    ifc_file = ifcopenshell.open(file_path)

    query_functions = {
        "by_type": query_by_type,
        "by_material": query_by_material,
        "by_property": query_by_property,
        "by_space": query_by_space,
        "by_classification": query_by_classification,
    }

    func = query_functions.get(query_type)
    if func is None:
        print(json.dumps({"error": f"Unknown query_type: {query_type}"}))
        return

    result = func(ifc_file, value, max_results)
    result["query_type"] = query_type
    result["query_value"] = value
    result["file_path"] = file_path

    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
