export const PRE_PUSH_HOOK_NAME = 'pre-push';

// modlist-repository.md, The repository, story 5: a clone fetches each source mod from the URL its .gitmodules names.
export const PRE_PUSH_HOOK = String.raw`#!/bin/sh
tab=$(printf '\t')
unpinned=0
refuse() {
  echo "Push refused: $1" >&2
  unpinned=1
}
url_of() {
  git config --blob "$1:.gitmodules" --null --get-regexp '^submodule\..*\.(path|url)$' 2>/dev/null | tr '\0' '\n' | PIN_PATH="$2" awk '
    NR % 2 { key = $0; next }
    key ~ /\.path$/ && $0 == ENVIRON["PIN_PATH"] { wanted = substr(key, 1, length(key) - 5) ".url" }
    key ~ /\.url$/ { urls[key] = $0 }
    END { if (wanted in urls) print urls[wanted] }'
}
url_holds() {
  heads=$(git -C "$1" ls-remote --heads "$2") || return 2
  [ -z "$heads" ] && return 1
  git -C "$1" fetch --quiet --no-tags --no-write-fetch-head "$2" $(echo "$heads" | cut -f2) || return 2
  for tip in $(echo "$heads" | cut -f1); do
    git -C "$1" merge-base --is-ancestor "$3" "$tip" 2>/dev/null && return 0
  done
  return 1
}
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
      refuse "$path pins $sha, and has no checkout to verify it against."
    elif url=$(url_of "$local_sha" "$path"); [ -z "$url" ]; then
      refuse "$path pins $sha, and .gitmodules names no remote for it."
    else
      url_holds "$path" "$url" "$sha"
      case $? in
        1) refuse "$path pins $sha, which $url lacks." ;;
        2) refuse "$path pins $sha, and $url could not be reached to verify it." ;;
      esac
    fi
  done <<PINS
$pins
PINS
done
exit $unpinned
`;
