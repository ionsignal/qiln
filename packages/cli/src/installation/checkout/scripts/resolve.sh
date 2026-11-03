# Resolves the approved branch of the approved repository to one commit ID.
# It only reads: nothing on the host is written or changed. The repository is
# reached over HTTPS only, with prompts and every configuration file outside
# the repository disabled, and the commit is printed only when the repository
# lists exactly the approved reference once. Exit codes 20 to 99 mean nothing
# was changed.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
GIT_TERMINAL_PROMPT=0
GIT_CONFIG_NOSYSTEM=1
GIT_CONFIG_GLOBAL=/dev/null
GIT_ALLOW_PROTOCOL=https
export GIT_TERMINAL_PROMPT GIT_CONFIG_NOSYSTEM GIT_CONFIG_GLOBAL GIT_ALLOW_PROTOCOL
exec 2>/dev/null

test $# -eq 2 || exit 20
url=$1
ref=$2
case $url in https://*) ;; *) exit 20 ;; esac
case $ref in refs/heads/*) ;; *) exit 20 ;; esac
command -v git >/dev/null || exit 21

listing=$(git ls-remote --refs "$url" "$ref") || exit 22
rows=$(printf '%s\n' "$listing" | awk 'NF > 0 { n++ } END { print n + 0 }')
test "$rows" -eq 1 || exit 23
oid=$(printf '%s\n' "$listing" | awk -v ref="$ref" '$2 == ref { print $1 }')
case $oid in '' | *[!0-9a-f]*) exit 23 ;; esac
test ${#oid} -eq 40 || exit 23
printf '%s\n' "$oid"
exit 0
