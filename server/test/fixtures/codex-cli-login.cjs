const fs = require('node:fs');
const plan = JSON.parse(fs.readFileSync('test-plan.json', 'utf8'));
fs.writeFileSync('login-ready', String(process.pid));
function ready() {
  if (plan.holdLogin && !fs.existsSync('allow-login')) { setTimeout(ready, 10); return; }
  console.log(plan.noSubscription ? 'Logged in using an API key' : 'Logged in using ChatGPT');
}
ready();
