/*!
 * @file Extensions for Three.js to help allow per-bone scaling of skeletons.
 * @author Arian Kordi <https://github.com/ariankordi>
 */

// @ts-check
/*
Helpful references:
- [ ] https://github.com/lo-th/phy/blob/main/src/3TH/character/SkeletonExtand.js
- [ ] https://github.com/lo-th/lab/blob/master/src/lth/Skeleton_Add.js
- [ ] https://github.com/lo-th/Avatar.lab/blob/gh-pages/src/skeleton.js
Author of the THREE.Skeleton.prototype.update override, and
thus this entire method for scaling a model, is lo-th.
All other references I found on GitHub were simply copying his code.
*/

import * as THREE from 'three';

// // ---------------------------------------------------------------------
// //  Extensions for Skeleton Scaling
// // ---------------------------------------------------------------------

/**
 * A description for a model attached to a bone on a {@link THREE.Skeleton}.
 * This kind of attachment will follow the position of a scaled bone
 * while also allowing the attached model to maintain its own separate scale.
 * @typedef {{
 * obj: THREE.Object3D,
 * boneIdx: number,
 * localScale: THREE.Vector3|null
 * }} SkeletonAttachment
 */

/**
 * Cached information about a skeleton's place in the node hierarchy.
 * @typedef {{
 * bones: Array<THREE.Bone>,
 * count: number,
 * indexMap: Map<THREE.Object3D, number>,
 * starts: Array<THREE.Object3D>,
 * missing: Array<number>
 * }} SkeletonHierarchyInfo
 */

/**
 * Custom version of {@link THREE.Skeleton} to add attachments.
 * @typedef {THREE.Skeleton & {
 * _attachments: Array<SkeletonAttachment>|undefined,
 * _hierarchyInfo: SkeletonHierarchyInfo|undefined,
 * attach: function(THREE.Object3D, string, boolean=): void,
 * detach: function(THREE.Object3D): void
 * detachAll: function(): void
 * }} SkeletonWithAttachments
 */

/**
 * Custom version of {@link THREE.Bone} with custom scaling properties.
 * Note that the misspelled "scalling" name is still used from lo-th's original code.
 * NOTE: This property may also be set on plain {@link THREE.Object3D} nodes
 * (joints that are not skinned, so GLTFLoader did not make them THREE.Bone).
 * @typedef {THREE.Bone & {
 * scalling: THREE.Vector3|undefined,
 * scaleForRootAdjust: THREE.Vector3Like|undefined,
 * scaleForRootSelf: THREE.Vector3Like|undefined,
 * }} BoneWithScaling
 */

/**
 * Adds extensions (override functions) to the THREE.Skeleton namespace ({@link THREE.Skeleton})
 * to enable hierarchical per-bone local scaling for Three.js skeletons.
 * @param {typeof THREE.Skeleton} Skeleton - The THREE.Skeleton class.
 */
function addSkeletonScalingExtensions(Skeleton) {
	// NOTE: This used to check Skeleton.prototype._attachments, but that is only
	// ever set on instances, so the "already run" check could never trigger.
	if (/** @type {any} */ (Skeleton.prototype)._scalingExtended) {
		console.warn('addSkeletonScalingExtensions: Already run, skipping.');
		return; // Already run, skip this.
	}
	/** @type {any} */ (Skeleton.prototype)._scalingExtended = true;

	// Replace function that runs every time a skeleton is updated.
	// Original function (r178, 2025, functionality is simple):
	// https://github.com/mrdoob/three.js/blob/e117b283555e0ccc5034fa5193b951bc987280ed/src/objects/Skeleton.js#L198
	Skeleton.prototype.update = (function () {
		// Static, shared variables to be used temporarily for every run.

		/** @readonly */ // - (Below two are defined in three.js Skeleton.js)
		const _identityMatrix = /* @__PURE__ */ new THREE.Matrix4().identity();
		// Used to flatten each bone's final matrix:
		const _offsetMatrix = /* @__PURE__ */ new THREE.Matrix4();

		const scaleMatrix = /* @__PURE__ */ new THREE.Matrix4();
		/** Skinning-only world matrix for the root bone (see `scaleForRootSelf`). */
		const _rootSkinMatrix = /* @__PURE__ */ new THREE.Matrix4();
		const posVec = /* @__PURE__ */ new THREE.Vector3();

		// Used for decomposing/composing when updating attachments:
		const tmpQuat = /* @__PURE__ */ new THREE.Quaternion();
		const tmpTrans = /* @__PURE__ */ new THREE.Vector3();

		/**
		 * One scratch matrix per depth of the hierarchy walk, to hold the
		 * scaled world matrix of the node being visited at that depth.
		 * (Recursion means one shared matrix would be overwritten by children.)
		 * @type {Array<THREE.Matrix4>}
		 */
		const _depthMatrices = [];

		// State for the hierarchy walk, set at the start of every update().
		/** @type {Map<THREE.Object3D, number>|null} */
		let _walkIndexMap = null;
		/** @type {Float32Array|null} */
		let _walkBoneMatrices = null;
		/** @type {Array<THREE.Matrix4>|null} */
		let _walkBoneInverses = null;

		/**
		 * Adjusts translation, if this bone is a direct child of the root (skl_root).
		 * @param {THREE.Object3D &
		 * {scaleForRootAdjust: THREE.Vector3Like|undefined}} bone - The bone to check/adjust for.
		 * @param {THREE.Matrix4} matrix - The local matrix.
		 * @param {THREE.Vector3Like|undefined} [scaleOverride] - Scale vector to use instead of
		 * the bone's `scaleForRootAdjust`. Used to adjust the root bone itself (see `scaleForRootSelf`).
		 */
		function adjustTranslationForRoot(bone, matrix, scaleOverride) {
			// scaleForRootAdjust being present on the bone itself indicates its parent is root.
			// NOTE: This checks the bone's own property rather than the parent's, since the
			// root (e.g. skl_root) is sometimes not skinned, so it may not be a THREE.Bone
			// instance at all (GLTFLoader only creates THREE.Bone for skinned joints).
			const scale = scaleOverride || bone.scaleForRootAdjust;
			if (!scale) {
				return;
			}

			// Get translation/W-axis from matrix.
			const translation = tmpTrans.setFromMatrixPosition(matrix);
			// (Scale vector used to adjust translation is `scale`, above.)

			// Multiply translation by YYX axes:
			translation.x *= scale.y;
			translation.y *= scale.y;
			translation.z *= scale.x;
			// Move Y down to keep the model's root (legs) planted.
			translation.y += (scale.x - scale.y); //* 1.0;
			// 1.0 = Local-to-world scale of the body model.

			matrix.setPosition(translation); // Set translation back on matrix.
		}

		/**
		 * @param {Array<SkeletonAttachment>} attachments - The attachment array.
		 * @param {Parameters<typeof THREE.Matrix4.prototype.fromArray>[0]} boneMatrices -
		 * The raw matrices array to update the attachment with.
		 * @param {typeof THREE.Skeleton.prototype.boneInverses} boneInverses -
		 * boneInverses array from the skeleton, to apply inverse bind matrix.
		 */
		function updateAttachments(attachments, boneMatrices, boneInverses) {
			for (const at of attachments) {
				// _offsetMatrix - Temporary matrix for the bone's worldMatrix.
				// scaleMatrix - Temporary matrix for the inverted parent.

				// Get the world matrix of the bone we just fed to skinning:
				_offsetMatrix.fromArray(boneMatrices, at.boneIdx * 16); // Already scaled.

				// Apply the inverse bind matrix to the attachment.
				_offsetMatrix.multiplyMatrices(_offsetMatrix,
					scaleMatrix.copy(boneInverses[at.boneIdx]).invert());

				// The caller wants to preserve the attachment's own local scale.
				if (at.localScale) {
					// Remove the bone's scale by re-composing with the local scale.
					_offsetMatrix.decompose(tmpTrans, tmpQuat, posVec);
					_offsetMatrix.compose(tmpTrans, tmpQuat, at.localScale);
				}

				// Copy bone-space to world-space for the attachment.
				// at.obj.matrixWorld.copy(_offsetMatrix);// .multiply(at.local);
				// at.obj.matrixWorldNeedsUpdate = false; // Make the matrix stay put.

				/** The world matrix of the object's parent, or identity if there is none. */
				const parentWorld = at.obj.parent ? at.obj.parent.matrixWorld : _identityMatrix;
				scaleMatrix.copy(parentWorld).invert(); // Convert world to local matrix.

				// Multiply two matrices and store result in the object's matrix.
				at.obj.matrix.multiplyMatrices(scaleMatrix, _offsetMatrix);
				at.obj.updateMatrixWorld(true); // Update now. (Not recommended to change directly.)
			}
		}

		/**
		 * Works out (and caches) where this skeleton's bones sit in the node
		 * hierarchy: a map from bone to its index in `skeleton.bones`, and the
		 * top-level node(s) the parent-first walk needs to start from.
		 * The walk starts at the highest ancestor below the Scene rather than at
		 * the topmost bone, so that scaled non-bone joints above a bone count too.
		 * @param {SkeletonWithAttachments} skeleton - The skeleton.
		 * @returns {SkeletonHierarchyInfo} The cached hierarchy information.
		 */
		function getHierarchyInfo(skeleton) {
			const bones = skeleton.bones;
			const cached = skeleton._hierarchyInfo;
			if (cached && cached.bones === bones && cached.count === bones.length) {
				return cached;
			}

			/** @type {Map<THREE.Object3D, number>} */
			const indexMap = new Map();
			/** @type {Array<number>} */
			const missing = []; // Indices of undefined bones, which get identity.
			for (let i = 0; i < bones.length; i++) {
				if (bones[i]) {
					indexMap.set(bones[i], i);
				} else {
					missing.push(i);
				}
			}

			/** @type {Set<THREE.Object3D>} */
			const starts = new Set();
			for (const bone of indexMap.keys()) {
				/** @type {THREE.Object3D} */
				let top = bone;
				while (top.parent && !(/** @type {THREE.Scene} */ (top.parent).isScene)) {
					top = top.parent;
				}
				starts.add(top);
			}

			/** @type {SkeletonHierarchyInfo} */
			const info = {
				bones, count: bones.length, indexMap, starts: [...starts], missing
			};
			skeleton._hierarchyInfo = info;
			return info;
		}

		/**
		 * Visits a node (parent first), applies its per-node scaling, writes its
		 * skinning matrix if it is a bone in the skeleton, and then moves each child
		 * so that it follows the position of this (possibly scaled) node.
		 * This works on every node of the hierarchy, not just direct bone children,
		 * so scaled/unscaled non-bone joints in between do not break the chain,
		 * and the order of `skeleton.bones` no longer matters.
		 * @param {THREE.Object3D} node - The node to visit. Its matrixWorld position
		 * must have already been corrected by its parent.
		 * @param {number} depth - Depth of the walk, for the scratch matrices.
		 */
		function visit(node, depth) {
			const scalling = /** @type {BoneWithScaling} */ (/** @type {unknown} */ (node)).scalling;
			/** The node's world matrix. It will be re-assigned if there is scaling. */
			let matrixWorld = node.matrixWorld;

			// If the node has "scalling" (note spelling!), apply it.
			if (scalling) {
				const scratch = _depthMatrices[depth] ||
					(_depthMatrices[depth] = new THREE.Matrix4());
				matrixWorld = scratch.copy(matrixWorld).scale(scalling);

				// Adjust translation for the root (skl_root).
				adjustTranslationForRoot(
					/** @type {BoneWithScaling} */ (/** @type {unknown} */ (node)), matrixWorld);
			}

			// Update boneMatrices[] (like the original update function)
			const idx = /** @type {Map<THREE.Object3D, number>} */ (_walkIndexMap).get(node);
			if (idx !== undefined) {
				/** The world matrix that is fed to skinning for this bone. */
				let skinWorld = matrixWorld;
				// If this is the root bone itself and it has skinned vertices (for example
				// the top of the pants' waistband), it must be moved exactly like its
				// children (chest, hip) or those vertices stay behind when height changes.
				// This is ONLY used for skinning: children below still receive the
				// unadjusted `matrixWorld`, because they apply this adjustment themselves.
				const rootSelf = /** @type {BoneWithScaling} */ (/** @type {unknown} */ (node)).scaleForRootSelf;
				if (rootSelf) {
					skinWorld = _rootSkinMatrix.copy(matrixWorld);
					adjustTranslationForRoot(
						/** @type {BoneWithScaling} */ (/** @type {unknown} */ (node)), skinWorld, rootSelf);
				}
				_offsetMatrix.multiplyMatrices(skinWorld,
					/** @type {Array<THREE.Matrix4>} */ (_walkBoneInverses)[idx]);
				_offsetMatrix.toArray(/** @type {Float32Array} */ (_walkBoneMatrices), idx * 16);
			}

			// Children follow the (possibly scaled) parent's position. This is done
			// for every node, not only scaled ones, so that corrections made higher
			// up the hierarchy carry down through unscaled nodes. If nothing above
			// was scaled, this just recomputes the same position.
			for (const child of node.children) {
				scaleMatrix.copy(matrixWorld).multiply(child.matrix);
				posVec.setFromMatrixPosition(scaleMatrix);
				child.matrixWorld.setPosition(posVec);
				visit(child, depth + 1);
			}
		}

		/**
		 * Override of the update function to apply per-bone scaling and attachments.
		 * In the author (https://github.com/lo-th)'s words: "force local scalling"
		 * From lab (2019): https://github.com/lo-th/lab/blob/5e8949f3202a952df2269e80f40a93f362cf22aa/src/lth/Skeleton_Add.js#L136
		 * From Avatar.lab (2017): https://github.com/lo-th/Avatar.lab/blob/e96e7f3862c04feb7ce9fb6744561ffb8661fb21/src/skeleton.js#L5
		 * @this {SkeletonWithAttachments}
		 */
		return function update() {
			console.assert(this.boneMatrices instanceof Float32Array); // Enforce non-null.
			const boneMatrices = /** @type {Float32Array} */ (this.boneMatrices);

			const info = getHierarchyInfo(this);
			_walkIndexMap = info.indexMap;
			_walkBoneMatrices = boneMatrices;
			_walkBoneInverses = this.boneInverses;

			// Walk the hierarchy parent-first, filling boneMatrices[].
			for (const start of info.starts) {
				visit(start, 0);
			}

			// Bone entries that are undefined get the identity matrix, as before.
			for (const i of info.missing) {
				_offsetMatrix.multiplyMatrices(_identityMatrix, this.boneInverses[i]);
				_offsetMatrix.toArray(boneMatrices, i * 16);
			}

			// Don't hold on to references between updates.
			_walkIndexMap = null;
			_walkBoneMatrices = null;
			_walkBoneInverses = null;

			// Update all registered attachments after bones are updated.
			if (this._attachments) {
				updateAttachments(this._attachments, boneMatrices, this.boneInverses);
			}

			// Finally, update boneTexture (like the original update function)
			if (this.boneTexture) {
				this.boneTexture.needsUpdate = true;
			}
		};
	})();

	// Define SkeletonWithAttachments extensions.

	/** @type {SkeletonWithAttachments} */ (Skeleton.prototype).attach =
	/**
	 * @param {THREE.Object3D} obj - The Object3D to attach (SkinnedMesh, glTF scene, etc.)
	 * @param {string} boneName - Bone name to look up once.
	 * @param {boolean} [useBoneScale] - If this is false, then the bone's individual
	 * scale is ignored, and the object's local scale will be used when attaching.
	 * @throws {Error} Throws if the bone specified in `boneName` cannot be found.
	 * @this {SkeletonWithAttachments}
	 */
	function (obj, boneName, useBoneScale = false) {
		const boneIdx = this.bones.findIndex(b => b.name === boneName);
		if (boneIdx === -1) {
			throw new Error(`Bone '${boneName}' not found.`);
		}

		// Turn off auto‐updates so our manual matrix stays put.
		obj.matrixAutoUpdate = false;
		// obj.matrixWorldAutoUpdate = false; // Not modifying matrixWorld directly.

		const localScale = useBoneScale ? null : obj.scale;
		/** @type {SkeletonAttachment} */
		const att = { obj, boneIdx, localScale };

		// Add the attachment or create the _attachments array.
		if (this._attachments) {
			this._attachments.push(att);
		} else {
			this._attachments = [att];
		}
		// this.update(); // Update the attachment instantly. (Not needed)
	};

	/** @type {SkeletonWithAttachments} */ (Skeleton.prototype).detach =
	/**
	 * @param {THREE.Object3D} obj - The object to detach.
	 * @this {SkeletonWithAttachments}
	 */
	function (obj) {
		if (this._attachments) {
			this._attachments = this._attachments.filter(a => a.obj !== obj);
		}
	};

	/** @type {SkeletonWithAttachments} */ (Skeleton.prototype).detachAll =
	function () {
		this._attachments = undefined;
	};
}

export { addSkeletonScalingExtensions };
