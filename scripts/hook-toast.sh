#!/bin/bash
# hook-toast.sh — tmux popup notifications for agent hooks.
#
# Usage:
#   hook-toast.sh <system> <message>          # queued toast (shows for 2s each)
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
# One-shot toasts are queued per-session — multiple hooks can fire toasts
# without clobbering each other. A single popup reads from the queue,
# showing each message for 2s before advancing. Popups target the session
# that spawned them via -t, so they stay in the right terminal.
#
# Multi-stage example (PreCompact):
#   hook-toast.sh memento --status precompact
#   hook-toast.sh --update precompact "⏳ Getting context..."
#   hook-toast.sh --update precompact "⏳ Extracting memories..."
#   hook-toast.sh --update precompact "✓ Stored 7 memories"
#   hook-toast.sh --close precompact

# Bail silently if not in tmux
if ! tmux info &>/dev/null; then
    exit 0
fi

# Derive session name — used for per-session queue isolation and -t targeting
SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null)
if [ -z "$SESSION" ]; then
    exit 0
fi

TOAST_DIR="/tmp/hook-toast/${SESSION}"
QUEUE_FILE="$TOAST_DIR/queue"
READER_PID_FILE="$TOAST_DIR/reader.pid"
mkdir -p "$TOAST_DIR"

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

# Check if the queue reader popup is still alive
reader_alive() {
    local pid
    pid=$(cat "$READER_PID_FILE" 2>/dev/null) || return 1
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# Queued one-shot toast — append to queue, spawn reader if needed
toast_oneshot() {
    local system="$1"
    local message="$2"
    local icon
    icon=$(get_icon "$system")

    # Append to queue: icon|colour|title|message
    echo "${icon}|$(get_style "$system")|$(get_title "$system")|$message" >> "$QUEUE_FILE"

    # If reader is already running, it will pick up the new entry
    if reader_alive; then
        return
    fi

    # Spawn a reader popup targeting this session
    (tmux display-popup -t "$SESSION" -x R -y 0 -w 42 -h 3 \
        -s "fg=colour245" -E "
        echo \$\$ > '$READER_PID_FILE'
        while true; do
            LINE=\$(head -1 '$QUEUE_FILE' 2>/dev/null)
            if [ -z \"\$LINE\" ]; then
                rm -f '$READER_PID_FILE'
                break
            fi
            TAIL=\$(tail -n +2 '$QUEUE_FILE' 2>/dev/null)
            if [ -n \"\$TAIL\" ]; then
                echo \"\$TAIL\" > '$QUEUE_FILE'
            else
                > '$QUEUE_FILE'
            fi
            ICON=\$(echo \"\$LINE\" | cut -d'|' -f1)
            MSG=\$(echo \"\$LINE\" | cut -d'|' -f4-)
            clear
            echo \"  \$ICON \$MSG\"
            sleep 2
        done
        rm -f '$QUEUE_FILE' '$READER_PID_FILE'
    " &>/dev/null &)
}

# Start a multi-stage toast (polling status file) — targets this session
toast_start() {
    local system="$1"
    local id="$2"
    local status_file="$TOAST_DIR/$id"
    local colour icon title
    colour=$(get_style "$system")
    icon=$(get_icon "$system")
    title=$(get_title "$system")

    echo "⏳ Starting..." > "$status_file"

    (tmux display-popup -t "$SESSION" -x R -y 0 -w 42 -h 3 \
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
