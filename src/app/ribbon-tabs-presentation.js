/**
 * Presentation tabs of the ribbon.
 */

import { h } from "./dom.js";
import { LAYOUTS } from "../presentation/layouts.js";
import { SIZE_PRESETS } from "../presentation/geometry.js";
import { ANIMATION_TRIGGER_OPTIONS, animationDistanceField, animationEffectButton, animationIndex, animationTimeField, canApplyEffect, hasAnimation } from "./ribbon-animation.js";
import { ANIMATION_PICK_REASON, ANIMATION_SELECT_REASON, THEME_REASON, button, canEditPresText, hasObjects, hasPres, hasSlide, historyControls, seam } from "./ribbon-shared.js";
/** @typedef {import("./ribbon-shared.js").RibbonContext} RibbonContext */
/** @typedef {import("./ribbon-shared.js").Control} Control */
/** @typedef {import("./ribbon-shared.js").Tab} Tab */

const SHAPE_ITEMS = [
  { shape: "rect", label: "Rectangle", icon: "rect" },
  { shape: "roundRect", label: "Rounded rectangle", icon: "roundrect" },
  { shape: "ellipse", label: "Ellipse", icon: "ellipse" },
  { shape: "triangle", label: "Triangle", icon: "triangle" },
  { shape: "arrow", label: "Arrow", icon: "arrow" }
];

const ARRANGE_ITEMS = [
  { op: "front", label: "Bring to front", icon: "bring-front" },
  { op: "forward", label: "Bring forward", icon: "bring-forward" },
  { op: "backward", label: "Send backward", icon: "send-backward" },
  { op: "back", label: "Send to back", icon: "send-back" }
];

const TRANSITION_STYLE_OPTIONS = [
  { value: "none", label: "None" },
  { value: "fade", label: "Fade" },
  { value: "wipe", label: "Wipe" }
];

const TRANSITION_DIRECTION_OPTIONS = [
  { value: "left", label: "From left" },
  { value: "right", label: "From right" },
  { value: "up", label: "From top" },
  { value: "down", label: "From bottom" }
];

/**
 * The link popover for presentations: the caret/selection while a text object is
 * being edited, otherwise the selected object. Mirrors the document popover.
 * @param {RibbonContext} ctx
 * @param {() => void} close
 * @returns {HTMLElement}
 */
function presentationLinkPopover(ctx, close) {
  return ctx.presentationEditor?.createLinkForm(close) ?? h("div", { class: "popover-body" });
}

/**
 * @param {string} mark
 * @param {string} label
 * @param {string} iconName
 * @returns {Control}
 */
function presentationMark(mark, label, iconName) {
  return {
    id: `pres-mark-${mark}`,
    kind: "toggle",
    size: "small",
    label,
    icon: iconName,
    attrs: { "data-action": "mark", "data-mark": mark },
    enabled: canEditPresText,
    active: (ctx) => Boolean(ctx.presentationEditor?.markActive(/** @type {any} */ (mark))),
    action: (ctx) => ctx.presentationEditor?.toggleMark(/** @type {any} */ (mark))
  };
}

/**
 * @param {string} align
 * @param {string} label
 * @returns {Control}
 */
function presentationAlign(align, label) {
  return {
    id: `pres-align-${align}`,
    kind: "toggle",
    size: "small",
    label,
    icon: `align-${align}`,
    attrs: { "data-action": "align", "data-align": align },
    enabled: canEditPresText,
    active: (ctx) => ctx.presentationEditor?.getTextState()?.align === align,
    action: (ctx) => ctx.presentationEditor?.setAlign(/** @type {any} */ (align))
  };
}

/** @returns {Control} */
function arrangeMenu() {
  return button({
    id: "arrange",
    kind: "menu",
    label: "Arrange",
    title: "Arrange objects",
    icon: "bring-front",
    attrs: { "data-action": "arrange-menu" },
    enabled: hasObjects,
    items: (ctx) =>
      ARRANGE_ITEMS.map((item) => ({
        label: item.label,
        icon: item.icon,
        attrs: { "data-action": `arrange-${item.op}` },
        action: () => ctx.presentationEditor?.arrange(/** @type {any} */ (item.op))
      }))
  });
}

/** @returns {Control} */
function layoutMenu() {
  return button({
    id: "new-slide",
    kind: "menu",
    label: "New slide",
    icon: "slide-new",
    attrs: { "data-action": "new-slide" },
    enabled: hasPres,
    items: (ctx) =>
      LAYOUTS.map((layout) => ({
        label: layout.label,
        icon: "layout",
        attrs: { "data-action": "new-slide-layout", "data-layout": layout.id },
        action: () => ctx.presentationEditor?.newSlide(layout.id)
      }))
  });
}

/**
 * A Width / Height field that routes through the editor's scale-or-keep popover.
 * @param {"width" | "height"} axis
 * @returns {Control}
 */
function slideSizeField(axis) {
  return {
    id: `slide-${axis}`,
    kind: "field",
    label: axis === "width" ? "Width" : "Height",
    icon: axis === "width" ? "column-width" : "row-height",
    min: 320,
    attrs: { "data-action": `slide-${axis}` },
    enabled: hasPres,
    value: (ctx) => ctx.presentationEditor?.getSize()[axis] ?? "",
    apply: (ctx, value) => {
      const size = ctx.presentationEditor?.getSize();
      if (!size) return;
      ctx.presentationEditor?.requestSlideSize(
        axis === "width" ? value : size.width,
        axis === "height" ? value : size.height
      );
    }
  };
}


/** @returns {Tab[]} */
export function presentationTabs() {
  return [
    {
      id: "home",
      label: "Home",
      groups: [
        {
          id: "clipboard",
          label: "Clipboard",
          controls: [
            button({
              id: "paste",
              label: "Paste",
              title: "Paste the copied objects (Ctrl/Cmd+V)",
              icon: "paste",
              attrs: { "data-action": "paste" },
              enabled: (ctx) => hasSlide(ctx) && Boolean(ctx.presentationEditor?.canPaste()),
              action: (ctx) => ctx.presentationEditor?.paste()
            }),
            button({
              id: "cut",
              label: "Cut",
              size: "small",
              title: "Cut (Ctrl/Cmd+X)",
              icon: "cut",
              attrs: { "data-action": "cut" },
              enabled: hasObjects,
              action: (ctx) => ctx.presentationEditor?.cut()
            }),
            button({
              id: "copy",
              label: "Copy",
              size: "small",
              title: "Copy (Ctrl/Cmd+C)",
              icon: "copy",
              attrs: { "data-action": "copy" },
              enabled: hasObjects,
              action: (ctx) => ctx.presentationEditor?.copy()
            })
          ]
        },
        {
          id: "slides",
          label: "Slides",
          controls: [
            layoutMenu(),
            button({
              id: "duplicate-slide",
              label: "Duplicate",
              size: "small",
              title: "Duplicate slide",
              icon: "duplicate",
              attrs: { "data-action": "duplicate-slide" },
              enabled: hasSlide,
              action: (ctx) => {
                const id = ctx.presentationEditor?.getSlideId();
                if (id) ctx.presentationEditor?.duplicateSlide(id);
              }
            }),
            button({
              id: "delete-slide",
              label: "Delete",
              size: "small",
              title: "Delete slide",
              icon: "trash",
              attrs: { "data-action": "delete-slide" },
              enabled: (ctx) => hasSlide(ctx) && Boolean(ctx.presentationEditor?.canDeleteSlide()),
              action: (ctx) => {
                const id = ctx.presentationEditor?.getSlideId();
                if (id) ctx.presentationEditor?.deleteSlide(id);
              }
            })
          ]
        },
        {
          id: "text",
          label: "Text",
          controls: [
            presentationMark("bold", "Bold", "bold"),
            presentationMark("italic", "Italic", "italic"),
            presentationMark("underline", "Underline", "underline"),
            presentationMark("strike", "Strikethrough", "strike"),
            presentationAlign("left", "Align left"),
            presentationAlign("center", "Align centre"),
            presentationAlign("right", "Align right"),
            button({
              id: "pres-link",
              kind: "menu",
              label: "Link",
              title: "Link",
              icon: "link",
              keepFocus: true,
              attrs: { "data-action": "link" },
              enabled: hasObjects,
              content: presentationLinkPopover
            })
          ]
        },
        { id: "arrange", label: "Arrange", controls: [arrangeMenu()] },
        { id: "history", label: "History", controls: historyControls() }
      ]
    },
    {
      id: "insert",
      label: "Insert",
      groups: [
        {
          id: "objects",
          label: "Objects",
          controls: [
            button({
              id: "insert-textbox",
              kind: "toggle",
              label: "Text box",
              title: "Text box: drag on the slide to draw it",
              icon: "textbox",
              attrs: { "data-action": "insert-textbox" },
              enabled: hasSlide,
              active: (ctx) => ctx.presentationEditor?.getTool()?.type === "text",
              action: (ctx) => {
                const armed = ctx.presentationEditor?.getTool()?.type === "text";
                ctx.presentationEditor?.setTool(armed ? null : { type: "text" });
              }
            }),
            button({
              id: "insert-shape",
              kind: "menu",
              label: "Shape",
              title: "Shape: pick one, then drag on the slide",
              icon: "shape",
              attrs: { "data-action": "insert-shape" },
              enabled: hasSlide,
              active: (ctx) => ctx.presentationEditor?.getTool()?.type === "shape",
              items: (ctx) =>
                SHAPE_ITEMS.map((item) => ({
                  label: item.label,
                  icon: item.icon,
                  attrs: { "data-action": "insert-shape-item", "data-shape": item.shape },
                  action: () => ctx.presentationEditor?.setTool({ type: "shape", shape: item.shape })
                }))
            }),
            button({
              id: "insert-line",
              kind: "toggle",
              label: "Line",
              title: "Line: drag on the slide to draw it",
              icon: "line",
              attrs: { "data-action": "insert-line" },
              enabled: hasSlide,
              active: (ctx) => ctx.presentationEditor?.getTool()?.type === "line",
              action: (ctx) => {
                const armed = ctx.presentationEditor?.getTool()?.type === "line";
                ctx.presentationEditor?.setTool(armed ? null : { type: "line" });
              }
            }),
            button({
              id: "insert-image",
              label: "Image",
              title: "Insert an image from a file",
              icon: "image",
              attrs: { "data-action": "insert-image" },
              enabled: hasSlide,
              action: (ctx) => ctx.presentationEditor?.pickImage()
            })
          ]
        },
        {
          id: "references",
          label: "Reference",
          controls: [
            button({
              id: "reference-embed",
              label: "Embed",
              title: "Show part of another page on this slide, live",
              icon: "link",
              attrs: { "data-action": "reference-embed" },
              enabled: hasSlide,
              action: (ctx, element) => ctx.presentationEditor?.insertEmbed(element)
            }),
            button({
              id: "reference-expression",
              label: "Expression",
              title: "Show the result of a formula over tables and sections",
              icon: "expression",
              attrs: { "data-action": "reference-expression" },
              enabled: hasSlide,
              action: (ctx, element) => ctx.presentationEditor?.insertExpression(element)
            })
          ]
        }
      ]
    },
    {
      id: "design",
      label: "Design",
      groups: [
        {
          id: "size",
          label: "Slide size",
          controls: [
            button({
              id: "slide-size",
              kind: "menu",
              label: "Size",
              title: "Slide size presets",
              icon: "layout",
              attrs: { "data-action": "slide-size" },
              enabled: hasPres,
              items: (ctx) =>
                SIZE_PRESETS.map((preset) => ({
                  label: `${preset.label}  ${preset.width}×${preset.height}`,
                  attrs: { "data-action": "slide-size-preset", "data-preset": preset.id },
                  action: () => ctx.presentationEditor?.requestSlideSize(preset.width, preset.height)
                }))
            }),
            slideSizeField("width"),
            slideSizeField("height")
          ]
        },
        {
          id: "background",
          label: "Background",
          controls: [
            {
              id: "slide-background",
              kind: "color",
              label: "Background",
              title: "Slide background colour",
              icon: "background",
              attrs: { "data-action": "slide-background" },
              enabled: hasSlide,
              value: (ctx) => ctx.presentationEditor?.getSlide()?.background.color ?? "#ffffff",
              onSelect: (ctx, value) => ctx.presentationEditor?.setBackground(value)
            }
          ]
        },
        {
          id: "theme",
          label: "Theme",
          controls: [seam({ id: "theme", label: "Theme", icon: "theme", attrs: { "data-action": "theme" } }, THEME_REASON)]
        }
      ]
    },
    {
      id: "transitions",
      label: "Transitions",
      groups: [
        {
          id: "transition",
          label: "Transition",
          controls: [
            {
              id: "transition-style",
              kind: "select",
              label: "Style",
              icon: "transition",
              size: "large",
              attrs: { "data-action": "transition-style" },
              options: TRANSITION_STYLE_OPTIONS,
              enabled: hasSlide,
              value: (ctx) => ctx.presentationEditor?.getSlide()?.transition.style ?? "none",
              onSelect: (ctx, value) => ctx.presentationEditor?.setTransition({ style: value })
            },
            {
              id: "transition-direction",
              kind: "select",
              label: "Direction",
              icon: "transition",
              size: "large",
              attrs: { "data-action": "transition-direction" },
              options: TRANSITION_DIRECTION_OPTIONS,
              enabled: (ctx) => (ctx.presentationEditor?.getSlide()?.transition.style ?? "none") === "wipe",
              value: (ctx) => ctx.presentationEditor?.getSlide()?.transition.direction ?? "left",
              onSelect: (ctx, value) => ctx.presentationEditor?.setTransition({ direction: value })
            },
            {
              id: "transition-duration",
              kind: "field",
              label: "Duration (ms)",
              icon: "transition",
              min: 0,
              attrs: { "data-action": "transition-duration" },
              enabled: (ctx) => (ctx.presentationEditor?.getSlide()?.transition.style ?? "none") !== "none",
              value: (ctx) => ctx.presentationEditor?.getSlide()?.transition.duration ?? "",
              apply: (ctx, value) => ctx.presentationEditor?.setTransition({ duration: value })
            },
            button({
              id: "transition-all",
              label: "Apply to all",
              title: "Use this slide's transition on every slide",
              icon: "slide",
              attrs: { "data-action": "apply-transition-all" },
              enabled: hasSlide,
              action: (ctx) => ctx.presentationEditor?.applyTransitionToAll()
            })
          ]
        }
      ]
    },
    {
      id: "animations",
      label: "Animations",
      groups: [
        {
          id: "animation",
          label: "Animation",
          controls: [
            animationEffectButton("appear", "Appear", "Appear: the object shows up when it starts", "animation"),
            animationEffectButton("fade-in", "Fade in", "Fade the object in", "transition"),
            button({
              id: "animation-slide-in",
              kind: "menu",
              label: "Slide in",
              title: "Slide the object in from an edge",
              icon: "slide",
              attrs: { "data-action": "animation-slide-in" },
              enabled: canApplyEffect,
              disabledReason: ANIMATION_SELECT_REASON,
              active: (ctx) => ctx.presentationEditor?.getSelectedAnimation()?.effect === "slide-in",
              items: (ctx) =>
                TRANSITION_DIRECTION_OPTIONS.map((option) => ({
                  label: option.label,
                  attrs: { "data-action": "animation-slide-in-item", "data-direction": option.value },
                  action: () => ctx.presentationEditor?.applyAnimationEffect("slide-in", { direction: /** @type {any} */ (option.value) })
                }))
            }),
            animationEffectButton("motion", "Motion path", "Move the object from one point to another", "motion-path"),
            button({
              id: "animation-add",
              kind: "menu",
              label: "Add animation",
              title: "Give the selected objects another animation, keeping the ones they have",
              icon: "plus",
              attrs: { "data-action": "animation-add" },
              enabled: hasObjects,
              disabledReason: ANIMATION_SELECT_REASON,
              items: (ctx) => [
                { label: "Appear", icon: "animation", attrs: { "data-action": "animation-add-item", "data-effect": "appear" }, action: () => ctx.presentationEditor?.addAnimation("appear") },
                { label: "Fade in", icon: "transition", attrs: { "data-action": "animation-add-item", "data-effect": "fade-in" }, action: () => ctx.presentationEditor?.addAnimation("fade-in") },
                ...TRANSITION_DIRECTION_OPTIONS.map((option) => ({
                  label: `Slide in ${option.label.toLowerCase()}`,
                  icon: "slide",
                  attrs: { "data-action": "animation-add-item", "data-effect": "slide-in", "data-direction": option.value },
                  action: () => ctx.presentationEditor?.addAnimation("slide-in", { direction: /** @type {any} */ (option.value) })
                })),
                { label: "Motion path", icon: "motion-path", attrs: { "data-action": "animation-add-item", "data-effect": "motion" }, action: () => ctx.presentationEditor?.addAnimation("motion") }
              ]
            })
          ]
        },
        {
          id: "animation-timing",
          label: "Timing",
          controls: [
            {
              id: "animation-trigger",
              kind: "select",
              label: "Start",
              icon: "on-click",
              size: "large",
              attrs: { "data-action": "animation-trigger" },
              options: ANIMATION_TRIGGER_OPTIONS,
              enabled: hasAnimation,
              disabledReason: ANIMATION_PICK_REASON,
              value: (ctx) => ctx.presentationEditor?.getSelectedAnimation()?.trigger ?? "click",
              onSelect: (ctx, value) => ctx.presentationEditor?.updateAnimation({ trigger: value })
            },
            animationTimeField("delay", "Delay (ms)", 0),
            animationTimeField("duration", "Duration (ms)", 0),
            {
              id: "animation-direction",
              kind: "select",
              label: "Direction",
              icon: "transition",
              size: "large",
              attrs: { "data-action": "animation-direction" },
              options: TRANSITION_DIRECTION_OPTIONS,
              enabled: (ctx) => ctx.presentationEditor?.getSelectedAnimation()?.effect === "slide-in",
              disabledReason: "Direction applies to Slide in animations",
              value: (ctx) => ctx.presentationEditor?.getSelectedAnimation()?.direction ?? "left",
              onSelect: (ctx, value) => ctx.presentationEditor?.updateAnimation({ direction: value })
            },
            animationDistanceField("x"),
            animationDistanceField("y")
          ]
        },
        {
          id: "animation-order",
          label: "Order",
          controls: [
            button({
              id: "animation-pick",
              kind: "menu",
              label: "Animations",
              title: "Choose which animation on this slide to edit",
              icon: "list",
              attrs: { "data-action": "animation-pick" },
              enabled: (ctx) => (ctx.presentationEditor?.getAnimations().length ?? 0) > 0,
              disabledReason: "This slide has no animations",
              items: (ctx) =>
                (ctx.presentationEditor?.describeAnimations() ?? []).map((entry) => ({
                  label: `${entry.number}. ${entry.label}`,
                  icon: entry.selected ? "check" : undefined,
                  className: entry.selected ? "is-current" : undefined,
                  attrs: { "data-action": "animation-pick-item", "data-animation-id": entry.id },
                  action: () => ctx.presentationEditor?.selectAnimation(entry.id)
                }))
            }),
            button({
              id: "animation-earlier",
              size: "small",
              label: "Move earlier",
              icon: "move-up",
              attrs: { "data-action": "animation-earlier" },
              enabled: (ctx) => animationIndex(ctx) > 0,
              disabledReason: ANIMATION_PICK_REASON,
              action: (ctx) => ctx.presentationEditor?.moveSelectedAnimation(-1)
            }),
            button({
              id: "animation-later",
              size: "small",
              label: "Move later",
              icon: "move-down",
              attrs: { "data-action": "animation-later" },
              enabled: (ctx) => {
                const index = animationIndex(ctx);
                return index >= 0 && index < (ctx.presentationEditor?.getAnimations().length ?? 0) - 1;
              },
              disabledReason: ANIMATION_PICK_REASON,
              action: (ctx) => ctx.presentationEditor?.moveSelectedAnimation(1)
            }),
            button({
              id: "animation-remove",
              size: "small",
              label: "Remove animation",
              icon: "trash",
              attrs: { "data-action": "animation-remove" },
              enabled: hasAnimation,
              disabledReason: ANIMATION_PICK_REASON,
              action: (ctx) => ctx.presentationEditor?.removeAnimation()
            })
          ]
        },
        {
          id: "animation-preview",
          label: "Preview",
          controls: [
            button({
              id: "animation-preview",
              kind: "toggle",
              label: "Preview",
              title: "Play this slide's animations",
              icon: "play",
              attrs: { "data-action": "animation-preview" },
              enabled: (ctx) => Boolean(ctx.presentationEditor?.isPreviewing() || ctx.presentationEditor?.getAnimations().length),
              disabledReason: "This slide has no animations",
              active: (ctx) => Boolean(ctx.presentationEditor?.isPreviewing()),
              action: (ctx) => {
                const editor = ctx.presentationEditor;
                if (editor?.isPreviewing()) editor.stopPreview();
                else editor?.startPreview();
              }
            })
          ]
        }
      ]
    },
    {
      id: "slideshow",
      label: "Slide Show",
      groups: [
        {
          id: "start-show",
          label: "Start slide show",
          controls: [
            button({
              id: "show-beginning",
              label: "From beginning",
              title: "Play from the first slide (Cmd/Ctrl+Enter)",
              icon: "play",
              attrs: { "data-action": "show-from-beginning" },
              enabled: hasSlide,
              action: (ctx) => ctx.shell.startSlideshow("beginning")
            }),
            button({
              id: "show-current",
              label: "From current slide",
              title: "Play from the current slide (Shift+Cmd/Ctrl+Enter)",
              icon: "play",
              attrs: { "data-action": "show-from-current" },
              enabled: hasSlide,
              action: (ctx) => ctx.shell.startSlideshow("current")
            })
          ]
        }
      ]
    }
  ];
}
