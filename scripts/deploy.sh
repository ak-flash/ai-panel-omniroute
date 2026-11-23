#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  printf '%s\n' 'Использование: ./scripts/deploy.sh' \
    'HEALTH_URL — необязательный адрес проверки /api/ready.'
  exit 0
fi

log() { printf '[deploy] %s\n' "$*"; }
fail() { printf '[deploy] %s\n' "$*" >&2; exit 1; }

[[ $# == 0 ]] || fail 'Неизвестные аргументы. См. --help.'
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

for cmd in git node npm pm2 curl flock; do
  command -v "$cmd" >/dev/null || fail "Не найдена команда: $cmd"
done
node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 22 ? 1 : 0)' ||
  fail 'Требуется Node.js 22 или новее.'

exec 9>"$(git rev-parse --absolute-git-dir)/ai-panel-deploy.lock"
flock -n 9 || fail 'Деплой в этой рабочей копии уже выполняется.'
# Не передавать блокировку демону PM2 и запущенному приложению.
pm2_cmd() { pm2 "$@" 9>&-; }

branch=$(git symbolic-ref --quiet --short HEAD) || fail 'Переключитесь на ветку с upstream.'
changes=$(git status --porcelain)
[[ -z "$changes" ]] || fail 'Рабочая копия не чистая. Сохраните локальные изменения перед деплоем.'

log "Обновление ветки $branch"
git pull --ff-only

# Читаем .env тем же парсером, что и сервер, не выполняя его как shell-скрипт.
health_url=${HEALTH_URL:-$(node -e '
  const { loadConfig, loadEnvFile, resolveEnvFile } = require("./src/config");
  loadEnvFile(resolveEnvFile());
  const { host, port } = loadConfig();
  const addr = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  process.stdout.write(`http://${addr.includes(":") ? `[${addr}]` : addr}:${port}/api/ready`);
')}

# Ошибка PM2 не должна интерпретироваться как отсутствие процесса.
exists=$(pm2_cmd jlist | node -e '
  const processes = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  process.stdout.write(String(processes.some(({ name }) => name === "ai-panel")));
')

log 'Установка production-зависимостей'
npm ci --omit=dev

if [[ $exists == true ]]; then
  log 'Перезапуск ai-panel'
  pm2_cmd restart ai-panel --update-env
else
  log 'Первый запуск ai-panel'
  pm2_cmd start server.js --name ai-panel
fi

log 'Проверка /api/ready'
for ((attempt = 1; attempt <= 15; attempt++)); do
  if status=$(curl --silent --max-time 2 --output /dev/null --write-out '%{http_code}' -- "$health_url") &&
    [[ $status == 200 ]]; then
    pm2_cmd save
    log "Готово: $(git rev-parse --short HEAD), /api/ready → HTTP 200"
    exit 0
  fi
  if ((attempt < 15)); then sleep 1; fi
done

pm2_cmd logs ai-panel --lines 30 --nostream || true
fail '/api/ready не вернул HTTP 200. Проверьте логи, HOST/PORT и HEALTH_URL.'
