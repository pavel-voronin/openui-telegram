import { createLibrary, defineAction } from '@openuidev/lang-core';
import { z } from 'zod';
import { compileWidget, createInterface, createWidgetController, defineWidgetComponent } from 'openui-telegram';
import type { SavedState, CompileOptions } from 'openui-telegram';
import { library as base } from './library.js';
import { fileURLToPath } from 'node:url';

export const scenes = {
  state: {
    title: '1. Общее состояние и графика',
    instructions: 'Нажмите «+1»: число и полоска изменятся вместе. «Вид» переключает Canvas/SVG с тем же значением.',
    source: `$n = 1
$svg = false
heading = Text("Число: " + $n)
view = Text($svg ? "SVG" : "Canvas")
chart = $svg ? Icon(@Twice($n)) : Plot(@Twice($n))
root = Stack([heading, Button("+1", @Set($n, $n + 1)), Button("Вид", @Set($svg, !$svg)), view, chart])`,
  },
  query: {
    title: '2. Асинхронный Query',
    instructions: '«Фильтр» меняет аргументы запроса. После «Загрузка…» результат придёт сам. «Ошибка» запускает учебный сбой; «Фильтр» возвращает успешный запрос.',
    source: `$request = {filter: 1, fail: false}
data = Query("read", $request, {value: 0})
root = Stack([Text("Фильтр: " + $request.filter), Button("Фильтр", @Set($request, {filter: $request.filter + 1, fail: false})), Button("Ошибка", @Set($request, {filter: $request.filter + 1, fail: true})), QueryStatus(), Text("Результат: " + data.value)])`,
  },
  save: {
    title: '3. Mutation: успех и ошибка',
    instructions: 'Поднимите число через «+1». «Сбой» отклонит запись и НЕ сбросит число. «Сохранить» выполнит запись, сбросит число в 1 и покажет событие приложения. Данные учебные, записи в настоящую БД нет.',
    source: `$n = 1
$notice = "Запись не выполнялась"
$failed = false
save = Mutation("save", {count: $n, fail: false})
bad = Mutation("save", {count: $n, fail: true})
root = Stack([Text("Число: " + $n), Button("+1", @Set($n, $n + 1)), Button("Сбой", Action([@Set($failed, true), @Set($notice, ""), @Run(bad), @Reset($n)])), Button("Сохранить", Action([@Set($failed, false), @Run(save), @Reset($n), @Notify("Записано; число сброшено")])), Text($notice), Text($failed && bad.status == "error" ? "Сбой: сброс не выполнен" : "")])`,
  },
  edit: {
    title: '4. Patch и восстановление',
    instructions: 'Увеличьте число → «Запомнить» → ещё увеличьте → «Вернуть»: число восстановится в новом экземпляре runtime. «Patch» заменяет заголовок программы, сохраняя число. «Запомнить» также выполняет программу по частям через streaming.',
    source: `$n = 1
$note = ""
heading = Text("Исходная программа")
root = Stack([heading, Text("Число: " + $n), Button("+1", @Set($n, $n + 1)), Button("Запомнить", @Remember()), Button("Вернуть", @Restore()), Button("Patch", @Edit()), Text($note)])`,
  },
} as const;
export type SceneName = keyof typeof scenes;

const QueryStatus = defineWidgetComponent({ name: 'QueryStatus', description: 'Query lifecycle', props: z.object({}),
  render({ runtime, text }) {
    const snapshot = runtime.querySnapshot;
    return `<p>${text(snapshot.__openui_loading.length ? 'Загрузка…' : snapshot.__openui_errors.length ? 'Ошибка запроса' : 'Запрос завершён')}</p>`;
  },
});
const Stack = defineWidgetComponent({ name: 'Stack', description: 'Layout',
  props: z.object({ children: z.array(z.union([...Object.values(base.components).filter(c => c.name !== 'Stack').map(c => c.ref), QueryStatus.ref])) }),
  render: base.components.Stack.component.render,
});
export const showcaseLibrary = createLibrary({
  components: [...Object.values(base.components).filter(c => c.name !== 'Stack'), QueryStatus, Stack], root: 'Stack',
  functions: Object.values(base.functions ?? {}),
  actions: [...Object.values(base.actions ?? {}), ...['Remember', 'Restore', 'Edit'].map(name =>
    defineAction({ name, description: name, params: z.object({}) }))],
});

export function compileScenario(name: SceneName, instanceId: string, options: Pick<CompileOptions, 'clientSpecialization' | 'clientComponents'> = {}) {
  return compileWidget({ mode: 'updatable', ...options, library: showcaseLibrary, source: scenes[name].source, instanceId,
    clientEntry: name === 'state' || options.clientComponents?.length || options.clientSpecialization === false
      ? fileURLToPath(new URL('./client-components.js', import.meta.url)) : undefined });
}

/** Application-owned scenario lifecycle, independent of Telegram delivery. */
export function createScenario(name: SceneName, instanceId: string, onChange: () => void,
  wait: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 900))) {
  let saved: SavedState | undefined;
  let pending = '';
  let session: ReturnType<typeof createInterface>;
  let controller: ReturnType<typeof createWidgetController>;
  let initial: Promise<unknown>;
  function install(source: string, version: number, state?: SavedState) {
    session = createInterface(showcaseLibrary, source, {
      instanceId, version, initialState: state,
      async onOperation(operation) {
        await wait();
        if (operation.args.fail) throw new Error('Учебный отказ');
        if (operation.tool === 'read') return { value: Number(operation.args.filter) * 100 };
        if (operation.tool === 'save') return { saved: operation.args.count };
        throw new Error('Unknown demo tool');
      },
      onAction(event) {
        if (event.type === 'Notify') session.runtime.setState('$notice', event.params.message);
        else pending = event.type;
      },
    });
    session.runtime.subscribe(onChange);
    controller = createWidgetController(session.runtime);
    // Bootstrap in HTML is revision 0. The live application frame must supersede it.
    initial = controller.frame();
  }
  install(scenes[name].source, 1);
  return {
    async frame() { await initial; return controller.frame(); },
    encode: (frame: Parameters<typeof controller.encode>[0], base?: Parameters<typeof controller.encode>[1]) => controller.encode(frame, base),
    async handle(data: string) {
      pending = ''; await controller.handle(data);
      const action = pending;
      if (action === 'Remember') {
        saved = session.runtime.snapshot();
        // Exercise upstream streaming on the same program while retaining user state.
        const source = session.message.content;
        session.resetStream();
        for (let i = 0; i < source.length; i += 40) session.push(source.slice(i, i + 40), i + 40 >= source.length);
        session.runtime.setState('$note', 'Поток завершён; сохранено: ' + saved.state.$n);
      } else if (action === 'Edit') {
        session.patch('heading = Text("Программа после patch")');
        session.runtime.setState('$note', 'Число сохранено');
      } else if (action === 'Restore') {
        if (!saved) session.runtime.setState('$note', 'Сначала нажмите Запомнить');
        else {
          const source = session.message.content, version = session.runtime.version + 1;
          session.dispose(); install(source, version, saved);
          session.runtime.setState('$note', 'Восстановлено в новом runtime');
        }
      }
    },
    dispose() { session.dispose(); },
  };
}
