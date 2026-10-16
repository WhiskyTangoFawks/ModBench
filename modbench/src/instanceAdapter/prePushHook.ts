export const PRE_PUSH_HOOK_NAME = 'pre-push';

export const PRE_PUSH_HOOK = String.raw`#!/bin/sh
zero=$(git hash-object --stdin </dev/null | tr '0-9a-f' '0')
tab=$(printf '\t')
unpinned=0
while read -r local_ref local_sha remote_ref remote_sha; do
  case "$local_sha" in *[!0]*) ;; *) continue ;; esac
  if [ "$remote_sha" = "$zero" ] || ! git cat-file -e "$remote_sha" 2>/dev/null; then
    pins=$(git -c core.quotePath=false ls-tree -r "$local_sha" | while IFS="$tab" read -r meta path; do
      case "$meta" in "160000 "*) set -- $meta; printf '%s\t%s\n' "$3" "$path" ;; esac
    done)
  else
    pins=$(git -c core.quotePath=false diff-tree -r --no-renames "$remote_sha" "$local_sha" | while IFS="$tab" read -r meta path; do
      case "$meta" in :*" 160000 "*) set -- $meta; printf '%s\t%s\n' "$4" "$path" ;; esac
    done)
  fi
  [ -z "$pins" ] && continue
  while IFS="$tab" read -r sha path; do
    if [ -z "$(git -C "$path" branch -r --contains "$sha" 2>/dev/null)" ]; then
      echo "Push refused: $path pins $sha, which is on no remote of that source mod." >&2
      unpinned=1
    fi
  done <<PINS
$pins
PINS
done
exit $unpinned
`;
