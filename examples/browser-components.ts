import type { WidgetComponent } from 'openui-telegram';

// Shared implementations: imported by the application and bundled through clientEntry.
export const components: Record<string, WidgetComponent> = {
  Tap: {
    reactive: ['value'],
    render({ props, field, text }) {
      const value = field<number>('quantity', props.value, { rules: { min: 1, max: 5 } });
      return `<div><span>Quantity: ${text(value.value)}</span></div>`;
    },
    mount({ element, field, on }) {
      const value = field<number>('quantity');
      for (const delta of [-1, 1]) {
        const button = element.ownerDocument.createElement('button'); button.textContent = delta > 0 ? '+' : '−';
        element.appendChild(button); on(button, 'click', () => value.setValue(Number(value.value) + delta));
      }
    },
    update({ element, form, scope }) {
      element.setAttribute('title', Object.values(form(scope).errors).join(', '));
    },
  },
  Chart: {
    render: () => '<div></div>',
    mount({ element }) {
      const canvas = element.ownerDocument.createElement('canvas'); canvas.width = 180; canvas.height = 36; element.appendChild(canvas);
    },
    update({ element, props }) {
      const context = element.querySelector('canvas')!.getContext('2d')!;
      context.clearRect(0, 0, 180, 36); context.fillStyle = '#2f80ed'; context.fillRect(0, 0, Math.min(180, Number(props.value) * 12), 36);
    },
  },
};
