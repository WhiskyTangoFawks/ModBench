export const PRE_PUSH_HOOK_NAME = 'pre-push';

export const PRE_PUSH_HOOK = String.raw`#!/bin/sh
tab=$(printf '\t')
unpinned=0
while read -r local_ref local_sha remote_ref remote_sha; do
  case "$local_sha" in *[!0]*) ;; *) continue ;; esac
  known=
  case "$remote_sha" in *[!0]*) git cat-file -e "$remote_sha" 2>/dev/null && known=$remote_sha ;; esac
  pins=$(git -c core.quotePath=false log --format= --raw -m -r --no-renames "$local_sha" --not $known --remotes="$1" | while IFS="$tab" read -r meta path; do
    case "$meta" in :*" 160000 "*) set -- $meta; printf '%s\t%s\n' "$4" "$path" ;; esac
  done)
  [ -z "$pins" ] && continue
  while IFS="$tab" read -r sha path; do
    prefix=$(git -C "$path" rev-parse --show-prefix 2>/dev/null) || prefix=missing
    if [ -n "$prefix" ]; then
      echo "Push refused: $path pins $sha, and has no checkout to verify it against." >&2
      unpinned=1
    elif [ -z "$(git -C "$path" branch -r --contains "$sha" 2>/dev/null)" ]; then
      echo "Push refused: $path pins $sha, which is on no remote of that source mod." >&2
      unpinned=1
    fi
  done <<PINS
$pins
PINS
done
exit $unpinned
`;
