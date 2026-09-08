export async function resolve(specifier, context, nextResolve) {
  if (specifier === "scripting") {
    return {
      shortCircuit: true,
      url: new URL("../tests/scripting-module-stub.mjs", import.meta.url).href,
    };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      error?.code !== "ERR_MODULE_NOT_FOUND" ||
      !specifier.startsWith(".") ||
      /\.[cm]?[jt]sx?$/.test(specifier)
    ) {
      throw error;
    }
    return nextResolve(`${specifier}.ts`, context);
  }
}
