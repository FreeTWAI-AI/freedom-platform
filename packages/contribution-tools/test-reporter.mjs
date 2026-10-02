// Read runner events, not TAP text that a test could print to stdout. A process
// exiting successfully without registering tests is not an executed test suite.
export default async function* report(source) {
  const files = [];
  for await (const event of source) {
    if (event.type !== 'test:summary') continue;
    const { file, counts, success } = event.data;
    if (file) files.push({ file, counts, success });
    else yield JSON.stringify({ counts, success, files }) + '\n';
  }
}
