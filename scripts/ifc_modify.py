#!/usr/bin/env python3
"""
IFC Modify - Modify existing IFC/BIM files using ifcopenshell.

Reads args from stdin (JSON), outputs result to stdout (JSON).

Supported operations:
  - set_property:   set or update a property value on an element
  - add_element:    add a new IFC element to the model
  - remove_element: remove an element by GlobalId
  - set_material:   assign or change material on an element
"""
import sys
import json
import os

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.util.element as element_util


def find_element_by_guid(ifc_file, global_id):
    """Find an element by its GlobalId."""
    try:
        return ifc_file.by_guid(global_id)
    except (RuntimeError, Exception):
        return None


def op_set_property(ifc_file, target_guid, data):
    """Set or update a property on a target element.

    data: { pset_name: str, property_name: str, value: any }
    """
    element = find_element_by_guid(ifc_file, target_guid)
    if element is None:
        return {"success": False, "action": "set_property",
                "message": f"Element not found: {target_guid}"}

    pset_name = data.get("pset_name", "Pset_Custom")
    property_name = data.get("property_name")
    value = data.get("value")

    if not property_name:
        return {"success": False, "action": "set_property",
                "message": "property_name is required in data"}

    try:
        # Try to find existing property set
        existing_pset = None
        psets = element_util.get_psets(element)
        pset_id = None

        if pset_name in psets:
            pset_id = psets[pset_name].get("id")
            if pset_id:
                existing_pset = ifc_file.by_id(pset_id)

        if existing_pset is not None:
            # Update existing property set
            ifcopenshell.api.run(
                "pset.edit_pset", ifc_file,
                pset=existing_pset,
                properties={property_name: value},
            )
        else:
            # Create new property set and assign it
            new_pset = ifcopenshell.api.run(
                "pset.add_pset", ifc_file,
                product=element,
                name=pset_name,
            )
            ifcopenshell.api.run(
                "pset.edit_pset", ifc_file,
                pset=new_pset,
                properties={property_name: value},
            )

        return {"success": True, "action": "set_property",
                "message": f"Set {pset_name}.{property_name} = {value} on {target_guid}"}
    except Exception as e:
        return {"success": False, "action": "set_property",
                "message": str(e)}


def op_add_element(ifc_file, target_guid, data):
    """Add a new element to the model.

    target: GlobalId of parent container (IfcBuildingStorey, etc.) or 'auto'
    data: { ifc_type: str, name: str, properties?: dict }
    """
    ifc_type = data.get("ifc_type", "IfcBuildingElementProxy")
    name = data.get("name", "New Element")
    properties = data.get("properties", {})

    # Find parent container
    container = None
    if target_guid and target_guid.lower() != "auto":
        container = find_element_by_guid(ifc_file, target_guid)
        if container is None:
            return {"success": False, "action": "add_element",
                    "message": f"Parent container not found: {target_guid}"}
    else:
        # Auto-detect: use first IfcBuildingStorey
        storeys = ifc_file.by_type("IfcBuildingStorey")
        if storeys:
            container = storeys[0]
        else:
            buildings = ifc_file.by_type("IfcBuilding")
            if buildings:
                container = buildings[0]

    try:
        element = ifcopenshell.api.run(
            "root.create_entity", ifc_file,
            ifc_class=ifc_type,
            name=name,
        )

        # Assign to container
        if container is not None:
            try:
                ifcopenshell.api.run(
                    "spatial.assign_container", ifc_file,
                    relating_structure=container,
                    products=[element],
                )
            except Exception:
                pass  # Container assignment is best-effort

        # Add properties if specified
        if properties:
            pset_name = data.get("pset_name", "Pset_Custom")
            try:
                pset = ifcopenshell.api.run(
                    "pset.add_pset", ifc_file,
                    product=element,
                    name=pset_name,
                )
                # Filter to serialisable values
                clean_props = {}
                for k, v in properties.items():
                    if isinstance(v, (int, float, bool, str)):
                        clean_props[k] = v
                if clean_props:
                    ifcopenshell.api.run(
                        "pset.edit_pset", ifc_file,
                        pset=pset,
                        properties=clean_props,
                    )
            except Exception:
                pass

        return {"success": True, "action": "add_element",
                "message": f"Created {ifc_type} '{name}' (GlobalId: {element.GlobalId})",
                "global_id": element.GlobalId}
    except Exception as e:
        return {"success": False, "action": "add_element",
                "message": str(e)}


def op_remove_element(ifc_file, target_guid, data):
    """Remove an element by its GlobalId."""
    element = find_element_by_guid(ifc_file, target_guid)
    if element is None:
        return {"success": False, "action": "remove_element",
                "message": f"Element not found: {target_guid}"}

    ifc_type = element.is_a()
    name = element.Name

    try:
        ifcopenshell.api.run(
            "root.remove_product", ifc_file,
            product=element,
        )
        return {"success": True, "action": "remove_element",
                "message": f"Removed {ifc_type} '{name}' ({target_guid})"}
    except Exception as e:
        return {"success": False, "action": "remove_element",
                "message": str(e)}


def op_set_material(ifc_file, target_guid, data):
    """Assign or change material on an element.

    data: { material_name: str, category?: str }
    """
    element = find_element_by_guid(ifc_file, target_guid)
    if element is None:
        return {"success": False, "action": "set_material",
                "message": f"Element not found: {target_guid}"}

    material_name = data.get("material_name", "Default Material")
    category = data.get("category")

    try:
        # Check if this material already exists in the file
        existing_material = None
        for mat in ifc_file.by_type("IfcMaterial"):
            if mat.Name == material_name:
                existing_material = mat
                break

        if existing_material is None:
            # Create new material
            existing_material = ifcopenshell.api.run(
                "material.add_material", ifc_file,
                name=material_name,
                category=category,
            )

        # Assign material to element
        ifcopenshell.api.run(
            "material.assign_material", ifc_file,
            products=[element],
            material=existing_material,
        )

        return {"success": True, "action": "set_material",
                "message": f"Assigned material '{material_name}' to {target_guid}"}
    except Exception as e:
        return {"success": False, "action": "set_material",
                "message": str(e)}


def main():
    args = json.loads(sys.stdin.read())

    file_path = args["file_path"]
    output_path = args["output_path"]
    operations = args["operations"]

    # Resolve relative paths
    if not os.path.isabs(file_path):
        file_path = os.path.abspath(file_path)
    if not os.path.isabs(output_path):
        output_path = os.path.abspath(output_path)

    if not os.path.isfile(file_path):
        print(json.dumps({"error": f"File not found: {file_path}"}))
        return

    ifc_file = ifcopenshell.open(file_path)

    # Dispatch operations
    operation_handlers = {
        "set_property": op_set_property,
        "add_element": op_add_element,
        "remove_element": op_remove_element,
        "set_material": op_set_material,
    }

    operation_results = []
    warnings = []

    for i, op in enumerate(operations):
        action = op.get("action")
        target = op.get("target", "")
        data = op.get("data", {})

        handler = operation_handlers.get(action)
        if handler is None:
            operation_results.append({
                "success": False,
                "action": action,
                "message": f"Unknown action: {action}",
            })
            continue

        result = handler(ifc_file, target, data)
        operation_results.append(result)

        if not result["success"]:
            warnings.append(f"Operation {i + 1} ({action}) failed: {result['message']}")

    # Save the modified file
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    ifc_file.write(output_path)

    operations_applied = sum(1 for r in operation_results if r["success"])

    output = {
        "output_path": output_path,
        "operations_applied": operations_applied,
        "operations_total": len(operations),
        "operation_results": operation_results,
        "warnings": warnings,
    }

    print(json.dumps(output))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
