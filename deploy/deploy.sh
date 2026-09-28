#!/usr/bin/env bash
# Trusted copy installed on the VM. GitHub Actions passes only the commit SHA.
set -Eeuo pipefail

sha="${1:-}"
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Invalid commit SHA' >&2
  exit 2
fi

root=/opt/sjma-reserves
envfile="$root/deploy.env"
releases="$root/releases"
release="$releases/$sha"
log="$root/deploy-last.log"
repository=https://github.com/sjmalbal/sjma-reserves.git

test -f "$envfile" || { echo 'Deployment configuration is missing' >&2; exit 2; }
test -d "$root/.private" || { echo 'Private credentials are missing' >&2; exit 2; }
mkdir -p "$releases"
exec 9>"$root/deploy.lock"
flock -n 9 || { echo 'Another deployment is in progress' >&2; exit 2; }

if [[ -L "$root/current" ]]; then
  old_release="$(readlink -f "$root/current")"
else
  old_release="$root/reservas-ts"
fi
old_tag="$(cat "$root/deployed.sha" 2>/dev/null || echo local)"
test -f "$old_release/deploy/compose.yaml" || { echo 'Previous release is missing' >&2; exit 2; }
new_started=0
temporary=
: > "$log"

rollback() {
  local status=$?
  if [[ -n "$temporary" && -d "$temporary" ]]; then rm -rf "$temporary"; fi
  if (( status != 0 )); then
    echo 'Deployment failed; keeping the previous release' >&2
    if (( new_started )); then
      if SJMA_IMAGE_TAG="$old_tag" docker compose -p deploy --env-file "$envfile" \
        -f "$old_release/deploy/compose.yaml" up -d --no-build --force-recreate reservas >>"$log" 2>&1; then
        echo 'Previous container restored' >&2
      else
        echo 'Automatic rollback failed; inspect the container and deployment log' >&2
        tail -n 30 "$log" >&2 || true
      fi
    else
      tail -n 30 "$log" >&2 || true
    fi
  fi
}
trap rollback EXIT

if [[ ! -d "$release/.git" ]]; then
  temporary="$(mktemp -d "$releases/.incoming.XXXXXX")"
  git clone --quiet --depth 1 --branch main "$repository" "$temporary"
  actual="$(git -C "$temporary" rev-parse HEAD)"
  [[ "$actual" == "$sha" ]] || { echo 'Commit is no longer the head of main' >&2; exit 3; }
  mv "$temporary" "$release"
  temporary=
else
  actual="$(git -C "$release" rev-parse HEAD)"
  [[ "$actual" == "$sha" ]] || { echo 'Release directory has another commit' >&2; exit 3; }
fi

SJMA_IMAGE_TAG="$sha" docker compose -p deploy --env-file "$envfile" \
  -f "$release/deploy/compose.yaml" build reservas >"$log" 2>&1 || {
    tail -n 30 "$log" >&2
    exit 1
  }

new_started=1
SJMA_IMAGE_TAG="$sha" docker compose -p deploy --env-file "$envfile" \
  -f "$release/deploy/compose.yaml" up -d --no-build --force-recreate reservas >>"$log" 2>&1 || {
    tail -n 30 "$log" >&2
    exit 1
  }

health=starting
for _ in $(seq 1 45); do
  health="$(docker inspect sjma-reserves --format '{{.State.Health.Status}}' 2>/dev/null || echo missing)"
  [[ "$health" == healthy ]] && break
  [[ "$health" == unhealthy ]] && break
  sleep 2
done
[[ "$health" == healthy ]] || { echo "New container health: $health" >&2; exit 1; }
curl --fail --silent --show-error --max-time 10 \
  --resolve espais.sjmalbal.com:443:127.0.0.1 \
  https://espais.sjmalbal.com/ -o /dev/null

ln -sfn "$release" "$root/current.next"
mv -Tf "$root/current.next" "$root/current"
printf '%s\n' "$sha" > "$root/deployed.sha.tmp"
mv -f "$root/deployed.sha.tmp" "$root/deployed.sha"
new_started=0
echo "SJMA_DEPLOY_OK $sha"
