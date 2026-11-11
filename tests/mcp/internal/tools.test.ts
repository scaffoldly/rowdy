import { describe, expect, it } from '@jest/globals';
import type { z } from 'zod';
import { tools } from '../../../src/mcp';

const shape = (schema: unknown): Record<string, z.ZodType> => (schema as z.ZodObject).shape;
const hosted = { limits: { runtimes: ['aws.microvm' as const], timeout: 3_600_000 } };

describe('tools', () => {
  it('names both runtimes, with their own ranges, without limits', () => {
    const create = tools().create_sandbox!;
    const input = shape(create.inputSchema);

    expect(input.runtime?.description).toBe('Where it runs. Defaults to aws.microvm.');
    expect(input.timeout?.description).toBe(
      'Milliseconds before it stops, in whole seconds: 1000 to 28800000 on aws.microvm, 1000 to 900000 on aws.lambda.'
    );
    expect(input.memory?.description).toBe(
      'Megabytes: 512, 1024, 2048, 4096 or 8192 on aws.microvm; 128 to 10240 on aws.lambda.'
    );
    expect(create.description).toContain('It lasts 15 minutes unless its timeout says otherwise, at most 8 hours.');
  });

  it('says what the default image has', () => {
    expect(shape(tools().create_sandbox!.inputSchema).image?.description).toContain(
      'Defaults to scaffoldly/sandbox: Debian with Python, Node'
    );
  });

  it('says them for one runtime, within the caps, with no runtime to pick', () => {
    const narrowed = tools(hosted);
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
    const create = shape(tools({ limits: { runtimes: ['aws.microvm'], memory: 2048 } }).create_sandbox!.inputSchema);

    expect(create.memory?.description).toBe('Megabytes: 512, 1024 or 2048.');
  });

  it('leaves out what only aws.microvm has, on aws.lambda alone', () => {
    const narrowed = tools({ limits: { runtimes: ['aws.lambda'] } });

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
    expect(tools(hosted).create_sandbox!.run).toBe(tools().create_sandbox!.run);
  });
});
