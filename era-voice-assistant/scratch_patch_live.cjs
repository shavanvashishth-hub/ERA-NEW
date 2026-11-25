const fs = require('fs');
let s = fs.readFileSync('d:/era-voice-assistant/server/eraLiveSession.ts', 'utf8');

// Find exact index of end of phone call interception block
const target = '              }\r\n            }\r\n          }\r\n\r\n          // User turn audio transcription';
const idx = s.indexOf(target);
console.log('Target idx:', idx);
if (idx === -1) {
  // try without trailing part
  const idx2 = s.lastIndexOf('executeCompanionTool("makePhoneCall"');
  console.log('makePhoneCall idx:', idx2);
  console.log(JSON.stringify(s.substring(idx2, idx2 + 200)));
} else {
  const insertBefore = '          }\r\n\r\n          // User turn audio transcription';
  const insert = `\r\n\r\n            // \u2705 Pre-emptive Refusal Interception: App / Website / Software building\r\n            const isBuildRefusal = /(?:nahi.?bana.?sak|nahi.?bana.?pa.?rahi|koi.?dikkat|dikkat.?aa|cannot.?build|cannot.?create|can.t.?build)/i.test(modelTranscription);\r\n            const isBuildIntent = /(?:website|app|game|software|dashboard|portfolio|ecommerce|banao|bana.?do|create|build|develop|calculator|snake|tetris|quiz|todo|kanban)/i.test(currentTurnUserText || '');\r\n            if (isBuildRefusal && isBuildIntent) {\r\n              console.warn('\u26a0\ufe0f [ERA Live Engine] Build refusal intercepted. Triggering buildWebsiteApp fallback!');\r\n              const buildPrompt = (currentTurnUserText || 'Modern Web Application').trim();\r\n              executeCompanionTool('buildWebsiteApp', { prompt: buildPrompt }, clientWs).then((res) => {\r\n                sendJson(clientWs, { type: 'action_executed', action: { id: 'build_' + Date.now(), toolName: 'buildWebsiteApp', title: 'App Built!', detail: res && res.message || 'Application launched!', timestamp: Date.now() } });\r\n                sendJson(clientWs, { type: 'transcription', sender: 'model', text: 'Ji boss! Aapka application build ho gaya aur browser mein launch kar diya! ' + (res && res.message || '') });\r\n              }).catch(function() {});\r\n            }`;
  
  s = s.replace('          }\r\n\r\n          // User turn audio transcription', insert + '\r\n          }\r\n\r\n          // User turn audio transcription');
  
  if (s.includes('isBuildRefusal')) {
    fs.writeFileSync('d:/era-voice-assistant/server/eraLiveSession.ts', s, 'utf8');
    console.log('SUCCESS');
  } else {
    console.log('FAILED to insert');
  }
}
