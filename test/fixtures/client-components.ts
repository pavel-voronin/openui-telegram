import type { WidgetComponent } from 'openui-telegram';

export const components: Record<string, WidgetComponent> = {
  Text: { render: ({ props, text }) => `<p>${text(props.value)}</p>` },
  Stack: { render: async ({ props, renderNode }) => `<section>${await renderNode(props.children)}</section>` },
  Button: { render: ({ props, text, action }) => `<button ${action(props.action, { label: props.label })}>${text(props.label)}</button>` },
  Counter: {
    reactive: ['value'],
    render({ props, field, text }) {
      const value = field<number>(props.name, props.value, { scope: 'entry', rules: { min: 0 } });
      return `<span><button>${text(value.value)}</button></span>`;
    },
    mount({ element, props, field, on }) {
      const value = field<number>(props.name, props.value, { scope: 'entry', rules: { min: 0 } });
      on(element.querySelector('button')!, 'click', () => value.setValue(value.value + 1));
    },
  },
  Plot: {
    render: () => '<span><canvas width="120" height="40"></canvas></span>',
    update({ element, props }) {
      const canvas = element.querySelector('canvas')!;
      const ctx = canvas.getContext('2d')!;
      ctx.clearRect(0, 0, 120, 40); ctx.fillStyle = '#3584e4';
      ctx.fillRect(0, 0, Number(props.value) * 4, 40);
    },
  },
  Icon: { render: ({ props, text }) => `<svg width="120" height="20"><rect width="${text(Number(props.value) * 4)}" height="20" fill="#3584e4" /></svg>` },
};
export const functions = { Twice: ({ value }: { value: number }) => value * 2 };
