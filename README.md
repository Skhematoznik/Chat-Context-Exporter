# Chat Context Exporter

**Chat Context Exporter** — локальное Chromium MV3-расширение для экспорта AI-диалогов в Markdown.

Текущая версия: **0.6.0**.

## Архитектура 0.6.x

Проект по одному сервису переводится с чтения виртуализированного DOM на пассивный захват штатных сетевых ответов страницы через `chrome.debugger` / Chrome DevTools Protocol.

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
- **DeepSeek — DOM adapter.** Еще не мигрирован.
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

Claude 0.6.0 использует штатный GET conversation endpoint с `tree=True` и `rendering_mode=messages`.

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

## Дополнительные проходы

Настройка относится к acquisition-процессу адаптера.

Для Grok и Claude дополнительный проход означает повторный:

```text
reload
→ passive network capture
→ merge по стабильному message ID
```

Если второй проход содержит те же сообщения, они считаются дубликатами. Если он содержит ранее отсутствующие сообщения, они добавляются. Если тот же ID пришел в более полном состоянии, сохраненная версия может быть обновлена.

Для еще не мигрированных DOM-адаптеров дополнительные проходы сохраняют их текущую логику.

## Панель

Панель выполнена в нейтральной dark-теме. Маджента используется в фирменной иконке, а не как основной цвет интерфейса.

Поля контекстные. Для full-snapshot network adapters Grok/Claude показываются:

- чат;
- текущий статус;
- таймер;
- число сообщений;
- проход — только если включены дополнительные проходы.

`Метод`, `Шаг` и `Позиция` не показываются, потому что эти адаптеры не используют scrolling.

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

Grok `message` и Claude `content[].text` передаются как Markdown blocks без обратного преобразования через DOM.

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

Полный response body и полный текст разговора в технический лог не записываются.

## Настройки

Сохраняются:

- автосохранение;
- сохранение лога;
- автозакрытие панели;
- дополнительные проходы и их число (1–3);
- минимальная/максимальная задержка.

## Permissions

`manifest.json` 0.6.0 использует:

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
src/background/               service worker, save channel, debugger transport
src/content/                  runtime orchestration
src/core/                     settings/logger/save + DOM collector/scroller для еще не мигрированных сервисов
src/adapters/                 только реально подключенные adapters
src/adapters/chatgpt/         текущие ChatGPT DOM profiles
src/exporters/                Markdown exporter
src/options/                  настройки
src/ui/                       floating panel
```

Template adapters, backup-копии и неиспользуемые future-заготовки в рабочем репозитории не хранятся.

## Ограничения 0.6.0

- Claude `content` в предоставленном образце содержит только `type="text"`; неизвестные content types пока диагностируются, но не преобразуются в Markdown без реального образца их структуры.
- Attachment metadata у Grok/Claude распознается и журналируется, но mapping вложений требует отдельных тестовых разговоров.
- Grok branching пока не поддержан без реального образца и правила выбора активной ветки.
- Внутренние endpoints веб-приложений могут изменяться.

## Лицензия и безопасность

См. `LICENSE`, `LICENSE.ru.md`, `PRIVACY.md`, `SECURITY.md` и `CONTRIBUTING.md`.
