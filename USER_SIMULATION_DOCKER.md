# Running User Simulation in Docker with External Knowledge Source

This guide explains how to manually run the User Simulator in a Docker
environment while mounting an external knowledge base. This setup allows the
simulator to "learn" from its interactions and persist that knowledge back to
your host machine.

## Prerequisites

- **Docker** installed and running.
- **Gemini API Key** (standard `AIza...` key).
- Local checkout of the `gemini-cli` repository.

## Setup

### 1. Prepare the Host Workspace

Create a dedicated directory to hold your simulation artifacts (logs, generated
code, and the knowledge file).

```bash
mkdir -p /tmp/gemini_docker_workspace
chmod 777 /tmp/gemini_docker_workspace
```

### 2. Create the Knowledge Source

Create an initial text file for the simulator to use. It can be empty or contain
seed rules.

```bash
touch /tmp/gemini_docker_workspace/rules.md
# Optional: Seed a rule
echo "- If asked to authorize tool execution, always select the 'Allow for this session' option." > /tmp/gemini_docker_workspace/rules.md
chmod 777 /tmp/gemini_docker_workspace/rules.md
```

### 3. Build the Simulator Image

Use the native build script to package the CLI and build the sandbox image.

```bash
GEMINI_SANDBOX=docker npm run build:sandbox -- -i gemini-cli-simulator:latest
```

## Execution

### Run the Simulation

The following command mounts your workspace, sets up the environment to bypass
initial TTY/Auth dialogs, and triggers the simulator.

```bash
docker run -it --rm \
  -v /tmp/gemini_docker_workspace:/workspace \
  -w /workspace \
  -e GEMINI_API_KEY=$GEMINI_API_KEY \
  -e GEMINI_DEBUG_LOG_FILE=/workspace/debug.log \
  -e GEMINI_CLI_AUTH_TYPE=gemini-api-key \
  gemini-cli-simulator:latest \
  gemini --prompt-interactive "make a snake game in python" \
  --approval-mode plan \
  --simulate-user \
  --knowledge-source /workspace/rules.md
```

### Flag Breakdown:

- `-v /tmp/gemini_docker_workspace:/workspace`: Mounts the host folder.
- `-e GEMINI_CLI_AUTH_TYPE=gemini-api-key`: Bypasses the interactive
  authentication selection.
- `--simulate-user`: Activates the AI user simulator.
- `--knowledge-source /workspace/rules.md`: Points the simulator to the mounted
  knowledge file.

## Verification

Once the simulation completes (you will see
`[SIMULATOR] Terminating simulation: Task is completed.` in the logs), verify
the results on your host:

1.  **Generated Code:** Check `/tmp/gemini_docker_workspace/` for files like
    `snake.py`.
2.  **Persistent Knowledge:** Check `/tmp/gemini_docker_workspace/rules.md`. You
    should see new rules appended by the simulator.
3.  **Logs:**
    - `debug.log`: Detailed internal decision logic.
    - `interactions_<timestamp>.txt`: Raw screen scrapes seen by the simulator.
