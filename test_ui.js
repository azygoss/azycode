import { enhancedWelcomeScreen } from './src/ui.js';
const lines = enhancedWelcomeScreen({ connected: true, model: 'gpt-4o', mode: 'architect', reasoning: 'high' });
console.log(lines.join('\n'));
