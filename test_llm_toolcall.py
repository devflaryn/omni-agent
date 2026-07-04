"""Live test that mimics the real agent flow: a tool-call scenario.

Run from the project root:
    python test_llm_toolcall.py
"""
import json
from llm import ask_llm
from agent import parse_response


def main():
    system_prompt = (
        "You are an autonomous agent. Respond ONLY with a single raw JSON object.\n"
        "To call a tool use: {\"type\": \"tool_call\", \"tool\": \"name\", \"args\": {}}\n"
        "To give a final answer use: {\"type\": \"final_answer\", \"content\": \"...\"}\n"
        "No markdown, no prose outside JSON.\n\n"
        "AVAILABLE TOOLS:\n"
        "### Tool: list_directory\n"
        "Description: Lists files in a directory.\n"
        'To call this tool, output exactly: {"type": "tool_call", "tool": "list_directory", "args": {"directory": "."}}\n'
    )

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": "List the current directory."},
    ]

    print(">>> Sending tool-call request to Cline API (glm-5.2)...")
    raw = ask_llm(messages, temperature=0.0)
    print(">>> RAW content:\n")
    print(raw)
    print("\n>>> Parsing with agent.parse_response...")
    rtype, payload = parse_response(raw)
    print(f">>> TYPE: {rtype}")
    print(f">>> PAYLOAD: {payload}")

    if rtype == "tool_call":
        print(f">>> SUCCESS: parsed a tool_call -> tool={payload.get('tool')} args={payload.get('args')}")
    elif rtype == "final_answer":
        print(f">>> Got a final_answer instead: {payload}")
    else:
        print(f">>> Could not parse a clean action: {payload}")

    if raw.startswith('{"type": "final_answer", "content": "[Error]'):
        print("!!! ask_llm returned an ERROR envelope.")
    else:
        print(">>> No error envelope from ask_llm (data envelope unwrapped correctly).")


if __name__ == "__main__":
    main()
