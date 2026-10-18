// In the repo the planner's state machine lives in ui/plan.js (the server and the UI use it too).
// scripts/install.mjs copies ui/plan.js itself to ~/.pi/agent/extensions/omni-plan-lib.mjs, not this file.
export * from "../../ui/plan.js";
