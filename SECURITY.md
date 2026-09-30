# Security

## Модель безопасности

Расширение работает только после явного действия пользователя в текущей вкладке. Acquisition policy проекта — passive/read-only.

Grok и Claude используют permission `debugger` только для пассивного CDP Network capture: подключение к текущей вкладке, `Network.enable`, обычный reload, наблюдение за штатными запросами страницы, `Network.getResponseBody`, detach. Они не создают собственных backend-запросов.

DeepSeek 0.7.2 выполняет обычный reload текущей страницы для штатной синхронизации локальной истории самим сайтом, после чего extension content script в `ISOLATED` world read-only читает конкретную IndexedDB-запись текущего `chat_session_id`. MAIN-world bridge отсутствует. ChatGPT Shared 0.8.1 использует только passive CDP `Network` observation + ordinary reload; захватывается основной GET Document текущей `/share/<id>` страницы. ChatGPT authenticated thread 0.8.6 использует passive CDP Network capture штатных paginated JSON responses и локальное изменение `scrollTop` в `ISOLATED` world как pagination trigger; собственные backend-запросы отсутствуют.

### Разрешено

- extension code в `ISOLATED` world;
- read-only DOM/browser-storage access;
- IndexedDB transaction только `readonly`;
- passive `chrome.debugger` observation и чтение response body, уже полученного страницей;
- обычный reload/scroll браузера, когда это требуется acquisition-моделью;
- локальный parsing/export и extension-owned UI.

### Запрещено

- `world: "MAIN"`;
- CDP `Runtime.evaluate` или иное выполнение собственного JavaScript в page world;
- вставка `<script>` и вызов внутренних page/app функций;
- собственные `fetch` / `XMLHttpRequest` / `WebSocket` к внутренним API AI-сервисов;
- извлечение cookies/access/session tokens для собственных запросов;
- request/response/header/payload modification;
- monkey-patching page network APIs;
- manipulation React/Next/Vue/internal application state;
- `put` / `add` / `delete` / `clear` / `deleteDatabase` в site storage;
- автоматическое очищение site cache/storage;
- обход iframe/CORS/browser security.

Network adapter должен читать только ответы, которые сама страница уже получает штатно. Local-cache adapter должен выполнять только readonly-чтение данных, которые сайт уже сохранил сам.


### ChatGPT Shared 0.8.1 guardrails

- matcher ограничен точным текущим `https://chatgpt.com/share/<shareId>` и HTTP method `GET`;
- `Network.getResponseBody` вызывается только после `Network.loadingFinished`;
- HTML разбирается как строка данных; embedded JavaScript не исполняется;
- `Runtime.evaluate`, `MAIN` world, `Fetch.enable`, request interception/mutation и response mutation отсутствуют;
- request/response headers, Cookie, Set-Cookie, Authorization и POST body не читаются/не логируются;
- полный Document body не записывается в technical log и не сохраняется отдельным diagnostic artifact;
- после локального parsing в runtime передается только normalized snapshot разговора.

### ChatGPT authenticated thread 0.8.6 guardrails

- matcher ограничен текущим conversation ID и `GET` URL вида `/backend-api/conversations/<id>` или `/backend-api/conversations/<id>/messages?...`;
- extension не генерирует эти GET-запросы: initial response приходит после обычного reload, предыдущие страницы — только после штатной реакции интерфейса на browser scroll;
- `Network.getResponseBody` вызывается только после `Network.loadingFinished`;
- `page_info.start_cursor/end_cursor/has_previous_page/has_next_page` используются для проверки полноты и cursor-chain;
- DOM не используется как источник transcript; только read-only поиск scroll-container и изменение scroll position;
- `Runtime.evaluate`, `MAIN` world, `Fetch.enable`, request interception/mutation, response mutation и site-storage writes отсутствуют;
- headers/cookies/tokens и POST body не читаются/не логируются.

## Bug reports

При отчете об ошибке не публикуйте cookies, tokens или другие учетные данные. Технические логи расширения предпочтительнее полного network dump. Если для диагностики нужен JSON разговора, передавайте только осознанно выбранный response body без auth headers.
