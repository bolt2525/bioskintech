import bmesh
import bpy
import math
import re
from pathlib import Path
from mathutils import Matrix, Vector


ROOT = Path(__file__).resolve().parents[1]
HEAD_MODEL = ROOT / "public" / "models" / "clinical" / "male_head.glb"
OUTPUT_MODEL = ROOT / "public" / "models" / "clinical" / "male_head_hair.glb"
BOUNDARY_SOURCE = ROOT / "src" / "data" / "scalpBoundaryPreset.ts"
HEAD_CENTER = Vector((0.0, 0.58, -0.08))
# Convert Blender's Z-up coordinates to the Y-up frame used by Three.js/glTF.
BLENDER_TO_THREE = Matrix.Rotation(-math.pi / 2, 4, "X")


def load_boundary():
    source = BOUNDARY_SOURCE.read_text(encoding="utf-8")
    vector_pattern = r"(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)"
    back = re.search(r"const MIDLINE_BACK = \[" + vector_pattern + r"\]", source)
    front = re.search(r"const MIDLINE_FRONT = \[" + vector_pattern + r"\]", source)
    right_block = source.split("const RIGHT_SCALP_BOUNDARY = [", 1)[1].split("] as const;", 1)[0]
    right = [tuple(map(float, match)) for match in re.findall(r"\[\s*" + vector_pattern + r"\s*\]", right_block)]
    if not back or not front or len(right) < 3:
        raise RuntimeError(f"Could not read scalp boundary from {BOUNDARY_SOURCE}")
    return [
        tuple(map(float, back.groups())),
        *right,
        tuple(map(float, front.groups())),
        *((-x, y, z) for x, y, z in reversed(right)),
    ]


def create_boundary_profile(points):
    samples = []
    previous_angle = -math.inf
    for x, y, z in points:
        angle = math.atan2(z - HEAD_CENTER.z, x - HEAD_CENTER.x)
        while angle < previous_angle:
            angle += math.tau
        samples.append((angle, y))
        previous_angle = angle
    return samples


def boundary_height(angle, profile):
    first_angle = profile[0][0]
    while angle < first_angle:
        angle += math.tau
    while angle >= first_angle + math.tau:
        angle -= math.tau
    for index in range(1, len(profile)):
        end_angle, end_height = profile[index]
        if angle <= end_angle:
            start_angle, start_height = profile[index - 1]
            amount = (angle - start_angle) / (end_angle - start_angle or 1)
            return start_height + (end_height - start_height) * amount
    last_angle, last_height = profile[-1]
    amount = (angle - last_angle) / (first_angle + math.tau - last_angle or 1)
    return last_height + (profile[0][1] - last_height) * amount


def signed_distance(point, profile):
    angle = math.atan2(point.z - HEAD_CENTER.z, point.x - HEAD_CENTER.x)
    return point.y - boundary_height(angle, profile)


def clip_triangle(vertices, profile):
    polygon = [(point, signed_distance(point, profile)) for point in vertices]
    clipped = []
    for index, (current, current_distance) in enumerate(polygon):
        previous, previous_distance = polygon[index - 1]
        current_inside = current_distance >= 0
        previous_inside = previous_distance >= 0
        if current_inside != previous_inside:
            amount = previous_distance / (previous_distance - current_distance)
            clipped.append((previous.lerp(current, amount), 0.0))
        if current_inside:
            clipped.append((current, current_distance))
    return [point for point, _ in clipped]


def smoothstep(edge0, edge1, value):
    amount = min(1.0, max(0.0, (value - edge0) / (edge1 - edge0)))
    return amount * amount * (3.0 - 2.0 * amount)


def build_cap(head, profile, model_to_viewer, viewer_to_model):
    source = bmesh.new()
    source.from_mesh(head.data)
    source.transform(head.matrix_world)
    source.transform(BLENDER_TO_THREE)
    source.transform(model_to_viewer)
    bmesh.ops.triangulate(source, faces=list(source.faces))
    bmesh.ops.subdivide_edges(
        source,
        edges=list(source.edges),
        cuts=2,
        use_grid_fill=True,
    )
    source.normal_update()

    cap = bmesh.new()
    vertex_cache = {}

    def add_vertex(point):
        key = tuple(round(value, 6) for value in point)
        if key not in vertex_cache:
            vertex_cache[key] = cap.verts.new(point)
        return vertex_cache[key]

    accepted = 0
    for face in source.faces:
        center = face.calc_center_median()
        radial = center - HEAD_CENTER
        if signed_distance(center, profile) < -0.08:
            continue
        if abs(face.normal.dot(radial.normalized())) < 0.12:
            continue

        points = clip_triangle([vert.co.copy() for vert in face.verts], profile)
        if len(points) < 3:
            continue
        for index in range(1, len(points) - 1):
            triangle = (points[0], points[index], points[index + 1])
            vertices = [add_vertex(point) for point in triangle]
            try:
                output_face = cap.faces.new(vertices)
                output_face.smooth = True
                accepted += 1
            except ValueError:
                continue

    source.free()
    if not accepted:
        cap.free()
        raise RuntimeError("Scalp boundary produced no cap faces")

    bmesh.ops.recalc_face_normals(cap, faces=list(cap.faces))
    for face in cap.faces:
        radial = (face.calc_center_median() - HEAD_CENTER).normalized()
        if face.normal.dot(radial) < 0:
            face.normal_flip()
    cap.normal_update()
    for vertex in cap.verts:
        point = vertex.co
        normal = vertex.normal.normalized()
        angle = math.atan2(point.z - HEAD_CENTER.z, point.x - HEAD_CENTER.x)
        edge_distance = point.y - boundary_height(angle, profile)
        edge_fade = smoothstep(0.0, 0.18, edge_distance)
        crown = smoothstep(0.35, 1.1, edge_distance)
        phase = point.x * 19.0 + point.z * 3.4 + math.sin(point.z * 2.1) * 0.2
        ridges = math.sin(phase) * 0.009
        part = math.exp(-((point.x - 0.13) / 0.055) ** 2) * math.exp(-((point.z - 0.45) / 0.8) ** 2)
        shell = 0.026 + crown * 0.055 + (ridges - part * 0.012) * edge_fade
        point += normal * shell

    cap.transform(viewer_to_model)
    mesh = bpy.data.meshes.new("ScalpHairSourceMesh")
    cap.to_mesh(mesh)
    cap.free()
    mesh.update()
    hair = bpy.data.objects.new("SCALP_HAIR_SOURCE", mesh)
    bpy.context.collection.objects.link(hair)
    mesh.transform(head.matrix_world.inverted())
    hair.matrix_world = head.matrix_world.copy()
    for polygon in mesh.polygons:
        polygon.use_smooth = True

    material = bpy.data.materials.new("Scalp Hair Source")
    material.diffuse_color = (0.12, 0.055, 0.025, 1.0)
    hair.data.materials.append(material)
    hair["source_for_clinical_hair_visualization"] = True
    hair["boundary_source"] = BOUNDARY_SOURCE.name
    return hair, accepted


def main():
    if not HEAD_MODEL.is_file():
        raise FileNotFoundError(f"Head model not found: {HEAD_MODEL}")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(HEAD_MODEL))
    heads = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and len(obj.data.vertices) > 100]
    if len(heads) != 1:
        raise RuntimeError(f"Expected one head mesh, found {len(heads)}")

    head = heads[0]
    head.name = "ClinicalHead"
    viewer_vertices = [
        BLENDER_TO_THREE @ (head.matrix_world @ vertex.co)
        for vertex in head.data.vertices
    ]
    minimum = Vector(tuple(min(point[axis] for point in viewer_vertices) for axis in range(3)))
    maximum = Vector(tuple(max(point[axis] for point in viewer_vertices) for axis in range(3)))
    center = (minimum + maximum) * 0.5
    scale_factor = 5.0 / max((maximum - minimum), default=1.0)
    model_to_viewer = Matrix.Scale(scale_factor, 4) @ Matrix.Translation(-center)
    viewer_to_model = BLENDER_TO_THREE.inverted() @ model_to_viewer.inverted()
    boundary = load_boundary()
    profile = create_boundary_profile(boundary)
    hair, triangle_count = build_cap(head, profile, model_to_viewer, viewer_to_model)

    bpy.ops.object.select_all(action="DESELECT")
    head.select_set(True)
    hair.select_set(True)
    bpy.context.view_layer.objects.active = head
    bpy.ops.export_scene.gltf(
        filepath=str(OUTPUT_MODEL),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_animations=False,
    )
    print(
        f"Exported {OUTPUT_MODEL} with {triangle_count} cap triangles; "
        f"head center={tuple(round(value, 4) for value in center)}, scale={scale_factor:.4f}"
    )


if __name__ == "__main__":
    main()
