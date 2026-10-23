# Client Hunter

Находит традиционные бизнесы с конкретной проверяемой проблемой на сайте, готовит досье и персональное письмо. Оператор одобряет письма в Telegram. Полная спецификация: [docs/spec.md](docs/spec.md).

**Текущая фаза: поиск возможностей, этап 1 — данные и снятие фильтров (без LLM).** Писем нет никаких: результат печатается в консоль и сохраняется в `data/reports/`. Отправка выключена (`SENDING_ENABLED=false`, `DRY_RUN=true`).

Что изменилось относительно спецификации — [docs/decisions.md](docs/decisions.md): юрлицо больше не фильтр, риск контакта хранится отдельно и на отбор не влияет, собирается и публичная почта (gmail и т. п.).

## Требования
- Node.js **24 LTS**
- Windows или Linux
- Ключи API для поиска и проверки сайтов **не нужны**. Для отбора через Claude (`npm run screen`) нужен `ANTHROPIC_API_KEY` в `.env` (отдельный платный API, не подписка Claude)

## Установка
```sh
npm install
npx playwright install chromium   # браузер для мобильных проверок и скриншотов
cp .env.example .env               # на Windows: copy .env.example .env
npm run check-config
```

## Как посмотреть поиск
```sh
npm run pipeline -- --market UK --segment S2 --limit 10
```
Что происходит:
1. **Поиск** — OpenStreetMap (Overpass) по городам из `discovery_cities` в `config/markets/uk.yaml` и тегам сегмента. Найденные компании сохраняются в базу (дубли по домену склеиваются).
2. **Проверка** — по `--limit` случайных необработанных компаний: robots.txt → главная → до 5 важных страниц → тип юрлица по тексту сайта → проверки из раздела 8.3 спеки → мобильная проверка в Chromium (390×844, скриншоты) → контакты с MX-проверкой.
3. **Вывод** — строка в консоль на каждую компанию, итог, и отчёт `data/reports/candidates-UK-*.md` + `.csv`.

Полезные флаги:
- `--no-discovery` — не искать заново, проверить ещё необработанные компании из базы
- `--no-browser` — без Chromium (быстрее, без скриншотов и мобильных проверок)
- `--segment S1` — Shopify-магазины (всё, что не Shopify, отсеивается)

Публичный Overpass иногда перегружен (HTTP 502/504) — программа сама ждёт и повторяет до 4 раз, а если город так и не ответил, переходит к следующему.

## Команды
| Команда | Что делает |
|---|---|
| `npm run pipeline -- --market UK --segment S2 --limit 10` | поиск + проверка + отчёт |
| `npm run report:candidates -- --market UK` | пересобрать отчёт из базы |
| `npm run reinspect -- --dry-run` | сколько компаний, отсеянных по старым правилам, будет перепроверено |
| `npm run reinspect -- --market UK --limit 50` | перепроверить их по новым правилам (без браузера; `--browser` — с мобильными проверками) |
| `npm run screen -- --dry-run --domain example.co.uk` | показать, что уйдёт в Claude Haiku, и оценку стоимости — **без вызова API** |
| `npm run screen -- --market UK --limit 10` | этап B: отбор компаний через Claude Haiku (**платно**, ~$0.001 за компанию; лимиты в `config/limits.yaml`) |
| `npm run import-csv -- --file list.csv --market UK --segment S2` | добавить свои домены (CSV: `website,name,city` или по домену в строке) |
| `npm run migrate` | применить `migrations/*.sql` |
| `npm run check-config` | проверить `config/` и флаги из `.env` |
| `npm test` · `npm run typecheck` · `npm run lint` | тесты (без сети и почты), типы, линтер |

## Что пока упрощено (без регистраций)
- **Companies House не подключён** — тип юрлица (Ltd/Limited/PLC/LLP и номер компании) берётся с сайта, `registry_status = not_checked`. Для Фазы 4 нужен бесплатный ключ.
- **PageSpeed не подключён** — проверки `SLOW_MOBILE` нет.
- **User-Agent** бота ссылается на этот репозиторий; заменить на страницу о боте на своём домене, когда он появится (`config/app.yaml`).

## Причины автоотказа (`reject_reason`)
| Код | Значение |
|---|---|
| `site_unreachable`, `home_http_NNN`, `home_not_html` | сайт не открылся |
| `robots_disallow`, `robots_unavailable` | robots.txt запрещает нам заходить |
| `redirects_offsite` | сайт перенаправляет на другой домен |
| `parked_domain` | домен припаркован / продаётся |
| `not_shopify`, `store_closed`, `too_few_products` | для S1 |
| `suppressed` | домен в suppression list |

Больше **не** отсеивают (с 2026-10-23): неизвестное юрлицо, ИП, отсутствие email, отсутствие технических проблем. Это записывается в базу, а законность холодного письма — отдельное поле «риск контакта» (`low` / `review_required` / `high`) рядом с компанией в отчёте.

## Конфиги
| Файл | Что внутри |
|---|---|
| `config/app.yaml` | часовой пояс оператора, User-Agent, порог score |
| `config/limits.yaml` | лимиты: страниц на сайт, задержки, таймауты, параллельность |
| `config/llm.yaml` | модели и цены токенов (Фаза 2) |
| `config/scoring.yaml` | веса скоринга (Фаза 2, не откалиброваны) |
| `config/offers.yaml` | офферы O1–O3 и цены-гипотезы |
| `config/copy-rules.yaml` | правила текста писем (Фаза 2) |
| `config/markets/*.yaml` | юридические профили рынков; включён только UK |
| `config/segments/*.yaml` | OSM-теги, SIC-коды по сегментам |

## Документы
- [docs/verification-log.md](docs/verification-log.md) — проверка источников данных
- [docs/email-setup.md](docs/email-setup.md) — домен, SPF/DKIM/DMARC, прогрев (к Фазе 3)
- `docs/legal/lia-*.md` — шаблоны оценки законного интереса
