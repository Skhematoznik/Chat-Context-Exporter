# Chat Context Exporter

**Chat Context Exporter** — локальное Chromium MV3-расширение для экспорта AI-диалогов в Markdown.

Текущая версия: **0.8.1**.

## Архитектура 0.8.x

Проект по одному сервису переводится с чтения виртуализированного DOM на структурированные источники данных, которые уже использует сама страница: штатные network responses или локальный browser storage.

Сетевой режим:

- запускается только после явного нажатия пользователем на кнопку расширения;
- подключает debugger к текущей вкладке;
- включает CDP `Network`;
- автоматически перезагружает страницу;
- наблюдает только штатные запросы самой страницы;
- получает нужный response body через `Network.getResponseBody`;
- не выполняет собственные `fetch` / `XMLHttpRequest` к backend AI-сервиса;
- не меняет запросы/ответы и не извлекает credentials для собственных запросов;
- разбирает данные локально и отключает debugger после захвата.

Chrome может показывать штатное предупреждение/индикатор о том, что вкладка отлаживается расширением. Это ожидаемое поведение.

### Passive/read-only invariant

Для всех адаптеров действует один обязательный контракт:

- extension runtime выполняется только в `ISOLATED` world;
- разрешено read-only чтение DOM/browser storage и пассивное наблюдение уже полученных страницей network responses;
- запрещены MAIN-world execution, `Runtime.evaluate`, `<script>` injection, вызовы внутренних функций приложения и manipulation application state;
- запрещены собственные `fetch` / `XMLHttpRequest` / `WebSocket` к AI-сервису, изменение request/response и использование credentials для собственных запросов;
- запрещены `put` / `add` / `delete` / `clear` / `deleteDatabase` и иные записи/удаления в site storage;
- обычный browser reload/scroll допускается только как пользовательское browser-level действие, если acquisition-модель адаптера этого требует.

DeepSeek 0.7.2 специально удаляет прежний MAIN-world IndexedDB bridge: local-cache читается напрямую из `ISOLATED` content script, строго `readonly`.

### Текущий статус адаптеров

- **Grok — network adapter.** Полный snapshot читается из `.../rest/app-chat/conversations/<id>/load-responses`.
- **Claude — network adapter.** Полный conversation tree читается из `.../api/organizations/<org-id>/chat_conversations/<conversation-id>?tree=True&rendering_mode=messages...`.
- **DeepSeek — reload + local-cache adapter.** При каждом запуске расширение сначала штатно перезагружает текущую страницу DeepSeek, ждет синхронизацию его локальной базы и затем read-only читает полную историю из `IndexedDB: deepseek-chat / history-message`, ключ — `chat_session_id`; DOM и scrolling не используются.
- **ChatGPT Shared (`/share/...`) — passive network adapter.** После обычного reload захватывается только основной `GET /share/<id>` Document response. Опубликованный snapshot извлекается локально из сериализованного React Router stream внутри HTML; живой DOM/React state страницы не читается и page-world code не выполняется.
- **ChatGPT authenticated thread (`/c/...`) — legacy DOM adapter.** Пока не мигрирован и функционально не менялся в 0.8.1.

После миграции сервиса его старый DOM-код удаляется; скрытый fallback не сохраняется.

## Grok

Grok network adapter использует фактические поля `responses[]`:

- `responseId`;
- `parentResponseId`;
- `sender` (`human` / `assistant`);
- `message`;
- `createTime`;
- `partial`;
- `isControl`.

Полный snapshot валидируется как линейная parent-chain. Несколько проходов объединяются по `responseId`; более полная версия того же response может заменить предыдущую.

Для подтвержденного Grok snapshot scrolling не используется.

## Claude

Claude использует штатный GET conversation endpoint с `tree=True` и `rendering_mode=messages`.

Фактически подтвержденные поля:

- conversation `uuid`, `name`, `created_at`, `updated_at`;
- `current_leaf_message_uuid`;
- `chat_messages[]`;
- message `uuid`;
- `sender` (`human` / `assistant`);
- `index`;
- `created_at`, `updated_at`;
- `parent_message_uuid`;
- `truncated`;
- assistant `stop_reason`;
- `content[]`, где подтвержден `type="text"` + `text`;
- `attachments`, `files`, `sync_sources` диагностируются отдельно.

Claude endpoint возвращает tree, поэтому адаптер не экспортирует массив вслепую. После merge он начинает с `current_leaf_message_uuid` и идет по `parent_message_uuid` до root, затем разворачивает полученную цепочку в хронологический порядок. Неактивные ветки не попадают в основной экспорт.

На предоставленном тестовом JSON активная ветка содержит 28 сообщений: 14 пользователя и 14 ассистента; все 28 имеют `created_at`, все 14 ответов ассистента завершены `stop_reason="end_turn"`, разрывов parent-chain нет.

Для этого full snapshot scrolling не используется. Если реальное сетевое поведение Claude позднее покажет порционную загрузку, scrolling добавляется только на основании такого наблюдения.


## ChatGPT Shared — passive network 0.8.1

Для публичных shared-страниц `https://chatgpt.com/share/<id>` production-adapter больше не использует DOM-прокрутку и не читает React state из page JavaScript.

Подтвержденный источник — основной Document response самой shared-страницы:

```text
user click
→ chrome.debugger attach
→ Network.enable
→ ordinary page reload
→ browser GET https://chatgpt.com/share/<id>
→ Network.loadingFinished
→ Network.getResponseBody
→ HTML response in extension memory
→ local React Router stream decoder
→ serverResponse.data.linear_conversation
→ transcript normalization
→ Markdown
→ detach
```

HTML не исполняется расширением. Parser только находит сериализованную строку `window.__reactRouterContext.streamController.enqueue(...)`, декодирует JSON string literal и React Router reference-table как данные. `MAIN` world, `Runtime.evaluate`, `document.querySelector` для acquisition, request interception и собственные backend-запросы отсутствуют.

На трех независимых public Shared fixtures подтверждена одна схема источника:

- `№ 1 AWF`: 225 raw nodes → 14 user + 14 assistant final = 28 transcript messages;
- `№ 1 Chat Context Exporter`: 2090 raw nodes → 55 user + 53 assistant final = 108 transcript messages;
- `№ 1 Tools MT5 Framework`: 4646 raw nodes → 100 user + 100 assistant final = 200 transcript messages.

Во всех трех fixtures `mapping.length == linear_conversation.length`, raw node IDs уникальны, parent-chain непрерывна, а `current_node` совпадает с последним raw node. Для AWF новый structured parser дает те же 28 transcript messages, что и прежний DOM collector.

Transcript-фильтр экспортирует только видимые `user` сообщения и видимые `assistant` сообщения с `channel="final"` / `recipient="all"`. `system`, `tool`, reasoning/commentary, hidden context и другие внутренние raw nodes не попадают в Markdown. Пользовательский `multimodal_text` поддерживается; metadata вложений выводится локально как список файлов без попытки открыть внутренний asset URL.

Web citations из `content_references[type="grouped_webpages"]` преобразуются в обычные Markdown links. File citations преобразуются в локальное текстовое обозначение источника/диапазона строк, потому что внутренние `turn...file...` ссылки ChatGPT вне исходной сессии не являются переносимыми URL. Bottom-list follow-up suggestions и invalid/hidden internal citation markers не экспортируются.

Полный HTML response используется только в памяти background-процесса для локального parsing. В content runtime передается уже компактный normalized snapshot; полный Document body не записывается в technical log и автоматически не сохраняется отдельным diagnostic artifact.

## DeepSeek

DeepSeek 0.7.2 больше не читает виртуализированный DOM. Экспериментально подтверждено, что штатный `history_messages` работает как синхронизация локального кеша:

```text
холодный кеш -> REPLACE + полный chat_messages[] -> IndexedDB
теплый кеш   -> MERGE + только дельта (или пустой массив)
```

Локальная запись хранится в:

```text
IndexedDB
database: deepseek-chat
store:    history-message
key:      chat_session_id
```

При каждом явном запуске DeepSeek-адаптера расширение сначала выполняет обычный reload текущей вкладки. Reload нужен только для того, чтобы сам DeepSeek синхронизировал `history-message`; после завершения навигации расширение выдерживает короткий период стабилизации и проверяет, что запись перестала меняться. Затем запись читается непосредственно extension content script в `ISOLATED` world через IndexedDB transaction `readonly`. MAIN-world execution не используется. Расширение не выполняет `put`, `add`, `delete`, `clear`, `deleteDatabase`, не очищает кеш DeepSeek и не делает собственных API-запросов.

Подтвержденный контракт сообщений:

- `message_id` — стабильный ID;
- `parent_id` — parent-chain;
- `role` (`USER` / `ASSISTANT`);
- `status`;
- `incomplete_message`;
- `inserted_at` — timestamp;
- `fragments[type=REQUEST]` — финальный пользовательский текст;
- `fragments[type=RESPONSE]` — финальный ответ ассистента;
- `THINK`, `TOOL_SEARCH`, `TOOL_OPEN` не экспортируются как текст диалога.

На контрольном cold-cache snapshot подтверждены 22 сообщения (11 user + 11 assistant), непрерывная цепочка `1 -> ... -> 22`, `status=FINISHED` у всех сообщений и timestamps 22/22.

После обязательного reload первый проход использует стабилизированную read-only запись IndexedDB. Дополнительный проход DeepSeek означает еще одно чтение той же записи без дополнительного reload. Результаты объединяются по `message_id`.

## Дополнительные проходы

Настройка относится к acquisition-процессу адаптера.

Для Grok и Claude дополнительный проход означает повторный:

```text
reload
→ passive network capture
→ merge по стабильному message ID
```

Если второй проход содержит те же сообщения, они считаются дубликатами. Если он содержит ранее отсутствующие сообщения, они добавляются. Если тот же ID пришел в более полном состоянии, сохраненная версия может быть обновлена.

Для DeepSeek каждый пользовательский запуск сначала делает один обязательный reload для синхронизации базы; дополнительный проход затем повторно читает `deepseek-chat / history-message` без еще одного reload и объединяет snapshots по `message_id`. Для ChatGPT Shared дополнительный проход означает еще один обычный reload и повторный passive capture полного Document snapshot; одинаковые message IDs учитываются как дубликаты, а для итогового экспорта выбирается наиболее свежий/полный валидный snapshot. Для legacy ChatGPT `/c/...` сохраняется текущая DOM-логика.

## Панель

Панель выполнена в нейтральной dark-теме. Маджента используется в фирменной иконке, а не как основной цвет интерфейса.

Поля контекстные. Для структурированных adapters Grok/Claude/DeepSeek/ChatGPT Shared показываются:

- чат;
- текущий статус;
- таймер;
- число сообщений;
- проход — только если включены дополнительные проходы.

`Метод`, `Шаг` и `Позиция` не показываются, потому что эти адаптеры не используют scrolling. DeepSeek выполняет один reload в начале пользовательского запуска только для штатной синхронизации IndexedDB, после чего работает без прокрутки.

## Markdown

Если у каждого сообщения есть надежный timestamp, отдельная дата разговора под H1 не выводится.

Формат сообщения:

```markdown
# Название страницы

***Пользователь*** — *28.09.2026 05:32:04*

Текст сообщения

---

***Ассистент*** — *28.09.2026 05:32:04*

Текст ответа
```

Timestamp преобразуется в локальное время браузера. Роль выделяется жирным курсивом, дата — обычным курсивом на той же строке.

Grok `message`, Claude `content[].text`, DeepSeek `REQUEST` / `RESPONSE` и ChatGPT Shared final text передаются как Markdown blocks без обратного преобразования через DOM. Для DeepSeek ссылки из `TOOL_OPEN`, которые однозначно сопоставляются с результатом поиска, восстанавливаются как Markdown links; неразрешимые `TOOL_SEARCH` reference-маркеры не выводятся. Для ChatGPT Shared web citations восстанавливаются из `content_references`, а внутренние file citations переводятся в переносимое текстовое обозначение источника.

Имя файла строится из заголовка разговора/страницы и очищается от символов, запрещенных в Windows filenames. Для ChatGPT Shared используется `serverResponse.data.title`.

## Логи

Техническое логирование является частью runtime. Настройка `Сохранять лог` определяет создание отдельного TXT-файла.

Network mode журналирует, в частности:

- attach/detach debugger;
- reload;
- совпавший request;
- HTTP response metadata и размер body;
- каждый acquisition pass;
- merge statistics (`added`, `updated`, `duplicates`);
- adapter-specific chain validation;
- Markdown/save pipeline.

Полный response body, полная IndexedDB-запись и полный текст разговора в технический лог не записываются. DeepSeek журналирует только метаданные cache/read, счетчики и validation statistics.

## Настройки

Сохраняются:

- автосохранение;
- сохранение лога;
- автозакрытие панели;
- дополнительные проходы и их число (1–3);
- минимальная/максимальная задержка.

## OpenAI / ChatGPT usage notice

На момент выпуска 0.8.1 действующие OpenAI Terms of Use содержат запрет на автоматическое или программное извлечение данных или Output. Проект не трактует публичную доступность shared-link как автоматическое разрешение на программное извлечение и не пытается обходить это ограничение.

Официальная справка OpenAI одновременно указывает, что shared conversation из личного аккаунта может просматривать любой, у кого есть соответствующая ссылка; такая ссылка не дает доступ к аккаунту автора. Это описывает доступность опубликованного содержимого, но само по себе не отменяет ограничения Terms of Use на automated/programmatic extraction.

Chat Context Exporter спроектирован как локальный passive/read-only инструмент: он не создает собственные запросы к внутренним API ChatGPT, не использует auth credentials для запросов, не изменяет request/response, не выполняет код в MAIN world и не передает собранный разговор на сервер расширения. Пользователь самостоятельно отвечает за соответствие своего использования применимым условиям сервиса. Для авторизованных/private ChatGPT страниц проект рекомендует **не использовать расширение**, пока пользователь самостоятельно не установил, что конкретное применение разрешено.

Ссылки для проверки актуальной редакции правил:

- OpenAI Europe Terms of Use: `https://openai.com/policies/eu-terms-of-use/`
- OpenAI Terms of Use (outside EEA/Switzerland/UK): `https://openai.com/policies/row-terms-of-use/`
- OpenAI Help — ChatGPT Shared Links: `https://help.openai.com/articles/7925741-chatgpt-shared-links-faq`

## Permissions

`manifest.json` 0.8.1 использует:

```text
activeTab
scripting
storage
downloads
debugger
```

`host_permissions` не используются.

## Структура проекта

```text
assets/icons/                 используемые extension/UI icons
src/background/               service worker, save channel, debugger transport, reload orchestration
src/content/                  runtime orchestration
src/core/                     settings/logger/save + DOM collector/scroller для еще не мигрированных сервисов
src/adapters/                 только реально подключенные adapters
src/adapters/chatgpt/         Shared passive network profile + wire parser + legacy authenticated thread profile
src/exporters/                Markdown exporter
src/options/                  настройки
src/ui/                       floating panel
```

Template adapters, backup-копии и неиспользуемые future-заготовки в рабочем репозитории не хранятся.

## Ограничения 0.8.1

- ChatGPT Shared production parser подтвержден на трех public Shared fixtures текущего React Router wire-format; изменение серверной сериализации может потребовать обновления decoder.
- ChatGPT Shared экспортирует metadata вложений, но не скачивает сами attachment bytes и не пытается превращать внутренние `sediment://`/file IDs в выдуманные внешние URL.
- ChatGPT Shared file citations не имеют переносимого публичного URL; они сохраняются как текстовое имя источника и диапазон строк, когда такие metadata доступны.
- Обычный авторизованный ChatGPT `/c/...` пока остается legacy DOM-profile и не относится к новому Shared network adapter.
- Claude `content` в предоставленном образце содержит только `type="text"`; неизвестные content types пока диагностируются, но не преобразуются в Markdown без реального образца их структуры.
- Attachment metadata у Grok/Claude распознается и журналируется, но mapping вложений требует отдельных тестовых разговоров.
- У DeepSeek прямые `TOOL_OPEN` references могут быть восстановлены в ссылки, если URL однозначно найден в соответствующем search fragment. Для `TOOL_SEARCH` references без однозначного URL внутренний marker не выводится и URL не выдумывается.
- Grok branching пока не поддержан без реального образца и правила выбора активной ветки.
- Внутренние endpoints и wire-format веб-приложений могут изменяться.

## Лицензия и безопасность

См. `LICENSE`, `LICENSE.ru.md`, `PRIVACY.md`, `SECURITY.md` и `CONTRIBUTING.md`.
