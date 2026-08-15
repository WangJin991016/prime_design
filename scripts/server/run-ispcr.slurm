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

: "${PRIME_RUN_ID:?PRIME_RUN_ID is required}"
: "${PRIME_ASSEMBLIES:?PRIME_ASSEMBLIES is required}"
: "${PRIME_MIN_SIZE:?PRIME_MIN_SIZE is required}"
: "${PRIME_MAX_SIZE:?PRIME_MAX_SIZE is required}"
: "${PRIME_MIN_PERFECT:?PRIME_MIN_PERFECT is required}"
: "${PRIME_MIN_GOOD:?PRIME_MIN_GOOD is required}"
: "${PRIME_FLIP_REVERSE:=0}"

if [[ ! "$PRIME_RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  printf 'Unsafe PRIME_RUN_ID: %s\n' "$PRIME_RUN_ID" >&2
  exit 2
fi
if [[ ! "$PRIME_ASSEMBLIES" =~ ^(mm10|hg38|hs1)(,(mm10|hg38|hs1))*$ ]]; then
  printf 'Invalid PRIME_ASSEMBLIES: %s\n' "$PRIME_ASSEMBLIES" >&2
  exit 2
fi
IFS=',' read -r -a ASSEMBLIES <<< "$PRIME_ASSEMBLIES"
for (( left = 0; left < ${#ASSEMBLIES[@]}; left++ )); do
  for (( right = left + 1; right < ${#ASSEMBLIES[@]}; right++ )); do
    if [[ "${ASSEMBLIES[$left]}" == "${ASSEMBLIES[$right]}" ]]; then
      printf 'Duplicate assembly: %s\n' "${ASSEMBLIES[$left]}" >&2
      exit 2
    fi
  done
done
readonly -a ASSEMBLIES
for numeric in "$PRIME_MIN_SIZE" "$PRIME_MAX_SIZE" "$PRIME_MIN_PERFECT" "$PRIME_MIN_GOOD"; do
  if [[ ! "$numeric" =~ ^[0-9]+$ ]]; then
    printf 'Invalid numeric parameter: %s\n' "$numeric" >&2
    exit 2
  fi
done
if (( PRIME_MIN_SIZE < 0 || PRIME_MAX_SIZE < PRIME_MIN_SIZE )); then
  printf 'Invalid product size range: %s-%s\n' "$PRIME_MIN_SIZE" "$PRIME_MAX_SIZE" >&2
  exit 2
fi
if [[ "$PRIME_FLIP_REVERSE" != "0" && "$PRIME_FLIP_REVERSE" != "1" ]]; then
  printf 'PRIME_FLIP_REVERSE must be 0 or 1\n' >&2
  exit 2
fi

readonly RUN_DIR="$ROOT/runs/$PRIME_RUN_ID"
readonly QUERY="$RUN_DIR/queries.tsv"
readonly COMPLETED="$RUN_DIR/completed.tsv"
[[ -x "$ISPCR" ]]
[[ -x "$BLAT" ]]
[[ -s "$QUERY" ]]
[[ -f "$ROOT/provision-manifest.tsv" ]]
if [[ -e "$COMPLETED" ]]; then
  printf 'Run already completed; refusing overwrite: %s\n' "$RUN_DIR" >&2
  exit 3
fi

readonly QUERY_SHA256="$(sha256sum "$QUERY" | awk '{print $1}')"
readonly TOOL_SHA256="$(sha256sum "$ISPCR" | awk '{print $1}')"
readonly BLAT_SHA256="$(sha256sum "$BLAT" | awk '{print $1}')"
readonly PROVISION_MANIFEST_SHA256="$(sha256sum "$ROOT/provision-manifest.tsv" | awk '{print $1}')"
readonly RUN_SCRIPT_SHA256="$(sha256sum "$0" | awk '{print $1}')"
readonly EXPECTED_TOOL_SHA256="$(awk -F '\t' '$1 == "tool" && $2 == "isPcr" {print $6}' "$ROOT/provision-manifest.tsv")"
readonly EXPECTED_BLAT_SHA256="$(awk -F '\t' '$1 == "tool" && $2 == "blat" {print $6}' "$ROOT/provision-manifest.tsv")"
[[ "$EXPECTED_TOOL_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$EXPECTED_BLAT_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$TOOL_SHA256" == "$EXPECTED_TOOL_SHA256" ]]
[[ "$BLAT_SHA256" == "$EXPECTED_BLAT_SHA256" ]]
readonly PRIMERS_FASTA="$RUN_DIR/primers.fasta"
readonly PRIMERS_FASTA_TMP="$PRIMERS_FASTA.tmp"
if [[ -e "$PRIMERS_FASTA" ]]; then
  printf 'Primer FASTA already exists; refusing overwrite: %s\n' "$PRIMERS_FASTA" >&2
  exit 3
fi
awk -F '\t' 'NF == 3 {print ">" $1 "_forward"; print $2; print ">" $1 "_reverse"; print $3}' \
  "$QUERY" > "$PRIMERS_FASTA_TMP"
mv "$PRIMERS_FASTA_TMP" "$PRIMERS_FASTA"
readonly PRIMERS_SHA256="$(sha256sum "$PRIMERS_FASTA" | awk '{print $1}')"
readonly RESULT_MANIFEST_TMP="$RUN_DIR/results-manifest.tsv.tmp"
readonly RESULT_MANIFEST="$RUN_DIR/results-manifest.tsv"
printf 'assembly\tdatabase\tdatabase_sha256\tispcr_result\tispcr_sha256\tispcr_hit_count\tblat_result\tblat_sha256\tblat_alignment_count\tblat_status\tblat_review_candidate_count\n' > "$RESULT_MANIFEST_TMP"

for assembly in "${ASSEMBLIES[@]}"; do
  database="$GENOME_DIR/${assembly}.2bit"
  output="$RUN_DIR/${assembly}.bed"
  partial="$output.tmp"
  blat_output="$RUN_DIR/${assembly}.psl"
  blat_partial="$blat_output.tmp"
  review_ids="$RUN_DIR/${assembly}.blat-review-ids.txt"
  review_fasta="$RUN_DIR/${assembly}.blat-review.fasta"
  [[ -f "$database" ]]
  database_sha256="$(sha256sum "$database" | awk '{print $1}')"
  expected_database_sha256="$(awk -F '\t' -v assembly="$assembly" '$1 == "genome" && $2 == assembly {print $6}' "$ROOT/provision-manifest.tsv")"
  [[ "$expected_database_sha256" =~ ^[0-9a-f]{64}$ ]]
  [[ "$database_sha256" == "$expected_database_sha256" ]]
  if [[ -e "$output" || -e "$blat_output" ]]; then
    printf 'Result already exists; refusing overwrite in: %s\n' "$RUN_DIR" >&2
    exit 3
  fi

  args=(
    "$database" "$QUERY" "$partial"
    "-minSize=$PRIME_MIN_SIZE"
    "-maxSize=$PRIME_MAX_SIZE"
    "-minPerfect=$PRIME_MIN_PERFECT"
    "-minGood=$PRIME_MIN_GOOD"
    "-out=bed"
  )
  if [[ "$PRIME_FLIP_REVERSE" == "1" ]]; then
    args+=("-flipReverse")
  fi
  "$ISPCR" "${args[@]}"
  if (( $(stat -Lc '%s' "$partial") > 268435456 )); then
    printf 'isPcr output exceeds 256 MiB safety limit: %s\n' "$partial" >&2
    exit 4
  fi
  mv "$partial" "$output"

  awk -F '\t' '
    NR == FNR { all[$1] = 1; next }
    { total[$4]++; if ($1 ~ /^chr([1-9]|1[0-9]|2[0-2]|X|Y|M|MT)$/) primary[$4]++ }
    END { for (id in all) if (total[id] != 1 || primary[id] != 1) print id }
  ' "$QUERY" "$output" | LC_ALL=C sort > "$review_ids"
  awk -F '\t' '
    NR == FNR { review[$1] = 1; next }
    ($1 in review) { print ">" $1 "_forward"; print $2; print ">" $1 "_reverse"; print $3 }
  ' "$review_ids" "$QUERY" > "$review_fasta"
  review_count="$(awk 'NF {n++} END {print n+0}' "$review_ids")"
  if (( review_count > 0 )); then
    "$BLAT" \
      -tileSize=9 -stepSize=4 -repMatch=16384 -minScore=15 -minIdentity=0 -noHead \
      "$database" "$review_fasta" "$blat_partial"
    blat_status="reviewed_suspicious_only"
  else
    : > "$blat_partial"
    blat_status="skipped_all_unique_primary"
  fi
  if (( $(stat -Lc '%s' "$blat_partial") > 268435456 )); then
    printf 'BLAT output exceeds 256 MiB safety limit: %s\n' "$blat_partial" >&2
    exit 4
  fi
  mv "$blat_partial" "$blat_output"

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$assembly" "$database" "$database_sha256" \
    "$output" "$(sha256sum "$output" | awk '{print $1}')" \
    "$(awk 'NF {n++} END {print n+0}' "$output")" \
    "$blat_output" "$(sha256sum "$blat_output" | awk '{print $1}')" \
    "$(awk 'NF {n++} END {print n+0}' "$blat_output")" \
    "$blat_status" "$review_count" >> "$RESULT_MANIFEST_TMP"
done

mv "$RESULT_MANIFEST_TMP" "$RESULT_MANIFEST"
readonly COMPLETED_TMP="$COMPLETED.tmp"
printf 'key\tvalue\n' > "$COMPLETED_TMP"
printf 'schemaVersion\t1\n' >> "$COMPLETED_TMP"
printf 'runId\t%s\n' "$PRIME_RUN_ID" >> "$COMPLETED_TMP"
printf 'assemblies\t%s\n' "$PRIME_ASSEMBLIES" >> "$COMPLETED_TMP"
printf 'completedAtUtc\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$COMPLETED_TMP"
printf 'querySha256\t%s\n' "$QUERY_SHA256" >> "$COMPLETED_TMP"
printf 'toolSha256\t%s\n' "$TOOL_SHA256" >> "$COMPLETED_TMP"
printf 'blatSha256\t%s\n' "$BLAT_SHA256" >> "$COMPLETED_TMP"
printf 'provisionManifestSha256\t%s\n' "$PROVISION_MANIFEST_SHA256" >> "$COMPLETED_TMP"
printf 'runScriptSha256\t%s\n' "$RUN_SCRIPT_SHA256" >> "$COMPLETED_TMP"
printf 'primersSha256\t%s\n' "$PRIMERS_SHA256" >> "$COMPLETED_TMP"
printf 'minSize\t%s\n' "$PRIME_MIN_SIZE" >> "$COMPLETED_TMP"
printf 'maxSize\t%s\n' "$PRIME_MAX_SIZE" >> "$COMPLETED_TMP"
printf 'minPerfect\t%s\n' "$PRIME_MIN_PERFECT" >> "$COMPLETED_TMP"
printf 'minGood\t%s\n' "$PRIME_MIN_GOOD" >> "$COMPLETED_TMP"
printf 'flipReverse\t%s\n' "$PRIME_FLIP_REVERSE" >> "$COMPLETED_TMP"
printf 'candidateCount\t%s\n' "$(awk 'NF {n++} END {print n+0}' "$QUERY")" >> "$COMPLETED_TMP"
printf 'blatTileSize\t9\n' >> "$COMPLETED_TMP"
printf 'blatStepSize\t4\n' >> "$COMPLETED_TMP"
printf 'blatRepMatch\t16384\n' >> "$COMPLETED_TMP"
printf 'blatMinScore\t15\n' >> "$COMPLETED_TMP"
printf 'blatMinIdentity\t0\n' >> "$COMPLETED_TMP"
printf 'blatReviewMode\tsuspicious_only_v1\n' >> "$COMPLETED_TMP"
mv "$COMPLETED_TMP" "$COMPLETED"
printf 'isPcr validation complete: %s\n' "$RUN_DIR"
