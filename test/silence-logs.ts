// Suppress logger output during tests. The logger calls console.log/warn/error
// directly, so we replace them with no-ops for the duration of the test run.
const noop = () => {};
console.log = noop;
console.warn = noop;
console.error = noop;
