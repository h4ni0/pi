# Workflow extension deployment

1. Deploy every source-controlled file in this directory except generated `node_modules/` content.
2. Install the pinned runtime dependency before Pi loads the extension:

   ```bash
   npm ci --omit=dev --prefix ~/.pi/agent/extensions/workflow
   ```

3. Carry the operator-owned workflow contract files separately from this repository when they are part of the release:
   - `~/.pi/SPECS.md`
   - `~/.pi/workflows/pipeline.yaml`

4. Run the release gate from `~/.pi/agent`:

   ```bash
   extensions/workflow/tests/run-typecheck.sh
   extensions/workflow/tests/run-tests.sh
   bun build extensions/workflow/index.ts --target=node --packages=external
   npm ls --prefix extensions/workflow --omit=dev
   ```

Do not commit or deploy a copied `node_modules/` tree; reproduce it from `package-lock.json` with `npm ci`.
