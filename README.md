# Chat Context Exporter

**Chat Context Exporter** — локальное Chromium MV3-расширение для экспорта AI-диалогов в Markdown.

Текущая версия: **0.7.1**.

## Архитектура 0.7.x

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

### Текущий статус адаптеров

- **Grok — network adapter.** Полный snapshot читается из `.../rest/app-chat/conversations/<id>/load-responses`.
- **Claude — network adapter.** Полный conversation tree читается из `.../api/organizations/<org-id>/chat_conversations/<conversation-id>?tree=True&rendering_mode=messages...`.
- **DeepSeek — reload + local-cache adapter.** При каждом запуске расширение сначала штатно перезагружает текущую страницу DeepSeek, ждет синхронизацию его локальной базы и затем read-only читает полную историю из `IndexedDB: deepseek-chat / history-message`, ключ — `chat_session_id`; DOM и scrolling не используются.
- **ChatGPT — DOM adapter.** Еще не мигрирован.

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


## DeepSeek

DeepSeek 0.7.1 больше не читает виртуализированный DOM. Экспериментально подтверждено, что штатный `history_messages` работает как синхронизация локального кеша:

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

При каждом явном запуске DeepSeek-адаптера расширение сначала выполняет обычный reload текущей вкладки. Reload нужен только для того, чтобы сам DeepSeek синхронизировал `history-message`; после завершения навигации расширение выдерживает короткий период стабилизации и проверяет, что запись перестала меняться. Затем запись читается через одноразовый `chrome.scripting.executeScript(..., world="MAIN")` в режиме `readonly`. Расширение не выполняет `put`, `delete`, `clear`, не очищает кеш DeepSeek и не делает собственных API-запросов.

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

Для DeepSeek каждый пользовательский запуск сначала делает один обязательный reload для синхронизации базы; дополнительный проход затем повторно читает `deepseek-chat / history-message` без еще одного reload и объединяет snapshots по `message_id`. Для еще не мигрированного ChatGPT DOM-адаптера сохраняется текущая логика.

## Панель

Панель выполнена в нейтральной dark-теме. Маджента используется в фирменной иконке, а не как основной цвет интерфейса.

Поля контекстные. Для структурированных adapters Grok/Claude/DeepSeek показываются:

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

Grok `message`, Claude `content[].text` и DeepSeek `REQUEST` / `RESPONSE` передаются как Markdown blocks без обратного преобразования через DOM. Для DeepSeek ссылки из `TOOL_OPEN`, которые однозначно сопоставляются с результатом поиска, восстанавливаются как Markdown links; неразрешимые `TOOL_SEARCH` reference-маркеры не выводятся в Markdown, чтобы не протаскивать внутренние `[reference:N]` токены; URL для них не выдумывается.

Имя файла строится из `document.title` и очищается от символов, запрещенных в Windows filenames.

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

## Permissions

`manifest.json` 0.7.1 использует:

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
src/background/               service worker, save channel, debugger transport, read-only page IndexedDB bridge
src/content/                  runtime orchestration
src/core/                     settings/logger/save + DOM collector/scroller для еще не мигрированных сервисов
src/adapters/                 только реально подключенные adapters
src/adapters/chatgpt/         текущие ChatGPT DOM profiles
src/exporters/                Markdown exporter
src/options/                  настройки
src/ui/                       floating panel
```

Template adapters, backup-копии и неиспользуемые future-заготовки в рабочем репозитории не хранятся.

## Ограничения 0.7.1

- Claude `content` в предоставленном образце содержит только `type="text"`; неизвестные content types пока диагностируются, но не преобразуются в Markdown без реального образца их структуры.
- Attachment metadata у Grok/Claude распознается и журналируется, но mapping вложений требует отдельных тестовых разговоров.
- У DeepSeek прямые `TOOL_OPEN` references могут быть восстановлены в ссылки, если URL однозначно найден в соответствующем search fragment. Для `TOOL_SEARCH` references без однозначного URL исходный marker сохраняется.
- Grok branching пока не поддержан без реального образца и правила выбора активной ветки.
- Внутренние endpoints веб-приложений могут изменяться.

## Лицензия и безопасность

См. `LICENSE`, `LICENSE.ru.md`, `PRIVACY.md`, `SECURITY.md` и `CONTRIBUTING.md`.
