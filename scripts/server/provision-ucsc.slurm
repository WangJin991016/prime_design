#!/usr/bin/env bash
#SBATCH --job-name=prime_ucsc_setup
#SBATCH --partition=dna
#SBATCH --cpus-per-task=16
#SBATCH --mem=64G
#SBATCH --time=02:00:00
#SBATCH --output=/home/u22111510029/workspace/Codex_workspace/prime_design/logs/%x_%j.out
#SBATCH --error=/home/u22111510029/workspace/Codex_workspace/prime_design/logs/%x_%j.err

set -euo pipefail
umask 002

readonly ROOT="/home/u22111510029/workspace/Codex_workspace/prime_design"
readonly BIN_DIR="$ROOT/bin"
readonly GENOME_DIR="$ROOT/genomes"
readonly LOG_DIR="$ROOT/logs"
readonly MM10_SOURCE="/home/u22111510029/references/Mus_musculus/UCSC/mm10/mm10.2bit"

readonly MM10_MD5="fcfcc276799031793a513e2e9c07adad"
readonly HG38_MD5="dcc3ea27079aa6dc3f9deccd7275e0f8"
readonly HS1_MD5="68202ff4ae8882deebe93da3f8a33a12"

mkdir -p "$BIN_DIR" "$GENOME_DIR" "$LOG_DIR"

verify_md5() {
  local file_path="$1"
  local expected="$2"
  local actual
  actual="$(md5sum "$file_path" | awk '{print $1}')"
  if [[ "$actual" != "$expected" ]]; then
    printf 'MD5 mismatch for %s: expected %s, got %s\n' "$file_path" "$expected" "$actual" >&2
    return 1
  fi
}

download_genome() {
  local assembly="$1"
  local expected_md5="$2"
  local destination="$GENOME_DIR/${assembly}.2bit"
  local partial="$destination.download"
  local url="https://hgdownload.soe.ucsc.edu/goldenPath/${assembly}/bigZips/${assembly}.2bit"

  if [[ -e "$destination" ]]; then
    verify_md5 "$destination" "$expected_md5"
    return
  fi

  curl --fail --silent --show-error --location \
    --retry 5 --retry-delay 5 --connect-timeout 30 --max-time 7200 \
    --continue-at - --output "$partial" "$url"
  verify_md5 "$partial" "$expected_md5"
  mv "$partial" "$destination"
}

readonly UCSC_TOOL_BUILD="linux.x86_64.v385"
readonly ISPCR="$BIN_DIR/isPcr-v385"
if [[ ! -e "$ISPCR" ]]; then
  readonly ISPCR_PARTIAL="$ISPCR.download"
  curl --fail --silent --show-error --location \
    --retry 5 --retry-delay 5 --connect-timeout 30 --max-time 1800 \
    --output "$ISPCR_PARTIAL" \
    "https://hgdownload.soe.ucsc.edu/admin/exe/${UCSC_TOOL_BUILD}/isPcr"
  chmod 0755 "$ISPCR_PARTIAL"
  mv "$ISPCR_PARTIAL" "$ISPCR"
fi
[[ -x "$ISPCR" ]]

readonly BLAT="$BIN_DIR/blat-v385-bin"
if [[ ! -e "$BLAT" ]]; then
  readonly BLAT_PARTIAL="$BLAT.download"
  curl --fail --silent --show-error --location \
    --retry 5 --retry-delay 5 --connect-timeout 30 --max-time 1800 \
    --output "$BLAT_PARTIAL" \
    "https://hgdownload.soe.ucsc.edu/admin/exe/${UCSC_TOOL_BUILD}/blat/blat"
  chmod 0755 "$BLAT_PARTIAL"
  mv "$BLAT_PARTIAL" "$BLAT"
fi
[[ -x "$BLAT" ]]

verify_md5 "$MM10_SOURCE" "$MM10_MD5"
if [[ ! -e "$GENOME_DIR/mm10.2bit" ]]; then
  ln -s "$MM10_SOURCE" "$GENOME_DIR/mm10.2bit"
fi
verify_md5 "$GENOME_DIR/mm10.2bit" "$MM10_MD5"

download_genome "hg38" "$HG38_MD5"
download_genome "hs1" "$HS1_MD5"

readonly MANIFEST_TMP="$ROOT/provision-manifest.tsv.tmp"
readonly MANIFEST="$ROOT/provision-manifest.tsv"
printf 'kind\tid\tpath\tbytes\tmd5\tsha256\tsource\n' > "$MANIFEST_TMP"
printf 'tool\tisPcr\t%s\t%s\t-\t%s\t%s\n' \
  "$ISPCR" "$(stat -Lc '%s' "$ISPCR")" \
  "$(sha256sum "$ISPCR" | awk '{print $1}')" \
  "https://hgdownload.soe.ucsc.edu/admin/exe/${UCSC_TOOL_BUILD}/isPcr" >> "$MANIFEST_TMP"
printf 'tool\tblat\t%s\t%s\t-\t%s\t%s\n' \
  "$BLAT" "$(stat -Lc '%s' "$BLAT")" \
  "$(sha256sum "$BLAT" | awk '{print $1}')" \
  "https://hgdownload.soe.ucsc.edu/admin/exe/${UCSC_TOOL_BUILD}/blat/blat" >> "$MANIFEST_TMP"

for assembly in mm10 hg38 hs1; do
  genome="$GENOME_DIR/${assembly}.2bit"
  case "$assembly" in
    mm10) expected_md5="$MM10_MD5" ;;
    hg38) expected_md5="$HG38_MD5" ;;
    hs1) expected_md5="$HS1_MD5" ;;
  esac
  printf 'genome\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$assembly" "$genome" "$(stat -Lc '%s' "$genome")" "$expected_md5" \
    "$(sha256sum "$genome" | awk '{print $1}')" \
    "https://hgdownload.soe.ucsc.edu/goldenPath/${assembly}/bigZips/${assembly}.2bit" \
    >> "$MANIFEST_TMP"
done

readonly ISPCR_USAGE="$LOG_DIR/isPcr-usage.txt"
"$ISPCR" > "$ISPCR_USAGE" 2>&1 || true
grep -Eq '^isPcr([[:space:]]|-)' "$ISPCR_USAGE"
sed -n '1p' "$ISPCR_USAGE" > "$LOG_DIR/isPcr-version.txt"
readonly BLAT_USAGE="$LOG_DIR/blat-usage.txt"
"$BLAT" > "$BLAT_USAGE" 2>&1 || true
grep -q '^blat - Standalone BLAT v' "$BLAT_USAGE"
sed -n '1p' "$BLAT_USAGE" > "$LOG_DIR/blat-version.txt"
mv "$MANIFEST_TMP" "$MANIFEST"
printf 'Provisioning complete: %s\n' "$MANIFEST"
