#!/usr/bin/env bash
#SBATCH --job-name=prime_primer3
#SBATCH --partition=dna
#SBATCH --cpus-per-task=16
#SBATCH --mem=64G
#SBATCH --time=00:30:00
#SBATCH --output=/home/u22111510029/workspace/Codex_workspace/prime_design/logs/prime_primer3_%j.out
#SBATCH --error=/home/u22111510029/workspace/Codex_workspace/prime_design/logs/prime_primer3_%j.err
set -euo pipefail
umask 002

readonly ROOT=/home/u22111510029/workspace/Codex_workspace/prime_design
readonly SOURCE_SHA=c981e42765ceb525f56607c6a7cf989ac5068483731c6e083b1e9fb22816463b
readonly RUN_ID="${PRIMER3_RUN_ID:-}"
[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { echo 'Invalid PRIMER3_RUN_ID' >&2; exit 2; }
readonly RUN_DIR="$ROOT/runs/$RUN_ID"
readonly INPUT="$RUN_DIR/request.boulder"
readonly OUTPUT="$RUN_DIR/result.boulder"
readonly STDERR_FILE="$RUN_DIR/primer3.stderr"
readonly RESULT_MANIFEST="$RUN_DIR/results-manifest.tsv"
readonly COMPLETED="$RUN_DIR/completed.tsv"
readonly PROVISION="$ROOT/primer3-provision-manifest.tsv"
readonly TOOL="$ROOT/tools/primer3-2.6.1/primer3_core"
readonly CONFIG="$ROOT/tools/primer3-2.6.1/primer3_config"
readonly INSTALL="$ROOT/tools/primer3-2.6.1"

[[ -s "$INPUT" && -x "$TOOL" && -d "$CONFIG" && -s "$PROVISION" ]] || { echo 'Primer3 input or installation is missing' >&2; exit 3; }
[[ ! -e "$OUTPUT" && ! -e "$COMPLETED" && ! -e "$RESULT_MANIFEST" ]] || { echo 'Refusing to overwrite Primer3 result' >&2; exit 4; }
grep -q $'version\t2.6.1' "$PROVISION" || { echo 'Primer3 version manifest drift' >&2; exit 5; }
grep -q $'source_sha256\t'"$SOURCE_SHA" "$PROVISION" || { echo 'Primer3 source manifest drift' >&2; exit 5; }
readonly EXPECTED_TOOL_SHA="$(awk -F '\t' '$1=="tool_sha256" {print $2}' "$PROVISION")"
readonly CONFIG_TREE_SHA="$(awk -F '\t' '$1=="config_tree_sha256" {print $2}' "$PROVISION")"
readonly TOOL_SHA="$(sha256sum "$TOOL" | awk '{print $1}')"
[[ "$TOOL_SHA" == "$EXPECTED_TOOL_SHA" ]] || { echo 'Primer3 executable drift' >&2; exit 6; }
[[ "$CONFIG_TREE_SHA" =~ ^[a-f0-9]{64}$ ]] || { echo 'Primer3 config-tree manifest drift' >&2; exit 6; }

readonly OUTPUT_TMP="$OUTPUT.tmp-$SLURM_JOB_ID"
readonly STDERR_TMP="$STDERR_FILE.tmp-$SLURM_JOB_ID"
(cd "$INSTALL" && ./primer3_core < "$INPUT" > "$OUTPUT_TMP" 2> "$STDERR_TMP")
[[ $(stat -c '%s' "$OUTPUT_TMP") -le 16777216 && $(stat -c '%s' "$STDERR_TMP") -le 4194304 ]] || { echo 'Primer3 output exceeded size limit' >&2; exit 7; }
mv "$OUTPUT_TMP" "$OUTPUT"
mv "$STDERR_TMP" "$STDERR_FILE"

readonly INPUT_SHA="$(sha256sum "$INPUT" | awk '{print $1}')"
readonly OUTPUT_SHA="$(sha256sum "$OUTPUT" | awk '{print $1}')"
readonly STDERR_SHA="$(sha256sum "$STDERR_FILE" | awk '{print $1}')"
readonly PROVISION_SHA="$(sha256sum "$PROVISION" | awk '{print $1}')"
readonly SCRIPT_SHA="$(sha256sum "$0" | awk '{print $1}')"
readonly RECORD_COUNT="$(grep -c '^=$' "$INPUT")"

readonly MANIFEST_TMP="$RESULT_MANIFEST.tmp-$SLURM_JOB_ID"
printf 'artifact\tpath\tbytes\tsha256\n' > "$MANIFEST_TMP"
for artifact in request result stderr; do
  case "$artifact" in
    request) file="$INPUT";; result) file="$OUTPUT";; stderr) file="$STDERR_FILE";;
  esac
  printf '%s\t%s\t%s\t%s\n' "$artifact" "$file" "$(stat -c '%s' "$file")" "$(sha256sum "$file" | awk '{print $1}')" >> "$MANIFEST_TMP"
done
mv "$MANIFEST_TMP" "$RESULT_MANIFEST"

readonly COMPLETED_TMP="$COMPLETED.tmp-$SLURM_JOB_ID"
printf 'key\tvalue\n' > "$COMPLETED_TMP"
printf 'schemaVersion\t1\n' >> "$COMPLETED_TMP"
printf 'protocolVersion\tprimer3-ssh-slurm-v1\n' >> "$COMPLETED_TMP"
printf 'runId\t%s\n' "$RUN_ID" >> "$COMPLETED_TMP"
printf 'completedAtUtc\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$COMPLETED_TMP"
printf 'primer3Version\t2.6.1\n' >> "$COMPLETED_TMP"
printf 'inputSha256\t%s\n' "$INPUT_SHA" >> "$COMPLETED_TMP"
printf 'outputSha256\t%s\n' "$OUTPUT_SHA" >> "$COMPLETED_TMP"
printf 'stderrSha256\t%s\n' "$STDERR_SHA" >> "$COMPLETED_TMP"
printf 'toolSha256\t%s\n' "$TOOL_SHA" >> "$COMPLETED_TMP"
printf 'sourceSha256\t%s\n' "$SOURCE_SHA" >> "$COMPLETED_TMP"
printf 'configTreeSha256\t%s\n' "$CONFIG_TREE_SHA" >> "$COMPLETED_TMP"
printf 'provisionManifestSha256\t%s\n' "$PROVISION_SHA" >> "$COMPLETED_TMP"
printf 'runScriptSha256\t%s\n' "$SCRIPT_SHA" >> "$COMPLETED_TMP"
printf 'recordCount\t%s\n' "$RECORD_COUNT" >> "$COMPLETED_TMP"
mv "$COMPLETED_TMP" "$COMPLETED"
printf 'Primer3 design complete: %s\n' "$RUN_DIR"
