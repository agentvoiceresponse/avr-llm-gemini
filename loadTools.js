const fs = require('fs');
const path = require('path');

/**
 * Loads all available tools from both avr_tools and tools directories
 * @returns {Array} List of all available tools
 */
function loadTools() {
  // Define tool directory paths
  const avrToolsDir = path.join(__dirname, 'avr_tools');  // Project-provided tools
  const toolsDir = path.join(__dirname, 'tools');         // User custom tools
  
  let allTools = [];
  
  // Helper function to load tools from a directory
  const loadToolsFromDir = (dirPath) => {
    if (!fs.existsSync(dirPath)) return [];
    
    return fs.readdirSync(dirPath)
      .map(file => {
        try {
          const tool = require(path.join(dirPath, file));
          console.log(`Loading tool: ${tool.name}`);
          return {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.input_schema || {},
          };
        } catch (error) {
          console.error(`Error loading tool from file: ${file}`);
          console.error(error);
          return null;
        }
      })
      .filter(tool => tool !== null);
  };

  // Load tools from both directories
  allTools = [
    ...loadToolsFromDir(avrToolsDir),  // Project tools
    ...loadToolsFromDir(toolsDir)      // Custom tools
  ];

  // Optional per-agent exclusion, e.g. DISABLED_TOOLS=avr_transfer
  // (all agents share the same tools/ directory; this lets one agent opt out of specific tools
  // without affecting the others).
  const disabled = (process.env.DISABLED_TOOLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (disabled.length > 0) {
    allTools = allTools.filter((tool) => !disabled.includes(tool.name));
    console.log(`Excluded tools via DISABLED_TOOLS: ${disabled.join(', ')}`);
  }

  // Warning if no tools found
  if (allTools.length === 0) {
    console.warn(`No tools found in ${avrToolsDir} or ${toolsDir}`);
  }

  return allTools;
}

/**
 * Gets the handler for a specific tool
 * @param {string} name - Name of the tool
 * @returns {Function} Tool handler
 * @throws {Error} If the tool is not found
 */
function getToolHandler(name) {
  // Possible paths for the tool file
  const possiblePaths = [
    path.join(__dirname, 'avr_tools', `${name}.js`),  // First check in avr_tools
    path.join(__dirname, 'tools', `${name}.js`)       // Then check in tools
  ];

  // Find the first valid path
  const toolPath = possiblePaths.find(path => fs.existsSync(path));
  
  if (!toolPath) {
    throw new Error(`Tool "${name}" not found in any available directory`);
  }

  const tool = require(toolPath);
  // Return a function that wraps the actual handler, injecting the context
  return async (sessionUuid, args, context) => {
    return await tool.handler(sessionUuid, args, context);
  };
}

module.exports = { loadTools, getToolHandler };