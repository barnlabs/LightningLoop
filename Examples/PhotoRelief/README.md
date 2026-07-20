# Photo-to-3D relief proof

This checked-in example was generated from the BarnLabs-owned LightningLoop app icon with the dependency-free `Tools/photo_to_relief.mjs` workflow. It produces textured GLB and OBJ models, a shaded preview, and a JSON validation report. The tool reopens the GLB container and fails unless it contains a nonempty mesh, embedded PNG texture, and material.

The model contains 4,096 vertices and 7,938 triangles. It is an honest single-view 2.5D luminance relief; it does not claim to reconstruct geometry hidden from the photograph.

A single image cannot recover hidden geometry. This is intentionally labeled a textured 2.5D luminance relief, not photogrammetry or a complete reconstructed object.
