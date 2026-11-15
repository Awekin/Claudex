<div align="center">

# Claudex

**Codex внутри Claude Code: общий контекст, треды в нужном проекте Codex App, карточки ответов и живая панель прогресса.**

*Hand tasks from Claude Code to Codex — with shared context, Codex App project threads and a live progress panel.*

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

### 🃏 Карточка ответа

```
✅ Codex: готово · «Исправь логин…» · 2 мин 14 с

<ответ Codex>

Изменённые файлы (3) · +67 −9
Команды: ✓ npm test   ✗ npm run lint
Как рассуждал (кратко): …
Тред в Codex: 01a1…
```

---

## Установка

**Что нужно:**

- [Claude Code](https://claude.com/claude-code): приложение Claude (вкладка Code) или CLI.
- Codex: ChatGPT.app с Codex, Codex.app или CLI `codex` (`npm install -g @openai/codex`) с выполненным входом в аккаунт OpenAI.
- Node.js 18.18+.
- Панель `codex-panel` работает в приложении Claude (вкладка Code); в терминальном CLI остаются карточки и `/codex:status`.

**В терминале:**

```bash
claude plugin marketplace add Awekin/Claudex
```

```bash
claude plugin install codex@claudex codex-panel@claudex
```

Или прямо в чате Claude Code:

```
/plugin marketplace add Awekin/Claudex
/plugin install codex@claudex
/plugin install codex-panel@claudex
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
| `/codex-panel` | Открыть панель Codex |

Флаги `rescue`: `--write` (разрешить правки), `--no-context` (не передавать переписку), `--model`, `--effort`.

Claude знает о плагине сам: достаточно написать «отдай это Codex» или «пусть Codex посмотрит».

Полное описание команд оригинала: [docs/UPSTREAM-README.md](docs/UPSTREAM-README.md).

### Переменные окружения

| Переменная | Значение |
|---|---|
| `CODEX_COMPANION_NO_CLAUDE_CONTEXT=1` | Не передавать переписку из Claude |
| `CODEX_COMPANION_NO_PROJECT=1` | Не привязывать треды к проектам Codex App |
| `CODEX_COMPANION_CODEX_BIN=/путь/к/codex` | Свой путь к Codex CLI |
| `CODEX_COMPANION_PLAIN_OUTPUT=1` | Голый текст ответа вместо карточки |

---

## Лицензия и авторство

- Основа: [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), © OpenAI, [Apache-2.0](LICENSE). См. также [NOTICE](NOTICE).
- Изменения Claudex (общий контекст, треды в проектах Codex App, карточки ответов, плагин `codex-panel`) распространяются под той же лицензией.
- Claudex — независимый проект и не связан с OpenAI или Anthropic.
