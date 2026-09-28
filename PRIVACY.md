# Privacy

Chat Context Exporter обрабатывает разговоры локально в браузере пользователя и не отправляет их на сторонний сервер расширения.

## Какие данные читаются

В зависимости от адаптера расширение может read-only читать:

- текст сообщений пользователя и ассистента;
- timestamps;
- идентификаторы сообщений и parent-связи;
- metadata, необходимую для определения полноты/порядка/активной ветки;
- сведения о наличии вложений;
- DOM текущей страницы для еще не мигрированных DOM-адаптеров;
- для DeepSeek — локальную IndexedDB-запись выбранного `chat_session_id`.

Grok и Claude получают данные из response body, который соответствующая страница сама получает при штатной загрузке разговора. DeepSeek 0.7.2 перед чтением выполняет обычный reload текущей страницы, после чего extension content script в `ISOLATED` world read-only читает запись из `IndexedDB: deepseek-chat / history-message`, которую синхронизирует и сохраняет сам сайт. ChatGPT Shared 0.8.1 после обычного reload читает только основной Document response текущей `/share/<id>` страницы и локально декодирует опубликованный snapshot из сериализованного React Router stream; живой DOM/React state не используется для acquisition.

## Passive/read-only policy

Расширение не выполняет собственный JavaScript в MAIN world сайта, не вызывает внутренние функции приложения, не создает собственные backend-запросы и не изменяет site storage. Все adapter acquisition-механизмы должны соответствовать этому правилу.

Разрешены только extension code в `ISOLATED` world, read-only DOM/browser-storage access, пассивное наблюдение через `chrome.debugger`, обычный reload/scroll при необходимости и локальная обработка результата.

## Сетевой режим

`chrome.debugger` и CDP `Network` используются как пассивный транспорт наблюдения.

Расширение:

- не создает собственные backend API-запросы к AI-сервисам;
- не извлекает cookies, access tokens или session tokens для собственных запросов;
- не модифицирует request/response;
- не monkey-patch'ит page network APIs;
- подключает debugger только после явного запуска пользователем;
- может обычным способом reload'ить текущую страницу после подключения, чтобы наблюдать ее штатную загрузку;
- отключает debugger после завершения, ошибки или отмены.


## ChatGPT Shared Document body

В версии 0.8.1 полный HTML Document response public Shared используется только временно в памяти background extension environment. Parser извлекает из него `serverResponse.data.linear_conversation`, после чего в content runtime передается уже компактный normalized snapshot.

Полный HTML body не записывается в technical log и больше не сохраняется автоматически отдельным diagnostic artifact. Request/response headers, cookies, Authorization и POST body для ChatGPT Shared не читаются и не добавляются в экспорт.

## Локальный кеш DeepSeek

Для DeepSeek расширение при каждом явном запуске сначала обычным способом перезагружает текущую вкладку, чтобы сам сайт обновил локальную историю. После завершения навигации расширение ждет короткой стабилизации записи. Затем content script, явно выполняемый в `ISOLATED` world, открывает `deepseek-chat`, создает transaction `history-message` в режиме `readonly` и читает только запись текущего `chat_session_id`.

Расширение не выполняет `put`, `add`, `delete`, `clear`, `deleteDatabase`, не очищает базу и не меняет cache/version metadata. Если база отсутствует, возможный `upgradeneeded` abort'ится; расширение не должно создавать отсутствующую site database. Полная запись используется только в памяти текущего запуска для построения Markdown.

## Логи

Runtime ведет техническую диагностику. Если включено `Сохранять лог`, создается локальный TXT-файл.

В лог могут попасть URL/ID текущего разговора, requestId, размеры ответов, счетчики сообщений и диагностические message IDs. Полный response body, полная IndexedDB-запись и полный текст разговора в технический лог не записываются.

## Сохранение

Markdown и TXT-лог сохраняются через браузерный Downloads API. При автосохранении используется каталог загрузок, настроенный в браузере. Расширение не задает скрытый абсолютный путь.
