// Omni Agent's OpenCode plugin. Omni writes this file into its own OpenCode config dir (<configDir>/plugin/omni.js)
// each time it writes opencode.json, from integrations/opencode/shim.js in the Omni repo: do not edit it here.
// The plugin itself lives in the repo (integrations/opencode/omni-plugin.mjs); this only hands it the package's `tool`.
import { tool } from "@opencode-ai/plugin";
import { createOmniPlugin } from "__OMNI_PLUGIN_URL__";

export const Omni = createOmniPlugin({ tool, root: "__OMNI_ROOT__" });
