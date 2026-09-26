#!/usr/bin/env bash
# Show/hide the GTK checklist through i3, without closing it.
set -euo pipefail

if [[ ${1:-} == --block ]]; then
    # i3blocks invokes once for display, then again for each click.
    printf '󰎞\n'
    [[ ${BLOCK_BUTTON:-} == 1 ]] || exit 0
elif [[ ${1:-} == --help || ${1:-} == -h ]]; then
    printf 'Usage: %s [--block]\nToggle Pinote on i3; --block prints an i3blocks icon and handles left clicks.\n' "$0"
    exit 0
elif (($#)); then
    printf 'Unexpected arguments. Use --help.\n' >&2
    exit 2
fi

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
for tool in i3-msg jq flock; do
    command -v "$tool" >/dev/null || { printf 'Missing command: %s\n' "$tool" >&2; exit 1; }
done
# Serialize clicks, including the interval before a newly launched window maps.
exec 9>"$root/.venv-gui/toggle-pinote.lock"
flock -x 9

windows() {
    i3-msg -t get_tree | jq -c '[recurse(.nodes[], .floating_nodes[]) |
        select(.window_properties.window_role? == "pinote-reminders") | .id]'
}
wm() {
    i3-msg "$1" | jq -e 'length > 0 and all(.[]; .success == true)' >/dev/null
}
ids=$(windows)
count=$(jq length <<<"$ids")
if ((count > 1)); then
    printf 'Multiple Pinote windows; refusing an ambiguous toggle.\n' >&2
    exit 1
elif ((count == 0)); then
    [[ -x "$root/.venv-gui/bin/pinote-gui" ]] || {
        printf 'Install the GTK environment described in README.md first.\n' >&2
        exit 1
    }
    # Do not inherit the bar pipe or lock into the long-running GUI.
    nohup "$root/.venv-gui/bin/pinote-gui" </dev/null >/dev/null 2>&1 9>&- &
    for ((attempt=0; attempt<100; attempt++)); do
        [[ $(windows) != '[]' ]] && exit 0
        sleep 0.1
    done
    printf 'Pinote did not open within 10 seconds; check its app.log.\n' >&2
    exit 1
fi
id=$(jq -r '.[0]' <<<"$ids")
# A window on another workspace is brought here, not hidden out of sight.
current=$(i3-msg -t get_workspaces | jq -r '.[] | select(.focused) | .name')
workspace=$(i3-msg -t get_tree | jq -r --argjson id "$id" '
    recurse(.nodes[], .floating_nodes[]) | select(.type == "workspace") |
    select(any(recurse(.nodes[], .floating_nodes[]); .id == $id)) | .name')
if [[ "$workspace" == "$current" ]]; then
    wm "[con_id=$id] move scratchpad"
else
    wm "[con_id=$id] move workspace current"
    wm "[con_id=$id] focus"
fi
