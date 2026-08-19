#!/usr/bin/env bash
#SBATCH --job-name=prime_ispcr
#SBATCH --partition=dna
#SBATCH --cpus-per-task=16
#SBATCH --mem=64G
#SBATCH --time=01:00:00
#SBATCH --output=/home/u22111510029/workspace/Codex_workspace/prime_design/logs/%x_%j.out
#SBATCH --error=/home/u22111510029/workspace/Codex_workspace/prime_design/logs/%x_%j.err

set -euo pipefail
umask 002

readonly ROOT="/home/u22111510029/workspace/Codex_workspace/prime_design"
readonly ISPCR="$ROOT/bin/isPcr-v385"
readonly BLAT="$ROOT/bin/blat-v385-bin"
readonly GENOME_DIR="$ROOT/genomes"

if [[ "${1:-}" == "--status" ]]; then
  job_id="${2:-}"
  run_id="${3:-}"
  [[ "$job_id" =~ ^[0-9]+$ ]] || { printf 'invalid status job id\n' >&2; exit 2; }
  [[ "$run_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { printf 'invalid status run id\n' >&2; exit 2; }
  state="$(squeue -h -j "$job_id" -o '%T' 2>/dev/null | head -n 1 || true)"
  if [[ -z "$state" ]]; then
    state="$(sacct -n -X -j "$job_id" -o State -P 2>/dev/null | awk -F '|' 'NF {print $1; exit}' || true)"
  fi
  printf 'slurmState\t%s\n' "${state:-UNKNOWN}"
  printf 'progressBegin\n'
  progress="$ROOT/runs/$run_id/progress.tsv"
  [[ -f "$progress" ]] && cat "$progress"
  printf 'progressEnd\n'
  exit 0
fi

: "${PRIME_RUN_ID:?PRIME_RUN_ID is required}"
: "${PRIME_ASSEMBLIES:?PRIME_ASSEMBLIES is required}"
: "${PRIME_MIN_SIZE:?PRIME_MIN_SIZE is required}"
: "${PRIME_MAX_SIZE:?PRIME_MAX_SIZE is required}"
: "${PRIME_MIN_PERFECT:?PRIME_MIN_PERFECT is required}"
: "${PRIME_MIN_GOOD:?PRIME_MIN_GOOD is required}"
: "${PRIME_PARALLELISM:?PRIME_PARALLELISM is required}"
: "${PRIME_FLIP_REVERSE:=0}"

[[ "$PRIME_RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { printf 'Unsafe PRIME_RUN_ID\n' >&2; exit 2; }
[[ "$PRIME_ASSEMBLIES" =~ ^(mm10|hg38|hs1)$ ]] || { printf 'Parallel runner requires exactly one assembly\n' >&2; exit 2; }
for numeric in "$PRIME_MIN_SIZE" "$PRIME_MAX_SIZE" "$PRIME_MIN_PERFECT" "$PRIME_MIN_GOOD" "$PRIME_PARALLELISM"; do
  [[ "$numeric" =~ ^[0-9]+$ ]] || { printf 'Invalid numeric parameter: %s\n' "$numeric" >&2; exit 2; }
done
(( PRIME_MIN_SIZE >= 0 && PRIME_MAX_SIZE >= PRIME_MIN_SIZE )) || { printf 'Invalid product size range\n' >&2; exit 2; }
(( PRIME_PARALLELISM >= 4 && PRIME_PARALLELISM <= 8 )) || { printf 'PRIME_PARALLELISM must be 4-8\n' >&2; exit 2; }
[[ "$PRIME_FLIP_REVERSE" == "0" || "$PRIME_FLIP_REVERSE" == "1" ]] || { printf 'Invalid PRIME_FLIP_REVERSE\n' >&2; exit 2; }

readonly ASSEMBLY="$PRIME_ASSEMBLIES"
readonly RUN_DIR="$ROOT/runs/$PRIME_RUN_ID"
readonly QUERY="$RUN_DIR/queries.tsv"
readonly COMPLETED="$RUN_DIR/completed.tsv"
readonly PROGRESS="$RUN_DIR/progress.tsv"
readonly SHARD_DIR="$RUN_DIR/shards"
readonly DATABASE="$GENOME_DIR/${ASSEMBLY}.2bit"
[[ -x "$ISPCR" && -x "$BLAT" && -s "$QUERY" && -f "$ROOT/provision-manifest.tsv" ]]
[[ ! -e "$COMPLETED" ]] || { printf 'Run already completed; refusing overwrite\n' >&2; exit 3; }

awk -F '\t' 'NF {
  if (NF != 3 || seen[$1]++ || length($1) > 128 || $1 !~ /^[A-Za-z0-9][A-Za-z0-9._-]*$/
      || $2 !~ /^[ACGTRYSWKMBDHVN]+$/ || $3 !~ /^[ACGTRYSWKMBDHVN]+$/) exit 2
}' "$QUERY" || { printf 'queries.tsv validation failed\n' >&2; exit 2; }
readonly CANDIDATE_TOTAL="$(awk 'NF {n++} END {print n+0}' "$QUERY")"
(( CANDIDATE_TOTAL > 0 )) || { printf 'queries.tsv is empty\n' >&2; exit 2; }
readonly ACTUAL_PARALLELISM="$(( CANDIDATE_TOTAL < PRIME_PARALLELISM ? CANDIDATE_TOTAL : PRIME_PARALLELISM ))"

phase="database_check"
candidate_completed=0
shard_completed=0
active_workers=0
blat_candidate_total=0
write_progress() {
  local tmp="$PROGRESS.tmp.$$"
  {
    printf 'key\tvalue\n'
    printf 'schemaVersion\t1\nrunId\t%s\nphase\t%s\nassembly\t%s\n' "$PRIME_RUN_ID" "$phase" "$ASSEMBLY"
    printf 'candidateTotal\t%s\ncandidateCompleted\t%s\n' "$CANDIDATE_TOTAL" "$candidate_completed"
    printf 'shardTotal\t%s\nshardCompleted\t%s\nactiveWorkers\t%s\n' "$ACTUAL_PARALLELISM" "$shard_completed" "$active_workers"
    printf 'configuredParallelism\t%s\nactualParallelism\t%s\n' "$PRIME_PARALLELISM" "$ACTUAL_PARALLELISM"
    printf 'blatCandidateTotal\t%s\nupdatedAtUtc\t%s\n' "$blat_candidate_total" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  } > "$tmp"
  mv "$tmp" "$PROGRESS"
}

declare -a shard_pids=()
terminate_shards() {
  local pid
  for pid in "${shard_pids[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${shard_pids[@]:-}"; do wait "$pid" 2>/dev/null || true; done
}
mark_failed() {
  local status=$?
  if (( status != 0 )); then
    terminate_shards
    phase="failed"
    active_workers=0
    write_progress || true
  fi
  exit "$status"
}
trap mark_failed EXIT

write_progress
readonly QUERY_SHA256="$(sha256sum "$QUERY" | awk '{print $1}')"
readonly TOOL_SHA256="$(sha256sum "$ISPCR" | awk '{print $1}')"
readonly BLAT_SHA256="$(sha256sum "$BLAT" | awk '{print $1}')"
readonly PROVISION_MANIFEST_SHA256="$(sha256sum "$ROOT/provision-manifest.tsv" | awk '{print $1}')"
readonly RUN_SCRIPT_SHA256="$(sha256sum "$0" | awk '{print $1}')"
readonly DATABASE_SHA256="$(sha256sum "$DATABASE" | awk '{print $1}')"
readonly EXPECTED_TOOL_SHA256="$(awk -F '\t' '$1 == "tool" && $2 == "isPcr" {print $6}' "$ROOT/provision-manifest.tsv")"
readonly EXPECTED_BLAT_SHA256="$(awk -F '\t' '$1 == "tool" && $2 == "blat" {print $6}' "$ROOT/provision-manifest.tsv")"
readonly EXPECTED_DATABASE_SHA256="$(awk -F '\t' -v assembly="$ASSEMBLY" '$1 == "genome" && $2 == assembly {print $6}' "$ROOT/provision-manifest.tsv")"
[[ "$TOOL_SHA256" == "$EXPECTED_TOOL_SHA256" && "$BLAT_SHA256" == "$EXPECTED_BLAT_SHA256" && "$DATABASE_SHA256" == "$EXPECTED_DATABASE_SHA256" ]]

readonly PRIMERS_FASTA="$RUN_DIR/primers.fasta"
[[ ! -e "$PRIMERS_FASTA" ]] || { printf 'Primer FASTA already exists; refusing overwrite\n' >&2; exit 3; }
awk -F '\t' 'NF == 3 {print ">" $1 "_forward"; print $2; print ">" $1 "_reverse"; print $3}' "$QUERY" > "$PRIMERS_FASTA.tmp"
mv "$PRIMERS_FASTA.tmp" "$PRIMERS_FASTA"
readonly PRIMERS_SHA256="$(sha256sum "$PRIMERS_FASTA" | awk '{print $1}')"

mkdir "$SHARD_DIR"
for (( shard=0; shard<ACTUAL_PARALLELISM; shard++ )); do
  awk -v shard="$shard" -v total="$ACTUAL_PARALLELISM" 'NF && ((NR-1)%total)==shard' "$QUERY" > "$SHARD_DIR/query-$shard.tsv"
done

phase="ispcr"
active_workers="$ACTUAL_PARALLELISM"
write_progress
for (( shard=0; shard<ACTUAL_PARALLELISM; shard++ )); do
  (
    shard_failure_marker="$SHARD_DIR/failed-$shard"
    mark_shard_failed() {
      local status=$?
      if (( status != 0 )); then
        printf 'isPcr shard exited %s\n' "$status" > "$shard_failure_marker.tmp"
        mv "$shard_failure_marker.tmp" "$shard_failure_marker"
      fi
      exit "$status"
    }
    trap mark_shard_failed EXIT
    query="$SHARD_DIR/query-$shard.tsv"
    partial="$SHARD_DIR/result-$shard.bed.tmp"
    output="$SHARD_DIR/result-$shard.bed"
    args=("$DATABASE" "$query" "$partial" "-minSize=$PRIME_MIN_SIZE" "-maxSize=$PRIME_MAX_SIZE" "-minPerfect=$PRIME_MIN_PERFECT" "-minGood=$PRIME_MIN_GOOD" "-out=bed")
    [[ "$PRIME_FLIP_REVERSE" == "1" ]] && args+=("-flipReverse")
    if "$ISPCR" "${args[@]}"; then
      (( $(stat -Lc '%s' "$partial") <= 268435456 )) || exit 4
      mv "$partial" "$output"
      printf '%s\n' "$(awk 'NF {n++} END {print n+0}' "$query")" > "$SHARD_DIR/done-$shard.tmp"
      mv "$SHARD_DIR/done-$shard.tmp" "$SHARD_DIR/done-$shard"
      trap - EXIT
    else
      exit 1
    fi
  ) &
  shard_pids+=("$!")
done

while (( shard_completed < ACTUAL_PARALLELISM )); do
  new_shards=0
  new_candidates=0
  for (( shard=0; shard<ACTUAL_PARALLELISM; shard++ )); do
    [[ ! -f "$SHARD_DIR/failed-$shard" ]] || { printf 'isPcr shard %s failed\n' "$shard" >&2; exit 5; }
    if [[ ! -f "$SHARD_DIR/done-$shard" ]] && ! kill -0 "${shard_pids[$shard]}" 2>/dev/null; then
      wait "${shard_pids[$shard]}" 2>/dev/null || true
      printf 'isPcr shard %s exited without a completion marker\n' "$shard" >&2
      exit 5
    fi
    if [[ -f "$SHARD_DIR/done-$shard" ]]; then
      new_shards=$((new_shards + 1))
      new_candidates=$((new_candidates + $(<"$SHARD_DIR/done-$shard")))
    fi
  done
  if (( new_shards != shard_completed )); then
    shard_completed="$new_shards"
    candidate_completed="$new_candidates"
    active_workers=$((ACTUAL_PARALLELISM - shard_completed))
    write_progress
  fi
  (( shard_completed == ACTUAL_PARALLELISM )) || sleep 2
done
for pid in "${shard_pids[@]}"; do wait "$pid"; done
shard_pids=()

readonly SHARD_MANIFEST="$RUN_DIR/shard-manifest.tsv"
printf 'shard\tquery_count\tquery_sha256\tresult_sha256\thit_count\n' > "$SHARD_MANIFEST.tmp"
for (( shard=0; shard<ACTUAL_PARALLELISM; shard++ )); do
  printf '%s\t%s\t%s\t%s\t%s\n' "$shard" \
    "$(awk 'NF {n++} END {print n+0}' "$SHARD_DIR/query-$shard.tsv")" \
    "$(sha256sum "$SHARD_DIR/query-$shard.tsv" | awk '{print $1}')" \
    "$(sha256sum "$SHARD_DIR/result-$shard.bed" | awk '{print $1}')" \
    "$(awk 'NF {n++} END {print n+0}' "$SHARD_DIR/result-$shard.bed")" >> "$SHARD_MANIFEST.tmp"
done
mv "$SHARD_MANIFEST.tmp" "$SHARD_MANIFEST"
readonly SHARD_MANIFEST_SHA256="$(sha256sum "$SHARD_MANIFEST" | awk '{print $1}')"

readonly OUTPUT="$RUN_DIR/${ASSEMBLY}.bed"
readonly OUTPUT_TMP="$OUTPUT.tmp"
cat "$SHARD_DIR"/result-*.bed > "$RUN_DIR/all-shards.bed.tmp"
awk -F '\t' 'NR==FNR {order[$1]=NR; next} {if (!($4 in order)) exit 7; print order[$4] "\t" FNR "\t" $0}' \
  "$QUERY" "$RUN_DIR/all-shards.bed.tmp" | LC_ALL=C sort -t $'\t' -k1,1n -k2,2n | cut -f3- > "$OUTPUT_TMP"
(( $(stat -Lc '%s' "$OUTPUT_TMP") <= 268435456 )) || { printf 'isPcr output exceeds 256 MiB\n' >&2; exit 4; }
mv "$OUTPUT_TMP" "$OUTPUT"

readonly BLAT_OUTPUT="$RUN_DIR/${ASSEMBLY}.psl"
readonly REVIEW_IDS="$RUN_DIR/${ASSEMBLY}.blat-review-ids.txt"
readonly REVIEW_FASTA="$RUN_DIR/${ASSEMBLY}.blat-review.fasta"
awk -F '\t' 'NR==FNR {all[$1]=1; next} {total[$4]++; if ($1 ~ /^chr([1-9]|1[0-9]|2[0-2]|X|Y|M|MT)$/) primary[$4]++} END {for(id in all) if(total[id]!=1 || primary[id]!=1) print id}' \
  "$QUERY" "$OUTPUT" | LC_ALL=C sort > "$REVIEW_IDS"
awk -F '\t' 'NR==FNR {review[$1]=1; next} ($1 in review) {print ">" $1 "_forward"; print $2; print ">" $1 "_reverse"; print $3}' \
  "$REVIEW_IDS" "$QUERY" > "$REVIEW_FASTA"
blat_candidate_total="$(awk 'NF {n++} END {print n+0}' "$REVIEW_IDS")"
phase="blat"
active_workers=0
write_progress
if (( blat_candidate_total > 0 )); then
  "$BLAT" -tileSize=9 -stepSize=4 -repMatch=16384 -minScore=15 -minIdentity=0 -noHead "$DATABASE" "$REVIEW_FASTA" "$BLAT_OUTPUT.tmp"
  blat_status="reviewed_suspicious_only"
else
  : > "$BLAT_OUTPUT.tmp"
  blat_status="skipped_all_unique_primary"
fi
(( $(stat -Lc '%s' "$BLAT_OUTPUT.tmp") <= 268435456 )) || { printf 'BLAT output exceeds 256 MiB\n' >&2; exit 4; }
mv "$BLAT_OUTPUT.tmp" "$BLAT_OUTPUT"

phase="packaging"
write_progress
readonly RESULT_MANIFEST="$RUN_DIR/results-manifest.tsv"
printf 'assembly\tdatabase\tdatabase_sha256\tispcr_result\tispcr_sha256\tispcr_hit_count\tblat_result\tblat_sha256\tblat_alignment_count\tblat_status\tblat_review_candidate_count\n' > "$RESULT_MANIFEST.tmp"
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$ASSEMBLY" "$DATABASE" "$DATABASE_SHA256" "$OUTPUT" \
  "$(sha256sum "$OUTPUT" | awk '{print $1}')" "$(awk 'NF {n++} END {print n+0}' "$OUTPUT")" "$BLAT_OUTPUT" \
  "$(sha256sum "$BLAT_OUTPUT" | awk '{print $1}')" "$(awk 'NF {n++} END {print n+0}' "$BLAT_OUTPUT")" "$blat_status" "$blat_candidate_total" >> "$RESULT_MANIFEST.tmp"
mv "$RESULT_MANIFEST.tmp" "$RESULT_MANIFEST"

printf 'key\tvalue\n' > "$COMPLETED.tmp"
for row in \
  "schemaVersion\t2" "runId\t$PRIME_RUN_ID" "assemblies\t$PRIME_ASSEMBLIES" \
  "completedAtUtc\t$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "querySha256\t$QUERY_SHA256" \
  "toolSha256\t$TOOL_SHA256" "blatSha256\t$BLAT_SHA256" "provisionManifestSha256\t$PROVISION_MANIFEST_SHA256" \
  "runScriptSha256\t$RUN_SCRIPT_SHA256" "primersSha256\t$PRIMERS_SHA256" "minSize\t$PRIME_MIN_SIZE" \
  "maxSize\t$PRIME_MAX_SIZE" "minPerfect\t$PRIME_MIN_PERFECT" "minGood\t$PRIME_MIN_GOOD" \
  "flipReverse\t$PRIME_FLIP_REVERSE" "candidateCount\t$CANDIDATE_TOTAL" "configuredParallelism\t$PRIME_PARALLELISM" \
  "actualParallelism\t$ACTUAL_PARALLELISM" "shardStrategy\tround_robin_v1" "shardManifestSha256\t$SHARD_MANIFEST_SHA256" \
  "blatTileSize\t9" "blatStepSize\t4" "blatRepMatch\t16384" "blatMinScore\t15" "blatMinIdentity\t0" \
  "blatReviewMode\tsuspicious_only_v1"; do printf '%b\n' "$row" >> "$COMPLETED.tmp"; done
mv "$COMPLETED.tmp" "$COMPLETED"
phase="complete"
write_progress
trap - EXIT
printf 'Parallel isPcr validation complete: %s\n' "$RUN_DIR"
