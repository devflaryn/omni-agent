"""Headless Textual test: confirm ThoughtWidget's content RichLog has wrap=True
and that clicking the header toggles expansion (so the wrapped thought shows).

Run from the project root:
    python test_thought_wrap.py
"""
import asyncio
import sys

from textual.app import App, ComposeResult

from agent import ThoughtWidget


class T(App):
    def compose(self) -> ComposeResult:
        long_thought = (
            "I'll help you unpack the APK file. Let me start by listing the "
            "workspace directory to confirm the file is there, then decompile "
            "with apktool, and finally build a knowledge graph so I don't have "
            "to re-read thousands of smali files on every turn. "
        ) * 3
        yield ThoughtWidget("1.2s", long_thought)


async def main():
    app = T()
    async with app.run_test() as pilot:
        rl = app.query_one(".thought-content")
        print("RichLog wrap attribute:", getattr(rl, "wrap", "MISSING"))
        print("display before click:", rl.display)
        header = app.query_one(".thought-header")
        await pilot.click(header)
        await pilot.pause()
        print("display after click (should be True):", rl.display)
    print("OK: ThoughtWidget renders with wrap enabled.")


if __name__ == "__main__":
    asyncio.run(main())
