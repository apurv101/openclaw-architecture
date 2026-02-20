#!/usr/bin/env python3
"""
IFC Validate - Validate IFC/BIM files using ifcopenshell.

Reads args from stdin (JSON), outputs result to stdout (JSON).

Supports check levels:
  - syntax: verify the file can be parsed as valid STEP/IFC
  - schema: verify all entities conform to the IFC schema
  - rules:  apply custom validation rules (naming, properties, spatial, etc.)
"""
import sys
import json
import os
from collections import Counter

import ifcopenshell
import ifcopenshell.util.element as element_util


def check_syntax(file_path):
    """Check if the file can be parsed at all. Returns (ifc_file, issues)."""
    issues = []
    ifc_file = None

    try:
        ifc_file = ifcopenshell.open(file_path)
    except Exception as e:
        issues.append({
            "severity": "error",
            "rule": "syntax",
            "location": file_path,
            "message": f"Failed to parse IFC file: {str(e)}",
        })
        return None, issues

    # Basic syntax checks
    try:
        schema = ifc_file.schema
        if schema not in ("IFC2X3", "IFC4", "IFC4X1", "IFC4X2", "IFC4X3"):
            issues.append({
                "severity": "warning",
                "rule": "syntax",
                "location": "header",
                "message": f"Unusual IFC schema version: {schema}",
            })
    except Exception:
        issues.append({
            "severity": "warning",
            "rule": "syntax",
            "location": "header",
            "message": "Could not determine IFC schema version.",
        })

    # Check for basic required entities
    projects = ifc_file.by_type("IfcProject")
    if not projects:
        issues.append({
            "severity": "error",
            "rule": "syntax",
            "location": "IfcProject",
            "message": "No IfcProject entity found. Every IFC file must have exactly one IfcProject.",
        })
    elif len(projects) > 1:
        issues.append({
            "severity": "error",
            "rule": "syntax",
            "location": "IfcProject",
            "message": f"Multiple IfcProject entities found ({len(projects)}). Only one is allowed.",
        })

    return ifc_file, issues


def check_schema(ifc_file):
    """Check schema conformance of entities. Returns list of issues."""
    issues = []

    # Use ifcopenshell's built-in validation if available
    try:
        import ifcopenshell.validate as ifc_validate

        logger = _ValidationLogger()
        ifc_validate.validate(ifc_file, logger)

        for entry in logger.entries:
            severity = "error" if entry["level"] == "ERROR" else "warning"
            issues.append({
                "severity": severity,
                "rule": "schema",
                "location": entry.get("instance", ""),
                "message": entry.get("message", "Schema validation issue"),
            })
    except ImportError:
        # ifcopenshell.validate not available; do manual checks
        issues.extend(_manual_schema_checks(ifc_file))
    except Exception as e:
        # Validation itself failed; fall back to manual checks
        issues.append({
            "severity": "warning",
            "rule": "schema",
            "location": "validator",
            "message": f"Built-in validator raised an error: {str(e)}. Falling back to manual checks.",
        })
        issues.extend(_manual_schema_checks(ifc_file))

    return issues


class _ValidationLogger:
    """Logger class compatible with ifcopenshell.validate."""

    def __init__(self):
        self.entries = []

    def error(self, message, instance=None):
        self.entries.append({
            "level": "ERROR",
            "message": str(message),
            "instance": str(instance) if instance else "",
        })

    def warning(self, message, instance=None):
        self.entries.append({
            "level": "WARNING",
            "message": str(message),
            "instance": str(instance) if instance else "",
        })

    # Some versions use __call__
    def __call__(self, level, message, instance=None):
        self.entries.append({
            "level": level,
            "message": str(message),
            "instance": str(instance) if instance else "",
        })


def _manual_schema_checks(ifc_file):
    """Manual schema-like checks when built-in validator is unavailable."""
    issues = []

    # Check that all products have a GlobalId
    for product in ifc_file.by_type("IfcRoot"):
        gid = product.GlobalId
        if not gid or len(gid) < 1:
            issues.append({
                "severity": "error",
                "rule": "schema",
                "location": f"#{product.id()} ({product.is_a()})",
                "message": "Entity missing required GlobalId attribute.",
            })

    # Check IfcOwnerHistory references
    for product in ifc_file.by_type("IfcRoot"):
        try:
            oh = product.OwnerHistory
            # In IFC4, OwnerHistory is optional; in IFC2X3 it is required
            if ifc_file.schema == "IFC2X3" and oh is None:
                issues.append({
                    "severity": "warning",
                    "rule": "schema",
                    "location": f"#{product.id()} {product.is_a()} '{product.Name}'",
                    "message": "OwnerHistory is required in IFC2X3 but is missing.",
                })
        except Exception:
            pass

    # Check that spatial structure elements have names
    spatial_types = ("IfcProject", "IfcSite", "IfcBuilding", "IfcBuildingStorey", "IfcSpace")
    for spatial_type in spatial_types:
        for entity in ifc_file.by_type(spatial_type):
            if not entity.Name:
                issues.append({
                    "severity": "warning",
                    "rule": "schema",
                    "location": f"#{entity.id()} {entity.is_a()} ({entity.GlobalId})",
                    "message": f"{spatial_type} should have a Name attribute.",
                })

    return issues


def check_rules(ifc_file, rule_names=None):
    """Apply custom validation rules. Returns list of issues."""
    all_rules = {
        "naming": rule_naming,
        "properties": rule_properties,
        "spatial": rule_spatial,
        "materials": rule_materials,
        "geometry": rule_geometry,
        "duplicates": rule_duplicates,
    }

    if rule_names:
        rules_to_run = {k: v for k, v in all_rules.items() if k in rule_names}
        unknown = set(rule_names) - set(all_rules.keys())
        issues = []
        for name in unknown:
            issues.append({
                "severity": "warning",
                "rule": "config",
                "location": "",
                "message": f"Unknown rule '{name}'. Available: {', '.join(all_rules.keys())}",
            })
    else:
        rules_to_run = all_rules
        issues = []

    for rule_name, rule_func in rules_to_run.items():
        try:
            rule_issues = rule_func(ifc_file)
            issues.extend(rule_issues)
        except Exception as e:
            issues.append({
                "severity": "warning",
                "rule": rule_name,
                "location": "",
                "message": f"Rule '{rule_name}' raised an exception: {str(e)}",
            })

    return issues


def rule_naming(ifc_file):
    """Check element naming conventions."""
    issues = []
    default_names = {"", "default", "unnamed", "new", "object", "element"}

    for product in ifc_file.by_type("IfcProduct"):
        name = product.Name
        if name is None or name.strip() == "":
            issues.append({
                "severity": "warning",
                "rule": "naming",
                "location": f"#{product.id()} {product.is_a()} ({product.GlobalId})",
                "message": f"{product.is_a()} has no name.",
            })
        elif name.strip().lower() in default_names:
            issues.append({
                "severity": "info",
                "rule": "naming",
                "location": f"#{product.id()} {product.is_a()} ({product.GlobalId})",
                "message": f"{product.is_a()} has a default/placeholder name: '{name}'.",
            })

    return issues


def rule_properties(ifc_file):
    """Check that elements have required property sets."""
    issues = []
    # Check that walls, doors, windows, slabs have at least one property set
    important_types = ("IfcWall", "IfcWallStandardCase", "IfcDoor", "IfcWindow",
                       "IfcSlab", "IfcColumn", "IfcBeam")

    for ifc_type in important_types:
        for element in ifc_file.by_type(ifc_type):
            try:
                psets = element_util.get_psets(element)
                if not psets:
                    issues.append({
                        "severity": "info",
                        "rule": "properties",
                        "location": f"#{element.id()} {element.is_a()} '{element.Name}' ({element.GlobalId})",
                        "message": f"{element.is_a()} has no property sets.",
                    })
            except Exception:
                pass

    return issues


def rule_spatial(ifc_file):
    """Verify spatial hierarchy is complete: Project > Site > Building > Storey."""
    issues = []

    projects = ifc_file.by_type("IfcProject")
    sites = ifc_file.by_type("IfcSite")
    buildings = ifc_file.by_type("IfcBuilding")
    storeys = ifc_file.by_type("IfcBuildingStorey")

    if not projects:
        issues.append({
            "severity": "error",
            "rule": "spatial",
            "location": "",
            "message": "No IfcProject found.",
        })
    if not sites:
        issues.append({
            "severity": "warning",
            "rule": "spatial",
            "location": "",
            "message": "No IfcSite found. A complete spatial hierarchy requires at least one site.",
        })
    if not buildings:
        issues.append({
            "severity": "warning",
            "rule": "spatial",
            "location": "",
            "message": "No IfcBuilding found. A complete spatial hierarchy requires at least one building.",
        })
    if not storeys:
        issues.append({
            "severity": "warning",
            "rule": "spatial",
            "location": "",
            "message": "No IfcBuildingStorey found. Buildings typically have at least one storey.",
        })

    # Check that storeys have elevation set
    for storey in storeys:
        if storey.Elevation is None:
            issues.append({
                "severity": "info",
                "rule": "spatial",
                "location": f"#{storey.id()} IfcBuildingStorey '{storey.Name}' ({storey.GlobalId})",
                "message": "IfcBuildingStorey has no Elevation value set.",
            })

    # Check that products are contained in spatial structure
    uncontained = 0
    for product in ifc_file.by_type("IfcProduct"):
        if product.is_a() in ("IfcProject", "IfcSite", "IfcBuilding",
                               "IfcBuildingStorey", "IfcSpace",
                               "IfcOpeningElement"):
            continue
        # Check if element has spatial containment
        contained = False
        for rel in getattr(product, "ContainedInStructure", []):
            contained = True
            break
        if not contained:
            # Also check if decomposed (aggregated)
            for rel in getattr(product, "Decomposes", []):
                contained = True
                break
        if not contained:
            # Check void filling (doors/windows in openings)
            for rel in getattr(product, "FillsVoids", []):
                contained = True
                break
        if not contained:
            uncontained += 1

    if uncontained > 0:
        issues.append({
            "severity": "warning",
            "rule": "spatial",
            "location": "",
            "message": f"{uncontained} product(s) are not contained in any spatial structure element.",
        })

    return issues


def rule_materials(ifc_file):
    """Check that load-bearing elements have materials assigned."""
    issues = []
    structural_types = ("IfcWall", "IfcWallStandardCase", "IfcColumn",
                        "IfcBeam", "IfcSlab", "IfcFooting", "IfcPile")

    for ifc_type in structural_types:
        for element in ifc_file.by_type(ifc_type):
            try:
                mat = element_util.get_material(element)
                if mat is None:
                    issues.append({
                        "severity": "warning",
                        "rule": "materials",
                        "location": f"#{element.id()} {element.is_a()} '{element.Name}' ({element.GlobalId})",
                        "message": f"Structural element {element.is_a()} has no material assigned.",
                    })
            except Exception:
                pass

    return issues


def rule_geometry(ifc_file):
    """Check that elements have geometric representations."""
    issues = []
    element_types_requiring_geometry = (
        "IfcWall", "IfcWallStandardCase", "IfcColumn", "IfcBeam",
        "IfcSlab", "IfcDoor", "IfcWindow", "IfcStair", "IfcRamp",
        "IfcRoof", "IfcCurtainWall", "IfcPlate",
    )

    for ifc_type in element_types_requiring_geometry:
        for element in ifc_file.by_type(ifc_type):
            rep = element.Representation
            if rep is None:
                issues.append({
                    "severity": "warning",
                    "rule": "geometry",
                    "location": f"#{element.id()} {element.is_a()} '{element.Name}' ({element.GlobalId})",
                    "message": f"{element.is_a()} has no geometric representation.",
                })
            else:
                # Check that at least one representation has items
                has_items = False
                for shape_rep in (rep.Representations or []):
                    if shape_rep.Items and len(shape_rep.Items) > 0:
                        has_items = True
                        break
                if not has_items:
                    issues.append({
                        "severity": "info",
                        "rule": "geometry",
                        "location": f"#{element.id()} {element.is_a()} '{element.Name}' ({element.GlobalId})",
                        "message": f"{element.is_a()} has a representation but no geometry items.",
                    })

    return issues


def rule_duplicates(ifc_file):
    """Check for duplicate GlobalIds."""
    issues = []
    guid_counter = Counter()

    for entity in ifc_file.by_type("IfcRoot"):
        gid = entity.GlobalId
        if gid:
            guid_counter[gid] += 1

    for gid, count in guid_counter.items():
        if count > 1:
            # Find all entities with this GUID
            entity_names = []
            for entity in ifc_file.by_type("IfcRoot"):
                if entity.GlobalId == gid:
                    entity_names.append(f"#{entity.id()} {entity.is_a()} '{entity.Name}'")

            issues.append({
                "severity": "error",
                "rule": "duplicates",
                "location": gid,
                "message": f"Duplicate GlobalId found ({count} occurrences): {', '.join(entity_names)}",
            })

    return issues


def main():
    args = json.loads(sys.stdin.read())

    file_path = args["file_path"]
    check_level = args.get("check_level", "schema")
    rule_names = args.get("rules", None)

    # Resolve relative paths
    if not os.path.isabs(file_path):
        file_path = os.path.abspath(file_path)

    if not os.path.isfile(file_path):
        print(json.dumps({"error": f"File not found: {file_path}"}))
        return

    all_issues = []
    schema = None

    # Level 1: Syntax check (always performed)
    ifc_file, syntax_issues = check_syntax(file_path)
    all_issues.extend(syntax_issues)

    if ifc_file is None:
        # Cannot proceed without a parseable file
        print(json.dumps({
            "valid": False,
            "file_path": file_path,
            "check_level": check_level,
            "issues": all_issues,
        }))
        return

    schema = ifc_file.schema

    # Level 2: Schema check
    if check_level in ("schema", "rules"):
        schema_issues = check_schema(ifc_file)
        all_issues.extend(schema_issues)

    # Level 3: Custom rules
    if check_level == "rules":
        rule_issues = check_rules(ifc_file, rule_names)
        all_issues.extend(rule_issues)

    # Determine validity: no errors = valid
    has_errors = any(i["severity"] == "error" for i in all_issues)

    result = {
        "valid": not has_errors,
        "file_path": file_path,
        "schema": schema,
        "check_level": check_level,
        "issues": all_issues,
        "issue_count": len(all_issues),
        "error_count": sum(1 for i in all_issues if i["severity"] == "error"),
        "warning_count": sum(1 for i in all_issues if i["severity"] == "warning"),
        "info_count": sum(1 for i in all_issues if i["severity"] == "info"),
    }

    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
