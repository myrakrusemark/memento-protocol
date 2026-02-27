#!/bin/bash
# hook-toast.sh — tmux popup notifications for agent hooks.
#
# Usage:
#   hook-toast.sh <system> <message>          # one-shot toast (auto-closes after 2s)
#   hook-toast.sh <system> --status <id>      # start a multi-stage toast (poll mode)
#   hook-toast.sh --update <id> <message>     # update a running toast
#   hook-toast.sh --close <id>                # close a running toast (after delay)
#
# Built-in systems: fathom, memento
#   fathom  → 📝 purple (colour141)
#   memento → 🧠 teal (colour37)
#
# Any other system name works too — gets a default icon and grey border.
#
# Multi-stage example (PreCompact):
#   hook-toast.sh memento --status precompact
#   hook-toast.sh --update precompact "⏳ Getting context..."
#   hook-toast.sh --update precompact "⏳ Extracting memories..."
#   hook-toast.sh --update precompact "✓ Stored 7 memories"
#   hook-toast.sh --close precompact

TOAST_DIR="/tmp/hook-toast"
mkdir -p "$TOAST_DIR"

# Bail silently if not in tmux
if ! tmux info &>/dev/null; then
    exit 0
fi

get_style() {
    case "$1" in
        memento) echo "colour37" ;;
        fathom)  echo "colour141" ;;
        *)       echo "colour245" ;;
    esac
}

get_icon() {
    case "$1" in
        memento) echo "🧠" ;;
        fathom)  echo "📝" ;;
        *)       echo "📌" ;;
    esac
}

get_title() {
    case "$1" in
        memento) echo "Memento" ;;
        fathom)  echo "Fathom" ;;
        *)       echo "$1" ;;
    esac
}

# One-shot toast
toast_oneshot() {
    local system="$1"
    local message="$2"
    local colour icon title
    colour=$(get_style "$system")
    icon=$(get_icon "$system")
    title=$(get_title "$system")

    (tmux display-popup -x R -y 0 -w 42 -h 3 \
        -s "fg=$colour" -T " $icon $title " -E \
        "echo '  $message'; sleep 2" &>/dev/null &)
}

# Start a multi-stage toast (polling status file)
toast_start() {
    local system="$1"
    local id="$2"
    local status_file="$TOAST_DIR/$id"
    local colour icon title
    colour=$(get_style "$system")
    icon=$(get_icon "$system")
    title=$(get_title "$system")

    echo "⏳ Starting..." > "$status_file"

    (tmux display-popup -x R -y 0 -w 42 -h 3 \
        -s "fg=$colour" -T " $icon $title " -E "
        LAST=''
        while [ -f '$status_file' ]; do
            MSG=\$(cat '$status_file' 2>/dev/null)
            if [ \"\$MSG\" != \"\$LAST\" ]; then
                clear
                echo \"  \$MSG\"
                LAST=\"\$MSG\"
            fi
            case \"\$MSG\" in ✓*|✗*) sleep 2; break ;; esac
            sleep 0.2
        done
    " &>/dev/null &)
}

# Update a running toast
toast_update() {
    local id="$1"
    local message="$2"
    echo "$message" > "$TOAST_DIR/$id"
}

# Close a running toast (remove status file — popup exits on next poll)
toast_close() {
    local id="$1"
    # Give the popup time to display the final message
    sleep 2
    rm -f "$TOAST_DIR/$id"
}

# --- Argument parsing ---
case "${1:-}" in
    --update)
        toast_update "$2" "$3"
        ;;
    --close)
        toast_close "$2"
        ;;
    --*)
        echo "Unknown option: $1" >&2
        exit 1
        ;;
    "")
        echo "Usage: hook-toast.sh <system> <message>" >&2
        echo "       hook-toast.sh <system> --status <id>" >&2
        echo "       hook-toast.sh --update <id> <message>" >&2
        echo "       hook-toast.sh --close <id>" >&2
        exit 1
        ;;
    *)
        SYSTEM="$1"
        shift
        if [ "${1:-}" = "--status" ]; then
            toast_start "$SYSTEM" "$2"
        else
            toast_oneshot "$SYSTEM" "$*"
        fi
        ;;
esac
