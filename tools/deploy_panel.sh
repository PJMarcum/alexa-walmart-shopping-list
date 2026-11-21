#!/usr/bin/env bash
# Deploy the kitchen panel to Home Assistant, into a versioned directory.
#
# Why a version in the PATH rather than a ?v= query:
#
# Home Assistant serves /local/ with "Cache-Control: public, max-age=2678400",
# which is 31 days, and sends no revalidation. A browser that has loaded
# /local/kitchen/panel.js will not ask for it again within a month. Editing the
# file on the box therefore changes nothing on the tablet, silently, which is
# exactly how an evening gets lost.
#
# A query string on panel.js alone does not help, because panel.js imports
# ./styles.js, ./model.js, ./images.js, ./actions.js and ./clock.js with
# relative specifiers. Those resolve without the query and come straight from
# cache. Putting the version in the directory is the only thing that busts the
# whole module graph at once, because every relative import inherits it.
#
# The cost is that panel_custom's module_url in configuration.yaml names the
# directory, so a new version needs a Home Assistant restart. That is the
# trade: a restart you chose, instead of a stale file you did not notice.
#
# Usage:  tools/deploy_panel.sh v3
set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: $0 <version>   e.g. $0 v3" >&2
  exit 2
fi

HOST="${HA_HOST:-homeassistant.local}"
# NOT root. The Advanced SSH add-on builds an AllowUsers line from its
# username option and sshd rejects root by name before reading any key.
USER_NAME="${HA_USER:?set HA_USER to your SSH add-on username}"
KEY="${HA_KEY:-$HOME/.ssh/id_ed25519}"
SRC="ha/www/kitchen"
DEST="/homeassistant/www/kitchen/$VERSION"

SSH="ssh -i $KEY -o StrictHostKeyChecking=no -o BatchMode=yes $USER_NAME@$HOST"

echo "Deploying $SRC -> $DEST"
$SSH "sudo mkdir -p '$DEST'"

fail=0
for f in "$SRC"/*.js; do
  base="$(basename "$f")"
  # scp is not available: the add-on ships sftp:false and OpenSSH 9+ runs scp
  # over the sftp subsystem, so it dies with "Connection closed".
  remote_md5=$(cat "$f" | $SSH "sudo tee '$DEST/$base' >/dev/null && sudo md5sum '$DEST/$base' | cut -d' ' -f1")
  local_md5=$(md5sum < "$f" | cut -d' ' -f1)
  if [ "$remote_md5" = "$local_md5" ]; then
    printf '  ok    %-12s %s\n' "$base" "$local_md5"
  else
    printf '  FAIL  %-12s local=%s remote=%s\n' "$base" "$local_md5" "$remote_md5"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "One or more files did not match after upload. Nothing was switched over." >&2
  exit 1
fi

# Switch configuration.yaml over, rather than printing a step to do by hand.
#
# The panel_custom block lives INLINE in configuration.yaml. There is also a
# ha/panel_custom.yaml in this repo, which is a snippet to paste, included
# from nowhere: editing it changes nothing, and an afternoon was lost to
# editing it, verifying the md5 of the file just written, and concluding the
# deploy was live. A copy you wrote is not a copy anything reads.
CONF=/homeassistant/configuration.yaml
echo
echo "Pointing $CONF at $VERSION"
before=$($SSH "sudo grep -o '/local/kitchen/[^/]*/panel.js' '$CONF' | head -1")
$SSH "sudo cp '$CONF' '$CONF.bak-pre-$VERSION' &&       sudo sed -i 's|/local/kitchen/[^/]*/panel\.js|/local/kitchen/$VERSION/panel.js|' '$CONF'"
after=$($SSH "sudo grep -o '/local/kitchen/[^/]*/panel.js' '$CONF' | head -1")
echo "  was: ${before:-<none found>}"
echo "  now: ${after:-<none found>}"

if [ "$after" != "/local/kitchen/$VERSION/panel.js" ]; then
  echo "configuration.yaml does not name this version. Nothing will change on" >&2
  echo "the tablet until it does. Backup: $CONF.bak-pre-$VERSION" >&2
  exit 1
fi

cat <<EOF

Restart Home Assistant; panels register once at startup. Afterwards, confirm
what is actually REGISTERED rather than what is on disk:

  websocket get_panels -> panels.kitchen.config._panel_custom.module_url

EOF
