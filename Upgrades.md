 Investigating Skill Format

 I'm currently focused on researching the Skill format through skill-expert. I need to ensure the tilldone-templates Skill package adheres precisely to the correct structure
 and frontmatter requirements, building on my initial understanding. I'll meticulously cross-reference that information to be confident in my implementation.

 Defining Skill Structure

 I am now structuring the skill. I've pinpointed the skill directory as .pi/skills/tilldone-templates/ and will create SKILL.md with frontmatter for name, description, and
 trigger. A templates/ subdirectory is planned for JSON templates. Specifically, I'm creating react-component.json, bug-fix.json, and feature-implementation.json. The next step
 is crafting SKILL.md to instruct the agent to utilize these templates with tilldone.


 query_experts 2 parallel — Skill Expert, Agent Expert
 ✓ Skill Expert 14s · ✓ Agent Expert 17s

 ── Skill Expert ──
 The standard structure for a Pi skill package follows the [Agent Skills standard](https://agentskills.io). It is designed to be self-contained and easily discoverable by the
 agent.

 ### 1. Standard Directory Structure
 A skill is a directory containing a `SKILL.md` file. Supporting files (like JSON templates, scripts, or assets) are placed in subdirectories relative to the skill root.

 ```text
 my-skill/
 ├── SKILL.md              # Required: frontmatter + instructions
 ├── scripts/              # Helper scripts (bash, node, etc.)
 │   └── setup.sh
 ├── templates/            # JSON templates, boilerplates
 │   └── config.json
 └── docs/                 # Detailed reference documentation
     └── API.md
 ```

 ### 2. `SKILL.md` Format
 The `SKILL.md` file must start with a YAML frontmatter. The **description** is the most critical part, as it's what the agent uses to decide when to load the skill.

 ```markdown
 ---
 name: my-skill
 description: Comprehensive description of when the agent should use this skill. Be specific about the tasks it handles (e.g., "Use this skill to scaffold new React projects
 with Tailwind CSS").
 ---

 # My Skill Name

 ## Setup
 Instructions for the agent to prepare the environment.
 ```bash
 # Example: Use relative paths to run setup scripts
 ./scripts/setup.sh
 ```

 ## Usage
 Explain how the agent should use the templates or scripts.
 The agent can read supporting files using their relative paths:
 - Read template: `templates/config.json`
 - Follow guide: `docs/API.md`
 ```

 ### 3. Frontmatter Requirements
 | Field | Required | Rules |
 |-------|----------|-------|
 | `name` | Yes | 1-64 chars, lowercase `a-z`, `0-9`, and `-`. **Must match the directory name.** |
 | `description` | Yes | Max 1024 chars. This is what the agent "sees" in its system prompt before loading the full skill. |
 | `allowed-tools`| No | Space-delimited list of tools the skill is permitted to use. |

 ### 4. How the Agent Finds Supporting Files
 1. **Discovery:** The agent sees the skill's `name` and `description` in its system prompt.
 2. **Loading:** When the agent determines the skill is relevant, it uses the `read` tool to load the full `SKILL.md`.
 3. **Execution:** Once loaded, the agent follows the instructions in the markdown. It treats the skill's directory as the base path. To read a JSON template, the agent will
 call `read(path: "path/to/skill/templates/config.json")`.

 ### 5. Skill Locations
 Pi looks for skills in these locations:
 - **Project-specific:** `.pi/skills/` or `.agents/skills/` in your current directory.
 - **Global:** `~/.pi/agent/skills/` or `~/.agents/skills/`.
 - **Installed:** Within `node_modules` if they are part of a Pi-compatible package.

 ### Example for your JSON templates:
 If you have a skill called `api-gen` and a template at `api-gen/templates/schema.json`, your `SKILL.md` should say:
 > "To generate the API, read the base schema from `templates/schema.json` and use it as a reference for the new implementation."

 ── Agent Expert ──
 To best instruct a Pi agent to use a specific tool with data from a file inside your skill's directory, follow these patterns in your `SKILL.md`.

 ### 1. Use Relative Paths
 Always reference your data files using paths relative to the `SKILL.md` file. The Pi agent is specifically instructed to resolve these relative paths against the skill's
 directory to form absolute paths for tool commands.

 ### 2. Explicit Read-and-Use Workflow
 Don't just mention the file; explicitly instruct the agent to **read** the file first and then **apply** its contents to the tool.

 ### 3. Provide a Template-to-Tool Mapping
 Show the agent exactly how the data in your file maps to the tool's parameters.

 ---

 ### Example: A "Task Automator" Skill

 Suppose your skill directory looks like this:
 ```text
 my-task-skill/
 ├── SKILL.md
 └── templates/
     └── web-setup.json
 ```

 **Contents of `templates/web-setup.json`:**
 ```json
 {
   "listName": "Website Launch",
   "steps": ["Setup repo", "Install deps", "Deploy to Vercel"]
 }
 ```

 **Best Practice `SKILL.md` Instructions:**

 ```markdown
 ---
 name: my-task-skill
 description: Automates project setup tasks using predefined templates.
 ---

 # Project Setup Skill

 This skill uses JSON templates to quickly populate your task list.

 ## Usage Instructions

 To set up a new project, follow these steps:

 1. **Read the Template**: Use the `read` tool to load the data from `templates/web-setup.json`.
 2. **Apply to TillDone**: Once you have the data, use the `tilldone` extension to create the list and tasks.

 ### Mapping Data to Tools

 When you read a template from the `templates/` directory, map the JSON fields as follows:
 - `listName` → use with `action: "new-list"`
 - `steps` → use as the `texts` array with `action: "add"`

 ### Example Workflow for the Agent:
 - `read({ path: "templates/web-setup.json" })` (resolved to the full skill path)
 - `bash({ command: "pi -e extensions/tilldone.ts" })`
 - `tilldone({ action: "new-list", text: "Website Launch" })`
 - `tilldone({ action: "add", texts: ["Setup repo", "Install deps", "Deploy to Vercel"] })`
 ```

 ### Why this works:
 - **Path Resolution**: Because you used `templates/web-setup.json`, the agent knows to look inside the skill's own folder, not the project's root.
 - **Tool Chaining**: By telling the agent to "Read... then Apply", you ensure it has the context (the file content) in its memory before it attempts to call the specialized
 tool.
 - **Clarity**: Using a "Mapping" section removes ambiguity about how the agent should interpret the data file's structure.


 Agent Expert done in 17s


 $ mkdir -p .pi/skills/tilldone-templates/templates

 (no output)



 write .pi/skills/tilldone-templates/templates/react-component.json

 {
    "title": "React Component Implementation",
    "description": "A standardized workflow for building and testing a new React component.",
    "tasks": [
       "Define component interface (Props)",
       "Scaffold component file with basic structure",
       "Implement styling (CSS/Tailwind/Styled)",
       "Implement component logic and state",
       "Write unit tests (Vitest/Jest)",
       "Verify rendering in host application",
       "Documentation/PropTypes/ReadMe"
    ]
 }




 write .pi/skills/tilldone-templates/templates/bug-fix.json

 {
    "title": "Bug Fix Workflow",
    "description": "A methodical approach to identifying, fixing, and verifying bugs.",
    "tasks": [
       "Reproduce the bug with a failing test case",
       "Trace the root cause in the source code",
       "Implement the fix",
       "Verify the fix with the reproduction test",
       "Run full regression suite",
       "Clean up debug logs/comments",
       "Document the fix in PR/Changelog"
    ]
 }




 write .pi/skills/tilldone-templates/templates/node-api.json

 {
    "title": "Node.js Endpoint Setup",
    "description": "Steps to implement a new REST/GraphQL endpoint.",
    "tasks": [
       "Define API schema (Zod/TypeBox)",
       "Register route in Express/Fastify",
       "Implement controller logic",
       "Implement database service layer",
       "Add validation middleware",
       "Add error handling cases",
       "Test endpoint with curl/Postman/Insomnia",
       "Write integration tests"
    ]
 }




 write .pi/skills/tilldone-templates/SKILL.md

 ---
 name: tilldone-templates
 description: Use this skill to load standardized task blueprints for common workflows (React components, Bug fixes, API endpoints) into the TillDone extension.
 ---

 # TillDone Templates

 Standardize your development workflow by loading predefined blueprints into your task list. This skill provides the structure for common development scenarios.

 ## Available Templates

 - `templates/react-component.json`: For building UI components.
 - `templates/bug-fix.json`: For methodical bug hunting and fixing.
 - `templates/node-api.json`: For implementing backend endpoints.

 ## Instructions for the Agent

 When the user asks for a standard workflow or starts a task that matches one of the templates above:

 1.  **Read the Template**: Use the `read` tool to load the JSON content from the appropriate file in the `templates/` directory of this skill.
 2.  **Initialize TillDone**:
     -   Call `tilldone` with `action: "new-list"`.
     -   Use the `title` field from the JSON as the `text` parameter.
     -   Use the `description` field from the JSON as the `description` parameter.
 3.  **Add Tasks**:
     -   Call `tilldone` with `action: "add"`.
     -   Pass the `tasks` array from the JSON to the `texts` parameter.
 4.  **Start Work**: Toggle the first task to `inprogress` using `tilldone toggle id: 1` before performing any other actions.

 ## Example Request
 User: "I need to fix a bug in the auth flow."
 Agent:
 - `read({ path: ".pi/skills/tilldone-templates/templates/bug-fix.json" })`
 - `tilldone({ action: "new-list", text: "Bug Fix Workflow", description: "..." })`
 - `tilldone({ action: "add", texts: [...] })`
 - `tilldone({ action: "toggle", id: 1 })`



 The TillDone Blueprints skill has been successfully deployed!

 I have created the skill at .pi/skills/tilldone-templates/ with three starter blueprints:

 1. React Component: Standard steps for building, styling, and testing UI components.
 2. Bug Fix: A methodical approach to reproduction, root-cause analysis, and verification.
 3. Node.js API: A checklist for implementing endpoints, including schema definition and integration testing.

 ### 🚀 How to use it

 You don't need to do anything special! Simply give me a prompt like:
 - "I need to fix a bug in the login page."
 - "Let's build a new React button component."
 - "I want to add a POST /users endpoint."

 Because of the description in the SKILL.md, I will recognize the request, load the corresponding template, and automatically populate your TillDone list with the standardized
 steps.

 ### 📂 Structure

 - .pi/skills/tilldone-templates/SKILL.md: The "brain" of the skill with instructions and metadata.
 - .pi/skills/tilldone-templates/templates/: A folder containing the JSON blueprints. You can add more .json files here to create your own custom workflows!

 The team is standing by if you'd like to add more specialized templates or tweak the existing ones.