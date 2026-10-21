/**
 * Animation controls of the presentation ribbon.
 */

import { ANIMATION_PICK_REASON, ANIMATION_SELECT_REASON, button, hasObjects } from "./ribbon-shared.js";
/** @typedef {import("./ribbon-shared.js").RibbonContext} RibbonContext */
/** @typedef {import("./ribbon-shared.js").Control} Control */

export const ANIMATION_TRIGGER_OPTIONS = [
  { value: "click", label: "On click" },
  { value: "with", label: "With previous" },
  { value: "after", label: "After previous" }
];

/** @param {RibbonContext} ctx */
export const hasAnimation = (ctx) => Boolean(ctx.presentationEditor?.getSelectedAnimation());

/**
 * Position of the selected animation in the slide's order, or -1.
 * @param {RibbonContext} ctx
 * @returns {number}
 */
export function animationIndex(ctx) {
  const editor = ctx.presentationEditor;
  const selected = editor?.getSelectedAnimation();
  return selected && editor ? editor.getAnimations().findIndex((animation) => animation.id === selected.id) : -1;
}

/** @param {RibbonContext} ctx */
export const canApplyEffect = (ctx) => hasObjects(ctx) || hasAnimation(ctx);

/**
 * A gallery button: it sets the effect of the selected animation, or, when none is selected
 * (or it belongs to another object), animates the selected objects with it.
 * @param {"appear" | "fade-in" | "motion"} effect
 * @param {string} label
 * @param {string} title
 * @param {string} iconName
 * @returns {Control}
 */
export function animationEffectButton(effect, label, title, iconName) {
  return button({
    id: `animation-${effect}`,
    label,
    title,
    icon: iconName,
    attrs: { "data-action": `animation-${effect}` },
    enabled: canApplyEffect,
    disabledReason: ANIMATION_SELECT_REASON,
    active: (ctx) => ctx.presentationEditor?.getSelectedAnimation()?.effect === effect,
    action: (ctx) => ctx.presentationEditor?.applyAnimationEffect(effect)
  });
}

/**
 * Number field for how far the selected motion animation travels along one axis (px). The
 * start point stays where it is; the end point moves.
 * @param {"x" | "y"} axis
 * @returns {Control}
 */
export function animationDistanceField(axis) {
  return {
    id: `animation-move-${axis}`,
    kind: "field",
    label: `Move ${axis.toUpperCase()} (px)`,
    icon: "motion-path",
    attrs: { "data-action": `animation-move-${axis}` },
    enabled: (ctx) => ctx.presentationEditor?.getSelectedAnimation()?.effect === "motion",
    disabledReason: "Distance applies to Motion path animations",
    value: (ctx) => {
      const path = ctx.presentationEditor?.getSelectedAnimation()?.path;
      return path ? Math.round(path.to[axis] - path.from[axis]) : "";
    },
    apply: (ctx, value) => {
      const path = ctx.presentationEditor?.getSelectedAnimation()?.path;
      if (!path) return;
      ctx.presentationEditor?.updateAnimation({ path: { from: path.from, to: { ...path.to, [axis]: path.from[axis] + value } } });
    }
  };
}

/**
 * Number field for the selected animation's delay or duration (milliseconds).
 * @param {"delay" | "duration"} key
 * @param {string} label
 * @param {number} min
 * @returns {Control}
 */
export function animationTimeField(key, label, min) {
  return {
    id: `animation-${key}`,
    kind: "field",
    label,
    icon: "transition",
    min,
    attrs: { "data-action": `animation-${key}` },
    enabled: hasAnimation,
    disabledReason: ANIMATION_PICK_REASON,
    value: (ctx) => ctx.presentationEditor?.getSelectedAnimation()?.[key] ?? "",
    apply: (ctx, value) => ctx.presentationEditor?.updateAnimation({ [key]: value })
  };
}
