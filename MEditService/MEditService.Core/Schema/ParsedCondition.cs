using System.Text.Json;
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

    // Schema-level (instance-free) twin of Extract's per-property discovery (#154): does
    // recordType have a condition-owning field named fieldPath? Callers that only have a record's
    // CLR type (not yet a loaded instance) — PluginWriter's read-only/apply-dispatch checks,
    // EditOrchestrator's whole-list-restage supersession — use this instead of hardcoding a single
    // field name, so any of a record's condition-owning fields (not just "Conditions") is
    // recognized consistently everywhere.
    bool IsConditionListField(Type recordType, string fieldPath);

    // Validation-time shape check for a composed indexed path of arbitrary depth (#182/#184: e.g.
    // "Effects[2].Conditions" one level deep, or "Effects[2].Conditions[1].Conditions" two levels
    // deep — the numeric indices are write-time-only, per #169's AC — existence/range are enforced
    // at write, not here). Takes the raw composed field path rather than pre-parsed pieces: every
    // production caller (PluginWriter, EditOrchestrator) only ever wanted the yes/no answer, never
    // the parsed segments themselves, so parsing an arbitrary number of "<name>[<index>]." segments
    // is entirely this codec's job now — callers just gate on fieldPath.Contains('[') before
    // delegating here. A distinct method from IsConditionListField rather than an extension of it:
    // that method also gates the bare-fieldpath whole-list-restage path (#153/#154), and loosening
    // it for indexed paths would make a nested list's add/remove/reorder appear stageable before
    // #183 actually extends ApplyListValue to resolve one. Accepts when, walking the composed path's
    // array segments in order, each hop's element type declares the next segment's property (array
    // or, at the terminal segment, condition list) directly — or, when an element type is abstract
    // and declares nothing itself (Quest.Aliases's IAQuestAliasGetter is a marker interface with
    // zero data properties), when any concrete subtype does. A malformed composed path (unbalanced
    // bracket, non-numeric index, or one that doesn't resolve against recordType at all) returns
    // false, same fail-closed rule as before.
    bool IsNestedConditionListField(Type recordType, string composedFieldPath);

    // Write-back (#152): applies one scalar condition-field edit in place on the mutable record.
    // fieldPath is the owning field (e.g. "Conditions"), index the condition's position within it,
    // subField the edited part (see ConditionPath in Edits/ for the wire-path convention that
    // produces these three already-parsed pieces).
    ConditionApplyResult ApplyFieldValue(IMajorRecord record, string fieldPath, int index, string subField, JsonElement value);

    // Write-back (#153): replaces fieldPath's entire condition list with newList, a JSON array of
    // ParsedCondition-shaped objects — the whole-subtree rewrite an add/remove/reorder produces
    // (ADR-0019: array indices have no stable identity, so arity/order changes replace the whole
    // list rather than address one element).
    ConditionApplyResult ApplyListValue(IMajorRecord record, string fieldPath, JsonElement newList);

    // The function picker's catalog (#152): every function name this game's Mutagen package
    // resolves — not a hand-maintained ~479-entry list, so a game with a different Function enum
    // never silently offers a name it can't actually parse or write.
    IEnumerable<string> AvailableFunctions();

    // The Run On target list's catalog (#167): every RunOnType name this game's Mutagen package
    // resolves — the frontend previously hardcoded FO4's own member names a second time
    // (`ConditionCells.tsx`'s `RUN_ON_TARGETS`), with no compiler tie to this enum, so a future
    // game's differently-shaped RunOnType (e.g. Skyrim/Starfield both omit or add members FO4
    // doesn't have) would silently offer a name it can't actually parse or write. Same shape as
    // AvailableFunctions above.
    IEnumerable<string> AvailableRunOnTargets();

    // #165: decodes a Number-category parameter's raw value to its enum member name — the
    // ParsedConditionParam.TypeName hook ADR-0032 anticipated ("ActorValue 24 -> Health"). Per-game
    // because the enums themselves are per-game (mirrors AvailableFunctions/AvailableRunOnTargets
    // above). typeName is the parameter's own ParsedConditionParam.TypeName; a type this game has no
    // static enum table for, or a value outside that table's known members, returns null — the
    // caller falls back to the raw number, never a wrong or invented name.
    string? DecodeParamValue(string typeName, int number);
}

// Outcome of applying a value onto a Mutagen condition field. Mirrors VmadApplyResult's shape
// (Applied/NotFound) — no ReadOnly case yet, since no condition sub-field is currently read-only.
public enum ConditionApplyResult
{
    Applied,
    NotFound,
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
// "ActorValue", "Global") — a display cue for an undecoded value, and the hook ADR-0032 anticipated
// for enum-value decoding. DecodedValue (#165) is that decode's result — populated only for a
// Number-category parameter whose TypeName has a known static enum table for the loaded game (e.g.
// Sex 0 -> "Male"), via IConditionCodec.DecodeParamValue; null when undecodable (no table for
// TypeName, or a value outside the table's known members) or the parameter isn't Number-category
// (a Form/Text parameter is already human-legible without decoding). Never persisted — it's a pure
// function of (TypeName, Number), recomputed at read time in DuckDbRecordIndex.GetConditions
// rather than stored, so it can never drift from the raw value it was derived from.
public sealed record ParsedConditionParam(
    ConditionParamCategory Category,
    string TypeName,
    int? Number = null,
    string? FormKey = null,
    string? Text = null,
    string? DecodedValue = null);

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
