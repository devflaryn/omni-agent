---
name: project-scaffolding
description: Scaffold and build software projects — create file structures, write code, set up build configs, and run builds.
when_to_use: Use this skill when the user asks to create a new project, write an application, set up a server, build a frontend, or scaffold any kind of software.
allowed-tools: write_file, list_directory, read_file_chunk
---

# Project Scaffolding Skill

This skill guides you through creating software projects from scratch inside the workspace.

## Step 1 — Understand the requirements
Before writing any code, make sure you understand:
- What language/framework the user wants
- What the project should do
- Any specific architecture or structure preferences

## Step 2 — Plan the structure
Write your plan to `/workspace/notes.md` using `write_file`. Include:
- Project directory structure
- Key files to create
- Dependencies needed
- Build/run instructions

## Step 3 — Create the project structure
1. Use `write_file` to create each source file with its full content.
2. Use `list_directory` to verify the structure as you build.
3. Create configuration files (package.json, requirements.txt, Makefile, etc.) as needed.

## Step 4 — Install dependencies and build
If the project needs dependencies installed or a build step:
- The workspace runs inside a Linux Docker sandbox.
- Use `write_file` to create a shell script if needed, then the sandbox tools to run it.
- For Python: create requirements.txt and use pip install.
- For Node.js: create package.json and use npm install.
- For C/C++: use gcc/g++/make.

## Step 5 — Test
1. Write a test script or test file.
2. Run it and check the output.
3. Fix any errors by reading the error output and editing the relevant files.

## Best Practices
- Create files ONE AT A TIME with complete, working content. Do not create stub files and plan to fill them later.
- Always write clean, well-structured code following the conventions of the chosen language/framework.
- Include comments and documentation where appropriate.
- If the user asks for a specific design or UI, match it exactly.
- After scaffolding, use `list_directory` to show the user the final structure and explain how to run the project.
