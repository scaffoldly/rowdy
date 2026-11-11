import { describe, expect, it } from '@jest/globals';
import type { z } from 'zod';
import { instructions, tools, toolsFor } from '../../../src/mcp';

const shape = (schema: unknown): Record<string, z.ZodType> => (schema as z.ZodObject).shape;
const hosted = { limits: { runtimes: ['aws.microvm' as const], timeout: 3_600_000 }, shared: true };

describe('toolsFor', () => {
  it('is the tools as they are with no host to say them for', () => {
    expect(Object.keys(toolsFor())).toEqual(Object.keys(tools));
    expect(toolsFor().create_sandbox?.description).toBe(tools.create_sandbox.description);
  });

  it('names both runtimes, with their own ranges, by default', () => {
    const create = shape(tools.create_sandbox.inputSchema);

    expect(create.runtime?.description).toBe('Where it runs. Defaults to aws.microvm.');
    expect(create.timeout?.description).toBe(
      'Milliseconds before it stops, in whole seconds: 1000 to 28800000 on aws.microvm, 1000 to 900000 on aws.lambda.'
    );
    expect(create.memory?.description).toBe(
      'Megabytes: 512, 1024, 2048, 4096 or 8192 on aws.microvm; 128 to 10240 on aws.lambda.'
    );
    expect(tools.create_sandbox.description).toContain(
      'It lasts 15 minutes unless its timeout says otherwise, at most 8 hours.'
    );
  });

  it('says them for one runtime, within the caps, with no runtime to pick', () => {
    const narrowed = toolsFor(hosted);
    const create = shape(narrowed.create_sandbox!.inputSchema);

    expect(create.runtime).toBeUndefined();
    expect(shape(narrowed.list_sandboxes!.inputSchema).runtime).toBeUndefined();
    expect(create.timeout?.description).toBe('Milliseconds before it stops, in whole seconds: 1000 to 3600000.');
    expect(create.env?.description).toBe('Environment variables for every command. At most 50.');
    expect(narrowed.create_sandbox!.description).toContain('at most an hour.');
    expect(narrowed.stop_sandbox!.description).not.toContain('aws.lambda');
    expect(narrowed.run_command!.description).not.toContain('aws.microvm');
    expect(shape(narrowed.run_command!.inputSchema).timeout_ms?.description).not.toContain('aws.microvm');
  });

  it('leaves the memory a host caps out', () => {
    const create = shape(toolsFor({ limits: { runtimes: ['aws.microvm'], memory: 2048 } }).create_sandbox!.inputSchema);

    expect(create.memory?.description).toBe('Megabytes: 512, 1024 or 2048.');
  });

  it("says a caller's sandboxes are theirs on a shared host", () => {
    const narrowed = toolsFor(hosted);

    expect(narrowed.list_sandboxes!.description).toMatch(/^Lists your sandboxes/);
    expect(narrowed.get_sandbox!.description).toMatch(/^Finds one of your sandboxes/);
    expect(tools.list_sandboxes.description).toMatch(/^Lists sandboxes/);
  });

  it('leaves out what only aws.microvm has, on aws.lambda alone', () => {
    const narrowed = toolsFor({ limits: { runtimes: ['aws.lambda'] } });

    expect(Object.keys(narrowed)).toEqual([
      'create_sandbox',
      'get_sandbox',
      'list_sandboxes',
      'delete_sandbox',
      'run_command',
      'read_output',
    ]);
    expect(shape(narrowed.run_command!.inputSchema).timeout_ms).toBeUndefined();
    expect(narrowed.run_command!.description).not.toContain('timeout_ms');
    expect(shape(narrowed.create_sandbox!.inputSchema).env?.description).toBe(
      'Environment variables for every command.'
    );
  });

  it('still checks what a host allows, whatever the text', () => {
    const narrowed = toolsFor(hosted);

    expect(narrowed.create_sandbox!.run).toBe(tools.create_sandbox.run);
  });
});

describe('instructions', () => {
  it('names no tool, so tools can change without it', () => {
    [{}, hosted, { limits: { runtimes: ['aws.lambda' as const] } }].forEach((options) =>
      Object.keys(tools).forEach((name) => expect(instructions(options)).not.toContain(name))
    );
  });

  it("says it's the person's own account, and what it costs them, unless the host is shared", () => {
    expect(instructions()).toContain("in the person's own AWS account");
    expect(instructions()).toContain("A running sandbox costs money until it's stopped");
    expect(instructions(hosted)).not.toContain("person's own");
    expect(instructions(hosted)).not.toContain('costs money');
    expect(instructions(hosted)).toContain("Stop a sandbox when you're done with it.");
    expect(instructions(hosted)).toContain('Only your own sandboxes can be seen or used.');
  });

  it('says what the default image has, on create_sandbox', () => {
    expect(shape(tools.create_sandbox.inputSchema).image?.description).toContain(
      'Defaults to scaffoldly/sandbox: Debian with Python, Node'
    );
  });

  it("says how long a sandbox lasts, within the host's cap", () => {
    expect(instructions()).toContain('A sandbox lasts 15 minutes unless its timeout says otherwise, at most 8 hours.');
    expect(instructions(hosted)).toContain('at most an hour.');
  });
});
