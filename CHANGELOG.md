# Changelog

## 0.8.7 — 2026-10-02

- ChatGPT targeted replies больше не экспортируют служебный wire-envelope `Selected text / Selection / My request` внутрь пользовательского сообщения; сохраняется фактический `My request`.
- Добавлен fallback для незавершенного assistant turn: видимый `is_thinking_preamble_message=true` / `channel=commentary` экспортируется только если для того же turn отсутствует обычный `channel=final`.
- Для paginated thread fallback дополнительно разрешается на уровне полного pass snapshot, поэтому final на соседней JSON-странице подавляет provisional preamble и не создает дубль.
- Добавлена диагностика `targetedReplyEnvelopesNormalized`, `assistantPreambleCandidates`, `assistantPreambleFallbacksIncluded`, `assistantPreamblesSuppressedByFinal`.
- Сетевой capture, fast pagination 0.8.5, request-wait state machine 0.8.6 и generated-file-card normalization 0.8.4 не изменялись.

## 0.8.6 — 2026-09-29

- ChatGPT authenticated-thread pagination now pauses local scroll commands as soon as the expected `/messages?before=<cursor>` request is observed by passive CDP Network capture.
- While that request is in flight, the content script polls capture state without issuing additional `scrollTop` changes; scrolling resumes only if the request disappears without advancing the page.
- Added `CHATGPT_THREAD_PAGINATION_REQUEST_PENDING` / `..._RESOLVED` diagnostics for verifying the request-wait state machine.
- Fast pagination geometry from 0.8.5 is unchanged: direct steps remain about five viewports (minimum 1200 px), and the extension still never creates its own ChatGPT backend pagination requests.

## 0.8.5 — 2026-09-29

Ускорена passive-network pagination авторизованных ChatGPT thread без изменения сетевого transport или parser.

- только для `authenticated-thread` network pagination добавлен отдельный fast-scroll path: вместо общего `0.7 × clientHeight` + `smooth` используется прямой локальный шаг `5 × clientHeight`, минимум 1200 px;
- fast-scroll применяется только как trigger штатной pagination интерфейса ChatGPT; расширение по-прежнему не создает собственные `/backend-api/.../messages` запросы и лишь пассивно читает ответы браузера через `chrome.debugger`;
- пользовательские `minDelayMs/maxDelayMs` между scroll-действиями сохранены; ускорение достигается уменьшением числа действий, а не обходом настроенной задержки;
- после каждого прямого шага оставлен короткий settle 120 ms для виртуализированного списка и scroll listeners, затем проверяется capture state;
- технический лог получил `CHATGPT_THREAD_PAGINATION_SCROLL_MODE` с `stepViewports`, `stepPx` и `settleMs`; каждый `SCROLL_UP` сохраняет фактическую стратегию `direct-fast-pagination`;
- обычный DOM scroller Grok/Claude/legacy paths и стандартные `scrollUpOneStep/scrollDownOneStep` не изменены;
- generated-file-card normalization и operational-error policy 0.8.4 функционально не менялись.

## 0.8.4 — 2026-09-29

Исправлено представление созданных ChatGPT файлов в Markdown и отделены штатно обработанные операционные сбои от реальных ошибок расширения.

- standalone Markdown-ссылки `sandbox:/mnt/data/...` в финальных assistant-сообщениях ChatGPT нормализуются в нижнюю часть сообщения, как файловые карточки в интерфейсе ChatGPT; порядок нескольких карточек сохраняется;
- нормализация выполняется только после обработки `content_references`, поэтому исходные `start_idx/end_idx` не сдвигаются; обычные web/file citations, inline-ссылки и ссылки внутри fenced code не переставляются;
- если generated-file card уже находится в конце сообщения, Markdown остается без изменений;
- thread/shared diagnostics получили `generatedFileCards` и `generatedFileCardsMoved`;
- перехваченные ошибки adapter/export/save/settings/options больше не отправляются через `console.warn` / `console.error`: они остаются в техническом логе и пользовательском UI/панели;
- `console.error` сохранен для действительно необработанных или инфраструктурных сбоев: отсутствие core-модулей, ошибка инъекции content scripts и финальный `run().catch`;
- paginated passive-network transport, cursor-chain validation и reverse-scroll pagination 0.8.3 функционально не менялись.

## 0.8.3 — 2026-09-29

Исправлено распознавание обычного авторизованного ChatGPT thread внутри вложенных маршрутов, включая Projects вида `/g/g-p-.../c/<conversation-id>` и другие ChatGPT URL, где сегмент `/c/<conversation-id>` не находится в корне pathname.

- thread profile теперь определяется по конечному сегменту `/c/<conversation-id>`, а не только через `pathname.startsWith('/c/')`;
- `conversation-id` извлекается из вложенного pathname;
- Project thread больше не падает в legacy DOM fallback с `variant=unknown`, `acquisitionMode=dom` и `scrollMode=normal`;
- после исправления используется тот же passive `chrome.debugger` Network transport и reverse-scroll pagination, что и для корневого `/c/...`;
- network parser, cursor-chain validation и правила фильтрации transcript не менялись.

## 0.8.2 — 2026-09-29

Обычный авторизованный ChatGPT `/c/...` переведен с legacy DOM transcript extraction на paginated passive-network adapter.

- initial tail загружается штатным `GET /backend-api/conversations/<conversation-id>?num_turns=10...` после обычного reload;
- previous pages пассивно захватываются из штатных `.../messages?before=<cursor>&num_turns=10...`, которые инициирует сам интерфейс ChatGPT при обычной прокрутке вверх; расширение не создает эти backend-запросы самостоятельно;
- `page_info.start_cursor/end_cursor/has_previous_page/has_next_page` используется как canonical pagination contract; completion наступает только при `has_previous_page=false`;
- добавлен `src/adapters/chatgpt/thread-wire-parser.js`: JSON page локально фильтруется до visible user + assistant final, поддерживает timestamps, `multimodal_text`, attachment metadata и `content_references`;
- cursor-chain валидируется: request `before` каждой следующей страницы должен совпасть с `start_cursor` предыдущей; первый response прохода обязан быть tail (`has_next_page=false`), последний — start (`has_previous_page=false`);
- старый authenticated-thread DOM transcript parser полностью удален; DOM остается только для поиска scroll-контейнера и browser-level scroll в `ISOLATED` world;
- network transport получил paginated state `awaiting-scroll`, page counters и технические события `CHATGPT_THREAD_PAGE_PARSED`, `CHATGPT_THREAD_PAGE_READY_FOR_SCROLL`, `CHATGPT_THREAD_START_REACHED`;
- дополнительные проходы повторяют весь paginated cycle после reload и дедуплицируются по стабильным message IDs;
- Grok, Claude, DeepSeek и ChatGPT Shared acquisition logic функционально не менялись.

## 0.8.1 — 2026-09-28

ChatGPT Shared переведен с диагностического capture 0.8.0 на production passive-network adapter с локальным decoding опубликованного snapshot.

- `/share/...` теперь использует общий passive `chrome.debugger` Network transport и захватывает только штатный `GET` основного Document текущей shared-страницы;
- после `Network.loadingFinished` background читает уже полученный браузером HTML через `Network.getResponseBody`; собственные API/backend-запросы, request interception и page-world execution отсутствуют;
- добавлен `src/adapters/chatgpt/shared-wire-parser.js`: HTML не исполняется, parser локально извлекает JSON string из `window.__reactRouterContext.streamController.enqueue(...)`, декодирует React Router reference-table и получает `serverResponse.data.linear_conversation`;
- большой HTML body разбирается в background и не пересылается целиком в content runtime; в capture state остается только компактный normalized snapshot;
- подтверждены три fixtures одной схемы: AWF `225 raw -> 28 transcript`, Chat Context Exporter `2090 -> 108`, Tools MT5 Framework `4646 -> 200`;
- validation требует уникальные raw node IDs, непрерывный parent-chain и совпадение `current_node` с последним raw node;
- transcript включает только видимые `user` и видимые `assistant` с `channel=final` / `recipient=all`; system/tool/reasoning/commentary/hidden nodes исключаются;
- поддержаны `text`, пользовательский `multimodal_text`, timestamps и metadata вложений; внутренние asset IDs не превращаются в выдуманные URL;
- `grouped_webpages` citations восстанавливаются в обычные Markdown links; file citations сохраняются как переносимое текстовое имя источника/диапазон строк; bottom-list follow-up suggestions и hidden/invalid internal markers не экспортируются;
- дополнительные проходы Shared снова используют общую network-семантику: повторный reload + passive Document capture, с pass statistics по стабильным message IDs;
- отдельная диагностическая CDP-сессия 0.8.0, сохранение `ChatGPT-Shared-Passive-Capture_*.txt` и связанный dead code удалены;
- Grok, Claude, DeepSeek и legacy ChatGPT `/c/...` функционально не изменены.

## 0.8.0 — 2026-09-28

Начата миграция ChatGPT Shared с DOM на passive network acquisition. Версия является диагностическим кандидатом: ее задача — определить фактический wire-format shared snapshot без page-world execution и без собственных backend-запросов.

- `src/adapters/chatgpt/shared-profile.js` полностью перестроен: старый DOM/scrolling SharedProfile удален; `/share/...` теперь объявляет `acquisitionMode=passive-network-diagnostic`;
- обычный ChatGPT `/c/...` thread-profile не менялся и остается legacy DOM adapter;
- background добавляет отдельную диагностическую CDP-сессию: `Network.enable` + `Page.enable`, затем обычный `chrome.tabs.reload`;
- слушаются `Network.requestWillBeSent`, `responseReceived`, `loadingFinished`, `loadingFailed`, а также main-frame `Page.frameNavigated` и `Page.loadEventFired`;
- к body допускаются только responses `chatgpt.com` типов `Document` / `Fetch` / `XHR` / `Other` с text/JSON-like MIME; image/media/font/stylesheet и сторонние origins не читаются;
- `Network.getResponseBody` вызывается только после `loadingFinished`; отдельный request никогда не повторяется расширением;
- response body локально сканируется на `shareId`, `routes/share.$shareId.($action)`, `sharedConversationId`, `serverResponse`, `linear_conversation`, `conversation_id`, `current_node`;
- для JSON body выполняется read-only structural probe, способный подтвердить `linear_conversation`, `current_node` и число raw nodes;
- technical log не содержит полного response body, headers, cookies, Authorization или POST body; URL в диагностике очищается от query/hash;
- при наличии кандидата сохраняется локальный `ChatGPT-Shared-Passive-Capture_*.txt` с metadata и полным body **одного** наиболее сильного response-кандидата;
- extra passes для diagnostic Shared намеренно игнорируются: один пользовательский запуск = один reload/capture window;
- README добавляет отдельное предупреждение о действующем ограничении OpenAI Terms of Use на automatic/programmatic extraction и рекомендует не применять расширение к authenticated/private ChatGPT pages без самостоятельной проверки допустимости;
- Grok, Claude и DeepSeek 0.7.2 функционально не изменены.

## 0.7.2 — 2026-09-28

Зафиксирован единый passive/read-only acquisition policy и DeepSeek переведен с MAIN-world bridge на прямое readonly-чтение IndexedDB из ISOLATED content-script world.

- удален `chrome.scripting.executeScript(..., world="MAIN")` reader DeepSeek и весь background message bridge для чтения IndexedDB;
- DeepSeek после обязательного обычного reload читает `deepseek-chat / history-message` непосредственно из extension content script в `ISOLATED` world;
- IndexedDB transaction остается строго `readonly`; `put`, `add`, `delete`, `clear`, `deleteDatabase` и иные записи в site storage не используются;
- перед `open()` используется `indexedDB.databases()` когда API доступен; если база отсутствует, возможный `upgradeneeded` немедленно abort'ится, чтобы расширение не создавало site database;
- все runtime scripts теперь явно запускаются с `world: "ISOLATED"`, а не полагаются на default Chrome behavior;
- зафиксирован общий invariant для всех адаптеров: запрещены MAIN-world execution, `Runtime.evaluate`, `<script>` injection, вызовы внутренних page-функций, собственные `fetch`/XHR/WebSocket к сервису, изменение request/response, использование auth credentials для запросов и запись/удаление site storage;
- разрешены только extension-код в `ISOLATED` world, read-only DOM/browser-storage access, passive `chrome.debugger` observation, обычный browser reload/scroll при необходимости адаптера и локальный parsing/export;
- Grok/Claude acquisition не изменен: они по-прежнему пассивно читают штатные response body через CDP `Network`;
- DeepSeek parser, reload/stability logic, citations и Markdown output функционально не менялись.

## 0.7.1 — 2026-09-28

DeepSeek local-cache acquisition синхронизирован с фактическим поведением сайта после live-ответов.

- каждый явный запуск DeepSeek-экспорта теперь сначала выполняет один обычный reload текущей вкладки, независимо от того, были ли новые сообщения;
- reload используется только как штатный триггер синхронизации самого DeepSeek: расширение не делает собственных API-запросов и не меняет site storage;
- после завершения навигации расширение выдерживает короткий grace period и требует два одинаковых последовательных read-only snapshot fingerprint перед первым экспортным чтением, чтобы не схватить старую запись в момент обновления IndexedDB;
- после стабилизации полная история читается из `IndexedDB: deepseek-chat / history-message` по текущему `chat_session_id`; DOM и scrolling по-прежнему не используются;
- дополнительные проходы DeepSeek не перезагружают страницу повторно: они повторяют только read-only чтение базы и merge по `message_id`;
- исправлено форматирование восстановленных DeepSeek citations: перед автоматически вставленной ссылкой `[N](URL)` добавляется ровно один пробел, если в исходном `RESPONSE` перед reference-marker не было whitespace;
- правило пробела применяется только к DeepSeek reference reconstruction и не меняет обычные Markdown-ссылки пользователя/ассистента;
- Grok/Claude network adapters, ChatGPT DOM adapter и общий Markdown exporter функционально не менялись.

## 0.7.0 — 2026-09-28

DeepSeek переведен с DOM collection на read-only local-cache acquisition.

- старый DeepSeek DOM adapter удален и заменен адаптером чтения `IndexedDB: deepseek-chat / history-message`;
- ключ записи — текущий `chat_session_id`, извлекаемый из URL разговора;
- чтение выполняется одноразовым `chrome.scripting.executeScript(..., world="MAIN")` и readonly-транзакцией; расширение не делает `put`, `delete`, `clear` и не очищает кеш DeepSeek;
- подтверждена модель синхронизации DeepSeek: cold-cache response дает `REPLACE` + полный `chat_messages[]`, warm-cache response дает `MERGE` + дельту либо пустой массив;
- контрольный cold-cache fixture содержит 22 сообщения (11 user + 11 assistant), `message_id=1..22`, непрерывный `parent_id`, `status=FINISHED` и timestamps 22/22;
- `REQUEST` экспортируется как сообщение пользователя, `RESPONSE` — как финальный ответ ассистента; `THINK`, `TOOL_SEARCH`, `TOOL_OPEN` не попадают в текст диалога;
- ссылки для `TOOL_OPEN`, которые однозначно сопоставляются с результатом поиска, восстанавливаются в Markdown; неразрешимые `TOOL_SEARCH` reference markers не выводятся, без выдумывания URL;
- дополнительные проходы DeepSeek повторно читают local-cache snapshot и объединяют данные по `message_id`, позволяя подхватить изменения, записанные сайтом между проходами;
- DeepSeek больше не прокручивает страницу, не читает сообщения из DOM и не перезагружает страницу для обычного экспорта;
- панель DeepSeek использует тот же компактный структурированный режим: без `Метод`, `Шаг` и `Позиция`;
- в ручном режиме после завершения сбора вторая кнопка теперь подписана `Закрыть`, а не `Отмена`;
- Grok и Claude network adapters, ChatGPT DOM adapter и общий Markdown формат 0.6.0 функционально не менялись.

## 0.6.0 — 2026-09-28

Добавлен второй полностью сетевой адаптер — Claude.

- старый Claude DOM adapter удален и заменен network adapter без DOM fallback;
- Claude захватывает штатный GET `chat_conversations/<id>?tree=True&rendering_mode=messages...` через общий `chrome.debugger` transport;
- несколько проходов объединяются по `chat_messages[].uuid`; более полная версия того же сообщения имеет приоритет;
- активный разговор строится от `current_leaf_message_uuid` по `parent_message_uuid`, поэтому неактивные ветки tree не экспортируются;
- подтвержденный fixture содержит 28 сообщений (14 user + 14 assistant), timestamps 28/28, `stop_reason=end_turn` 14/14, без разрывов parent-chain;
- Claude `content[].type=text` экспортируется как исходный Markdown; неизвестные content types и attachment metadata диагностируются отдельно до появления реальных тестовых образцов;
- transport получил необязательный HTTP method matcher: Grok ожидает POST, Claude — GET;
- дублирующиеся `PAGE_RELOAD_COMPLETED`, пришедшие почти одновременно для одного прохода, подавляются в техническом логе;
- network logging обобщен: common runtime пишет generic `JSON_PARSED`, а site-specific chain diagnostics возвращает сам adapter;
- панель network adapters использует adapter presentation capabilities; full-snapshot Grok/Claude не показывают `Метод`, `Шаг`, `Позиция`;
- Markdown role/timestamp объединены в одну строку: `***Пользователь*** — *DD.MM.YYYY HH:MM:SS*` и аналогично для ассистента;
- Grok network acquisition/merge/chain validation функционально не менялись.

## 0.5.1 — 2026-09-28

Зафиксирован первый рабочий Grok network adapter после многопроходных тестов.

- панель Grok стала контекстной: скрыты неиспользуемые `Метод`, `Шаг` и `Позиция`; `Проход` показывается только при включенных дополнительных проходах;
- статусная строка больше не дублирует число сообщений или номер прохода, уже показанные в панели;
- финальные статусы сокращены до `Сбор завершен.` / `Сохранено.`;
- Grok `createTime` нормализуется как timestamp каждого экспортируемого сообщения;
- Markdown выводит `***Пользователь***` / `***Ассистент***`, затем локальные `DD.MM.YYYY HH:MM:SS` отдельной строкой и затем содержимое сообщения;
- если timestamp есть у каждого сообщения, отдельная дата разговора под H1 не выводится;
- лог `GROK_CHAIN_STATUS` дополнен покрытием timestamps;
- network acquisition, reload, merge по `responseId`, дополнительные проходы и save pipeline функционально не менялись.

## 0.5.0 — 2026-09-28

Открыта новая архитектурная линия passive network capture.

- Grok полностью переведен с DOM collection на `chrome.debugger` / CDP `Network`; старый Grok DOM-код удален.
- При явном запуске Grok adapter подключает debugger, автоматически перезагружает вкладку и пассивно получает штатный `load-responses` response body через `Network.getResponseBody`.
- Grok JSON валидируется по `responseId` / `parentResponseId`, `human` / `assistant`, `partial` и `isControl`; полный линейный snapshot не требует прокрутки.
- Дополнительные проходы сохранены: для Grok это повторный network acquisition с дедупликацией по `responseId`.
- Network transport хранит технические события и размеры ответов, но не пишет полное тело разговора в TXT-лог.
- Добавлено permission `debugger`; `host_permissions` по-прежнему отсутствуют.
- Панель и options переведены на нейтральную dark-тему; маджента оставлена в фирменной иконке.
- Все существующие настройки и save/log pipeline сохранены.
- Удален неиспользуемый `_adapter-template.js`.
- DeepSeek, Claude и ChatGPT остаются на текущих DOM-адаптерах до их отдельных миграций.

# История изменений

Все заметные изменения проекта фиксируются в этом файле.

## 0.4.10 — 2026-09-28

Исправлена регрессия начала ChatGPT public shared, выявленная после перехода 0.4.9 на реальные ID DOM-skeleton.

- shared skeleton теперь разделяется на сырой DOM-каркас (`rawSkeletonCount`) и ожидаемые conversation-turn (`expectedTurnCount`);
- ведущий structural root исключается из coverage не по конкретному имени ID, а по узкому DOM-признаку: это пустой childless `data-turn-id-container`, уже отмеченный страницей как intersecting, без `section[data-turn]`, role-message, transient status, текста и placeholder-геометрии;
- исторический `client-created-root` по-прежнему распознается как structural root, поэтому старый shared DOM остается совместимым;
- обычные невидимые placeholders с `--last-known-height` / `--estimated-turn-height` или `min-h-14` не исключаются и остаются обязательными ожидаемыми turn;
- первый/последний semantic marker, missing/unresolved coverage и skeleton fingerprint теперь строятся по conversation skeleton после исключения structural prefix;
- лог дополнен `rawSkeletonCount`, `structuralTurnCount`, `structuralTurnIds` и `structuralTurnSkeletonIndexes`;
- transient/fallback логика 0.4.9, authenticated ThreadProfile, save pipeline, Markdown parser/exporter, Grok, DeepSeek и Claude функционально не менялись.

## 0.4.9 — 2026-09-28

Исправлены реальные DOM-состояния ChatGPT после остановленного/неполученного ответа и ошибка определения границ public shared.

- public shared больше не вычисляет первый/последний turn как `conversation-turn-1` / `conversation-turn-${expectedTurnCount}`: границы определяются по фактическим ID первого и последнего элемента skeleton и не зависят от схемы нумерации `conversation-turn-N`; в проблемном снимке 93 skeleton-turn завершались реально смонтированным `conversation-turn-92`;
- shared `section[data-turn="assistant"]` с `[data-streaming-response-status]` и без стандартного role-message классифицируется как `transient-status`: turn учитывается в coverage как разрешенный, но служебный текст незавершенной генерации не экспортируется в Markdown;
- transient turn не попадает в fallback-сбор, а при последующем появлении полноценного стандартного message-node классификация повышается до обычного сообщения без дубля;
- если shared дошел до устойчивой физической нижней границы, но coverage остается неполным, настроенный дополнительный проход теперь запускается независимо от semantic end-marker; окончательная ошибка после последнего прохода сохраняет строгую проверку missing/unresolved turn;
- диагностика shared дополнена `transientTurnCount`, `transientTurnIds`, `transientTurnOrdinals`, `missingTurnIds` и `missingTurnSkeletonIndexes`;
- authenticated thread теперь исключает из экспорта незавершенный assistant status, подтвержденный реальным DOM-сочетанием `data-markdown-text-tone="tertiary"` + отсутствие `data-chatgpt-selection-message-id` + наличие `data-chatgpt-agent-turn-start`; обычные завершенные ответы с message-id не затрагиваются;
- в диагностике authenticated thread добавлены число, turn-key и краткий preview таких transient assistant status;
- Markdown parser/exporter, save pipeline 0.4.7, Grok, DeepSeek и Claude функционально не менялись.

## 0.4.8 — 2026-09-28

Усилена проверка полноты ChatGPT public shared после сравнения shared и authenticated представлений большого чата.

- покрытие skeleton больше не считается достаточным только потому, что turn хотя бы один раз был смонтирован: отдельно учитываются `observedTurnCount`, `resolvedTurnCount`, стандартные message-turn, fallback message-turn и нераспознанные turn;
- `collectionComplete=true` теперь возможно только когда каждый ожидаемый skeleton turn не только просмотрен, но и разрешен в экспортируемое сообщение; неизвестный или пустой turn автоматически не считается служебным;
- shared-профиль получил осторожный fallback для `section[data-turn="user|assistant"]`, в которых ChatGPT не создал обычный `[data-message-author-role]`: сначала используются известные content-root, затем очищенный снимок самого turn без кнопок, меню, SVG, скрытых и служебных элементов;
- fallback включается только если после очистки остается содержательное DOM-содержимое; пустой user/assistant turn остается `unresolved` и не может дать ложное успешное завершение;
- shared ID теперь предпочитает стабильный ID turn, поэтому один и тот же turn не дублируется, если сначала был собран fallback-способом, а позднее ChatGPT смонтировал стандартный message-node;
- лог дополнен `resolvedTurnCount`, `fallbackMessageTurnCount`, `unresolvedTurnCount` и ordinal нераспознанных turn, чтобы следующий длинный прогон сразу показывал источник расхождения;
- дополнительный проход по-прежнему получает шанс добрать `missing`/`unresolved` turn, а окончательная ошибка после последнего прохода сообщает число полностью обработанных turn;
- изменения ограничены ChatGPT public shared и диагностикой полноты; authenticated thread, Grok, DeepSeek, Claude, Markdown parser/exporter и save pipeline 0.4.7 не менялись.

## 0.4.7 — 2026-09-28

Исправлена надежность длинных ChatGPT-проходов и локального сохранения. Markdown-парсинг 0.4.6 не менялся.

- authenticated thread больше не завершает поиск начала после пяти коротких стабильных проверок: при видимом DOM-признаке продолжающейся подгрузки расширение ждет не менее 45 секунд без прогресса (и не менее трех максимальных настроенных задержек), а рост `scrollHeight`, изменение DOM-signature или обновление собранного содержимого сбрасывают таймер бездействия;
- public shared больше не приравнивает количество `data-turn-id-container` к количеству экспортируемых сообщений: skeleton проверяется как покрытие turn, а Collector по-прежнему экспортирует только реальные `user`/`assistant` сообщения;
- для shared накапливается `observedTurnCount`; успешность определяется по `expectedTurnCount == observedTurnCount`, поэтому служебный/немесседжевый turn больше не создает ложный недобор сообщений;
- если первый проход дошел до конца, но turn-coverage неполный, настроенный дополнительный проход теперь действительно запускается вместо немедленной ошибки; окончательная ошибка выдается только после последнего доступного прохода;
- автосохранение Markdown и TXT-лога получило timeout и до трех повторных попыток; повтор одной операции использует стабильный `requestId`, а service worker дедуплицирует еще выполняющуюся попытку, чтобы timeout не создавал дублирующие загрузки;
- ручной `Save As` не повторяется автоматически и получает отдельный увеличенный timeout, чтобы не открывать несколько диалогов сохранения;
- `logger.saveOnce()` после неудачной попытки больше не остается навсегда привязан к failed promise и может быть вызван повторно;
- обработанные операционные ошибки основного прохода пишутся через `console.warn`, а `console.error` остается для действительно необработанных ошибок запуска;
- разрешения, DOM-only модель, Grok, DeepSeek, Claude и Markdown parser/exporter не менялись.

## 0.4.6 — 2026-09-27

Унифицирована семантическая очистка Markdown для public shared-профиля ChatGPT после сравнительного прогона одного и того же чата в shared и authenticated представлениях.

- shared-профиль теперь преобразует `[data-math-source]` в единичный Markdown math-блок/inline math так же, как уже проверенный authenticated thread;
- shared-профиль нормализует semantic copy markers ChatGPT для inline/fenced code и удаляет `[data-markdown-copy="exclude"]`;
- интерактивные списки предложенных продолжений, где каждый пункт является `[role="button"]`, исключаются из assistant snapshot вместе с их вводной строкой и разделителем;
- логика прокрутки, skeleton-проверки, ID, порядка, даты начала authenticated thread и сбор 28 сообщений не менялись;
- ThreadProfile, Grok, DeepSeek и Claude не изменены.

## 0.4.5 — 2026-09-27

Добавлена опциональная временная отметка начала ChatGPT thread по явному DOM `time[datetime]` перед первым сообщением.

- timestamp читается только после подтвержденного достижения настоящего начала истории;
- используется только `time[datetime]`, расположенный в первом `data-turn-key` перед первым `[data-user-message-bubble="true"]`;
- случайные временные разделители из последующих виртуальных окон игнорируются;
- значение `datetime` форматируется локально как `DD.MM.YYYY HH:mm` и выводится отдельной строкой сразу под H1, без подписи `Начало чата` или иной классификации;
- если надежной метки у первого сообщения нет, строка полностью отсутствует;
- времена отдельных сообщений ChatGPT по-прежнему не выводятся;
- логика прокрутки, сбора 28 сообщений и оба ChatGPT DOM-профиля не менялись.

## 0.4.4 — 2026-09-27

Уточнен Markdown-экспорт обычного авторизованного ChatGPT thread после успешного сбора 28 сообщений.

- ThreadProfile сохраняет semantic copy markers ChatGPT перед передачей DOM-снимка общему parser;
- `[data-markdown-copy="inline-code"]` преобразуется в настоящий inline code;
- `[data-markdown-copy="code-block"]` преобразуется в `pre/code`, а служебная панель блока и подпись «Обычный текст» не экспортируются;
- `[data-math-source]` используется как единственный источник уже отрисованной формулы, чтобы не дублировать KaTeX MathML/HTML; display-формулы экспортируются как `$$...$$`, inline-формулы как `$...$`;
- служебные `[data-markdown-copy="exclude"]` удаляются из snapshot;
- логика прокрутки, определения границ, ID, порядка и сбора сообщений не менялась;
- SharedProfile, Grok, DeepSeek и Claude не изменены.

## 0.4.3 — 2026-09-27

Исправлен сбор ответов ассистента в обычном авторизованном ChatGPT thread-профиле.

- подтверждено, что `[data-conversation-role="assistant"]` в authenticated thread является скрытым заголовком роли (`h4`), а не контейнером ответа;
- `ThreadProfile` теперь берет фактический текст ответа непосредственно из `[data-markdown-text-style="assistant-message"]`;
- контейнер `[data-chatgpt-selection-message-id]` используется как стабильная оболочка/ID ответа, если он доступен;
- один `data-turn-key` корректно разворачивается в два логических сообщения: пользователь и ассистент;
- порядок внутри turn сохраняется как `user` перед `assistant`;
- диагностический счетчик assistant-сообщений теперь определяется по фактическому assistant content root;
- `SharedProfile`, Grok, DeepSeek и Claude не изменены.

## 0.4.2 — 2026-09-27

ChatGPT разделен на один сервисный адаптер с двумя DOM-профилями.

- `ChatGPTAdapter` теперь отвечает за выбор режима страницы и делегирует DOM-логику профилям `shared-public` и `authenticated-thread`;
- добавлены `src/adapters/chatgpt/shared-profile.js` и `src/adapters/chatgpt/thread-profile.js`;
- public shared-профиль использует `[data-scroll-root]`, обычную шкалу `scrollTop`, отдельные `conversation-turn-N`, `data-message-author-role` и `data-message-id`;
- shared-профиль учитывает DOM-skeleton из уникальных `data-turn-id-container`: placeholders используются только как уже отрисованный страницей признак ожидаемого числа сообщений, но текст из них не извлекается;
- для shared-профиля начало подтверждается физическим верхом + смонтированным `conversation-turn-1`; конец — физическим низом + смонтированным последним ordinal turn;
- общее ядро теперь умеет сравнивать фактически собранное число сообщений с `getExpectedMessageCount()` адаптера и не завершает проход как успешный при недоборе;
- authenticated thread-профиль сохраняет отдельный `flex-col-reverse`/reverse-scroll режим и накопительное упорядочивание по стабильным `data-turn-key`;
- в панели по-прежнему отображается единый сервис `ChatGPT`, а в техническом логе различаются `variant=shared-public` и `variant=authenticated-thread`;
- Grok, DeepSeek и Claude не изменялись.

## 0.4.1 — 2026-09-27

- Исправлено распознавание публичных ChatGPT shared-ссылок (`/share/...`): адаптер получает приоритет по hostname + shared path и отображается как ChatGPT.
- Добавлен DOM-вариант `shared-public` с фактическим scroll-контейнером `group/scroll-root`.
- Для shared-страниц используется обычная положительная шкала `scrollTop`; ранее сохраненный authenticated timeline оставлен в отдельном reverse-режиме совместимости.
- Добавлен сбор сообщений по `[data-message-author-role]` с fallback на `article`, стабильные DOM-ID и порядок по `conversation-turn-N`/наблюдаемым перекрывающимся окнам.
- Расширена диагностика shared DOM: layout variant, число role nodes/articles, видимые ID и order keys, состояние верхнего status-loader и кнопки прокрутки вниз.
- В `ADAPTER_SELECTED` добавлено поле `variant`, чтобы по логу сразу видеть активную ветку адаптера.
- Рабочая логика Grok, DeepSeek и Claude не изменялась.

## 0.4.0 — 2026-09-27

Первый диагностический кандидат адаптера ChatGPT для shared-диалогов.

- добавлен отдельный `src/adapters/chatgpt-adapter.js`;
- добавлено определение `chatgpt.com` и DOM-признаков transcript/turn;
- выбран `[data-app-action-timeline-scroll].thread-scroll-container` как специализированный scroll-контейнер;
- общее ядро прокрутки расширено режимом `reverse` для `flex-col-reverse`, без изменения поведения существующих normal-scroll адаптеров;
- пользовательские сообщения берутся из `[data-user-message-bubble="true"]`;
- ответ ассистента берется только из `[data-markdown-text-style="assistant-message"]` внутри `[data-conversation-role="assistant"]`;
- `data-turn-key` используется как стабильная основа идентификации turn;
- добавлено накопительное упорядочивание turn по перекрывающимся виртуализированным DOM-окнам, поскольку `fallback-turn-N` по сохраненным снимкам не является глобально стабильным индексом;
- добавлена диагностика `visibleTurnKeys`, локальных `fallbackIndices`, virtual height/margin, верхнего status-loader, shared-path и состояния scroll-to-bottom;
- начало истории проверяется как reverse-физическая верхняя граница плюс отсутствие активного status-loader перед первым turn;
- конец истории проверяется как reverse-физический низ плюс неактивная/отсутствующая кнопка scroll-to-bottom;
- Grok, DeepSeek и Claude не изменены функционально;
- сохранена DOM-only / network-passive архитектурная граница.

## 0.3.0 — 2026-09-27

Claude зафиксирован как готовый адаптер.

- подтверждено автоматическое определение Claude и выбор `[data-autoscroll-container="true"]` с `[data-testid="transcript-list"]`;
- подтверждена реальная виртуализация: стартовый DOM содержал только последние 5 строк, а Collector по мере прокрутки накопил полную историю из 24 сообщений (12 пользовательских + 12 ответов);
- сообщения стабильно идентифицируются по `data-index` / `data-rs-index`, роли — по `data-perf-row="human|assistant"` с DOM-fallback;
- подтверждено начало истории по физическому верху и первому сообщению (`data-index="0"` / `aria-posinset="1"`);
- подтвержден конец истории по физическому низу и последнему сообщению (`data-last-message` / `aria-posinset == aria-setsize`);
- подтверждено сохранение уже собранных сообщений после виртуального удаления DOM-строк;
- дополнительный проход дал `passAdditions=[24,0]`, без дублей и пропусков в контрольном тесте;
- автоматическое и ручное сохранение сформировали одинаковый Markdown-файл;
- принудительное закрытие панели корректно прерывает выполнение и завершает лог состоянием `CANCELLED`;
- Grok и DeepSeek не изменены функционально.

## 0.2.1 — 2026-09-27

DeepSeek зафиксирован как готовый адаптер.

- подтвержден старт из частично загруженной истории: в начале было доступно 4 DOM-сообщения, после штатной подгрузки при прокрутке Collector накопил полные 16 сообщений (8 пользовательских + 8 ответов ассистента);
- подтверждена корректная работа при изменении `scrollHeight` и виртуальном удалении ранее видимых элементов из DOM;
- подтверждены устойчивые границы истории, накопительный Collector и дедупликация по `data-virtual-list-item-key`;
- дополнительный проход на контрольном тесте дал `passAdditions=[16,0]`;
- подтверждены автоматическое и ручное сохранение; полученные Markdown-файлы совпали побайтно;
- парсер игнорирует DOM-узлы, явно скрытые через `hidden`, `aria-hidden`, `display:none`, `visibility:hidden` или `opacity:0`;
- исправлены служебные невидимые символы DeepSeek в ссылках-цитатах (например, `[-21]` экспортируется как `[21]`);
- reasoning/search UI DeepSeek не включается в итоговый ответ;
- логика Grok и сетевые ограничения расширения не изменены.

## 0.2.0 — 2026-09-27

Начало поэтапной поддержки DeepSeek.

- добавлен отдельный `deepseek-adapter.js`;
- добавлено определение `chat.deepseek.com` и устойчивых DeepSeek DOM-признаков;
- выбран `.ds-virtual-list.ds-virtual-list--printable` как специализированный scroll-контейнер;
- сообщения отслеживаются по `data-virtual-list-item-key`;
- роли определяются по DOM содержимого, а не только по знаку ключа;
- ответ ассистента берется только из `.ds-assistant-message-main-content`, без `.ds-think-content`;
- добавлена диагностическая фиксация видимых virtual-list ключей на границах истории;
- стабильность набора ключей участвует в проверке границ DeepSeek;
- Grok-специфичные тексты ошибок общего ядра заменены на адаптерные;
- версия расширения отображается просто как `0.2.0`, без `baseline`/`candidate` в metadata расширения.

## 0.1.9 — 2026-09-27

Первая публичная baseline-версия репозитория.

### Grok

- автоматическое определение адаптера Grok;
- DOM-only проход истории вверх и вниз;
- подтверждение границ истории по DOM-маркерам;
- сбор сообщений пользователя и ассистента;
- дедупликация и обновление более полных DOM-снимков;
- опциональные дополнительные проходы от 1 до 3;
- сбор сообщений на движении в обе стороны;
- восстановление после отдельных холостых smooth-scroll шагов;
- таймер, счетчики и пользовательские статусы.

### Экспорт

- Markdown exporter;
- H1 из title страницы;
- роли `Пользователь` / `Ассистент` как отдельные жирные метки;
- сохранение заголовков, списков, ссылок, цитат, таблиц и code blocks;
- имя файла из title страницы с безопасной санитизацией;
- автосохранение и ручной `Save As`;
- автоматическое закрытие панели после успешного сохранения как настраиваемая опция.

### Настройки и диагностика

- автоматическое сохранение настроек;
- задержки по умолчанию 100–1000 мс;
- локальный технический TXT-лог;
- логирование проходов, количества добавленных сообщений, scroll recovery и длительности.

### Документация

- новый публичный README;
- политика конфиденциальности;
- правила участия в разработке;
- политика безопасности;
- MIT License и неофициальный русский перевод.
