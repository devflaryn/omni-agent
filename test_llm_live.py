"""Live smoke test for ask_llm against the real Cline API.

Run from the project root:
    python test_llm_live.py
"""
import json
from llm import ask_llm


def main():
    messages = [
        {
            "role": "system",
            "content": (
                "You are a helpful assistant. You MUST respond with a single raw "
                'JSON object only. Use {"type": "final_answer", "content": "..."}. '
                "No markdown, no prose outside JSON."
            ),
        },
        {
            "role": "user",
            "content": 'What is 2 + 2? Reply with {"type": "final_answer", "content": "..."}.',
        },
    ]

    print(">>> Sending request to Cline API (glm-5.2)...")
    raw = ask_llm(messages, temperature=0.0)
    print(">>> Raw content returned by ask_llm:\n")
    print(raw)
    print("\n>>> Done.\n")

    # Lightweight verification that the response is real content, not an error envelope.
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw[raw.find("{"):raw.rfind("}") + 1])
            rtype = parsed.get("type")
            print(f">>> Parsed JSON type: {rtype}")
            if rtype == "final_answer":
                print(f">>> Final answer: {parsed.get('content')}")
            elif rtype == "tool_call":
                print(f">>> Tool call: {parsed.get('tool')} args={parsed.get('args')}")
            else:
                print(">>> Unknown response type (see raw output above).")
        except json.JSONDecodeError:
            print(">>> Response was not valid JSON (see raw output above).")

        if raw.startswith('{"type": "final_answer", "content": "[Error]'):
            print("!!! ask_llm returned an ERROR envelope. See message above.")
        else:
            print(">>> SUCCESS: ask_llm returned content (no 'Missing choices field' error).")


if __name__ == "__main__":
    main()
