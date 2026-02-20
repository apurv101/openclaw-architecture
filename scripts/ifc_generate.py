#!/usr/bin/env python3
"""
IFC Generate - Create new IFC/BIM files from a structured specification.

Reads args from stdin (JSON), outputs result to stdout (JSON).

Creates IfcProject, IfcSite, IfcBuilding, then for each story creates
IfcBuildingStorey and elements (IfcWall, IfcDoor, IfcWindow, IfcSlab)
with proper geometric representations.
"""
import sys
import json
import os
import math
import time
import uuid

import ifcopenshell
import ifcopenshell.api


def create_guid():
    """Generate a new IFC GlobalId."""
    return ifcopenshell.guid.compress(uuid.uuid4().hex)


def create_ifc_file(spec, output_path, schema_version="IFC4"):
    """Create a complete IFC file from a specification dictionary."""
    # Create file using ifcopenshell.api (the modern approach)
    ifc = ifcopenshell.api.run("project.create_file", schema=schema_version)

    # ------------------------------------------------------------------
    # Project / Site / Building
    # ------------------------------------------------------------------
    project = ifcopenshell.api.run(
        "root.create_entity", ifc,
        ifc_class="IfcProject",
        name=spec.get("project_name", "New Project"),
    )

    # Assign default units (SI)
    ifcopenshell.api.run("unit.assign_unit", ifc)

    # Create default geometric context
    ctx = ifcopenshell.api.run(
        "context.add_context", ifc,
        context_type="Model",
    )
    body_ctx = ifcopenshell.api.run(
        "context.add_context", ifc,
        context_type="Model",
        context_identifier="Body",
        target_view="MODEL_VIEW",
        parent=ctx,
    )

    site = ifcopenshell.api.run(
        "root.create_entity", ifc,
        ifc_class="IfcSite",
        name=spec.get("site_name", "Default Site"),
    )
    ifcopenshell.api.run(
        "aggregate.assign_object", ifc,
        relating_object=project,
        products=[site],
    )

    building = ifcopenshell.api.run(
        "root.create_entity", ifc,
        ifc_class="IfcBuilding",
        name=spec.get("building_name", "Default Building"),
    )
    ifcopenshell.api.run(
        "aggregate.assign_object", ifc,
        relating_object=site,
        products=[building],
    )

    # ------------------------------------------------------------------
    # Stories
    # ------------------------------------------------------------------
    stories_spec = spec.get("stories", [])
    element_counts = {
        "IfcBuildingStorey": 0,
        "IfcSpace": 0,
        "IfcWall": 0,
        "IfcWallStandardCase": 0,
        "IfcSlab": 0,
        "IfcDoor": 0,
        "IfcWindow": 0,
    }
    total_elements = 0

    # Keep track of walls by name per storey for opening references
    for story_spec in stories_spec:
        story_name = story_spec.get("name", f"Story {element_counts['IfcBuildingStorey'] + 1}")
        story_elevation = story_spec.get("elevation", 0.0)
        story_height = story_spec.get("height", 3.0)

        storey = ifcopenshell.api.run(
            "root.create_entity", ifc,
            ifc_class="IfcBuildingStorey",
            name=story_name,
        )
        storey.Elevation = story_elevation

        ifcopenshell.api.run(
            "aggregate.assign_object", ifc,
            relating_object=building,
            products=[storey],
        )
        element_counts["IfcBuildingStorey"] += 1
        total_elements += 1

        # Elements to assign to this storey
        storey_elements = []
        walls_by_name = {}

        # ------ Spaces ------
        for space_spec in story_spec.get("spaces", []):
            space = ifcopenshell.api.run(
                "root.create_entity", ifc,
                ifc_class="IfcSpace",
                name=space_spec.get("name", "Space"),
            )
            long_name = space_spec.get("long_name")
            if long_name:
                space.LongName = long_name

            storey_elements.append(space)
            element_counts["IfcSpace"] += 1
            total_elements += 1

        # ------ Walls ------
        for wall_spec in story_spec.get("walls", []):
            wall_name = wall_spec.get("name", f"Wall-{total_elements}")
            sx = wall_spec.get("start_x", 0.0)
            sy = wall_spec.get("start_y", 0.0)
            ex = wall_spec.get("end_x", 0.0)
            ey = wall_spec.get("end_y", 0.0)
            wall_height = wall_spec.get("height", story_height)
            wall_thickness = wall_spec.get("thickness", 0.2)

            # Calculate wall length and direction
            dx = ex - sx
            dy = ey - sy
            wall_length = math.sqrt(dx * dx + dy * dy)
            if wall_length < 1e-6:
                continue  # Skip zero-length walls

            # Use IfcWall (generic) - works across IFC2X3 and IFC4
            wall = ifcopenshell.api.run(
                "root.create_entity", ifc,
                ifc_class="IfcWall",
                name=wall_name,
            )

            # Create geometric representation: extruded rectangle
            # Direction angle
            angle = math.atan2(dy, dx)

            # Create wall placement at start point, rotated to wall direction
            matrix = _make_placement_matrix(sx, sy, story_elevation, angle)
            ifcopenshell.api.run(
                "geometry.edit_object_placement", ifc,
                product=wall,
                matrix=matrix,
            )

            # Create extruded area solid representation for the wall
            # Profile: rectangle (wall_length x wall_thickness)
            # Extrusion: wall_height in Z direction
            try:
                representation = ifcopenshell.api.run(
                    "geometry.add_wall_representation", ifc,
                    context=body_ctx,
                    length=wall_length,
                    height=wall_height,
                    thickness=wall_thickness,
                )
                ifcopenshell.api.run(
                    "geometry.assign_representation", ifc,
                    product=wall,
                    representation=representation,
                )
            except Exception:
                # Fallback: create simple extruded area solid manually
                _add_extruded_rect_representation(
                    ifc, wall, body_ctx,
                    wall_length, wall_thickness, wall_height,
                )

            storey_elements.append(wall)
            walls_by_name[wall_name] = wall
            element_counts["IfcWall"] += 1
            total_elements += 1

        # ------ Slabs ------
        for slab_spec in story_spec.get("slabs", []):
            slab_name = slab_spec.get("name", f"Slab-{total_elements}")
            slab_x = slab_spec.get("x", 0.0)
            slab_y = slab_spec.get("y", 0.0)
            slab_width = slab_spec.get("width", 1.0)
            slab_depth = slab_spec.get("depth", 1.0)
            slab_thickness = slab_spec.get("thickness", 0.2)

            slab = ifcopenshell.api.run(
                "root.create_entity", ifc,
                ifc_class="IfcSlab",
                name=slab_name,
            )

            matrix = _make_placement_matrix(slab_x, slab_y, story_elevation, 0.0)
            ifcopenshell.api.run(
                "geometry.edit_object_placement", ifc,
                product=slab,
                matrix=matrix,
            )

            # Slab representation: extruded rectangle
            _add_extruded_rect_representation(
                ifc, slab, body_ctx,
                slab_width, slab_depth, slab_thickness,
            )

            storey_elements.append(slab)
            element_counts["IfcSlab"] += 1
            total_elements += 1

        # ------ Openings (doors/windows) ------
        for opening_spec in story_spec.get("openings", []):
            opening_type = opening_spec.get("type", "door")
            opening_name = opening_spec.get("name", f"Opening-{total_elements}")
            opening_width = opening_spec.get("width", 0.9)
            opening_height = opening_spec.get("height", 2.1 if opening_type == "door" else 1.2)
            sill_height = opening_spec.get("sill_height", 0.0 if opening_type == "door" else 0.9)

            if opening_type == "door":
                ifc_class = "IfcDoor"
                element_counts["IfcDoor"] += 1
            else:
                ifc_class = "IfcWindow"
                element_counts["IfcWindow"] += 1

            element = ifcopenshell.api.run(
                "root.create_entity", ifc,
                ifc_class=ifc_class,
                name=opening_name,
            )

            # Set dimensional attributes
            try:
                element.OverallWidth = opening_width
                element.OverallHeight = opening_height
            except Exception:
                pass

            storey_elements.append(element)
            total_elements += 1

            # If a wall is referenced, create an opening in that wall
            wall_name = opening_spec.get("wall_name")
            if wall_name and wall_name in walls_by_name:
                host_wall = walls_by_name[wall_name]
                offset = opening_spec.get("offset", 0.5)

                try:
                    # Create an IfcOpeningElement and void the wall
                    opening_element = ifcopenshell.api.run(
                        "root.create_entity", ifc,
                        ifc_class="IfcOpeningElement",
                        name=f"Opening for {opening_name}",
                    )
                    _add_extruded_rect_representation(
                        ifc, opening_element, body_ctx,
                        opening_width, 1.0, opening_height,
                    )

                    ifcopenshell.api.run(
                        "void.add_opening", ifc,
                        opening=opening_element,
                        element=host_wall,
                    )

                    ifcopenshell.api.run(
                        "void.add_filling", ifc,
                        opening=opening_element,
                        element=element,
                    )
                except Exception:
                    # Opening/filling API may not be available in all versions
                    pass

        # Assign all storey elements to the storey via spatial containment
        if storey_elements:
            ifcopenshell.api.run(
                "spatial.assign_container", ifc,
                relating_structure=storey,
                products=storey_elements,
            )

    # ------------------------------------------------------------------
    # Write file
    # ------------------------------------------------------------------
    resolved_path = os.path.abspath(output_path)
    os.makedirs(os.path.dirname(resolved_path), exist_ok=True)
    ifc.write(resolved_path)

    # Clean up zero counts
    element_summary = {k: v for k, v in element_counts.items() if v > 0}

    return {
        "output_path": resolved_path,
        "schema_version": schema_version,
        "project_name": spec.get("project_name", "New Project"),
        "stories_created": element_counts["IfcBuildingStorey"],
        "elements_created": total_elements,
        "element_summary": element_summary,
    }


def _make_placement_matrix(x, y, z, angle_rad):
    """Create a 4x4 transformation matrix for placement."""
    import numpy as np
    cos_a = math.cos(angle_rad)
    sin_a = math.sin(angle_rad)
    return np.array([
        [cos_a, -sin_a, 0.0, x],
        [sin_a, cos_a, 0.0, y],
        [0.0, 0.0, 1.0, z],
        [0.0, 0.0, 0.0, 1.0],
    ])


def _add_extruded_rect_representation(ifc, product, context, length, width, height):
    """Add an extruded rectangular solid representation to a product.

    This is a fallback when the higher-level API calls are not available.
    Creates a SweptSolid representation using IfcExtrudedAreaSolid.
    """
    try:
        # Create a rectangular profile
        point_list = [
            ifc.createIfcCartesianPoint((0.0, 0.0)),
            ifc.createIfcCartesianPoint((length, 0.0)),
            ifc.createIfcCartesianPoint((length, width)),
            ifc.createIfcCartesianPoint((0.0, width)),
            ifc.createIfcCartesianPoint((0.0, 0.0)),  # close the loop
        ]
        polyline = ifc.createIfcPolyline(point_list)
        profile = ifc.createIfcArbitraryClosedProfileDef("AREA", None, polyline)

        # Extrusion direction (Z-up)
        extrusion_dir = ifc.createIfcDirection((0.0, 0.0, 1.0))

        # Extrusion placement (at origin)
        extrusion_placement = ifc.createIfcAxis2Placement3D(
            ifc.createIfcCartesianPoint((0.0, 0.0, 0.0)),
            ifc.createIfcDirection((0.0, 0.0, 1.0)),
            ifc.createIfcDirection((1.0, 0.0, 0.0)),
        )

        solid = ifc.createIfcExtrudedAreaSolid(
            profile, extrusion_placement, extrusion_dir, height,
        )

        shape_rep = ifc.createIfcShapeRepresentation(
            context, "Body", "SweptSolid", [solid],
        )

        product_def_shape = ifc.createIfcProductDefinitionShape(None, None, [shape_rep])
        product.Representation = product_def_shape
    except Exception:
        pass  # Geometry creation is best-effort


def main():
    args = json.loads(sys.stdin.read())

    specification = args["specification"]
    output_path = args["output_path"]
    schema_version = args.get("schema_version", "IFC4")

    result = create_ifc_file(specification, output_path, schema_version)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
