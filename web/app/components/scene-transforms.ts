import { Mesh, type Object3D } from "three";

/** Bake fixed mesh-local transforms; animated parents still update world matrices. */
export function freezeMeshTransforms(root: Object3D) {
  root.traverse(object => {
    if (object instanceof Mesh) {
      object.updateMatrix();
      object.matrixAutoUpdate = false;
    }
  });
}
