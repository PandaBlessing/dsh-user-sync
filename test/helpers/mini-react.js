/**
 * 极简 React 渲染器：只支持 client.js 用到的 createElement / useState / useEffect。
 * 目的：在 Node 里挂载真实组件、点击按钮、断言渲染结果，不引入新依赖。
 */
export function createMiniReact() {
  let rootInstance = { hooks: [], index: 0 };

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
    useState(initial) {
      const index = rootInstance.index++;
      if (!(index in rootInstance.hooks)) {
        rootInstance.hooks[index] = typeof initial === 'function' ? initial() : initial;
      }
      const set = (next) => {
        rootInstance.hooks[index] = typeof next === 'function' ? next(rootInstance.hooks[index]) : next;
        schedule?.();
      };
      return [rootInstance.hooks[index], set];
    },
    useEffect(fn, deps) {
      const index = rootInstance.index++;
      const previous = rootInstance.hooks[index];
      const depsEqual = (a, b) => {
        const left = a ?? [];
        const right = b ?? [];
        if (left.length !== right.length) return false;
        return left.every((value, i) => Object.is(value, right[i]));
      };
      if (previous === undefined || !depsEqual(previous?.deps, deps)) {
        previous?.cleanup?.();
        const cleanup = fn();
        rootInstance.hooks[index] = { deps, cleanup };
      }
    },
  };

  let schedule = null;

  function renderNode(vnode) {
    if (vnode === null || vnode === undefined || typeof vnode === 'boolean') return null;
    if (typeof vnode === 'string' || typeof vnode === 'number') return { text: String(vnode) };
    if (Array.isArray(vnode)) return vnode.map(renderNode).filter(Boolean);
    if (typeof vnode.type === 'function') {
      rootInstance.index = 0;
      const out = vnode.type(vnode.props);
      return renderNode(out);
    }
    return {
      type: vnode.type,
      props: vnode.props ?? {},
      children: vnode.children.flatMap(renderNode).filter(Boolean),
    };
  }

  function collectText(node) {
    if (!node) return '';
    if (Array.isArray(node)) return node.map(collectText).join('');
    if (node.text !== undefined) return node.text;
    return (node.children ?? []).map(collectText).join('');
  }

  function findAll(node, predicate, out = []) {
    if (!node) return out;
    if (Array.isArray(node)) {
      for (const item of node) findAll(item, predicate, out);
      return out;
    }
    if (predicate(node)) out.push(node);
    for (const child of node.children ?? []) findAll(child, predicate, out);
    return out;
  }

  return {
    React,
    mount(component) {
      let tree = null;
      schedule = () => {
        tree = renderNode(React.createElement(component, {}));
      };
      schedule();
      return {
        get tree() {
          return tree;
        },
        text: () => collectText(tree),
        buttons() {
          return findAll(tree, (node) => node.type === 'button');
        },
        button(label) {
          return findAll(tree, (node) => node.type === 'button' && collectText(node).includes(label))[0] ?? null;
        },
        checkboxes() {
          return findAll(tree, (node) => node.type === 'input' && node.props.type === 'checkbox');
        },
      };
    },
  };
}
