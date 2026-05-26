const stripExamples = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stripExamples);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.toLowerCase().includes("example"))
        .map(([key, nested]) => [key, stripExamples(nested)]),
    );
  }

  return value;
};

export default (schema: unknown) => stripExamples(schema);
