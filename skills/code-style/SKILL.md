---
name: code-style
description: Как писать код — комментарии и пояснения, имена, стили и вид, слои и границы, хуки и сторы. Читается перед первой правкой кода и при любом сомнении, как оформить решение.
user-invocable: false
---

# code-style — как писать код

> Общее правило для всех ролей и всех репозиториев. Каждое правило — что делать, почему и пример
> «так / не так».

## Правила

### 1. В коде нет документации

Код не объясняет сам себя комментариями. Стандартные механики описаны в доках своих пакетов, и в
коде их не пересказывают. Если участку нужно объяснение — скорее всего это костыль: сначала ищи, как
сделать штатно. Если пояснение всё-таки нужно, оно пишется в `FAQ.md` в корне репозитория, а в коде
остаётся только ссылка на раздел.

**Почему:** объяснение в коде расходится с кодом молча, засоряет его и прячет костыль вместо того,
чтобы его убрать. FAQ один, его читают, и там видно, сколько исключений.

Так:
```ts
export function useOrders() {
  const query = createQuery(ordersQuery);
  …
}
```
```ts
// Почему токен не в куке — FAQ.md, «Сессия без кук».
const cell = createCell("session", null);
```

Не так:
```ts
/** Заказы: грузит с бэка в стор, читает селекторами, фильтрует по статусу,
 *  обновляется по событию корзины… */
export function useOrders() {
```
```ts
// Высота идёт по цепочке до прокрутки: список ужимается в родителя, листает контент.
const fill = { display: "flex", "flex-direction": "column", "min-height": 0 };
```

### 2. Имена внутри модуля не повторяют имя модуля

Модуль уже называет предмет: `orders` — это заказы. Файлы и компоненты внутри него называются по
своей роли, без повтора имени модуля. Снаружи их читают через имя модуля: `orders` → `Card`.

**Почему:** повтор ничего не добавляет к смыслу, удлиняет каждое имя и импорт, а при переименовании
модуля расходится — часть имён остаётся со старым словом.

Так:
```
orders/ui/card.tsx          → export function Card
orders/ui/card-details.tsx  → export function CardDetails
orders/use/list.ts          → export function useList
```

Не так:
```
orders/ui/orders-card.tsx   → export function OrdersCard
orders/model/orders.ts
```

### 3. API — файл на контроллер, внутри все его ручки

Запросы раскладываются по контроллерам бэка: один ресурс — один файл, в нём все его ручки. Не файл на
каждый запрос и не два файла на один ресурс в единственном и множественном числе.

**Почему:** ручки одного ресурса меняются вместе и читаются вместе. Разнесённые по файлам, они
дублируют пути и типы, и уже не видно, что ресурс умеет целиком.

Так:
```
orders/api/orders.ts      → list, get, create, remove
orders/api/delivery.ts    → get, update
```

Не так:
```
orders/api/orders.ts      → list
orders/api/order.ts       → get
orders/api/create-order.ts
```

### 4. Сегмент отвечает за своё

У каждого сегмента модуля одна ответственность, и чужое в него не кладётся:

- `api` — только запросы: путь, метод, тело, ответ как есть;
- `model` — описание данных: типы, перевод ответа бэка в свою форму, стор;
- `ui` — вид;
- `use` — хуки, которые связывают запрос, стор и экран.

**Почему:** перевод формы в `api` или запрос в `ui` прячет логику там, где её не ищут. Поменять форму
данных, не задев запросы, становится нельзя.

Так:
```ts
// api/orders.ts
export const get = (id: string) => request<OrderResponse>(`orders/${id}`);

// model/order.ts
export interface Order { … }
export const toOrder = (response: OrderResponse): Order => ({ … });
```

Не так:
```ts
// api/orders.ts
interface OrderResponse { … }
const toOrder = (response: OrderResponse): Order => ({ … });
export const get = async (id: string) => toOrder(await request(`orders/${id}`));
```

### 5. Составной компонент собирается целиком в одном месте

Части одного составного компонента кита (корень, контент, пункты, их подписи) живут в одном файле —
там, где компонент собирается. Части не разносятся по разным модулям: корень в одном, пункт в другом.
Компонент модуля, который кладут внутрь пункта, ничего не знает о том, куда его положат: он рисует
только своё содержимое.

**Почему:** разнесённые части работают только вместе, а по отдельности ломаются молча — пункт без
своего корня теряет контекст. Компонент, завязанный на чужой контейнер, нельзя поставить никуда
больше: карточку из списка уже не показать в другом месте.

Так:
```tsx
// widgets/list
<Listbox items={items}>
  <ListboxContent>
    <For each={orders}>
      {(order) => (
        <ListboxItem item={…}>
          <Card order={order} />
        </ListboxItem>
      )}
    </For>
  </ListboxContent>
</Listbox>

// orders/ui/card.tsx
export function Card(props: { order: Order }) {
  return <Typography>{props.order.title}</Typography>;
}
```

Не так:
```tsx
// widgets/list
<Listbox items={items}>
  <ListboxContent>
    <For each={orders}>{(order) => <Card order={order} />}</For>
  </ListboxContent>
</Listbox>

// orders/ui/card.tsx
export function Card(props: { order: Order }) {
  return <ListboxItem item={…}>{props.order.title}</ListboxItem>;
}
```

### 6. Механику даёт пакет — в приложении её не пишут

Базовые механики уже реализованы в пакетах, и у каждого пакета своя зона: запросы и их статусы,
хранилища, роутинг, вид, раскладка. Всё, что входит в зону пакета, берётся у пакета — никаких ручных
обработок рядом или поверх. Прежде чем писать, найди, как это делает пакет: его README, примеры, API.

Если для задачи приходится лепить в приложении что-то рядом с механикой пакета или поверх неё,
значит пакет не даёт всего нужного. Это не повод для обхода, а повод для заявки владельцу пакета.

**Почему:** ручная копия механики расходится с пакетом молча, дублирует его работу и ломается на
каждом его обновлении. Пробел, закрытый у себя, остаётся пробелом для всех остальных — заявка
закрывает его один раз и для всех.

Так:
```ts
// orders/use/list.ts
const remove = createMutation(() => ({
  mutationFn: removeOrder,
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ordersKey }),
}));

// widgets/order-preview
<Button disabled={remove.isPending} onClick={() => remove.mutate(order.id)}>
  Удалить
</Button>
<Show when={remove.isError}>…</Show>
```

Не так:
```ts
// widgets/order-preview
const [pending, setPending] = createSignal(false);
const [failed, setFailed] = createSignal(false);
const run = async (action: () => Promise<void>) => {
  setPending(true);
  try { await action(); } catch { setFailed(true); } finally { setPending(false); }
};
```

Не так: пакет не умеет нужного, и в приложении появляется своя обёртка, свой обход или стили поверх
его вида — вместо заявки владельцу пакета.

### 7. Код декомпозирован: каждая часть на своём месте

Файл делает одно. Вспомогательное — проверки, форматтеры, вычисления, ключи — не лежит рядом с
компонентом или хуком, а выносится в `lib` модуля. Типы — в `model`. В файле компонента остаётся
компонент, в файле хука — хук.

**Почему:** свалка в одном файле прячет, что модуль умеет, и мешает переиспользовать части. Вынесенную
функцию видно, её можно найти, проверить отдельно и взять в другом месте.

Так:
```
session/lib/token.ts       → export const isToken = …
session/provider.tsx       → import { isToken } from "./lib/token"
```

Не так:
```tsx
// session/provider.tsx
const isToken = (value: unknown): value is string | null => …;
const format = (date: string) => …;
export function SessionProvider(props) { … }
```
