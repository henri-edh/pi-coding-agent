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
