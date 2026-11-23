/** `Owner.method`, for instance and static methods alike; `Owner.[description]` for a symbol. */
export const methodName = (self: unknown, context: Pick<ClassMethodDecoratorContext, 'name' | 'static'>): string => {
  const name = typeof context.name === 'symbol' ? `[${context.name.description ?? ''}]` : context.name;
  const owner = context.static
    ? (self as { name?: string } | undefined)?.name
    : (self as { constructor?: { name?: string } } | undefined)?.constructor?.name;
  // The decorator output aliases a class that references itself statically as `_Name`.
  const bare = owner?.replace(/^_+/, '');
  return bare ? `${bare}.${name}` : name;
};
