// Automatic JSX transform runtime for bext.
// Both production (jsx/jsxs) and dev (jsxDEV) pass children inside props,
// so we extract them before calling h().

import { h, Fragment, type Renderable } from "./jsx";

function jsx(tag: any, props: any, _key?: any): Renderable {
  if (typeof tag !== "function") {
    const children = props?.children;
    if (children != null) {
      if (Array.isArray(children)) return h(tag, props, ...children);
      return h(tag, props, children);
    }
    return h(tag, props);
  }

  if (props == null || !("children" in props)) return tag(props ?? {});
  const componentChildren = props.children;
  if (Array.isArray(componentChildren)) {
    if (componentChildren.length > 1) {
      let alreadyFlat = true;
      for (let i = 0; i < componentChildren.length; i++) {
        const child = componentChildren[i];
        if (!(i in componentChildren) || child == null || child === false || child === true || Array.isArray(child)) {
          alreadyFlat = false;
          break;
        }
      }
      if (alreadyFlat) return tag(props);
    }
  } else if (
    componentChildren != null && componentChildren !== false && componentChildren !== true
  ) return tag(props);

  const { children, ...rest } = props || {};
  if (children != null) {
    if (Array.isArray(children)) return h(tag, rest, ...children);
    return h(tag, rest, children);
  }
  return h(tag, rest);
}

export { jsx, jsx as jsxs, jsx as jsxDEV, Fragment };
