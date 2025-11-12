type Differences = {
  [key: string]: unknown | Differences;
};

// Utility functions (replacing lodash)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function forEach(obj: any, callback: (value: any, key: string) => void): void {
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      callback(obj[key], key);
    }
  }
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmpty(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).length === 0;
}

function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a as Record<string, unknown>);
    const keysB = Object.keys(b as Record<string, unknown>);
    if (keysA.length !== keysB.length) return false;

    for (const key of keysA) {
      if (!keysB.includes(key)) return false;
      if (!isEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
        return false;
      }
    }
    return true;
  }

  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getDifferences(subset: any, superset: any): Differences {
  const differences: Differences = {};

  forEach(subset, (value, key) => {
    const supersetValue = (superset as Record<string, unknown>)[key];

    if (isObject(value) && !isArray(value)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nestedDifferences = getDifferences(value as any, supersetValue as any);
      if (!isEmpty(nestedDifferences)) {
        differences[key] = nestedDifferences;
      }
    } else if (isArray(value) && isArray(supersetValue)) {
      if (!isEqual(value.sort(), supersetValue.sort())) {
        differences[key] = { expected: value, actual: supersetValue };
      }
    } else if (!isEqual(value, supersetValue)) {
      differences[key] = { expected: value, actual: supersetValue };
    }
  });

  return differences;
}
