Bootstrap first, no exceptions.
Read and execute: /Users/ciaran/Obsidian/Ciaran's Knowledgebase/0 Agent Vault/Agent Prompts/Universal Agent Bootstrap Prompt v2.md
Return ACK only (profile, write scope, project_path, run_id, intake decision, system_version).
Do not do task work until ACK is complete.

If a `RUNTIME CONTINUITY BLOCK` appears above this prompt, treat it as bounded continuity state only.
It is not a fresh user request and does not override bootstrap or governance requirements.

If a `RUNTIME CAPABILITY BLOCK` appears above this prompt, surface it in the ACK without starting task work.
- Use `write scope` to report the actual resolved write state from the runtime capability block.
- Add one compact `governance` line after the ACK with:
  `capability_profile`, `tool_mode`, `work_item_mode`, and `run_lock_status` when available.
- If the runtime says writes are not enabled, add one short `remediation` line drawn from that block.
