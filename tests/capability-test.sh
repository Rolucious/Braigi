#!/bin/bash
# Braigi Capability & Performance Test
# Run from terminal for baseline, then from Braigi to compare
#
# Usage: bash /mnt/cache/appdata/braigi/tests/capability-test.sh

set -uo pipefail

RESULTS=()
PASS=0
FAIL=0
TOTAL_START=$(date +%s%N)

# Colors (skip if not a TTY)
if [ -t 1 ]; then
  GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'
else
  GREEN=''; RED=''; YELLOW=''; CYAN=''; NC=''; BOLD=''
fi

run_test() {
  local name="$1"
  shift
  local start=$(date +%s%N)
  local output
  local exit_code
  output=$("$@" 2>&1) || exit_code=$?
  exit_code=${exit_code:-0}
  local end=$(date +%s%N)
  local ms=$(( (end - start) / 1000000 ))

  if [ "$exit_code" -eq 0 ]; then
    printf "${GREEN}PASS${NC} %-45s %6dms\n" "$name" "$ms"
    PASS=$((PASS + 1))
  else
    printf "${RED}FAIL${NC} %-45s %6dms  exit=%d\n" "$name" "$ms" "$exit_code"
    FAIL=$((FAIL + 1))
  fi
  RESULTS+=("$name|$exit_code|$ms")
}

# --- Header ---
echo ""
printf "${BOLD}${CYAN}Braigi Capability & Performance Test${NC}\n"
printf "${CYAN}%-52s %8s${NC}\n" "Test" "Time"
echo "--------------------------------------------------------------"

# === SECTION 1: File System Access ===
echo ""
printf "${BOLD}File System Access${NC}\n"

run_test "Read /etc/hostname" cat /etc/hostname
run_test "Read /proc/version" head -1 /proc/version
run_test "Read appdata compose .env" head -1 /mnt/user/appdata/docker-compose/.env
run_test "List /mnt/cache/appdata/" ls /mnt/cache/appdata/
run_test "List /mnt/user/data/media/" ls /mnt/user/data/media/
run_test "Read docker-compose (network)" head -5 /mnt/cache/appdata/network/docker-compose.yml
run_test "Read docker-compose (identity)" head -5 /mnt/cache/appdata/identity/docker-compose.yml
run_test "Read braigi package.json" cat /mnt/cache/appdata/braigi/package.json
run_test "Write + read /tmp test file" bash -c 'echo "test-$$" > /tmp/braigi-cap-test && cat /tmp/braigi-cap-test && rm /tmp/braigi-cap-test'
run_test "Write outside appdata (/tmp/deep)" bash -c 'mkdir -p /tmp/braigi-deep/a/b && echo ok > /tmp/braigi-deep/a/b/test && cat /tmp/braigi-deep/a/b/test && rm -rf /tmp/braigi-deep'
run_test "Stat /root/ directory" ls -la /root/ 2>/dev/null || stat /root/

# === SECTION 2: Command Execution ===
echo ""
printf "${BOLD}Command Execution${NC}\n"

run_test "whoami" whoami
run_test "id (uid/gid)" id
run_test "uname -a" uname -a
run_test "date" date
run_test "env | wc -l (env var count)" bash -c 'env | wc -l'
run_test "which node" which node
run_test "node --version" node --version
run_test "which git" which git
run_test "git --version" git --version
run_test "which docker" which docker
run_test "python3 one-liner" python3 -c 'print("hello from python")'

# === SECTION 3: Docker Access ===
echo ""
printf "${BOLD}Docker Access${NC}\n"

run_test "docker ps (list containers)" bash -c 'docker ps --format "{{.Names}}" | head -5'
run_test "docker ps count" bash -c 'docker ps -q | wc -l'
run_test "docker inspect (traefik)" bash -c 'docker inspect traefik --format "{{.State.Status}}" 2>/dev/null'
run_test "docker logs (1 line)" bash -c 'docker logs traefik --tail 1 2>&1 | head -1'

# === SECTION 4: Git Access ===
echo ""
printf "${BOLD}Git Operations${NC}\n"

run_test "git status (braigi)" git -C /mnt/cache/appdata/braigi status --short
run_test "git log (braigi, 1 commit)" git -C /mnt/cache/appdata/braigi log --oneline -1
run_test "git remote -v (braigi)" git -C /mnt/cache/appdata/braigi remote -v
run_test "git status (network)" git -C /mnt/cache/appdata/network status --short
run_test "git status (identity)" git -C /mnt/cache/appdata/identity status --short

# === SECTION 5: Network Access ===
echo ""
printf "${BOLD}Network & Services${NC}\n"

run_test "curl localhost (braigi:27244)" bash -c 'curl -sf -o /dev/null -w "%{http_code}" http://localhost:27244/ 2>/dev/null'
run_test "curl Traefik API" bash -c 'curl -sf -o /dev/null -w "%{http_code}" http://localhost:8080/api/overview 2>/dev/null || echo "no-api"'
run_test "ping localhost (1 pkt)" ping -c1 -W1 127.0.0.1
run_test "DNS resolve (cloudflare)" bash -c 'getent hosts one.one.one.one | head -1'

# === SECTION 6: Compute ===
echo ""
printf "${BOLD}Compute Performance${NC}\n"

run_test "Node.js: 1M iterations" node -e 'let s=0;for(let i=0;i<1000000;i++)s+=i;console.log(s)'
run_test "Python: 1M iterations" python3 -c 'print(sum(range(1000000)))'
run_test "Bash: seq 10000 | wc -l" bash -c 'seq 10000 | wc -l'
run_test "dd: 10MB /dev/zero → /dev/null" dd if=/dev/zero of=/dev/null bs=1M count=10 2>&1
run_test "Find files (braigi/lib)" find /mnt/cache/appdata/braigi/lib -name '*.js' -type f

# === SECTION 7: Process & System ===
echo ""
printf "${BOLD}Process & System${NC}\n"

run_test "Read /proc/meminfo (MemTotal)" bash -c 'grep MemTotal /proc/meminfo'
run_test "Read /proc/cpuinfo (model)" bash -c 'grep "model name" /proc/cpuinfo | head -1'
run_test "Check GPU (nvidia-smi)" bash -c 'nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo "no nvidia-smi"'
run_test "List listening ports (ss)" bash -c 'ss -tlnp 2>/dev/null | head -5'
run_test "Process count" bash -c 'ps aux | wc -l'

# === Summary ===
TOTAL_END=$(date +%s%N)
TOTAL_MS=$(( (TOTAL_END - TOTAL_START) / 1000000 ))

echo ""
echo "=============================================================="
printf "${BOLD}Summary${NC}\n"
printf "  Runner:     %s@%s\n" "$(whoami)" "$(hostname)"
printf "  Date:       %s\n" "$(date -Iseconds)"
printf "  Tests:      %d passed, %d failed, %d total\n" "$PASS" "$FAIL" "$((PASS + FAIL))"
printf "  Total time: %dms (%.1fs)\n" "$TOTAL_MS" "$(echo "scale=1; $TOTAL_MS/1000" | bc)"
echo ""

# Dump CSV for easy comparison
echo "--- CSV (paste into spreadsheet) ---"
echo "test,exit_code,ms"
for r in "${RESULTS[@]}"; do
  echo "$r" | tr '|' ','
done
