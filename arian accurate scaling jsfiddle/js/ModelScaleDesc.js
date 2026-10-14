/*!
 * @file Descriptions (tables) of how to scale
 * different Mii body models and their bone names.
 * @author Arian Kordi <https://github.com/ariankordi>
 */

// @ts-check

import * as THREE from 'three';

/** @typedef {import('./SkeletonScalingExtensions.js').BoneWithScaling} BoneWithScaling */

// // ---------------------------------------------------------------------
// //  Descriptions for Body Model Scaling
// // ---------------------------------------------------------------------

/**
 * Describes the ways in which to apply the scale vector on
 * the model's bones. Each array represents names of bones.
 * @typedef {Object} ModelScaleDesc
 * @property {Array<string>|null} xyz - List of bones that should be scaled with the unmodified scale vector.
 * If null, then all bones will receive the unmodified scale vector, unless ones excluded in `none`.
 * @property {Array<string>} xyzYMin1 - List of bones that should be scaled with all three dimensions
 * of the scale vector, but with Y clamped to a minimum of 1.0. Used for the head bone (cosmetic neck).
 * @property {Array<string>|null} yxz - List of bones that should be scaled using the scale vector with Y and X swapped.
 * If null, then all bones will receive the the vector with Y and X swapped, unless ones excluded in `none`.
 * @property {Array<string>} scalar - List of bones that should be scaled uniformly using X for all dimensions.
 * @property {Array<string>|null} none - List of bones that should receive no additional scale.
 * Only applicable if `xyz` or `yxz` are non-null.
 * @property {string} root - The name of the root bone for which to adjust translation
 * (usually something along the lines of "skl_root").
 * @property {string} head - The name of the bone for which to attach the model's head.
 * NOTE: The head bone is not necessarily used for scaling, but is provided here for convenience.
 */

/**
 * Scaling description for the body model used in the editor.
 * Tested with Wii U (MiiBodyMiddle.bfres) and Switch (MiiBodyHigh.bfres) body models.
 * Also tested with the Wii (Mii Channel) body model, and the 3DS body should work too.
 * This model is mostly unused outside of system titles and certain first-party Wii channels (Wii Room).
 * Main reference: mii_VariableIconBodyImpl.o from NintendoSDK,
 * void nn::mii::detail::`anonymous namespace'::UpdateScale(class nn::util::Vector3f *,
 * enum nn::mii::detail::VriableIconBodyBoneKind, struct nn::util::Float3 const &)
 * @type {ModelScaleDesc}
 */
const editorBodyScaleDesc = {
	root: 'skl_root', // Adjust translation based on skl_root.
	head: 'head', // Head bone.
	xyz: null, // Let all bones receive full XYZ scale by default.
	xyzYMin1: ['head'], // Prevent neck from appearing too short.
	// The arms and elbows receive YXZ scale.
	yxz: ['arm_l1', 'arm_l2', 'arm_r1', 'arm_r2', 'elbow_l', 'elbow_r'],
	// Wrist, Shoulder, Ankle, Knee
	scalar: ['wrist_l', 'wrist_r', 'shoulder_l', 'shoulder_r',
		'ankle_l', 'ankle_r', 'knee_l', 'knee_r'],
	none: ['all_root', 'body']
	// NOTE: Bone whitelist or blacklist? This is using blacklist, but perhaps
	// for models with more bones/roots, a whitelist will cause less problems.
};

/**
 * Scaling description for the body model used in Miitomo, which
 * is similar to the model used in Tomodachi Life 3DS.
 * In contrast to the editor body, its bones use YXZ scale by default.
 * Reference: FUN_005357f0 in libcocos2dcpp.so 2.4.0 (inlined anim lerp/body scaling)
 * @type {ModelScaleDesc}
 */
const archBodyScaleDesc = {
	root: 'Skl_Root',
	head: 'Head', // Head bone. Note that there is also "z_Head".
	xyz: [], // No bones are receiving XYZ scale.
	xyzYMin1: [],
	yxz: null, // All bones receive YXZ scale by default.
	// Wrist, Ankle (no shoulders, knees)
	scalar: ['Ankle_R', 'Ankle_L', 'Wrist_R', 'Wrist_L'],
	// Above are referenced in body scale func. (Other bones are not mentioned by strings)
	// At the beginning of body scale func, jointRoot and Head are skipped.
	none: ['jointRoot', 'Head', 'nw4f_root'/** < For Super Mario Maker 2 bfres */]
};

/**
 * Detects and returns the appropriate {@link ModelScaleDesc} for the body model.
 * Currently just differentiates between editor's body model and Miitomo body model.
 * @param {THREE.Object3D} object - The model for which to detect the description.
 * @returns {ModelScaleDesc} The `ModelScaleDesc` that was detected.
 * @throws {Error} Throws if the `ModelScaleDesc` could not be detected.
 */
function detectModelDesc(object) {
	/** @type {ModelScaleDesc|null} */
	let desc = null;

	// Since the name/capitalization of skl_root differs,
	// this will be used to differentiate between editor and Miitomo body.
	object.traverse((bone) => {
		// if (!(bone instanceof THREE.Bone)) {
		// 	return;
		// }
		// ^^ may not work reliably? because some are nodes...?
		switch (bone.name) {
			case 'Skl_Root':
				desc = archBodyScaleDesc;
				break;
			case 'skl_root':
				desc = editorBodyScaleDesc;
				break;
		}
	});

	if (!desc) {
		throw new Error('detectModelDesc: Could not detect based on bone names.');
	}

	return desc;
}

/**
 * Checks if a node name is explicitly mentioned in one of the lists in the description.
 * Used to decide whether a joint that is NOT a skinned bone should be scaled.
 * @param {ModelScaleDesc} desc - Scaling behavior descriptor for the model.
 * @param {string} name - The node name.
 * @returns {boolean} True if the name is explicitly listed for scaling.
 */
function isExplicitlyScaled(desc, name) {
	return !!(desc.xyz?.includes(name) || desc.yxz?.includes(name) ||
		desc.scalar.includes(name) || desc.xyzYMin1.includes(name));
}

/**
 * Apply scaling to a model's bones based on a given scale description.
 * If there are multiple SkinnedMeshes, make sure the bones are shared
 * between them by checking the IDs. Otherwise, this needs to run for every SkinnedMesh.
 *
 * In addition to the bones of each skeleton, this scales joints that are NOT skinned
 * (GLTFLoader only makes THREE.Bone for skinned joints, so e.g. an elbow/shoulder/knee
 * joint can be a plain Object3D) as long as they are explicitly named in `desc`.
 * Without this, those joints would silently stay unscaled and any bones below them
 * would be positioned from an unscaled joint, which shows up as a step at the joint.
 * @param {THREE.Object3D} object - The model to apply scaling to.
 * @param {THREE.Vector3Like} scaleVector - The base scale vector.
 * @param {ModelScaleDesc} desc - Scaling behavior descriptor for the model.
 */
function applyScaleDesc(object, scaleVector, desc) {
	/** @type {Array<THREE.SkinnedMesh>} */
	const skinnedMeshes = [];
	/** Nodes that already got scale from a skeleton's bones. @type {Set<THREE.Object3D>} */
	const handled = new Set();

	// Handle the input as an object with multiple SkinnedMeshes.
	object.traverse((node) => {
		if (node instanceof THREE.SkinnedMesh) {
			skinnedMeshes.push(node);
			const bones = /** @type {THREE.SkinnedMesh} */ (node).skeleton.bones;
			applyScaleDescToBones(bones, scaleVector, desc);
			for (const bone of bones) {
				handled.add(bone);
			}
		}
	});

	// Scale explicitly named joints that are not part of any skeleton.
	object.traverse((node) => {
		if (handled.has(node) || node instanceof THREE.Mesh || !node.name) {
			return;
		}
		if (isExplicitlyScaled(desc, node.name)) {
			applyScaleDescToNode(node, scaleVector, desc);
		}
	});

	// Eager skeleton update (to avoid deferred frame-lagged updates).
	// It will still update without this, but the update will be delayed.
	// This is done last so all nodes have their scale set beforehand.
	for (const mesh of skinnedMeshes) {
		mesh.skeleton.update();
	}
}

/**
 * Apply scaling to the array of bones based on a given scale description.
 * @param {Array<THREE.Bone>} bones - The array of bones to apply scaling to.
 * This comes from {@link THREE.SkinnedMesh.prototype.skeleton.bones}.
 * @param {THREE.Vector3Like} scaleVector - The base scale vector.
 * @param {ModelScaleDesc} desc - Scaling behavior descriptor for the model.
 * @throws {Error} Throws if addSkeletonScalingExtensions has not been called yet.
 */
function applyScaleDescToBones(bones, scaleVector, desc) {
	if (!('attach' in THREE.Skeleton.prototype)) { // Notify the caller if this won't work.
		throw new Error('applyScaleDesc: This function to apply "scalling" has no effect, until "addSkeletonScalingExtensions" is run to patch THREE.Skeleton.prototype to allow per-bone scaling. Try running that first.');
	}

	for (const bone of bones) {
		applyScaleDescToNode(bone, scaleVector, desc);
	}
}

/**
 * Apply scaling to one node (a bone, or a joint that is not skinned).
 * @param {THREE.Object3D} node - The node to set `scalling` on.
 * @param {THREE.Vector3Like} scaleVector - The base scale vector.
 * @param {ModelScaleDesc} desc - Scaling behavior descriptor for the model.
 */
function applyScaleDescToNode(node, scaleVector, desc) {
	const bone = /** @type {BoneWithScaling} */ (/** @type {unknown} */ (node));
	const name = bone.name;

	// Mark root's direct children to be used for translation adjustment.
	// NOTE: This checks the bone's parent name rather than the bone's own name,
	// since the root (e.g. skl_root) is sometimes not skinned and therefore
	// not present in `bones` at all, so it can never be "bone" in this loop.
	// This bone still needs its normal scale/`.scalling` applied below,
	// so this does NOT skip to the next bone like it did previously.
	if (bone.parent?.name === desc.root) {
		bone.scaleForRootAdjust = scaleVector; // Set scale vector to be used.
	}

	// Skip if explicitly listed in `none`.
	if (desc.none?.includes(name)) {
		return;
	}

	/** Final scale vector to be determined for the bone. */
	const scale = new THREE.Vector3();

	// Test for XYZ, YXZ, Y-clamp, and scalar.
	if (desc.xyz?.includes(name)) {
		// console.debug('xyz:', name);
		scale.set(scaleVector.x, scaleVector.y, scaleVector.z);
	} else if (desc.yxz?.includes(name)) {
		// console.debug('yxz:', name);
		scale.set(scaleVector.y, scaleVector.x, scaleVector.z);
	} else if (desc.scalar.includes(name)) {
		// console.debug('scalar:', name);
		scale.setScalar(scaleVector.x);
	} else if (desc.xyzYMin1.includes(name)) {
		scale.set(scaleVector.x, Math.max(scaleVector.y, 1), scaleVector.z);
	} else {
		// Default: Either xyz, yxz, or no scale.
		if (desc.xyz === null) {
			// console.debug('xyz:', name);
			scale.set(scaleVector.x, scaleVector.y, scaleVector.z);
		} else if (desc.yxz === null) {
			// console.debug('yxz:', name);
			scale.set(scaleVector.y, scaleVector.x, scaleVector.z);
		}
		// Else, do not set scale.
	}

	bone.scalling = scale;
}

export {
	editorBodyScaleDesc,
	archBodyScaleDesc,
	detectModelDesc,
	applyScaleDesc,
	applyScaleDescToBones,
	applyScaleDescToNode
};
