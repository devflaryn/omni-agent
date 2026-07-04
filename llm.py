import json
import requests
from tool_registry import registry
from skills_loader import get_skills_prompt

# Switched from local LM Studio to the Cline API base URL
CLINE_API_URL = "https://api.cline.bot/api/v1/chat/completions"
# Using your provided Cline API key and targeting GLM 5.2
API_KEY = "REDACTED_API_KEY"
MODEL_NAME = "cline-pass/glm-5.2"

REQUEST_TIMEOUT = 300
MAX_RETRIES = 3

# A single general-purpose agent — no per-project "profile" selection anymore.
# Specialization comes from the skills system (skills/*/SKILL.md), which the
# agent loads on demand for a given task, not from a fixed persona chosen up
# front. This prompt just needs to cover what's true for EVERY task: general
# software engineering capability, the sandbox environment, and pointers to
# skills for anything more specific (Android RE, emulator testing, etc.).
DEFAULT_SYSTEM_PROMPT = """You are Omni Agent, a general-purpose engineering AI agent. You can write code, \
build and scaffold projects, debug and fix bugs, do software/Android reverse engineering, patch and rebuild \
APKs, analyze and modify native binaries, test apps on an emulator, and anything else the user asks for that \
falls within the tools available to you. You are not limited to any one domain — pick whichever tools and \
skills actually fit the task in front of you.

You operate inside a Linux Docker sandbox; the active project workspace is mounted at `/workspace`. Some tools \
(the Android emulator tools) instead run directly on the Windows host, since the emulator itself runs natively \
there — see their own descriptions for that distinction; everything else goes through the sandbox.

Consult AVAILABLE SKILLS below whenever a task matches one — they contain detailed, battle-tested step-by-step \
workflows (with tool call sequences and critical rules) that are more reliable than improvising from scratch, \
especially for anything Android/reverse-engineering related. For a task with no matching skill, just use the \
available tools directly and sensibly."""


def get_full_system_prompt():
    base_prompt = DEFAULT_SYSTEM_PROMPT

    base_prompt += """

WORKSPACE RULES:
1. The active project workspace is `/workspace`.
2. All project files live directly inside `/workspace`.
3. Use `/workspace/notes.md` for persistent memory.

RESPONSE FORMAT RULES:
You MUST always return valid JSON.

Tool call:
{
  "type": "tool_call",
  "tool": "tool_name",
  "args": {}
}

Final answer:
{
  "type": "final_answer",
  "content": "answer text"
}

Only call one tool at a time.
Never output markdown code fences.
Never output text outside JSON.

PLAN-AND-EXECUTE WORKFLOW (default behavior, not optional):
1. For any task that needs more than a one-line answer, call `plan_create` FIRST — before any other
   tool — with a short task summary and an ordered list of concrete, verifiable steps. You do not
   need to enumerate every possible step up front; you can extend the plan as you learn more. A truly
   trivial question (no tool use needed at all) can be answered directly without a plan.
2. Keep the plan synchronized with reality as you work, not just at the end:
   - `plan_update_task(task_id, status="in_progress")` when you start a step (finish/complete the
     previous one first — normally only one task is in_progress at a time).
   - `plan_update_task(task_id, status="completed")` the moment a step is genuinely done.
   - `plan_add_task(...)` the instant you discover new work that wasn't in the original plan — don't
     silently do extra work outside the plan.
   - `plan_update_task(task_id, status="skipped", notes="...")` if a planned step turns out to be
     unnecessary, explaining why.
   - `plan_reorder(...)` if you discover a dependency that changes the right order of remaining steps.
   - `plan_view()` any time you need a task's id or want to double check the plan is accurate.
3. Once an active plan exists, its current state is kept visible to you as a "CURRENT PLAN" section
   appended to this system prompt automatically — treat it as the single source of truth for what's
   done and what's left. If it ever looks stale relative to what you've actually done, fix it with
   plan_update_task rather than ignoring the discrepancy.
"""

    return base_prompt + "\n" + get_skills_prompt() + "\n" + registry.get_tool_prompt()


def _error_response(message):
    return json.dumps({
        "type": "final_answer",
        "content": f"[Error] {message}"
    })


def ask_llm(messages, temperature=0.7):
    payload = {
        "model": MODEL_NAME,
        "messages": messages,
        "temperature": temperature,
    }

    last_error = None

    for attempt in range(MAX_RETRIES):
        try:
            # Added Authorization header to authenticate your Cline Pass subscription
            response = requests.post(
                CLINE_API_URL,
                json=payload,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {API_KEY}"
                },
                timeout=REQUEST_TIMEOUT
            )

            if not response.ok:
                return _error_response(
                    f"Cline API HTTP {response.status_code}: "
                    f"{response.text[:1000]}"
                )

            try:
                data = response.json()
            except Exception:
                return _error_response(
                    f"Invalid JSON from Cline API:\n{response.text[:1000]}"
                )

            # The Cline API wraps the standard OpenAI-format chat completion
            # response inside a top-level "data" envelope, e.g.:
            #   {"data": {"choices": [{"message": {"content": "..."}}]}}
            # Unwrap it so the rest of the parsing can treat it like a normal
            # OpenAI response. We only unwrap when the top level lacks
            # "choices" but the nested "data" object has it, so this stays safe
            # for error payloads or any future flat responses.
            if (isinstance(data, dict)
                    and "data" in data
                    and isinstance(data["data"], dict)
                    and "choices" not in data
                    and "choices" in data["data"]):
                data = data["data"]

            choices = data.get("choices")

            if not choices:
                return _error_response(
                    f"Missing choices field:\n{json.dumps(data)[:1000]}"
                )

            message = choices[0].get("message", {})
            content = message.get("content")

            # The model may use native function-calling: content is null but
            # the tool calls are in message["tool_calls"]. Convert the first
            # tool call into the JSON format our agent loop expects.
            if not content and message.get("tool_calls"):
                tc = message["tool_calls"][0]
                fn = tc.get("function", {})
                tool_name = fn.get("name", "")
                try:
                    tool_args = json.loads(fn.get("arguments", "{}") or "{}")
                except (json.JSONDecodeError, TypeError):
                    tool_args = {}
                return json.dumps({"type": "tool_call", "tool": tool_name, "args": tool_args})

            # Some providers return content as an empty string with a
            # finish_reason of "stop" — treat that as a blank final answer
            # rather than an error so the loop doesn't abort.
            if content is None:
                finish_reason = choices[0].get("finish_reason", "")
                if finish_reason == "stop":
                    return json.dumps({"type": "final_answer", "content": "Done."})
                return _error_response(
                    f"Missing message content:\n{json.dumps(data)[:1000]}"
                )

            return content

        except requests.exceptions.Timeout:
            last_error = "Request timed out"

        except requests.exceptions.ConnectionError as e:
            last_error = f"Connection error: {e}"

        except Exception as e:
            last_error = str(e)

    return _error_response(last_error)