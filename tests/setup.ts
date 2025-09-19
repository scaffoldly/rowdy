export function testId(): string {
  return expect
    .getState()
    .currentTestName!.replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/--+/g, '-');
}

export default async function setup(): Promise<void> {}
