export function defaultValueFromSchema(schema) {
  return schema && Object.hasOwn(schema, "default") ? schema.default : undefined;
}

export function includeBooleanArgument(schema, checked, required = false) {
  return checked || required || defaultValueFromSchema(schema) !== undefined;
}

export function showToolParameter(tool, parameterName) {
  const hiddenInputs = tool?._meta?.["microsmcp/ui"]?.hiddenInputs;
  return !Array.isArray(hiddenInputs) || !hiddenInputs.includes(parameterName);
}
