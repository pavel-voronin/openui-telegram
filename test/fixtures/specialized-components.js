export const components = {
  A: {
    render: () => '<div></div>',
    mount({ element, on }) {
      globalThis.lifecycleMounts++;
      element.setAttribute('data-local-owner', 'A');
      const button = element.ownerDocument.createElement('button'); button.textContent = 'A'; element.append(button);
      on(button, 'click', () => { globalThis.localClicks = (globalThis.localClicks ?? 0) + 1; });
      return () => { globalThis.lifecycleDisposals++; };
    },
  },
  B: {
    render: () => '<div></div>',
    mount({ element }) {
      globalThis.lifecycleMounts++;
      element.setAttribute('data-local-owner', 'B');
      const button = element.ownerDocument.createElement('button'); button.textContent = 'B'; element.append(button);
      return () => { globalThis.lifecycleDisposals++; };
    },
  },
  Arguments: {
    render: () => '<span></span>',
    mount: function ({ element }) { element.textContent = arguments[0].text('<'); },
  },
  Input: {
    reactive: ['value'],
    render(context) {
      const field = context.field(context.props.name, context.props.value, { scope: 'entry', rules: { required: true } });
      return `<button data-errors="${context.text(Object.keys(context.form('entry').errors).join(','))}">${context.text(field.value || 'Empty')}</button>`;
    },
    mount(context) {
      const field = context.field(context.props.name, context.props.value, { scope: 'entry' });
      context.on(context.element, 'click', () => field.setValue(context.props.next));
    },
    update(context) {
      context.element.setAttribute('data-errors', Object.keys(context.form('entry').errors).join(','));
    },
  },
  Unused: {
    render() { throw new Error('UNUSED_RENDERER_SENTINEL'); },
    mount() { throw new Error('UNUSED_MOUNT_SENTINEL'); },
  },
  Disposable: {
    render: () => '<span>alive</span>',
    mount({ element }) {
      globalThis.lifecycleMounts++;
      return () => { globalThis.lifecycleDisposals++; };
    },
  },
  Dependent: {
    render(context) {
      context.element?.setAttribute('data-helper', 'present');
      return '<span>dependent</span>';
    },
    mount(context) { this.render(context); },
  },
};
