const fs = require('node:fs');
const plan = JSON.parse(fs.readFileSync('test-plan.json', 'utf8'));
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const calls = fs.existsSync('calls.jsonl') ? fs.readFileSync('calls.jsonl', 'utf8').trim().split('\n').filter(Boolean) : [];
  const turn = (plan.turns || [])[calls.length] || { answer: 'Fixture response' };
  const effort = process.argv.find(value => value.startsWith('model_reasoning_effort='));
  fs.appendFileSync('calls.jsonl', JSON.stringify({ pid: process.pid, effort, input: JSON.parse(input) }) + '\n');
  function finish() {
    if (turn.hold && !fs.existsSync('allow-turn')) { setTimeout(finish, 10); return; }
    if (turn.failure) { console.error(turn.failure); process.exitCode = 1; return; }
    const text = turn.raw || JSON.stringify({ answer: turn.answer || 'Fixture response', review: {
      status: turn.review || 'adequate', reason: turn.reason || (turn.review === 'needs_more_reasoning' ? 'ambiguity' : turn.review === 'missing_evidence' ? 'missing_evidence' : 'none'),
    } });
    console.log(JSON.stringify({ type: 'thread.started' }));
    console.log(JSON.stringify({ type: 'item.completed', item: { type: turn.tool ? 'command_execution' : 'agent_message', text } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: turn.usage || { input_tokens: 100, output_tokens: 50 } }));
  }
  finish();
});
