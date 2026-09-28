# Adapter Guide

## Общий принцип

Каждый сервисный адаптер описывает фактический способ получения и нормализации разговора. Общие transport/UI/export компоненты не должны содержать site-specific JSON/DOM-селекторы.

Адаптер должен быть минимальным и основываться на реально наблюдаемом контракте сервиса.

## Network adapter

Предпочтительный путь после линии 0.5.x:

```text
DebuggerTransport
→ штатный response body страницы
→ service adapter
→ NormalizedConversation
→ exporter
```

Network adapter определяет:

- hostname/service detection;
- URL pattern нужного штатного ответа;
- проверку JSON schema;
- ID, порядок/parent-chain;
- роли;
- служебные/transient элементы;
- критерий полноты;
- преобразование в normalized messages.
- надежный timestamp сообщения, если он присутствует в штатном payload.

Transport отвечает только за attach/Network.enable/reload/request tracking/getResponseBody/detach и не знает структуру JSON конкретного сервиса.

## Scroll

Scrolling не является обязательной частью адаптера. Он используется только после фактического подтверждения, что сервис получает историю порциями и штатно запрашивает следующую часть при прокрутке.

Если полный snapshot приходит при initial load, адаптер не должен выполнять скроллинг.

## Дополнительные проходы

Дополнительный проход — повтор acquisition-процесса конкретного адаптера. Network adapter должен дедуплицировать данные по стабильным ID.

## DOM adapter

DOM остается временным способом для еще не мигрированных сервисов. При успешном переводе сервиса на network capture его старый DOM adapter и ставший неиспользуемым site-specific код удаляются.

## Репозиторий

Не добавлять template adapters, backup-файлы или future-заготовки. Новый файл допустим, если он реально импортируется/используется runtime/build либо является необходимой project/GitHub документацией.
