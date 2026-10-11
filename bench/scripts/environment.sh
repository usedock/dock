#!/usr/bin/env bash
# Prints the runner hardware and tool versions as JSON, for the benchmark results. Needs jq.
set -euo pipefail
DOCK="${DOCK_BIN:-dock}"
image="$("$DOCK" images --json | jq -c '[.[] | select(.cached == true)]' 2>/dev/null || echo '[]')"
jq -n \
  --arg date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg runnerImage "${ImageOS:-unknown} ${ImageVersion:-unknown}" \
  --arg cpuModel "$(lscpu | sed -n 's/^Model name:[[:space:]]*//p' | head -1)" \
  --arg cpus "$(nproc)" \
  --arg hypervisor "$(lscpu | sed -n 's/^Hypervisor vendor:[[:space:]]*//p' | head -1)" \
  --arg memoryGiB "$(awk '/MemTotal/ {printf "%.1f", $2/1048576}' /proc/meminfo)" \
  --arg kernel "$(uname -r)" \
  --arg dock "$("$DOCK" version)" \
  --arg qemu "$(qemu-system-x86_64 --version | head -1)" \
  --argjson image "$image" \
  --arg kvm "$(ls -l /dev/kvm)" \
  '{date: $date, runnerImage: $runnerImage, cpuModel: $cpuModel, cpus: ($cpus|tonumber), hypervisor: $hypervisor, memoryGiB: ($memoryGiB|tonumber), kernel: $kernel, dock: $dock, qemu: $qemu, image: $image, kvm: $kvm}'
