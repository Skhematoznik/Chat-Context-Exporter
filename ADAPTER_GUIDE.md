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

## Tree

Если endpoint возвращает дерево, наличие массива сообщений не означает, что нужно экспортировать весь массив. Адаптер должен использовать фактический active/current leaf и parent links. Claude 0.6.0 строит текущую ветку от `current_leaf_message_uuid` к root.

## Scroll

Scrolling не является обязательной частью адаптера. Он используется только после фактического подтверждения, что сервис получает историю порциями и штатно запрашивает следующую часть при прокрутке.

Если полный snapshot приходит при initial load, адаптер не должен выполнять scrolling.

## Дополнительные проходы

Дополнительный проход — повтор acquisition-процесса конкретного адаптера. Network adapter объединяет результаты по стабильным ID и не должен терять сообщения, найденные только в одном из проходов.

## Панель

Адаптер может объявлять только нужные ему presentation capabilities. Если full-snapshot adapter не использует scrolling, строки `Шаг` и `Позиция` не отображаются вообще, а не заполняются `—`.

## DOM adapter

DOM остается временным способом для еще не мигрированных сервисов. При успешном переводе сервиса на network capture его старый DOM adapter и ставший неиспользуемым site-specific код удаляются.

## Репозиторий

Не добавлять template adapters, backup-файлы или future-заготовки. Новый файл допустим, если он реально импортируется/используется runtime/build либо является необходимой project/GitHub документацией.
