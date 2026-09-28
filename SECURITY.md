# Security

## Модель безопасности

Расширение работает только после явного действия пользователя в текущей вкладке.

Grok и Claude используют permission `debugger` для пассивного CDP Network capture. DeepSeek 0.7.1 выполняет обычный reload текущей страницы для штатной синхронизации локальной истории сайтом, а затем использует `scripting.executeScript` в MAIN world только для read-only чтения конкретной IndexedDB-записи текущего `chat_session_id`.

Без отдельного архитектурного решения запрещено добавлять:

- собственные `fetch` / `XMLHttpRequest` к внутренним API AI-сервисов;
- извлечение cookies/access/session tokens для собственных запросов;
- request/response modification;
- monkey-patching page network APIs;
- manipulation React/Next/internal application state для принудительной истории;
- `put` / `delete` / `clear` в site IndexedDB и автоматическое очищение кеша сайта;
- обход iframe/CORS/browser security.

Network adapter должен читать только ответы, которые сама страница уже получает штатно. Local-cache adapter должен выполнять только readonly-чтение данных, которые сайт уже сохранил сам.

## Bug reports

При отчете об ошибке не публикуйте cookies, tokens или другие учетные данные. Технические логи расширения предпочтительнее полного network dump. Если для диагностики нужен JSON разговора, передавайте только осознанно выбранный response body без auth headers.
