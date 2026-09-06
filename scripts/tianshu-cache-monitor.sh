#!/bin/bash
# ============================================================================
# tianshu-tui 缓存命中率监控 + 异常自动诊断（适配自 claude-cache-monitor.sh）
# ============================================================================
# 用法:
#   bash scripts/tianshu-cache-monitor.sh once       单次检查+报告
#   bash scripts/tianshu-cache-monitor.sh run        前台循环（每60s）
#   bash scripts/tianshu-cache-monitor.sh daemon     后台（nohup）
#   bash scripts/tianshu-cache-monitor.sh status     查看最近记录
#
# 数据源: tianshu `rivet serve` 的 GET /cache/usage（默认端口 3100，Bearer token fail-closed）。
#   totals.hitRate 为 0–100 百分比（本地口径 ΣcacheRead/Σinput，主轮行；无输入为 null）。
#   与知识库 permafrost 口径一致：Pro>85 正常 / <85 告警 / <70 dump。
#
# 动作: 只 dump（stats 快照 + 触发原因），不重启任何进程（知识库教训：自动重启会中断会话）。
# 依赖: bash + curl + node（JSON 解析/数值比较，Windows 可移植；不依赖 python3/bc/jq）。
# ============================================================================
set -u

TIANSHU_URL="${TIANSHU_URL:-http://127.0.0.1:3100}"
TIANSHU_TOKEN="${TIANSHU_TOKEN:-}"          # 若 rivet serve 设了 RIVET_SERVER_TOKEN，需一致
MONITOR_DIR="${MONITOR_DIR:-$HOME/.tianshu/cache-monitor}"
STATE_FILE="$MONITOR_DIR/state.json"
LOG_FILE="$MONITOR_DIR/monitor.log"

HIT_RATE_WARN=85        # 命中率低于此值（%）→ 告警
HIT_RATE_DUMP=70        # 命中率低于此值（%）→ 触发 dump
MISS_RATIO_DUMP=0.5     # 新增 miss 占比超过此值 → 触发 dump

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
mkdir -p "$MONITOR_DIR"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# 逃生开关（E1）：设 TIANSHU_CACHE_MONITOR_DISABLED=1 或 touch .disabled → once/run/daemon 静默退出
# （stop/status 不受影响，保证能停守护、能看状态）。
case "${1:-once}" in
  stop|status) ;;
  *)
    if [ "${TIANSHU_CACHE_MONITOR_DISABLED:-0}" = "1" ] || [ -f "$MONITOR_DIR/.disabled" ]; then
      echo "[$(ts)] ⛔ 逃生开关已启用（TIANSHU_CACHE_MONITOR_DISABLED=1 或 $MONITOR_DIR/.disabled），静默退出"
      exit 0
    fi
    ;;
esac

# node 脚本：从 JSON 文件抽取字段（含安全的数值兜底）
node_field() {
  # $1 = json 文件路径, $2 = 点路径表达式（如 totals.hitRate）
  node -e "
const fs=require('fs');
try {
  const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
  let v=d;
  for (const k of process.argv[2].split('.')) { if (v==null) break; v=v[k]; }
  if (v==null) { console.log('null'); process.exit(0); }
  console.log(typeof v==='number'?v:String(v));
} catch(e){ console.log('null'); }
" "$1" "$2" 2>/dev/null
}

fetch_stats() {
  local out="$MONITOR_DIR/.stats.tmp"
  # 关键：先清旧文件，避免 curl 连接失败时读到上一次的陈旧数据（误判为有数据）。
  rm -f "$out"
  if [ -n "$TIANSHU_TOKEN" ]; then
    curl -s -H "Authorization: Bearer $TIANSHU_TOKEN" "$TIANSHU_URL/cache/usage?days=1&scope=all" -o "$out" 2>/dev/null
  else
    curl -s "$TIANSHU_URL/cache/usage?days=1&scope=all" -o "$out" 2>/dev/null
  fi
  if [ ! -s "$out" ]; then echo '{"error":"unreachable"}'; return; fi
  echo "$out"
}

# 状态读写：把 totals 快照存成 JSON（last_hit_rate / last_req / last_read / last_create）
load_state() {
  [ -f "$STATE_FILE" ] && cat "$STATE_FILE" || echo '{"hit":null,"req":0,"read":0,"create":0}'
}

save_state() {
  local hit="$1" req="$2" read="$3" create="$4"
  node -e "
const fs=require('fs');
const d={hit:process.argv[1]==='null'?null:Number(process.argv[1]),req:Number(process.argv[2]),read:Number(process.argv[3]),create:Number(process.argv[4])};
fs.writeFileSync(process.argv[5], JSON.stringify(d,null,2));
" "$hit" "$req" "$read" "$create" "$STATE_FILE"
}

trigger_dump() {
  local reason="$1"
  local dump_id="dump-$(date '+%Y%m%d-%H%M%S')"
  local dump_dir="$MONITOR_DIR/$dump_id"
  mkdir -p "$dump_dir"
  echo -e "${RED}[$(ts)] 触发诊断 dump: $reason${NC}"
  echo "[$(ts)] TRIGGER: $reason" >> "$LOG_FILE"
  cp "$MONITOR_DIR/.stats.tmp" "$dump_dir/cache-usage.json" 2>/dev/null
  # 触发原因 + 当前快照
  cat > "$dump_dir/trigger.txt" << EOF
触发时间: $(ts)
触发原因: $reason
数据源: $TIANSHU_URL/cache/usage?days=1&scope=all
EOF
  echo -e "${GREEN}[$(ts)] dump 已保存: $dump_dir${NC}"
}

do_check() {
  local stats_file=$(fetch_stats)
  if [ "$(node_field "$stats_file" error 2>/dev/null)" = "unreachable" ] || [ ! -s "$stats_file" ]; then
    echo "[$(ts)] ⚠️ $TIANSHU_URL 不可达" >> "$LOG_FILE"
    echo "[$(ts)] unreachable"
    return
  fi

  local cur_hit=$(node_field "$stats_file" totals.hitRate)
  local cur_req=$(node_field "$stats_file" totals.requests)
  local cur_read=$(node_field "$stats_file" totals.cacheRead)
  local cur_create=$(node_field "$stats_file" totals.cacheCreate)
  [ "$cur_req" = "null" ] && cur_req=0
  [ "$cur_read" = "null" ] && cur_read=0
  [ "$cur_create" = "null" ] && cur_create=0

  local prev_hit=$(node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(d.hit==null?'null':d.hit)" "$STATE_FILE" 2>/dev/null || echo null)
  local prev_req=$(node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(d.req)" "$STATE_FILE" 2>/dev/null || echo 0)
  local prev_read=$(node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(d.read)" "$STATE_FILE" 2>/dev/null || echo 0)
  local prev_create=$(node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(d.create)" "$STATE_FILE" 2>/dev/null || echo 0)

  local triggered="" reason=""

  # 检查1: 命中率骤降（有输入数据时）
  if [ "$cur_hit" != "null" ]; then
    local hit_ok=$(node -e "console.log(Number(process.argv[1]) < Number(process.argv[2]) ? 1 : 0)" "$cur_hit" "$HIT_RATE_DUMP")
    if [ "$hit_ok" = "1" ]; then
      triggered=1; reason="hit_rate=${cur_hit}% < ${HIT_RATE_DUMP}%"
    fi
  fi

  # 检查2: 新增 miss 占比过高（delta）
  if [ "$cur_req" -gt "$prev_req" ] 2>/dev/null; then
    local new_read=$((cur_read - prev_read))
    local new_create=$((cur_create - prev_create))
    if [ "$new_read" -gt 0 ] && [ "$new_create" -gt 0 ]; then
      local miss_ratio=$(node -e "console.log((process.argv[2]/(process.argv[2]+process.argv[1])).toFixed(3))" "$new_read" "$new_create")
      local miss_ok=$(node -e "console.log(Number(process.argv[1]) > Number(process.argv[2]) ? 1 : 0)" "$miss_ratio" "$MISS_RATIO_DUMP")
      if [ "$miss_ok" = "1" ]; then
        triggered=1
        [ -n "$reason" ] && reason="$reason; "
        reason="${reason}miss_ratio=${miss_ratio} (+${new_create}miss/+${new_read}hit)"
      fi
    fi
  fi

  save_state "$cur_hit" "$cur_req" "$cur_read" "$cur_create"

  if [ -n "$triggered" ]; then
    trigger_dump "$reason"
    echo "[$(ts)] CHECK: rate=${cur_hit} req=${cur_req} → DUMP: $reason" >> "$LOG_FILE"
  else
    local icon="✅"
    if [ "$cur_hit" != "null" ]; then
      local warn_ok=$(node -e "console.log(Number(process.argv[1]) < Number(process.argv[2]) ? 1 : 0)" "$cur_hit" "$HIT_RATE_WARN")
      [ "$warn_ok" = "1" ] && icon="⚠️"
    fi
    echo "[$(ts)] $icon rate=${cur_hit}% req=${cur_req} read=${cur_read} create=${cur_create}" >> "$LOG_FILE"
  fi
  echo "[$(ts)] rate=${cur_hit}% req=${cur_req} read=${cur_read} create=${cur_create} ${triggered:+⚠️ $reason}"
}

case "${1:-once}" in
  once) do_check ;;
  run)
    echo "tianshu 缓存监控运行中（间隔60s，日志 $LOG_FILE）"
    echo "阈值: hit_rate<${HIT_RATE_DUMP}% 或 miss_ratio>${MISS_RATIO_DUMP} → 触发 dump（不重启进程）"
    while true; do do_check; sleep 60; done
    ;;
  daemon)
    nohup bash "$0" run >> "$MONITOR_DIR/daemon.log" 2>&1 &
    echo $! > "$MONITOR_DIR/daemon.pid"
    echo "监控守护已启动 (PID $!) · 日志 $MONITOR_DIR/daemon.log · 停止 bash $0 stop"
    ;;
  stop)
    if [ -f "$MONITOR_DIR/daemon.pid" ]; then
      pid=$(cat "$MONITOR_DIR/daemon.pid" 2>/dev/null)
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null && echo "已停止守护 (PID $pid)"
      else
        echo "守护未运行（PID 文件过期）"
      fi
      rm -f "$MONITOR_DIR/daemon.pid"
    else
      echo "无守护 PID 文件（守护未启动）"
    fi
    ;;
  status)
    echo "=== 最近检查 ==="; tail -5 "$LOG_FILE" 2>/dev/null || echo "(无记录)"
    echo "=== dump 历史 ==="; ls -lt "$MONITOR_DIR"/dump-* 2>/dev/null | head -5 || echo "(无 dump)"
    ;;
  *) echo "Usage: $0 {once|run|daemon|stop|status}" ;;
esac
