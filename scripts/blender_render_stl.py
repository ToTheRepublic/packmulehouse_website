#!/usr/bin/env python3
"""
Headless Blender: import STL(s), frame camera, render still or turntable.

Usage (via wrapper):
  blender -b -P scripts/blender_render_stl.py -- \\
    --input models/kit.stl \\
    --out renders/kit \\
    --mode still|turntable \\
    --frames 36 \\
    --res 1280x720
"""
import argparse
import math
import os
import sys


def parse_args(argv):
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    p = argparse.ArgumentParser()
    p.add_argument("--input", action="append", default=[], help="STL path (repeatable)")
    p.add_argument("--out", required=True, help="Output prefix (dir or file stem)")
    p.add_argument("--mode", choices=("still", "turntable"), default="still")
    p.add_argument("--frames", type=int, default=36)
    p.add_argument("--res", default="1280x720")
    p.add_argument("--engine", default="CYCLES", help="CYCLES (CPU, headless-safe) or BLENDER_EEVEE_NEXT")
    p.add_argument("--samples", type=int, default=16)
    return p.parse_args(argv)


def ensure_dir(path):
    d = path if os.path.isdir(path) or path.endswith(os.sep) else os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)


def import_stls(paths):
    import bpy

    imported = []
    for path in paths:
        path = os.path.abspath(path)
        if not os.path.isfile(path):
            raise FileNotFoundError(path)
        bpy.ops.wm.stl_import(filepath=path)
        obj = bpy.context.selected_objects[-1] if bpy.context.selected_objects else None
        if obj:
            obj.name = os.path.splitext(os.path.basename(path))[0]
            imported.append(obj)
    return imported


def fit_objects(objects):
    import bpy
    from mathutils import Vector

    if not objects:
        return 1.0, Vector((0, 0, 0))
    mins = Vector((1e9, 1e9, 1e9))
    maxs = Vector((-1e9, -1e9, -1e9))
    for obj in objects:
        for corner in obj.bound_box:
            w = obj.matrix_world @ Vector(corner)
            mins.x, mins.y, mins.z = min(mins.x, w.x), min(mins.y, w.y), min(mins.z, w.z)
            maxs.x, maxs.y, maxs.z = max(maxs.x, w.x), max(maxs.y, w.y), max(maxs.z, w.z)
    center = (mins + maxs) * 0.5
    size = (maxs - mins).length or 1.0
    # Center on origin, sit on Z=0
    for obj in objects:
        obj.location -= center
        obj.location.z -= (mins.z - center.z)
    return size, Vector((0, 0, (maxs.z - mins.z) * 0.5))


def setup_scene(size, look_at, res_x, res_y, engine, samples):
    import bpy

    scene = bpy.context.scene
    # Prefer EEVEE Next, then EEVEE, then Cycles
    engines = bpy.data.scenes[0].render.engine
    available = {e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items}
    if engine not in available:
        for cand in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"):
            if cand in available:
                engine = cand
                break
    scene.render.engine = engine
    scene.render.resolution_x = res_x
    scene.render.resolution_y = res_y
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"

    if engine.startswith("CYCLES"):
        scene.cycles.samples = samples
        scene.cycles.use_denoising = True
        scene.cycles.device = "CPU"
    else:
        if hasattr(scene, "eevee"):
            scene.eevee.taa_render_samples = max(8, samples)

    # Dark studio matching the site
    world = bpy.data.worlds.new("World") if "World" not in bpy.data.worlds else bpy.data.worlds["World"]
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.043, 0.043, 0.043, 1)
        bg.inputs[1].default_value = 1.0

    # Camera
    cam_data = bpy.data.cameras.new("PMHCam")
    cam = bpy.data.objects.new("PMHCam", cam_data)
    bpy.context.collection.objects.link(cam)
    dist = size * 1.6
    cam.location = (dist * 0.7, -dist, dist * 0.45)
    # Point at object
    track = cam.constraints.new(type="TRACK_TO")
    empty = bpy.data.objects.new("LookAt", None)
    empty.location = look_at
    bpy.context.collection.objects.link(empty)
    track.target = empty
    track.track_axis = "TRACK_NEGATIVE_Z"
    track.up_axis = "UP_Y"
    scene.camera = cam
    cam_data.lens = 50

    # Key + fill + rim
    def lamp(name, loc, energy, color=(1, 0.95, 0.88)):
        data = bpy.data.lights.new(name, type="AREA")
        data.energy = energy
        data.color = color
        data.size = size * 0.8
        obj = bpy.data.objects.new(name, data)
        obj.location = loc
        bpy.context.collection.objects.link(obj)
        return obj

    lamp("Key", (size, -size * 1.2, size * 1.4), energy=size * 80)
    lamp("Fill", (-size * 1.2, -size * 0.4, size * 0.6), energy=size * 25, color=(0.55, 0.7, 0.72))
    lamp("Rim", (0, size * 1.1, size * 0.9), energy=size * 40)

    # Simple tan/teal material on imported meshes
    mat = bpy.data.materials.new("PMHMat")
    mat.use_nodes = True
    principled = mat.node_tree.nodes.get("Principled BSDF")
    if principled:
        principled.inputs["Base Color"].default_value = (0.77, 0.65, 0.45, 1)
        if "Roughness" in principled.inputs:
            principled.inputs["Roughness"].default_value = 0.45
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH" and obj.name not in ("Cube",):
            if obj.data.materials:
                obj.data.materials[0] = mat
            else:
                obj.data.materials.append(mat)

    return cam, empty


def main():
    import bpy

    args = parse_args(sys.argv)
    if not args.input:
        print("ERROR: pass --input path.stl (repeatable)", file=sys.stderr)
        sys.exit(2)

    # Fresh scene
    bpy.ops.wm.read_factory_settings(use_empty=True)

    objs = import_stls(args.input)
    if not objs:
        print("ERROR: no meshes imported", file=sys.stderr)
        sys.exit(1)

    size, look = fit_objects(objs)
    w, h = [int(x) for x in args.res.lower().split("x")]
    cam, empty = setup_scene(size, look, w, h, args.engine, args.samples)

    out = os.path.abspath(args.out)
    ensure_dir(out if args.mode == "turntable" else os.path.dirname(out) or ".")

    scene = bpy.context.scene
    if args.mode == "still":
        dest = out if out.lower().endswith(".png") else out + ".png"
        scene.render.filepath = dest
        bpy.ops.render.render(write_still=True)
        print("WROTE", dest)
        return

    # Turntable: rotate empty (or objects) around Z
    n = max(2, args.frames)
    scene.frame_start = 1
    scene.frame_end = n
    for i in range(n):
        angle = (i / n) * 2 * math.pi
        for obj in objs:
            obj.rotation_euler[2] = angle
        frame_path = os.path.join(out, f"frame_{i:04d}.png")
        scene.render.filepath = frame_path
        bpy.ops.render.render(write_still=True)
        print("WROTE", frame_path)


if __name__ == "__main__":
    main()
