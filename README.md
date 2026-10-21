# Client Hunter

Находит традиционные бизнесы с конкретной проверяемой проблемой на сайте, готовит досье и персональное письмо. Оператор одобряет письма в Telegram. Полная спецификация: [docs/spec.md](docs/spec.md).

**Текущая фаза: 0 — каркас.** Конвейер, бот и отправка ещё не реализованы. Отправка писем выключена (`SENDING_ENABLED=false`, `DRY_RUN=true`).

## Требования
- Node.js **24 LTS** (на Node 20 `better-sqlite3` не собирается)
- Windows или Linux

## Установка
```sh
npm install
cp .env.example .env      # на Windows: copy .env.example .env
npm run migrate           # создаёт data/client-hunter.sqlite
npm run check-config      # проверяет все YAML-конфиги
```

## Команды
| Команда | Что делает | Статус |
|---|---|---|
| `npm run pipeline -- --help` | справка по конвейеру | ✅ |
| `npm run pipeline -- --market UK --segment S2 --limit 50` | проверяет аргументы и конфиг; стадии — в Фазе 1 | заглушка |
| `npm run migrate` | применяет `migrations/*.sql` | ✅ |
| `npm run check-config` | валидирует `config/` и флаги из `.env` | ✅ |
| `npm test` | тесты (без сети и почты) | ✅ |
| `npm run typecheck` / `npm run lint` | TypeScript / ESLint | ✅ |

## Переменные окружения
См. [.env.example](.env.example). В Фазе 0 ни одна не обязательна. Флаги безопасности принимают только `true`/`false`:
- `SENDING_ENABLED` (по умолчанию `false`) и `DRY_RUN` (по умолчанию `true`) — оператор меняет вручную только в Фазе 4.

## Конфиги
| Файл | Что внутри |
|---|---|
| `config/app.yaml` | часовой пояс оператора, время очереди/сводки, порог score |
| `config/limits.yaml` | лимиты на прогон (раздел 6.2) |
| `config/llm.yaml` | модели и цены токенов |
| `config/scoring.yaml` | веса и таблицы скоринга (не откалиброваны) |
| `config/offers.yaml` | офферы O1–O3 и цены-гипотезы |
| `config/copy-rules.yaml` | запреты и лимиты для текста писем, строки отказа |
| `config/markets/*.yaml` | юридические профили рынков; включён только UK, `legal_review_done: false` везде |
| `config/segments/*.yaml` | OSM-теги, SIC-коды, запросы по сегментам |

Конфиги проверяются zod-схемами (`src/config/schema.ts`): неизвестный ключ = ошибка.

## Документы
- [docs/verification-log.md](docs/verification-log.md) — проверка источников данных и условий
- [docs/email-setup.md](docs/email-setup.md) — домен, SPF/DKIM/DMARC, прогрев
- `docs/legal/lia-*.md` — шаблоны оценки законного интереса (заполняет оператор)
