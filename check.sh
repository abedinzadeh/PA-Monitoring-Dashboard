#!/bin/bash
# Global PA Solution Status Check - No Hardcoded Servers
# Author: Hossein Abedinzadeh

RED="\033[0;31m"
GREEN="\033[0;32m"
YELLOW="\033[1;33m"
BLUE="\033[0;34m"
NC="\033[0m" # No Color

# SSH login credentials
USER="serveradmin"

# Default password for most servers
DEFAULT_PASSWORD='CHANGE_ME'

# Alternative password
ALTERNATIVE_PASSWORD='CHANGE_ME'

# Path to the PA log file (same for all servers)
LOG_PATH="/home/serveradmin/pa/pa.log"

# Timeout settings (in seconds)
SSH_TIMEOUT=10
CONNECT_TIMEOUT=10
PING_TIMEOUT=5
COMMAND_TIMEOUT=10

# Rate limiting settings
CONCURRENT_LIMIT=4
DELAY_BETWEEN_SERVERS=0.9

# Password aliases for easy management
declare -A PASSWORD_ALIASES=(
    ["default"]='CHANGE_ME'
    ["alt"]='CHANGE_ME'
)

# ------------------------
# Functions (DEFINE THEM FIRST!)
# ------------------------

# Function to resolve password from entry
get_server_password() {
    local entry="$1"

    if [[ "$entry" == *":"* ]]; then
        local ip_part="${entry%%:*}"
        local password_part="${entry#*:}"

        if [[ -n "${PASSWORD_ALIASES[$password_part]}" ]]; then
            echo "${PASSWORD_ALIASES[$password_part]}"
        else
            echo "$password_part"
        fi
    else
        echo "$DEFAULT_PASSWORD"
    fi
}

# Function to get just the server IP
get_server_ip() {
    local entry="$1"
    if [[ "$entry" == *":"* ]]; then
        echo "${entry%%:*}"
    else
        echo "$entry"
    fi
}

# Function to test if server is reachable
is_server_reachable() {
    local server="$1"
    timeout $PING_TIMEOUT ping -c 1 -W 1 "$server" > /dev/null 2>&1
    return $?
}

# Function to try SSH connection
try_ssh_connection() {
    local server="$1"
    local password="$2"

    if ! is_server_reachable "$server"; then
        return 2  # Server not reachable
    fi

    echo "🔑 Attempting SSH connection with password..."

    # Use a temporary file for the password to avoid shell escaping issues
    local password_file=$(mktemp)
    printf '%s' "$password" > "$password_file"

    local output
    output=$(timeout $SSH_TIMEOUT sshpass -f "$password_file" ssh \
        -o StrictHostKeyChecking=no \
        -o ConnectTimeout=$CONNECT_TIMEOUT \
        -o ControlMaster=no \
        -o ControlPath=none \
        -o LogLevel=ERROR \
        -o UserKnownHostsFile=/dev/null \
        "$USER@$server" \
        "timeout $COMMAND_TIMEOUT tail -n 40 '$LOG_PATH' 2>/dev/null" 2>/dev/null)

    local exit_code=$?

    # Clean up the temporary password file
    rm -f "$password_file"

    if [[ $exit_code -eq 0 ]] && [[ -n "$output" ]]; then
        echo "$output"
        return 0  # Success
    fi

    if [[ $exit_code -eq 124 ]] || [[ $exit_code -eq 255 ]]; then
        return 3  # Timeout or connection refused
    fi

    return 1  # Authentication failed
}


# Single server check function
check_single_server() {
    local server_entry="$1"
    local server=$(get_server_ip "$server_entry")
    local password=$(get_server_password "$server_entry")

    echo -n "Checking $server ... "

    # Use single quotes to preserve special characters in password
    local output
    output=$(timeout $SSH_TIMEOUT sshpass -p "$password" ssh \
        -o StrictHostKeyChecking=no \
        -o ConnectTimeout=$CONNECT_TIMEOUT \
        -o ControlMaster=no \
        -o ControlPath=none \
        -o LogLevel=ERROR \
        -o UserKnownHostsFile=/dev/null \
        "$USER@$server" \
        "timeout $COMMAND_TIMEOUT tail -n 40 '$LOG_PATH' 2>/dev/null" 2>/dev/null)

    local exit_code=$?

    case $exit_code in
        0)  # Success
            # Check for IO Error exception first
            if echo "$output" | grep -iq "io error"; then
                echo -e "${YELLOW}🚫 IO ERROR - Firewall/Registration issue${NC}"
                echo "IO_ERROR: Found 'io error' in logs - manual intervention required"
                return 2  # Special exit code for IO errors
            # Check if server is healthy
            elif echo "$output" | grep -iq "successful"; then
                echo -e "${GREEN}✅ OK - Server is healthy${NC}"
                echo "VERIFICATION: SUCCESS - Found 'successful' in logs"
                return 0
            else
                echo -e "${RED}❌ FAIL - 'successful' not found in logs${NC}"
                echo "LOG_SNIPPET: $(echo "$output" | head -c 200)"
                return 1
            fi
            ;;
        1)  # Authentication failed
            echo -e "${RED}❌ FAIL - SSH authentication failed${NC}"
            return 1
            ;;
        2)  # Server not reachable
            echo -e "${RED}❌ FAIL - Server not reachable${NC}"
            return 1
            ;;
        124|255)  # Timeout or connection refused
            echo -e "${RED}❌ FAIL - SSH connection timeout or refused${NC}"
            return 1
            ;;
        *)  # Other errors
            echo -e "${RED}❌ FAIL - Unknown SSH error (code: $exit_code)${NC}"
            return 1
            ;;
    esac
}

# ------------------------
# Concurrent Check Function
# ------------------------

# Function to check a single server and output result
check_server_concurrent() {
    local server_entry="$1"
    local server=$(get_server_ip "$server_entry")
    local password=$(get_server_password "$server_entry")
    
    echo -n "Checking $server ... "
    
    # Use single quotes to preserve special characters in password
    local output
    output=$(timeout $SSH_TIMEOUT sshpass -p "$password" ssh \
        -o StrictHostKeyChecking=no \
        -o ConnectTimeout=$CONNECT_TIMEOUT \
        -o ControlMaster=no \
        -o ControlPath=none \
        -o LogLevel=ERROR \
        -o UserKnownHostsFile=/dev/null \
        "$USER@$server" \
        "timeout $COMMAND_TIMEOUT tail -n 40 '$LOG_PATH' 2>/dev/null" 2>/dev/null)

    local exit_code=$?
    local status log_output

    case $exit_code in
        0)  # Success
            if echo "$output" | grep -iq "successful"; then
                status="ok"
                log_output=$(printf "%s" "$output" | tr -d '\000-\037' | tr -d '\177-\377' | sed 's/\\/\\\\/g' | sed 's/"/\\"/g' | tr '\n\r' ' ' | tr -cd '[:print:]' | head -c 800)
                echo -e "${GREEN}✅ OK${NC}"
            else
                status="fail"
                log_output=$(printf "%s" "$output" | tr -d '\000-\037' | tr -d '\177-\377' | sed 's/\\/\\\\/g' | sed 's/"/\\"/g' | tr '\n\r' ' ' | tr -cd '[:print:]' | head -c 800)
                echo -e "${RED}❌ Issue detected${NC}"
            fi
            ;;
        2)  # Server not reachable
            status="error"
            log_output="Server not reachable"
            echo -e "${RED}❌ Server not reachable${NC}"
            ;;
        3)  # Timeout or connection refused
            status="error"
            log_output="SSH connection timeout or refused"
            echo -e "${RED}❌ SSH timeout${NC}"
            ;;
        *)  # Other errors
            status="error"
            log_output="Authentication failed"
            echo -e "${RED}❌ Auth failed${NC}"
            ;;
    esac
    
    # Output result in a parseable format
    echo "RESULT:$server:$status:$log_output"
}

# ------------------------
# Single Server Check Mode (NOW IT CAN FIND THE FUNCTION)
# ------------------------
if [[ "$1" == "single" && -n "$2" ]]; then
    TARGET_SERVER="$2"
    echo "🔧 Single server check mode for: $TARGET_SERVER"

    # Load servers from servers.json
    SERVERS_FILE="/home/serveradmin/pa/monitoring-dashboard/servers.json"
    if [[ ! -f "$SERVERS_FILE" ]]; then
        echo "❌ servers.json not found: $SERVERS_FILE"
        exit 1
    fi

    # Find the target server in servers.json
    SERVER_ENTRY=$(jq -r --arg ip "$TARGET_SERVER" '.active[] | select(.ip == $ip) | "\(.ip):\(.password // "default")"' "$SERVERS_FILE" 2>/dev/null)

    if [[ -z "$SERVER_ENTRY" ]]; then
        echo "❌ Server $TARGET_SERVER not found in servers.json"
        exit 1
    fi

    # Run single server check
    check_single_server "$SERVER_ENTRY"
    exit $?
fi

# ------------------------
# Normal Multi-Server Check Mode
# ------------------------

# Load servers from servers.json
SERVERS_FILE="/home/serveradmin/pa/monitoring-dashboard/servers.json"
if [[ ! -f "$SERVERS_FILE" ]]; then
    echo "❌ servers.json not found: $SERVERS_FILE"
    echo "⚠️  Please create servers.json with server configuration"
    exit 1
fi

# Load servers from JSON file - only active ones
echo "📋 Loading servers from $SERVERS_FILE"
SERVERS=()
while IFS= read -r line; do
    if [[ -n "$line" ]]; then
        ip=$(echo "$line" | jq -r '.ip')
        password=$(echo "$line" | jq -r '.password // "default"')
        if [[ -n "$ip" && "$ip" != "null" ]]; then
            SERVERS+=("$ip:$password")
        fi
    fi
done < <(jq -c '.active[]' "$SERVERS_FILE")

if [[ ${#SERVERS[@]} -eq 0 ]]; then
    echo "❌ No active servers found in servers.json"
    exit 1
fi

echo -e "${GREEN}✅ Loaded ${#SERVERS[@]} servers from configuration${NC}"

# ------------------------
# Generate Status JSON Function (Concurrent Version)
# ------------------------

generate_status_json() {
    local status_file="/home/serveradmin/pa/monitoring-dashboard/status.json"
    local status_data="["
    local first=true

    # Pre-load server names from servers.json
    declare -A server_names
    while IFS= read -r line; do
        ip=$(echo "$line" | jq -r '.ip')
        name=$(echo "$line" | jq -r '.name')
        if [[ -n "$ip" && "$ip" != "null" && -n "$name" && "$name" != "null" ]]; then
            server_names["$ip"]="$name"
        fi
    done < <(jq -c '.active[]' "$SERVERS_FILE")

    local checked=0
    local total=${#SERVERS[@]}
    local concurrent_limit=$CONCURRENT_LIMIT
    local pids=()

    echo -e "${BLUE}📊 Checking ${total} servers (concurrent limit: ${concurrent_limit})...${NC}"
    echo ""

    # Create a temporary file for results
    local result_file=$(mktemp)

    # Function to wait for background processes with limit
    wait_for_slot() {
        while [[ ${#pids[@]} -ge $concurrent_limit ]]; do
            # Wait for any background process to finish
            local finished_pid
            for finished_pid in "${pids[@]}"; do
                if ! kill -0 "$finished_pid" 2>/dev/null; then
                    # Remove finished PID from array
                    pids=("${pids[@]/$finished_pid}")
                    break 2
                fi
            done
            sleep 0.1
        done
    }

    # Start background checks
    for server_entry in "${SERVERS[@]}"; do
        wait_for_slot
        
        server=$(get_server_ip "$server_entry")
        echo "[$((checked+1))/$total] Starting check: $server"
        
        # Start background check
        ( check_server_concurrent "$server_entry" >> "$result_file" ) &
        pids+=($!)
        ((checked++))
    done

    # Wait for all background processes to complete
    echo "⏳ Waiting for all checks to complete..."
    for pid in "${pids[@]}"; do
        wait "$pid" 2>/dev/null
    done

    # Process results
    checked=0
    while IFS= read -r line; do
        if [[ "$line" == RESULT:* ]]; then
            IFS=':' read -r _ server status log_output <<< "$line"
            
            # Get server name
            server_name="${server_names[$server]:-Unknown}"
            server_name=$(printf "%s" "$server_name" | tr -d '\000-\037' | tr -d '\177-\377' | sed 's/\\/\\\\/g' | sed 's/"/\\"/g' | tr '\n\r' ' ' | tr -cd '[:print:]')

            if [[ "$first" != true ]]; then
                status_data+=","
            fi
            status_data+="{\"name\":\"$server_name\",\"ip\":\"$server\",\"status\":\"$status\",\"log\":\"$log_output\",\"timestamp\":\"$(date -Iseconds)\"}"
            first=false
            ((checked++))
            
            echo "[$checked/$total] Processed: $server - $status"
        fi
    done < "$result_file"

    # Clean up
    rm -f "$result_file"

    status_data+="]"

    # Validate and write JSON
    if echo "$status_data" | python3 -m json.tool > /dev/null 2>&1; then
        echo "$status_data" > "$status_file"
        file_size=$(stat -c%s "$status_file" 2>/dev/null || echo 0)
        echo ""
        echo "✅ Status JSON updated: $status_file ($file_size bytes, $checked servers)"
    else
        echo "❌ JSON validation failed - creating backup"
        echo "$status_data" > "${status_file}.invalid"
        echo "[{\"name\":\"System\",\"ip\":\"0.0.0.0\",\"status\":\"error\",\"log\":\"JSON generation failed\",\"timestamp\":\"$(date -Iseconds)\"}]" > "$status_file"
    fi
}

# ------------------------
# Check Dependencies
# ------------------------
check_dependencies() {
    if ! command -v sshpass >/dev/null 2>&1; then
        echo -e "${RED}❌ sshpass not found. Please install it first:${NC}"
        echo "   sudo apt install sshpass"
        exit 1
    fi

    if ! command -v jq >/dev/null 2>&1; then
        echo -e "${RED}❌ jq not found. Please install it first:${NC}"
        echo "   sudo apt install jq"
        exit 1
    fi

    if ! command -v timeout >/dev/null 2>&1; then
        echo -e "${RED}❌ timeout command not found. Please install it first:${NC}"
        echo "   sudo apt install coreutils"
        exit 1
    fi
}

# ------------------------
# Main execution
# ------------------------
main() {
    check_dependencies

    echo "--------------------------------------"
    echo " Global PA Solution Status Check - $(date)"
    echo "--------------------------------------"
    echo -e "${BLUE}📊 Monitoring ${#SERVERS[@]} servers...${NC}"
    echo ""

    # Generate status (includes the checking output)
    generate_status_json

    echo ""
    echo "--------------------------------------"
    echo "Check complete at $(date)"
}

main "$@"
