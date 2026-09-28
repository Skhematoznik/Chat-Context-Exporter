# Adapter Guide

## Общий принцип

Каждый сервисный адаптер описывает фактический способ получения и нормализации разговора. Общие transport/UI/export компоненты не должны содержать site-specific JSON/DOM-селекторы.

Адаптер должен быть минимальным и основываться на реально наблюдаемом контракте сервиса.

## Обязательный passive/read-only invariant

Ограничение применяется ко всем адаптерам без исключения. Acquisition может только наблюдать или read-only читать данные, которые браузер уже получил либо которые сайт уже сохранил локально.

Разрешено:

- extension runtime/content script только в `ISOLATED` world;
- read-only чтение DOM и browser storage текущего origin;
- `IndexedDB` transaction только в режиме `readonly`;
- `chrome.debugger` для пассивного наблюдения за штатными network responses страницы;
- `Network.enable` и `Network.getResponseBody` для ответа, который сама страница уже получила;
- обычный reload вкладки и, для legacy DOM-adapter, browser scrolling, если это часть штатного пользовательского поведения страницы;
- локальный parsing, validation, merge, Markdown generation и сохранение через extension APIs.

Запрещено:

- `world: "MAIN"`, `Runtime.evaluate`, внедрение `<script>` или выполнение собственного кода в JavaScript-контексте сайта;
- вызов внутренних функций/React/Next/Vue state сайта для получения истории;
- собственные `fetch`, `XMLHttpRequest`, `WebSocket` или иные backend/API-запросы к AI-сервису;
- извлечение cookies/access/session tokens для собственных запросов;
- изменение request/response, headers или payload;
- monkey-patching page/network APIs;
- `put`, `add`, `delete`, `clear`, `deleteDatabase` и другие записи/удаления в site storage;
- принудительное очищение cache/storage сайта или изменение его application state.

Extension-owned UI и orchestration работают только из `ISOLATED` extension environment и не должны использовать page JavaScript как acquisition-механизм.

## Network adapter

Предпочтительный путь:

```text
DebuggerTransport
→ штатный response body страницы
→ service adapter
→ NormalizedConversation
→ exporter
```

Network adapter определяет:

- hostname/service detection;
- URL pattern и HTTP method нужного штатного ответа;
- проверку JSON schema;
- стабильные ID;
- parent-chain/tree и правило выбора активной ветки;
- роли;
- служебные/transient элементы;
- критерий полноты;
- надежный timestamp сообщения;
- преобразование в normalized messages;
- adapter-specific диагностические события.

Transport отвечает только за attach, `Network.enable`, обычный reload, request tracking, `Network.getResponseBody` и detach. Он не инициирует endpoint-запросы и не знает структуру JSON конкретного сервиса.

## ChatGPT Shared network adapter

После диагностической фазы 0.8.0 фактический wire-format public Shared зафиксирован. Production 0.8.1 использует узкий passive flow:

```text
chrome.debugger attach
→ Network.enable
→ ordinary reload
→ GET current /share/<id> Document
→ wait Network.loadingFinished
→ Network.getResponseBody
→ local HTML/React Router stream decoder
→ serverResponse.data.linear_conversation
→ NormalizedConversation
```

Transport не сканирует все responses и не сохраняет полный diagnostic dump. Большой HTML body декодируется в background extension environment только как данные; JavaScript из HTML не исполняется. В content runtime передается компактный normalized snapshot.

Service-specific parser находится в `src/adapters/chatgpt/shared-wire-parser.js` и обязан валидировать `shareId`, raw IDs, parent-chain и `current_node`. Старый Shared DOM collector и discovery-логика 0.8.0 в production runtime не сохраняются.

## Local-cache adapter

Если сервис хранит каноническую историю в browser storage, допустим только read-only local-cache adapter:

```text
optional ordinary page reload for service-side cache sync
→ ISOLATED content script
→ page-origin IndexedDB (readonly)
→ service adapter
→ NormalizedConversation
→ exporter
```

Такой adapter должен явно определить database/store/key, стабильные message IDs, parent-chain, критерий полноты и timestamp. Чтение storage выполняется только после явного запуска пользователем. Не допускаются `put`, `add`, `delete`, `clear`, `deleteDatabase`, принудительное очищение кеша сайта или собственные backend-запросы.

DeepSeek 0.7.2 при каждом запуске сначала делает обычный reload текущего разговора, чтобы сам DeepSeek синхронизировал локальную историю. После короткой проверки стабильности extension content script в `ISOLATED` world read-only читает `deepseek-chat / history-message`, ключ `chat_session_id`. Дополнительные проходы повторяют только чтение базы и объединяются по `message_id`. DOM и scrolling не используются.

## Tree

Если endpoint возвращает дерево, наличие массива сообщений не означает, что нужно экспортировать весь массив. Адаптер должен использовать фактический active/current leaf и parent links. Claude строит текущую ветку от `current_leaf_message_uuid` к root.

## Scroll

Scrolling не является обязательной частью адаптера. Он используется только после фактического подтверждения, что сервис получает историю порциями и штатно запрашивает следующую часть при прокрутке.

Если полный snapshot приходит при initial load, адаптер не должен выполнять scrolling.

## Дополнительные проходы

Дополнительный проход — повтор acquisition-процесса конкретного адаптера. Network adapter объединяет результаты по стабильным ID и не должен терять сообщения, найденные только в одном из проходов. Local-cache adapter аналогично повторно читает readonly snapshot и выполняет merge по стабильным ID.

## Панель

Адаптер может объявлять только нужные ему presentation capabilities. Если full-snapshot adapter не использует scrolling, строки `Шаг` и `Позиция` не отображаются вообще, а не заполняются `—`.

## DOM adapter

DOM остается временным способом для еще не мигрированных сервисов. Он также обязан соблюдать passive/read-only invariant: никакого page-world code, backend-запросов или изменения application state. При успешном переводе сервиса на структурированный network/local-cache acquisition его старый DOM adapter и ставший неиспользуемым site-specific код удаляются.

## Репозиторий

Не добавлять template adapters, backup-файлы или future-заготовки. Новый файл допустим, если он реально импортируется/используется runtime/build либо является необходимой project/GitHub документацией.
