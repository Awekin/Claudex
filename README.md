<div align="center">

# Claudex

**Codex и Antigravity внутри Claude Code: общий контекст, треды в нужном проекте Codex App, модели Antigravity с автовыбором, карточки ответов и живая панель прогресса.**

*Hand tasks from Claude Code to Codex and Antigravity models — with shared context, Codex App project threads, automatic model choice and a live progress panel.*

[![Based on openai/codex-plugin-cc](https://img.shields.io/badge/based%20on-openai%2Fcodex--plugin--cc-black?logo=github)](https://github.com/openai/codex-plugin-cc)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-d97757)

</div>

> [!NOTE]
> **Claudex — форк [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)**, официального плагина Codex для Claude Code от OpenAI.
> Вся базовая часть (команды `/codex:*`, работа с Codex app-server, фоновые задачи) взята оттуда и распространяется под той же лицензией Apache-2.0, © OpenAI.
> В этом репозитории добавлены изменения, описанные ниже; история коммитов оригинала сохранена.

---

## Что нового по сравнению с оригиналом

| | Оригинал | Claudex |
|---|---|---|
| **Контекст** | Codex видит только текст задачи | Codex получает недавнюю переписку из Claude и не просит объяснять всё заново |
| **Треды** | Каждый запуск — новый временный тред | `/codex:rescue` продолжает тред текущей сессии Claude; ревью тоже сохраняются |
| **Codex App** | Треды не видны в приложении | Треды попадают в нужный **проект** в сайдбаре Codex App как `Claude → Codex: …` |
| **Ответ** | Голый текст | Карточка: статус, время, изменённые файлы `+/−`, команды, краткие рассуждения |
| **Ход работы** | Только `/codex:status` | **Панель Codex** сбоку от чата обновляется в реальном времени |
| **Установка Codex** | Нужен `codex` в `PATH` | Подхватывает CLI из ChatGPT.app или Codex.app |
| **Другие модели** | Только Codex | Плагин `antigravity`: Gemini 4 Hydrogen/Argon, Gemini Flash, Claude Opus/Sonnet из вашей подписки Google |

### 🧠 Общий контекст

К задаче добавляется блок `<claude_code_context>` с недавними сообщениями из Claude: только текст, без вызовов инструментов и их вывода, до 16 000 символов. При продолжении треда передаются только сообщения после прошлого хода Codex.

### 🧵 Треды, которые не теряются

- `/codex:rescue` без флагов продолжает тред Codex текущей сессии Claude, а если его нет, создаёт новый.
- `--fresh` — начать новый тред, `--resume` — продолжить явно.
- Стоп-гейт ревью по-прежнему работает в отдельном временном треде.

### 📁 Проекты в Codex App

Плагин находит проект Codex App, в который входит рабочая папка, и создаёт тред сразу в нём. Старые треды привязываются к проекту при продолжении.

### 🪟 Панель Codex

Отдельный плагин `codex-panel` открывает панель сбоку от чата в приложении Claude. Панель открывается сама, когда Codex берёт задачу, или по команде `/codex-panel`.

```
● в работе 1   ✓ 6

┃ Добавь атомарный gain для источника звука
┃ Outputs · задача · правит
┃ ● проверяет · 1 мин 57 с
┃ ✓ изучает › ✓ правит › ● проверяет › ○ итог
┃ 📖 Читает AGENTS.md, OutputsDSP.c
┃ 🔍 Ищет «sourceGain»
┃ ✎ Правит 1 файл
┃ 🧪 Запускает тесты · Scripts/test_dsp.sh
┃ 14 команд · 1 правка

ГОТОВО
✓ Исправь логин после обновления сессии            [Ответ]
  Outputs · задача · правит · 14 мин 15 с · 2 мин назад
```

### 🚀 Antigravity: модели Google в Claude Code

Плагин `antigravity` отдаёт задачи официальному [Antigravity CLI](https://antigravity.google/docs/install?tab=cli) `agy`, так же, как плагин Codex работает через `codex`: агент правит файлы проекта, запускает команды и отвечает карточкой.

- **Модели:** Gemini 4 Hydrogen (Low → XHigh), Gemini 4 Argon, Gemini 3.8 Flash, Claude Opus 5.5 / Sonnet 5.5, GPT-OSS. Набор зависит от вашей подписки, список и остаток квоты показывает `/antigravity:models`.
- **Автовыбор:** Claude сам выбирает модель под задачу: Flash для мелочей, Hydrogen для обычной работы, Hydrogen High/XHigh для сложного, Argon или Opus/Sonnet для второго мнения. Перед дорогими моделями Claude смотрит квоту, а карточка ответа показывает квоту модели до и после задачи. Если квота кончилась, плагин переключится на следующую модель и скажет об этом.
- **Память:** задачи из одного чата Claude идут в один разговор `agy`; продолжить его в терминале: `agy --conversation <id>`.
- **Квота:** если приложение Antigravity открыто, плагин берёт из него остаток квоты по каждой модели; без приложения квота просто не показывается.
- **Панель:** задачи Antigravity показываются в той же боковой панели, с меткой модели.

> [!NOTE]
> Задачи из `agy` хранятся в истории CLI, а не в списке разговоров приложения Antigravity. Следить за ними удобно в боковой панели и карточках.

### 🃏 Карточка ответа

```
✅ Codex: готово · «Исправь логин…» · 2 мин 14 с

<ответ Codex>

Изменённые файлы (3) · +67 −9
Команды: ✓ npm test   ✗ npm run lint
Как рассуждал (кратко): …
Лимиты Codex: 5 ч — осталось 94% (сброс в 22:21) · неделя — осталось 72%
Тред в Codex: 01a1…
```

---

## Установка

**Что нужно:**

- [Claude Code](https://claude.com/claude-code): приложение Claude (вкладка Code) или CLI.
- Codex: ChatGPT.app с Codex, Codex.app или CLI `codex` (`npm install -g @openai/codex`) с выполненным входом в аккаунт OpenAI.
- Node.js 18.18+.
- Для плагина `antigravity`: Antigravity CLI — `curl -fsSL https://antigravity.google/cli/install.sh | bash`, затем один раз запустить `agy` и войти в аккаунт Google. Приложение Antigravity нужно только для показа квоты.
- Панель `codex-panel` работает в приложении Claude (вкладка Code); в терминальном CLI остаются карточки и `/codex:status`.

**В терминале:**

```bash
claude plugin marketplace add Awekin/Claudex
```

```bash
claude plugin install codex@claudex codex-panel@claudex antigravity@claudex
```

Или прямо в чате Claude Code:

```
/plugin marketplace add Awekin/Claudex
/plugin install codex@claudex
/plugin install codex-panel@claudex
/plugin install antigravity@claudex
/reload-plugins
```

После установки откройте новый чат и выполните `/codex:setup`. Если Codex установлен, но вход не выполнен: `!codex login`.

В чате появятся команды `/codex:*` и `codex:codex-rescue` subagent в `/agents`.

> [!IMPORTANT]
> Если у вас уже стоит оригинальный плагин, удалите его, чтобы команды `/codex:*` не дублировались:
> `claude plugin uninstall codex@openai-codex`

---

## Использование

| Команда | Что делает |
|---|---|
| `/codex:rescue <задача>` | Отдать задачу Codex (продолжает тред сессии) |
| `/codex:rescue --fresh <задача>` | То же, но в новом треде |
| `/codex:rescue --background <задача>` | Запустить в фоне |
| `/codex:review` | Ревью текущих изменений |
| `/codex:adversarial-review` | Придирчивое ревью с фокусом на рисках |
| `/codex:status` · `/codex:result` · `/codex:cancel` | Управление фоновыми задачами |
| `/codex:limits` | Сколько осталось лимитов Codex: окно 5 ч и неделя |
| `/codex-panel` | Открыть панель Codex · Antigravity |
| `/antigravity:task [--model hydrogen-high] <задача>` | Отдать задачу Antigravity (модель Claude выберет сам, если не указана) |
| `/antigravity:models` | Модели Antigravity и остаток квоты |
| `/antigravity:status` · `/antigravity:result` | Ход и результат задач Antigravity |

Флаги `rescue`: `--write` (разрешить правки), `--no-context` (не передавать переписку), `--model`, `--effort`.

Claude знает о плагинах сам: достаточно написать «отдай это Codex» или «пусть Antigravity посмотрит».

Полное описание команд оригинала: [docs/UPSTREAM-README.md](docs/UPSTREAM-README.md).

### Переменные окружения

| Переменная | Значение |
|---|---|
| `CODEX_COMPANION_NO_CLAUDE_CONTEXT=1` | Не передавать переписку из Claude |
| `CODEX_COMPANION_NO_PROJECT=1` | Не привязывать треды к проектам Codex App |
| `CODEX_COMPANION_CODEX_BIN=/путь/к/codex` | Свой путь к Codex CLI |
| `CODEX_COMPANION_PLAIN_OUTPUT=1` | Голый текст ответа вместо карточки |
| `ANTIGRAVITY_AGY_BIN=/путь/к/agy` | Свой путь к Antigravity CLI |
| `ANTIGRAVITY_COMPANION_NO_CLAUDE_CONTEXT=1` | Не передавать переписку из Claude в Antigravity |

---

## Лицензия и авторство

- Основа: [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), © OpenAI, [Apache-2.0](LICENSE). См. также [NOTICE](NOTICE).
- Изменения Claudex (общий контекст, треды в проектах Codex App, карточки ответов, плагины `codex-panel` и `antigravity`) распространяются под той же лицензией.
- Claudex — независимый проект и не связан с OpenAI, Google или Anthropic.
