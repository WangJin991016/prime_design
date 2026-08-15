#!/usr/bin/env bash
#SBATCH --job-name=prime_primer3_setup
#SBATCH --partition=dna
#SBATCH --cpus-per-task=16
#SBATCH --mem=64G
#SBATCH --time=02:00:00
#SBATCH --output=/home/u22111510029/workspace/Codex_workspace/prime_design/logs/prime_primer3_setup_%j.out
#SBATCH --error=/home/u22111510029/workspace/Codex_workspace/prime_design/logs/prime_primer3_setup_%j.err
set -euo pipefail
umask 002

readonly ROOT=/home/u22111510029/workspace/Codex_workspace/prime_design
readonly COMMIT=7f9f17d6012f404e83bbf0f931a4d06eb4af465b
readonly SOURCE_SHA=c981e42765ceb525f56607c6a7cf989ac5068483731c6e083b1e9fb22816463b
readonly ARCHIVE="$ROOT/downloads/primer3-$COMMIT.tar.gz"
readonly BUILD_ROOT="$ROOT/build/primer3-$COMMIT"
readonly SOURCE_DIR="$BUILD_ROOT/primer3-$COMMIT"
readonly INSTALL="$ROOT/tools/primer3-2.6.1"
readonly MANIFEST="$ROOT/primer3-provision-manifest.tsv"

mkdir -p "$ROOT/downloads" "$ROOT/build" "$ROOT/tools" "$ROOT/logs"
[[ -s "$ARCHIVE" ]] || { echo "Missing pre-uploaded source archive: $ARCHIVE" >&2; exit 2; }
[[ "$(sha256sum "$ARCHIVE" | awk '{print $1}')" == "$SOURCE_SHA" ]] || { echo 'Primer3 source SHA-256 mismatch' >&2; exit 3; }

config_tree_hash() {
  local target=$1
  (cd "$target" && find . -type f -print0 | sort -z | while IFS= read -r -d '' file; do
    printf '%s\t%s\n' "${file#./}" "$(sha256sum "$file" | awk '{print $1}')"
  done) | sha256sum | awk '{print $1}'
}

if [[ -x "$INSTALL/primer3_core" && -d "$INSTALL/primer3_config" && -s "$MANIFEST" ]]; then
  grep -q $'version\t2.6.1' "$MANIFEST" || { echo 'Existing Primer3 manifest drift' >&2; exit 4; }
  grep -q $'source_sha256\t'"$SOURCE_SHA" "$MANIFEST" || { echo 'Existing Primer3 source drift' >&2; exit 4; }
  "$INSTALL/primer3_core" --about | grep -q '2.6.1' || { echo 'Existing Primer3 version drift' >&2; exit 4; }
  echo "Verified existing Primer3 installation: $INSTALL"
  exit 0
fi
[[ ! -e "$INSTALL" && ! -e "$MANIFEST" ]] || { echo 'Refusing to overwrite incomplete/different Primer3 installation' >&2; exit 5; }
[[ ! -e "$BUILD_ROOT" ]] || { echo "Refusing to overwrite build directory: $BUILD_ROOT" >&2; exit 6; }

mkdir "$BUILD_ROOT"
tar -xzf "$ARCHIVE" -C "$BUILD_ROOT"
make -C "$SOURCE_DIR/src" -j "${SLURM_CPUS_PER_TASK:-16}"
make -C "$SOURCE_DIR/src" test

readonly STAGE="$INSTALL.stage-$SLURM_JOB_ID"
mkdir -p "$STAGE"
cp "$SOURCE_DIR/src/primer3_core" "$STAGE/primer3_core"
cp -a "$SOURCE_DIR/src/primer3_config" "$STAGE/primer3_config"
chmod 0755 "$STAGE/primer3_core"
"$STAGE/primer3_core" --about | grep -q '2.6.1'

readonly TOOL_SHA="$(sha256sum "$STAGE/primer3_core" | awk '{print $1}')"
readonly CONFIG_SHA="$(config_tree_hash "$STAGE/primer3_config")"
readonly MANIFEST_TMP="$MANIFEST.tmp-$SLURM_JOB_ID"
printf 'key\tvalue\n' > "$MANIFEST_TMP"
printf 'schema_version\t1\n' >> "$MANIFEST_TMP"
printf 'version\t2.6.1\n' >> "$MANIFEST_TMP"
printf 'source_commit\t%s\n' "$COMMIT" >> "$MANIFEST_TMP"
printf 'source_sha256\t%s\n' "$SOURCE_SHA" >> "$MANIFEST_TMP"
printf 'compiler\t%s\n' "$(command -v gcc)" >> "$MANIFEST_TMP"
printf 'compiler_version\t%s\n' "$(gcc --version | head -n 1)" >> "$MANIFEST_TMP"
printf 'glibc_version\t%s\n' "$(getconf GNU_LIBC_VERSION)" >> "$MANIFEST_TMP"
printf 'tool_path\t%s/primer3_core\n' "$INSTALL" >> "$MANIFEST_TMP"
printf 'tool_sha256\t%s\n' "$TOOL_SHA" >> "$MANIFEST_TMP"
printf 'config_path\t%s/primer3_config\n' "$INSTALL" >> "$MANIFEST_TMP"
printf 'config_tree_sha256\t%s\n' "$CONFIG_SHA" >> "$MANIFEST_TMP"
printf 'provisioned_at_utc\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$MANIFEST_TMP"

mv "$STAGE" "$INSTALL"
mv "$MANIFEST_TMP" "$MANIFEST"
printf 'Primer3 2.6.1 provisioned: %s\n' "$INSTALL"
