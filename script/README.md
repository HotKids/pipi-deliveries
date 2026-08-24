# Scripting source

`project/` is the reviewable source of the Scripting edition. The release workflow runs its behavior tests, packages it, and verifies the generated `.scripting` archive before publishing.

Run the same checks locally with:

```sh
sh script/project/tools/test.sh
sh script/project/tools/package.sh /tmp/pipi-deliveries.scripting
sh script/project/tools/verify-package.sh /tmp/pipi-deliveries.scripting
```

`pipi-deliveries.scripting` is a generated convenience artifact. CI verifies that its file list and contents match `project/` so changes cannot be hidden in the archive.

The repository does not include substitute declarations for Scripting's native module. Exact TypeScript host API checking must use the `.d.ts` files synchronized by `scripting-cli` from the installed Scripting App; the current repository check covers executable behavior tests and package integrity without pretending that broad local stubs are authoritative host typings.
