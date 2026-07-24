using System.Text.Json;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Schema;

// Fallout 4's condition Mutagen edge: maps FO4's generic FunctionConditionData (function enum +
// ParameterOne/Two Record/Number/String, typed by the static GetParameterTypes table) onto the
// neutral ParsedCondition. FO4-typed by design — conditions have no shared cross-game Mutagen
// interface, so each game gets its own codec behind IConditionCodec. [ADR-0032]
public sealed class Fallout4ConditionCodec : IConditionCodec
{
    // Discovers a record's conditions by reflecting for a top-level `Conditions` property — the
    // shape COBJ/Perk/MagicEffect/Package/etc. share. Nested condition lists (quest aliases,
    // terminal items) are a later slice. Discovery is game-generic; Parse is FO4-specific.
    public IEnumerable<ConditionOwner> Extract(IMajorRecordGetter record)
    {
        if (record.GetType().GetProperty("Conditions")?.GetValue(record)
            is not IEnumerable<IConditionGetter> conditions)
        {
            return [];
        }

        var parsed = conditions.Select(Parse).ToList();
        return parsed.Count == 0 ? [] : [new ConditionOwner("Conditions", parsed)];
    }

    // Parses one Mutagen condition into neutral form.
    public static ParsedCondition Parse(IConditionGetter condition)
    {
        var (useGlobal, comparisonFloat, comparisonGlobal) = Comparison(condition);
        var data = condition.Data as IFunctionConditionDataGetter;

        return new ParsedCondition(
            Function: data?.Function.ToString() ?? condition.Data.GetType().Name,
            Operator: MapOperator(condition.CompareOperator),
            Or: condition.Flags.HasFlag(Condition.Flag.OR),
            RunOnTarget: condition.Data.RunOnType.ToString(),
            RunOnReference: condition.Data.RunOnType == Condition.RunOnType.Reference
                ? condition.Data.Reference.FormKey.ToString()
                : null,
            UseGlobal: useGlobal,
            ComparisonFloat: comparisonFloat,
            ComparisonGlobal: comparisonGlobal,
            Parameters: data == null ? [] : Parameters(data));
    }

    // FO4 exposes only two parameter slots (ParameterOne/Two). Mutagen's static
    // Condition.GetParameterTypes(function) supplies each slot's ParameterType, whose GetCategory()
    // decides whether the value reads from the record link, the number, or the string — no
    // hand-maintained per-function table. Slots typed None (unused by the function) are omitted.
    private static List<ParsedConditionParam> Parameters(IFunctionConditionDataGetter data)
    {
        var (first, second, _) = Condition.GetParameterTypes(data.Function);
        var list = new List<ParsedConditionParam>(2);
        AddParam(list, first, data.ParameterOneRecord, data.ParameterOneNumber, data.ParameterOneString);
        AddParam(list, second, data.ParameterTwoRecord, data.ParameterTwoNumber, data.ParameterTwoString);
        return list;
    }

    private static void AddParam(
        List<ParsedConditionParam> list,
        Condition.ParameterType type,
        IFormLinkGetter<IFallout4MajorRecordGetter> record,
        int number,
        string? text)
    {
        var name = type.ToString();
        switch (type.GetCategory())
        {
            case Condition.ParameterCategory.None:
                return;
            case Condition.ParameterCategory.Form:
                list.Add(new ParsedConditionParam(ConditionParamCategory.Form, name, FormKey: record.FormKey.ToString()));
                return;
            case Condition.ParameterCategory.String:
                list.Add(new ParsedConditionParam(ConditionParamCategory.Text, name, Text: text));
                return;
            default:
                list.Add(new ParsedConditionParam(ConditionParamCategory.Number, name, Number: number));
                return;
        }
    }

    // Explicit map rather than an ordinal cast: the two enums are declared independently, so a
    // reorder on either side must fail to compile here, never silently mis-parse (ADR-0032).
    private static ConditionOperator MapOperator(CompareOperator op) => op switch
    {
        CompareOperator.EqualTo => ConditionOperator.EqualTo,
        CompareOperator.NotEqualTo => ConditionOperator.NotEqualTo,
        CompareOperator.GreaterThan => ConditionOperator.GreaterThan,
        CompareOperator.GreaterThanOrEqualTo => ConditionOperator.GreaterThanOrEqualTo,
        CompareOperator.LessThan => ConditionOperator.LessThan,
        CompareOperator.LessThanOrEqualTo => ConditionOperator.LessThanOrEqualTo,
        _ => throw new ArgumentOutOfRangeException(nameof(op), op, "Unknown CTDA compare operator"),
    };

    private static (bool UseGlobal, float? Float, string? Global) Comparison(IConditionGetter condition) =>
        condition switch
        {
            IConditionGlobalGetter g => (true, null, g.ComparisonValue.FormKey.ToString()),
            IConditionFloatGetter f => (false, f.ComparisonValue, null),
            _ => (false, null, null),
        };

    public IEnumerable<string> AvailableFunctions() => Enum.GetNames<Condition.Function>();

    // ---- ApplyFieldValue: write-back (#152) ----

    // Record-level entry point PluginWriter calls: finds the mutable condition list via the same
    // reflection Extract uses to discover it, then delegates to the directly-testable list-level
    // overload below.
    public ConditionApplyResult ApplyFieldValue(
        IMajorRecord record, string fieldPath, int index, string subField, JsonElement value) =>
        record.GetType().GetProperty(fieldPath)?.GetValue(record) is IList<Condition> conditions
            ? ApplyFieldValue(conditions, index, subField, value)
            : ConditionApplyResult.NotFound;

    // subField is one of Function / RunOn / Operator / Comparison / UseGlobal / "Parameter\<n>"
    // (ConditionPath.SubField — Schema doesn't depend on Edits, so this reads it as a plain string).
    public static ConditionApplyResult ApplyFieldValue(
        IList<Condition> conditions, int index, string subField, JsonElement value)
    {
        if (index < 0 || index >= conditions.Count) return ConditionApplyResult.NotFound;
        var condition = conditions[index];

        if (subField == "Function") return ApplyFunction(condition, value);
        if (subField == "Operator") return ApplyOperator(condition, value);
        if (subField == "RunOn") return ApplyRunOn(condition, value);
        if (subField == "Comparison") return ApplyComparison(condition, value);
        if (subField == "UseGlobal") return ApplyUseGlobal(conditions, index, value);
        if (TryParseParameterIndex(subField, out var paramIndex)) return ApplyParameter(condition, paramIndex, value);
        return ConditionApplyResult.NotFound;
    }

    // Local mirror of ConditionPath.TryParseParameterIndex (Edits/ConditionPath.cs) — Schema owns no
    // dependency on Edits, so the "Parameter\<n>" shape is recognized here independently rather than
    // shared, the same way VmadCodec takes already-split path segments from its caller.
    private static bool TryParseParameterIndex(string subField, out int paramIndex)
    {
        paramIndex = -1;
        const string prefix = @"Parameter\";
        return subField.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            && int.TryParse(subField[prefix.Length..], out paramIndex) && paramIndex >= 0;
    }

    // Only slots 0 and 1 exist on FO4's FunctionConditionData (ParameterOne/Two) — no other index is
    // ever valid, regardless of what the current function's shape says.
    private static ConditionApplyResult ApplyParameter(Condition condition, int paramIndex, JsonElement value)
    {
        if (condition.Data is not FunctionConditionData data || paramIndex is not (0 or 1))
            return ConditionApplyResult.NotFound;

        var (first, second, _) = Condition.GetParameterTypes(data.Function);
        var category = (paramIndex == 0 ? first : second).GetCategory();

        return category switch
        {
            Condition.ParameterCategory.Form when value.ValueKind == JsonValueKind.String
                && FormKey.TryFactory(value.GetString()!, out var fk) =>
                SetFormParam(data, paramIndex, fk),
            Condition.ParameterCategory.String when value.ValueKind == JsonValueKind.String =>
                SetStringParam(data, paramIndex, value.GetString()),
            Condition.ParameterCategory.Number or Condition.ParameterCategory.None
                when value.ValueKind == JsonValueKind.Number =>
                SetNumberParam(data, paramIndex, value.GetInt32()),
            _ => ConditionApplyResult.NotFound,
        };
    }

    private static ConditionApplyResult SetFormParam(FunctionConditionData data, int paramIndex, FormKey fk)
    {
        if (paramIndex == 0) data.ParameterOneRecord.SetTo(fk); else data.ParameterTwoRecord.SetTo(fk);
        return ConditionApplyResult.Applied;
    }

    private static ConditionApplyResult SetStringParam(FunctionConditionData data, int paramIndex, string? text)
    {
        if (paramIndex == 0) data.ParameterOneString = text; else data.ParameterTwoString = text;
        return ConditionApplyResult.Applied;
    }

    private static ConditionApplyResult SetNumberParam(FunctionConditionData data, int paramIndex, int number)
    {
        if (paramIndex == 0) data.ParameterOneNumber = number; else data.ParameterTwoNumber = number;
        return ConditionApplyResult.Applied;
    }

    // Value shape: { "target": "<RunOnType name>", "reference": "<FormKey>"|null }. Reference is set
    // whenever provided (not only when target is Reference) — harmless when the target ignores it,
    // and avoids a separate reset rule for the non-Reference case.
    private static ConditionApplyResult ApplyRunOn(Condition condition, JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object
            || !value.TryGetProperty("target", out var targetEl) || targetEl.GetString() is not { } targetStr
            || !Enum.TryParse<Condition.RunOnType>(targetStr, out var target))
        {
            return ConditionApplyResult.NotFound;
        }

        condition.Data.RunOnType = target;
        if (value.TryGetProperty("reference", out var refEl) && refEl.ValueKind == JsonValueKind.String
            && FormKey.TryFactory(refEl.GetString()!, out var refFk))
        {
            condition.Data.Reference.SetTo(refFk);
        }
        return ConditionApplyResult.Applied;
    }

    // Comparison's expected JSON shape depends on the condition's *current* concrete type — a number
    // for ConditionFloat, a GLOB FormKey string for ConditionGlobal. Switching between the two is
    // "UseGlobal"'s job, not this one's.
    private static ConditionApplyResult ApplyComparison(Condition condition, JsonElement value) => condition switch
    {
        ConditionFloat f when value.ValueKind == JsonValueKind.Number => SetFloatComparison(f, value.GetSingle()),
        ConditionGlobal g when value.ValueKind == JsonValueKind.String
            && FormKey.TryFactory(value.GetString()!, out var fk) => SetGlobalComparison(g, fk),
        _ => ConditionApplyResult.NotFound,
    };

    private static ConditionApplyResult SetFloatComparison(ConditionFloat f, float v)
    {
        f.ComparisonValue = v;
        return ConditionApplyResult.Applied;
    }

    private static ConditionApplyResult SetGlobalComparison(ConditionGlobal g, FormKey fk)
    {
        g.ComparisonValue.SetTo(fk);
        return ConditionApplyResult.Applied;
    }

    // Switches the condition's concrete Mutagen type (Float <-> Global) — the only sub-field that
    // needs list-level access, since the two types aren't interchangeable in place. Carries the
    // shared envelope (Operator, Flags, Data) across; Comparison resets to that type's default (the
    // old value's type no longer applies, same "must not silently persist a stale value" rule as a
    // Function change).
    private static ConditionApplyResult ApplyUseGlobal(IList<Condition> conditions, int index, JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.True && value.ValueKind != JsonValueKind.False)
            return ConditionApplyResult.NotFound;

        var useGlobal = value.GetBoolean();
        var current = conditions[index];
        if (useGlobal == current is ConditionGlobal) return ConditionApplyResult.Applied;

        Condition replacement = useGlobal
            ? new ConditionGlobal { CompareOperator = current.CompareOperator, Flags = current.Flags, Data = current.Data }
            : new ConditionFloat { CompareOperator = current.CompareOperator, Flags = current.Flags, Data = current.Data };
        conditions[index] = replacement;
        return ConditionApplyResult.Applied;
    }

    private static ConditionApplyResult ApplyOperator(Condition condition, JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.String || value.GetString() is not { } s
            || !Enum.TryParse<ConditionOperator>(s, out var neutral))
        {
            return ConditionApplyResult.NotFound;
        }

        condition.CompareOperator = MapOperatorBack(neutral);
        return ConditionApplyResult.Applied;
    }

    // Inverse of MapOperator — explicit, same rationale (ADR-0032): a reorder on either enum must
    // fail to compile here, never silently mis-map.
    private static CompareOperator MapOperatorBack(ConditionOperator op) => op switch
    {
        ConditionOperator.EqualTo => CompareOperator.EqualTo,
        ConditionOperator.NotEqualTo => CompareOperator.NotEqualTo,
        ConditionOperator.GreaterThan => CompareOperator.GreaterThan,
        ConditionOperator.GreaterThanOrEqualTo => CompareOperator.GreaterThanOrEqualTo,
        ConditionOperator.LessThan => CompareOperator.LessThan,
        ConditionOperator.LessThanOrEqualTo => CompareOperator.LessThanOrEqualTo,
        _ => throw new ArgumentOutOfRangeException(nameof(op), op, "Unknown neutral compare operator"),
    };

    // A function change reshapes the parameter-type signature (#152): rather than selectively
    // resetting only the slots whose category changed, every underlying storage member (Record,
    // Number, String) on both slots is cleared unconditionally. That's the only way to guarantee a
    // value from the old function's shape can never silently read back through the new one,
    // regardless of which of the three storage members the old and new categories happened to share.
    private static ConditionApplyResult ApplyFunction(Condition condition, JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.String || value.GetString() is not { } s
            || !Enum.TryParse<Condition.Function>(s, out var fn))
        {
            return ConditionApplyResult.NotFound;
        }

        if (condition.Data is not FunctionConditionData data) return ConditionApplyResult.NotFound;

        data.Function = fn;
        data.ParameterOneRecord.Clear();
        data.ParameterOneNumber = 0;
        data.ParameterOneString = null;
        data.ParameterTwoRecord.Clear();
        data.ParameterTwoNumber = 0;
        data.ParameterTwoString = null;
        return ConditionApplyResult.Applied;
    }
}
