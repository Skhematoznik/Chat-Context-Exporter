# Release 1.0.25

Версия 1.0.25 — узкое correctness-исправление поверх 1.0.24.

## Исправленный сценарий

На реальном длинном чате без доступного TOC версия 1.0.24 смогла собрать:

- 114 стабильных canonical message-id;
- 116 turn-slot каркаса;
- подтвержденные начало и конец;
- только 2 unresolved turn-slot.

Но связная canonical chain останавливалась на 89 сообщениях. Старый eligibility-path требовал уже сшитую chain до запуска локального classifier, поэтому repair не запускался. Это было циклическое условие: unresolved slot могли быть единственной причиной самого разрыва.

## Что изменено

Без TOC локальный classifier теперь может исследовать ограниченное число unresolved turn-slot, если одновременно выполнены строгие предварительные условия:

- настоящий top подтвержден;
- настоящий bottom подтвержден;
- все canonical records стабильны;
- нет loop и ambiguity;
- каждый canonical record представлен собственным skeleton-slot;
- отсутствует другой незавершенный processing/auxiliary контекст;
- unresolved slot находятся в пределах safety-limit.

## Почему это не ослабляет COMPLETE

Repair только пытается классифицировать локальный неизвестный slot.

После него экспорт по-прежнему получает `COMPLETE` **только если обычный `validateCompleteness()` заново подтверждает всю цепочку**. Настоящее недогруженное сообщение, оставшийся gap, loop, нестабильная запись или неизвестный slot продолжают приводить к `INCOMPLETE`.

## Не изменено

- основной scanner;
- recovery scanner;
- checkpoint schema 16;
- TOC-backed repair;
- трехкратное подтверждение noncanonical slot;
- processing/artifact capture;
- serializer invariant 1.0.24;
- финальный verifier.
