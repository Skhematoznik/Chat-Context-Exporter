# Security

## Модель безопасности

Расширение работает только после явного действия пользователя в текущей вкладке.

Grok 0.5.0 использует permission `debugger` для пассивного CDP Network capture. Это сильное разрешение и оно не должно использоваться для выполнения произвольного JavaScript страницы, извлечения credentials, модификации запросов или обхода browser security boundaries.

Запрещено добавлять без отдельного архитектурного решения:

- собственные `fetch` / `XMLHttpRequest` к внутренним API AI-сервисов;
- извлечение cookies/access/session tokens для собственных запросов;
- request/response modification;
- monkey-patching page network APIs;
- manipulation React/Next/internal application state для принудительной истории;
- обход iframe/CORS/browser security.

Network adapter должен читать только ответы, которые сама страница уже получает штатно.

## Bug reports

При отчете об ошибке не публикуйте полные authenticated HTML snapshots, cookies, tokens или другие учетные данные. Технические логи расширения предпочтительнее полного дампа страницы.
