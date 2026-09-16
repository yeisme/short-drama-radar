## ADDED Requirements

### Requirement: Auditable experiment cancellation

Radar SHALL append a policy-guarded, idempotent cancellation receipt for an experiment without results. Cancellation SHALL neither count as an observation nor erase a manual failure streak. Results and cancellation SHALL be mutually exclusive.

#### Scenario: Cancel a pending experiment
- **WHEN** an operator supplies an experiment, a new key and a reason after its lock
- **THEN** Radar records cancellation without changing the frozen experiment, allows a later lock, and rejects results for the cancelled experiment

### Requirement: Frozen sample identity

Radar SHALL hash explicitly selected bounded local regular files and append versioned sample references. A material-bound experiment SHALL freeze two episodes for each arm, with compatible language, format and per-episode duration. Results SHALL cite its exact material digest. Legacy experiments SHALL retain their input and interpretation.

#### Scenario: Prevent accidental material substitution
- **WHEN** a result cites a different material digest or omits it for a bound experiment
- **THEN** Radar rejects the result without appending a revision

### Requirement: Conditions distinct from operational notes

For material-bound experiments Radar SHALL exclude budget and recruitment notes from protocol comparison identity while including substantive experimental conditions. Original experiment digests SHALL remain unchanged.

#### Scenario: Revise a budget note
- **WHEN** two new material-bound rounds share conditions but differ only in budget or recruitment notes
- **THEN** their protocol comparison digest is equal and their immutable experiment digest records the note difference

### Requirement: Preparation and local delivery projection

Radar SHALL expose candidate evidence gaps, unknown attractiveness, review-required credibility and cost notes separately. It SHALL export a deterministic material-bound work package only to a new local file, label it prepared but not accepted, and reject cancelled experiments.

#### Scenario: Missing evidence remains unknown
- **WHEN** a candidate lacks demand or counterevidence references
- **THEN** preparation reports those gaps without claiming the market has no opportunity

#### Scenario: Existing output is preserved
- **WHEN** an export target already exists
- **THEN** Radar fails without overwriting that file or executing external actions
