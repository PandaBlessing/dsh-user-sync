/**
 * 极简 React 渲染器：只支持 client.js 用到的 createElement / useState / useEffect。
 * 目的：在 Node 里挂载真实组件、点击按钮、断言渲染结果，不引入新依赖。
 *
 * 每个函数组件有独立的 hook 上下文（按组件函数引用持久化），
 * 嵌套子组件渲染时不会覆盖父组件的 hook 槽位。
 */
export function createMiniReact() {
  const instances = new Map();
  const hookStack = [];

  const current = () => hookStack[hookStack.length - 1];

  // 与真实 React 一致：setState 不在一帧内同步重渲染，而是异步合并调度。
  // 同步重渲染会在 useEffect 执行栈里递归调用自身（栈溢出），也无法模拟批处理。
  let schedule = null;
  let pending = false;
  const requestRender = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      schedule?.();
    });
  };

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
    useState(initial) {
      const instance = current();
      const index = instance.index++;
      if (!(index in instance.hooks)) {
        instance.hooks[index] = typeof initial === 'function' ? initial() : initial;
      }
      const set = (next) => {
        instance.hooks[index] = typeof next === 'function' ? next(instance.hooks[index]) : next;
        requestRender();
      };
      return [instance.hooks[index], set];
    },
    useEffect(fn, deps) {
      const instance = current();
      const index = instance.index++;
      const previous = instance.hooks[index];
      const depsEqual = (a, b) => {
        const left = a ?? [];
        const right = b ?? [];
        if (left.length !== right.length) return false;
        return left.every((value, i) => Object.is(value, right[i]));
      };
      if (previous === undefined || !depsEqual(previous?.deps, deps)) {
        previous?.cleanup?.();
        const cleanup = fn();
        instance.hooks[index] = { deps, cleanup };
      }
    },
  };

  function renderNode(vnode) {
    if (vnode === null || vnode === undefined || typeof vnode === 'boolean') return null;
    if (typeof vnode === 'string' || typeof vnode === 'number') return { text: String(vnode) };
    if (Array.isArray(vnode)) return vnode.map(renderNode).filter(Boolean);
    if (typeof vnode.type === 'function') {
      let instance = instances.get(vnode.type);
      if (!instance) {
        instance = { hooks: [], index: 0 };
        instances.set(vnode.type, instance);
      }
      instance.index = 0;
      hookStack.push(instance);
      try {
        return renderNode(vnode.type(vnode.props));
      } finally {
        hookStack.pop();
      }
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
    mount(component, props = {}) {
      let tree = null;
      schedule = () => {
        tree = renderNode(React.createElement(component, props));
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
