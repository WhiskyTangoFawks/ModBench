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
}
