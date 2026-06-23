# Workflow Extension Examples

Workflows are YAML files placed in `~/.pi/workflows/` or `.pi/workflows/`. The workflow id is the filename without `.yml`/`.yaml`.

See [`EXAMPLE.yml`](./EXAMPLE.yml) for a complete workflow.

## Sequential phases

`next` is optional. If a phase omits `next`, the runner advances to the next phase in YAML order.

```yaml
phases:
  - id: plan
    prompt: |
      Plan {{input}}

  - id: execute
    prompt: |
      Execute this plan:
      {{phase.plan.output}}
```

## Output contracts

Configure output in YAML with the phase-level `output` field, next to `next`. Do not repeat the output contract in the prompt; the runner injects it into the phase system prompt.

For normal text output:

```yaml
- id: plan
  output:
    type: text
    description: "Markdown implementation plan."
  prompt: |
    Plan {{input}}
```

For structured output, the runner also configures the `workflow_phase_result` tool:

```yaml
- id: verify
  output:
    type: structured
    status:
      enum: [PASS, FAIL]
      description: "PASS when checks pass; FAIL when remediation is needed."
    report: "Complete Markdown verification report."
    data:
      description: "Optional verification metrics."
      fields:
        failedChecks:
          type: integer
          description: "Number of failed checks."
  prompt: |
    Verify the implementation.
```

For backwards compatibility, `output: structured` is still accepted, but the object form is preferred because it documents and validates the output contract.

Structured output exposes:

- `{{phase.verify.output}}` or `{{phase.verify.report}}` — the `report` text
- `{{phase.verify.status}}` — the structured status
- `{{phase.verify.data}}` — JSON for the data object
- `{{phase.verify.data.someKey}}` — one nested data value
- `{{phase.verify.json}}` — full structured result as JSON

Add `?` to make a template reference optional, useful for loops:

```yaml
Previous verification feedback:
{{phase.verify.output?}}
```

## Conditional `next`

`next` rules are evaluated in order. The first matching rule wins.

```yaml
- id: verify
  output:
    type: structured
    status:
      enum: [PASS, FAIL]
    report: "Complete Markdown verification report."
  next:
    - if:
        status: FAIL
      goto: execute
    - if:
        status: PASS
      goto: review
    - end: true
```

If no `next` rule matches, the runner falls back to the next phase in YAML order. Add a final catch-all `- end: true` when you want unmatched results to stop instead.

## End the workflow conditionally

Use `end: true` to stop without running later phases.

```yaml
- id: review
  output:
    type: structured
    status:
      enum: [HAS_COMMENTS, APPROVED]
    report: "Complete Markdown review report."
    data:
      fields:
        hasComments:
          type: boolean
          description: "Whether there are actionable review comments."
  next:
    - if:
        field: data.hasComments
        equals: true
      goto: address-review
    - end: true
```

## Condition forms

Conditions can match structured status:

```yaml
if:
  status: PASS
```

or multiple statuses:

```yaml
if:
  status: [APPROVED, NO_CHANGES]
```

They can match a structured field:

```yaml
if:
  field: data.hasComments
  equals: true
```

Supported field operators:

- `equals`
- `not_equals` or `notEquals`
- `contains`
- `matches` — string regex or `{ pattern, flags }`
- `exists` — boolean

They can also match report text:

```yaml
if:
  output_contains: "CHANGES_REQUESTED"
```

```yaml
if:
  output_matches:
    pattern: "^## Verdict\\s+APPROVED"
    flags: "mi"
```

## Loop guard

Use `maxTransitions` to prevent infinite loops:

```yaml
description: "Pipeline"
maxTransitions: 12
phases:
  # ...
```

Default: `50`.

Supported `data.fields.*.type` values: `string`, `number`, `integer`, `boolean`, `array`, `object`, `any`.

## Field reference

Top-level workflow fields:

```yaml
description: "Human readable description"
maxTransitions: 50
phases: []
```

Phase fields:

```yaml
- id: verify
  system: "Optional system instructions"
  prompt: "Required prompt"
  model: "provider/model"
  tools: [read, bash]
  thinking: medium
  output:
    type: structured # or text; omitted means normal text output
    status:
      enum: [PASS, FAIL]
    report: "Report description"
  next: []
```
