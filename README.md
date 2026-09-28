# Chat Context Exporter

**Chat Context Exporter** — локальное Chromium MV3-расширение для экспорта AI-диалогов в Markdown.

Текущая версия: **0.5.1**.

## Архитектура 0.5.x

Линия 0.5.x переводит сервисы с чтения виртуализированного DOM на пассивный сетевой захват штатных ответов страницы через `chrome.debugger` / Chrome DevTools Protocol.

Принцип сетевого режима:

- расширение не выполняет собственные `fetch` / `XMLHttpRequest` к backend AI-сервиса;
- не меняет запросы и ответы страницы;
- не извлекает cookies, access tokens или session tokens для собственных запросов;
- debugger подключается только после явного нажатия пользователем на кнопку расширения;
- после подключения расширение может автоматически перезагрузить текущую вкладку, чтобы увидеть штатные сетевые ответы страницы;
- response body разбирается локально;
- debugger отключается после получения необходимых данных;
- экспорт и лог сохраняются локально через браузерный download API.

### Текущий статус адаптеров

- **Grok — network adapter, 0.5.1.** Старый Grok DOM collector удален. История читается из штатного ответа `.../rest/app-chat/conversations/<id>/load-responses`.
- **DeepSeek — существующий DOM adapter.** Еще не мигрирован на network capture.
- **Claude — существующий DOM adapter.** Еще не мигрирован на network capture.
- **ChatGPT — существующий DOM adapter с shared/authenticated profiles.** Еще не мигрирован на network capture.

Переход выполняется по одному сервису. После успешной миграции конкретного сервиса его старый DOM-код удаляется, а не сохраняется как скрытый fallback.

## Grok 0.5.1

Для наблюдаемого Grok authenticated chat страница при первичной загрузке получает один JSON snapshot через endpoint вида:

```text
https://grok.com/rest/app-chat/conversations/<conversation-id>/load-responses
```

Ответ содержит массив `responses`. Для каждого элемента используются фактические поля Grok:

- `responseId` — стабильный ID;
- `parentResponseId` — связь в цепочке;
- `sender` — `human` / `assistant`;
- `message` — основной Markdown-текст;
- `partial` — признак незавершенного элемента;
- `isControl` — служебный элемент;
- attachment-поля и metadata — диагностируются отдельно.

Grok adapter:

1. подключает debugger;
2. включает CDP `Network`;
3. автоматически перезагружает текущую вкладку;
4. пассивно ожидает штатный `load-responses`;
5. получает body через `Network.getResponseBody`;
6. валидирует JSON и parent-chain;
7. нормализует `human` / `assistant`;
8. передает данные общему Markdown exporter;
9. сохраняет файл;
10. отключает debugger.

Для подтвержденного полного Grok snapshot прокрутка не используется. Если в будущем реальный контракт Grok изменится на порционную загрузку, scrolling должен добавляться только после подтверждения такого поведения.

## Дополнительные проходы

Настройка сохранена и теперь относится к **получению истории**, а не обязательно к DOM-прокрутке.

Для Grok 0.5.1 дополнительный проход означает повторный штатный цикл reload + passive capture. Responses объединяются по `responseId`; повторный одинаковый snapshot не создает дублей.

Для еще не мигрированных DOM-адаптеров дополнительный проход сохраняет прежнее поведение.

## Интерфейс

Плавающая панель остается draggable и закрывается `×` с остановкой текущего запуска.

Интерфейс 0.5.1 выполнен в нейтральной dark-теме. Маджента сохранена в фирменной иконке, но не используется как основная цветовая схема панели и страницы настроек.

Панель контекстная: она показывает только поля, релевантные активному адаптеру и способу его работы.

Для Grok network adapter показываются:

- сервис;
- статус;
- таймер;
- число сообщений;
- номер прохода только когда включены дополнительные проходы.

`Метод`, `Шаг` и `Позиция` для Grok не отображаются, потому что Grok 0.5.1 получает полный JSON snapshot без scrolling.

## Настройки

Сохраняются все существующие настройки:

- `Автосохранение` — ON по умолчанию;
- `Сохранять лог` — OFF по умолчанию;
- `Закрывать панель после сохранения` — ON по умолчанию;
- `Дополнительные проходы` — OFF по умолчанию;
- число дополнительных проходов — 1, допустимо 1–3;
- минимальная задержка — 100 мс;
- максимальная задержка — 1000 мс.

Настройки применяются автоматически.

## Логи

Техническое логирование является обязательной частью runtime. Настройка `Сохранять лог` определяет только создание отдельного TXT-файла.

Network mode журналирует, в частности:

- `START`;
- `SETTINGS`;
- `ADAPTER_SELECTED`;
- `CAPTURE_METHOD_SELECTED`;
- `DEBUGGER_ATTACH_STARTED` / `DEBUGGER_ATTACHED` / `DEBUGGER_DETACHED`;
- `NETWORK_ENABLED`;
- `PAGE_RELOAD_REQUESTED` / `PAGE_RELOAD_COMPLETED`;
- `NETWORK_REQUEST_MATCHED`;
- `NETWORK_RESPONSE_RECEIVED`;
- `NETWORK_BODY_CAPTURED`;
- `PASS_STARTED` / `PASS_COMPLETED`;
- `JSON_PARSED`;
- `GROK_CHAIN_STATUS`;
- `MARKDOWN_BUILT`;
- save pipeline;
- `COMPLETED` / `FINAL`.

Полное тело разговора в TXT-лог не записывается.

## Markdown

Общий exporter сохраняет роль, надежный timestamp сообщения (если он доступен) и затем содержимое:

```markdown
# Название страницы

***Пользователь***

28.09.2026 05:32:04

...

---

***Ассистент***

28.09.2026 05:32:04

...
```

Если надежный timestamp есть у каждого сообщения, отдельная дата разговора под H1 не выводится.

Grok уже возвращает основной ответ в Markdown-представлении, поэтому network adapter передает `message` как Markdown block без обратного преобразования через DOM.

Имя файла строится из `document.title` и очищается от символов, запрещенных в Windows filenames.

## Permissions

`manifest.json` 0.5.1 использует:

```text
activeTab
scripting
storage
downloads
debugger
```

`host_permissions` не используются.

`debugger` — сильное разрешение Chrome. Оно необходимо для пассивного чтения response body через CDP. Chrome может показывать системный индикатор/предупреждение, что вкладка отлаживается расширением. Открытие DevTools или enterprise policy может разорвать/запретить debugger session.

## Структура проекта

```text
assets/icons/                 используемые extension/UI icons
src/background/               service worker, save channel, debugger transport
src/content/                  runtime orchestration
src/core/                     settings, logger, save, DOM collector/scroller для еще не мигрированных сервисов
src/adapters/                 только реально подключенные adapters
src/adapters/chatgpt/         текущие ChatGPT DOM profiles
src/exporters/                Markdown exporter
src/options/                  настройки
src/ui/                       floating panel
```

В репозитории не хранятся adapter templates, backup-копии старых реализаций или неиспользуемые future-заготовки. История изменений хранится Git.

## Ограничения 0.5.1

- Grok network adapter проверен по наблюдаемой линейной структуре `responses`; разветвленная Grok-chain намеренно считается неподдержанной, пока не будет реального образца и правила выбора активной ветки.
- attachment metadata распознается и журналируется, но mapping вложений в Markdown должен подтверждаться отдельными реальными образцами.
- DeepSeek, Claude и ChatGPT пока остаются на прежних DOM-механизмах и будут мигрироваться по отдельности.
- Network endpoints AI-сервисов являются внутренними контрактами веб-приложений и могут изменяться.

## Лицензия и безопасность

См. `LICENSE`, `LICENSE.ru.md`, `PRIVACY.md`, `SECURITY.md` и `CONTRIBUTING.md`.
