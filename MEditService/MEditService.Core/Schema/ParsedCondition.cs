using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

// The per-game strategy seam (ADR-0032): resolves a record's conditions into neutral form. The
// input is the game-agnostic IMajorRecordGetter; each implementation reaches into its own game's
// Mutagen condition types. Only Fallout4ConditionCodec exists today; other games fail loudly
// (no codec) rather than silently mis-parse.
public interface IConditionCodec
{
    // One entry per condition-bearing field on the record (empty if none). FieldPath is the owning
    // field, e.g. "Conditions".
    IEnumerable<ConditionOwner> Extract(IMajorRecordGetter record);
}

public sealed record ConditionOwner(string FieldPath, IReadOnlyList<ParsedCondition> Conditions);

// The game-neutral condition model. Anchored on xEdit's cross-game `wbConditionToStr` — the fields
// every Bethesda game renders a condition from — not on any one game's Mutagen types. Per-game
// IConditionCodec implementations map their divergent Mutagen shapes onto this. [ADR-0032]

public enum ConditionOperator
{
    EqualTo,
    NotEqualTo,
    GreaterThan,
    GreaterThanOrEqualTo,
    LessThan,
    LessThanOrEqualTo,
}

// How to render a parameter's value. Mirrors Mutagen's Condition.ParameterCategory: a Form is a
// FormKey link, a Number a plain integer, a String a literal. None params are omitted from the
// parsed model entirely (a function that doesn't use a slot yields no param for it).
public enum ConditionParamCategory
{
    Number,
    Form,
    Text,
}

// One used parameter of a condition function. TypeName is the resolved ParameterType name (e.g.
// "ActorValue", "Global") — a display cue now and the hook for future enum-value decoding
// (ActorValue 24 -> "Health"), which stays out of the neutral model deliberately (ADR-0032).
public sealed record ParsedConditionParam(
    ConditionParamCategory Category,
    string TypeName,
    int? Number = null,
    string? FormKey = null,
    string? Text = null);

// A single parsed condition in neutral form. Renders as
// `RunOnTarget.Function(Parameters) <Operator> Comparison [AND|OR]`.
public sealed record ParsedCondition(
    string Function,                                   // decoded function name, game-agnostic
    ConditionOperator Operator,
    bool Or,                                            // true = OR, false = AND
    string RunOnTarget,                                 // "Subject" | "Target" | "Reference" | ...
    string? RunOnReference,                             // FormKey, set only when RunOnTarget == Reference
    bool UseGlobal,
    float? ComparisonFloat,                             // set when !UseGlobal
    string? ComparisonGlobal,                           // GLOB FormKey, set when UseGlobal
    IReadOnlyList<ParsedConditionParam> Parameters);
