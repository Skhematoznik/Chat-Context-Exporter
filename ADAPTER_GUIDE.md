# Adapter Guide

## Общий принцип

Каждый сервисный адаптер описывает фактический способ получения и нормализации разговора. Общие transport/UI/export компоненты не должны содержать site-specific JSON/DOM-селекторы.

Адаптер должен быть минимальным и основываться на реально наблюдаемом контракте сервиса.

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

Transport отвечает только за attach/Network.enable/reload/request tracking/getResponseBody/detach и не знает структуру JSON конкретного сервиса.


## Local-cache adapter

Если сервис после initial load хранит каноническую историю в browser storage и сетевой endpoint возвращает только `REPLACE`/`MERGE` snapshots, допустим read-only local-cache adapter:

```text
optional page reload for service-side cache sync
→ page IndexedDB (readonly)
→ service adapter
→ NormalizedConversation
→ exporter
```

Такой adapter должен явно определить database/store/key, стабильные message IDs, parent-chain, критерий полноты и timestamp. Чтение storage выполняется только после явного запуска пользователем. Не допускаются `put`, `delete`, `clear`, принудительное очищение кеша сайта или собственные backend-запросы.

DeepSeek 0.7.1 при каждом запуске сначала делает обычный reload текущего разговора, чтобы сам DeepSeek синхронизировал локальную историю, затем после короткой проверки стабильности read-only читает `deepseek-chat / history-message`, ключ `chat_session_id`. Дополнительные проходы повторяют только чтение базы и объединяются по `message_id`. DOM и scrolling не используются.

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

DOM остается временным способом для еще не мигрированных сервисов. При успешном переводе сервиса на структурированный network/local-cache acquisition его старый DOM adapter и ставший неиспользуемым site-specific код удаляются.

## Репозиторий

Не добавлять template adapters, backup-файлы или future-заготовки. Новый файл допустим, если он реально импортируется/используется runtime/build либо является необходимой project/GitHub документацией.
