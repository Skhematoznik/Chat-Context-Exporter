# Chat Context Exporter 1.0.25

Первый публичный релиз репозитория.

Chat Context Exporter сохраняет открытый чат ChatGPT в Markdown и перед выдачей `COMPLETE` проверяет связность истории, canonical message-id, turn-skeleton и доступные prompt-группы.

## Что важно в 1.0.25

- исправлен no-TOC сценарий, в котором unresolved служебные turn-slot могли одновременно разрывать canonical chain и блокировать собственный локальный repair;
- финальный критерий `COMPLETE` не ослаблен;
- сохранена защита 1.0.24 от ложного `INCOMPLETE`, когда текст чата сам содержит примеры `<!-- noncanonical-turn: ... -->`;
- длинные чаты, checkpoint, пауза при скрытии вкладки, processing details и generated artifacts остаются частью текущей архитектуры.

## Установка

1. Скачайте `Chat-Context-Exporter-v1.0.25.zip`.
2. Распакуйте архив.
3. Откройте `chrome://extensions/`.
4. Включите режим разработчика.
5. Нажмите «Загрузить распакованное расширение» и выберите папку с `manifest.json`.

Подробное описание, ограничения и правила диагностики находятся в `README.md`.
