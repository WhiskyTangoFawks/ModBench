using System.Collections;
using System.Reflection;
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
    // Discovers a record's conditions by reflecting over every top-level property whose value is a
    // condition list — the shape COBJ's `Conditions`, Quest's `DialogConditions`/`UnusedConditions`,
    // Perk's `Conditions`, etc. all share — rather than a single hardcoded property name, so a
    // record with more than one condition-carrying field (#154) surfaces one owner per field,
    // independently keyed by that field's own name. Also folds in ExtractNested's one-array-level
    // nested owners (#181 — an Ingestible's Effects[i].Conditions, a Message's
    // MenuButtons[i].Conditions). Two-level nesting (a Perk effect's own conditions doubly-indexed,
    // a Quest alias's Conditions) is out of scope, deferred to a follow-up ticket. Discovery is
    // game-generic; Parse is FO4-specific.
    public IEnumerable<ConditionOwner> Extract(IMajorRecordGetter record)
    {
        var owners = new List<ConditionOwner>();
        foreach (var prop in record.GetType().GetProperties())
        {
            if (!IsConditionListProperty(prop)) continue;
            if (prop.GetValue(record) is not IEnumerable<IConditionGetter> conditions) continue;

            var parsed = conditions.Select(Parse).ToList();
            if (parsed.Count > 0) owners.Add(new ConditionOwner(prop.Name, parsed));
        }
        owners.AddRange(ExtractNested(record));
        return owners;
    }

    // Per-array-item nested condition lists, one array level below the record (#181) — e.g. an
    // Ingestible's Effects[i].Conditions, a Message's MenuButtons[i].Conditions. Same shape test as
    // the flat pass above (IsConditionListProperty), just applied to each element of every
    // array-of-struct property rather than to the record's own top-level properties, so a new
    // nesting shape needs no new hardcoded property/array name here or anywhere else. Keyed by an
    // indexed path composing the enclosing array's own property name and index with the nested
    // list's own name (e.g. "Effects[2].Conditions") — the same CTDA\<FieldPath>\<Index>\<SubField>
    // wire path just treats that whole composed string as one opaque FieldPath segment (#169).
    private static IEnumerable<ConditionOwner> ExtractNested(IMajorRecordGetter record)
    {
        foreach (var prop in record.GetType().GetProperties())
        {
            if (!IsArrayOfNestableStructsProperty(prop)) continue;
            if (prop.GetValue(record) is not IEnumerable items) continue;

            var index = 0;
            foreach (var item in items)
            {
                if (item != null)
                    foreach (var owner in ExtractElementOwners(item, prop.Name, index))
                        yield return owner;
                index++;
            }
        }
    }

    // One array element's own condition-owning properties (there's normally at most one, but the
    // shape test makes no such assumption), keyed by the composed "<ArrayProp>[<Index>].<NestedProp>"
    // path.
    private static IEnumerable<ConditionOwner> ExtractElementOwners(object item, string arrayPropName, int index)
    {
        foreach (var nested in item.GetType().GetProperties())
        {
            if (!IsConditionListProperty(nested)) continue;
            if (nested.GetValue(item) is not IEnumerable<IConditionGetter> conditions) continue;

            var parsed = conditions.Select(Parse).ToList();
            if (parsed.Count > 0)
                yield return new ConditionOwner($"{arrayPropName}[{index}].{nested.Name}", parsed);
        }
    }

    // A property worth descending into for nested condition lists: an array/list of some struct
    // element type, excluding element types that are FormLinks (nothing to nest into), plain
    // scalars/enums (same reason), the record's own flat condition lists (already handled by
    // Extract's top-level pass — descending into individual Condition elements would be pointless),
    // and — the child-record exclusion (#169) — element types Mutagen enumerates as their own
    // top-level major records (e.g. Quest's Scenes: a Scene is itself flattened into its own SCEN
    // record row with its own top-level Conditions field, so nesting it again here would duplicate
    // it). IMajorRecordGetter is the same signal SchemaReflector's own top-level table discovery
    // uses — no hardcoded type list.
    private static bool IsArrayOfNestableStructsProperty(PropertyInfo prop)
    {
        if (prop.GetIndexParameters().Length != 0) return false;
        if (IsConditionListProperty(prop)) return false;

        var elementType = GetEnumerableElementType(prop.PropertyType);
        if (elementType == null) return false;
        if (elementType.IsPrimitive || elementType.IsEnum || elementType == typeof(string)) return false;
        if (typeof(IFormLinkGetter).IsAssignableFrom(elementType)) return false;
        if (typeof(IMajorRecordGetter).IsAssignableFrom(elementType)) return false;
        return true;
    }

    // The element type of the first IEnumerable<T> a type implements (declared or inherited) — null
    // for non-generic/non-enumerable types. Works on the concrete runtime property types Extract
    // walks (e.g. Noggog.ExtendedList<Effect>), not just the *Getter interfaces SchemaReflector's
    // own IsListType checks.
    private static Type? GetEnumerableElementType(Type type) =>
        type.GetInterfaces().Prepend(type)
            .FirstOrDefault(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IEnumerable<>))
            ?.GetGenericArguments()[0];

    // Schema-level twin of Extract's own per-instance discovery — same shape check
    // (IsConditionListProperty), just applied to the CLR type rather than a live value, for callers
    // that don't yet have a loaded record instance (#154).
    public bool IsConditionListField(Type recordType, string fieldPath) =>
        recordType.GetProperty(fieldPath) is { } prop && IsConditionListProperty(prop);

    // #182: the Type-only twin of ExtractNested's per-instance discovery — walks into the enclosing
    // array property, then checks the element type (or, when abstract/interface and bare, any
    // concrete subtype in the same assembly) for a condition-list property named nestedField.
    // recordType is either the record's getter interface (PluginWriter.IsReadOnly, via
    // schema.RecordType) or its concrete setter class (EditOrchestrator's record.GetType()
    // dispatch) — both resolve the same way, since GetEnumerableElementType works on either shape.
    public bool IsNestedConditionListField(Type recordType, string arrayProp, string nestedField)
    {
        if (recordType.GetProperty(arrayProp) is not { } arrayPropInfo) return false;

        var elementType = GetEnumerableElementType(arrayPropInfo.PropertyType);
        if (elementType == null) return false;

        if (elementType.GetProperty(nestedField) is { } directProp && IsConditionListProperty(directProp))
            return true;

        // A concrete element type that doesn't declare the field directly has nothing further to
        // check — only an abstract/interface marker (Quest.Aliases's IAQuestAliasGetter/
        // AQuestAlias) gets the permissive concrete-subtype fallback.
        if (!elementType.IsAbstract && !elementType.IsInterface) return false;

        return elementType.Assembly.GetTypes()
            .Where(t => !t.IsAbstract && !t.IsInterface && elementType.IsAssignableFrom(t))
            .Any(t => t.GetProperty(nestedField) is { } p && IsConditionListProperty(p));
    }

    // The one shape test that decides "is this property a condition list" everywhere it matters:
    // not an indexer, and its value would satisfy IEnumerable<IConditionGetter> (covers both
    // non-nullable ExtendedList<Condition> and nullable ExtendedList<Condition>? owners like
    // Quest's DialogConditions/UnusedConditions).
    private static bool IsConditionListProperty(PropertyInfo prop) =>
        prop.GetIndexParameters().Length == 0
        && typeof(IEnumerable<IConditionGetter>).IsAssignableFrom(prop.PropertyType);

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
    // overload below. A composed fieldPath (#182: "Effects[2].Conditions") routes through the
    // nested resolver instead — record is always a concrete instance here (never the abstract
    // getter-interface/setter-base Type that IsNestedConditionListField has to allow for), so
    // walking arrayProp -> element -> nestedField never needs the stage-time permissive fallback:
    // the live element's own GetType() is always concrete.
    public ConditionApplyResult ApplyFieldValue(
        IMajorRecord record, string fieldPath, int index, string subField, JsonElement value)
    {
        if (TryParseNestedFieldPath(fieldPath, out var arrayProp, out var arrayIndex, out var nestedField))
            return ApplyNestedFieldValue(record, arrayProp, arrayIndex, nestedField, index, subField, value);

        return record.GetType().GetProperty(fieldPath)?.GetValue(record) is IList<Condition> conditions
            ? ApplyFieldValue(conditions, index, subField, value)
            : ConditionApplyResult.NotFound;
    }

    // Walks into the enclosing array (arrayProp) at arrayIndex, then the nested condition list
    // (nestedField) on that element, before delegating to the same list-level ApplyFieldValue every
    // flat/scalar edit uses. Any resolution failure (unknown array property, out-of-range index —
    // #169's AC: caught here since only a live instance can know the real length, not the stage-time
    // shape check — a null element, or the nested property not actually being a condition list on
    // this concrete element) returns NotFound before any mutation, so a bad nested path can never
    // produce a partial write.
    private static ConditionApplyResult ApplyNestedFieldValue(
        IMajorRecord record, string arrayProp, int arrayIndex, string nestedField,
        int conditionIndex, string subField, JsonElement value)
    {
        if (record.GetType().GetProperty(arrayProp)?.GetValue(record) is not System.Collections.IList array)
            return ConditionApplyResult.NotFound;
        if (arrayIndex < 0 || arrayIndex >= array.Count) return ConditionApplyResult.NotFound;
        if (array[arrayIndex] is not { } element) return ConditionApplyResult.NotFound;
        if (element.GetType().GetProperty(nestedField)?.GetValue(element) is not IList<Condition> conditions)
            return ConditionApplyResult.NotFound;

        return ApplyFieldValue(conditions, conditionIndex, subField, value);
    }

    // Local mirror of ConditionPath.TryParseNestedFieldPath (Edits/ConditionPath.cs) — Schema owns
    // no dependency on Edits, so this composed-path shape is recognized here independently rather
    // than shared, the same way TryParseParameterIndex below is already duplicated for the same
    // reason. Parses "Effects[2].Conditions" into its enclosing array property name/index and the
    // nested condition-list property name; false for a flat (unbracketed) fieldPath or anything
    // that doesn't match this one-level shape.
    private static bool TryParseNestedFieldPath(
        string fieldPath, out string arrayProp, out int arrayIndex, out string nestedField)
    {
        arrayProp = "";
        arrayIndex = -1;
        nestedField = "";

        var openBracket = fieldPath.IndexOf('[');
        if (openBracket <= 0) return false;

        var closeBracket = fieldPath.IndexOf(']', openBracket);
        if (closeBracket < 0) return false;

        var afterBracket = closeBracket + 1;
        if (afterBracket >= fieldPath.Length || fieldPath[afterBracket] != '.') return false;

        var indexStr = fieldPath[(openBracket + 1)..closeBracket];
        if (!int.TryParse(indexStr, out var parsedIndex) || parsedIndex < 0) return false;

        var nested = fieldPath[(afterBracket + 1)..];
        if (nested.Length == 0 || nested.Contains('[')) return false;

        arrayProp = fieldPath[..openBracket];
        arrayIndex = parsedIndex;
        nestedField = nested;
        return true;
    }

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
    // ---- ApplyListValue: whole-list restage write-back (#153) ----

    // Record-level entry point PluginWriter calls for an add/remove/reorder restage: replaces the
    // entire condition list in place with freshly-materialized Condition instances. Mirrors
    // ApplyFieldValue's record-level/list-level split. #183: a composed fieldPath ("Effects[2].
    // Conditions" — a nested list's own restage) routes through the same arrayProp -> element ->
    // nestedField walk ApplyFieldValue's nested branch already uses, landing on the list-level
    // ApplyListValue instead of the scalar one.
    public ConditionApplyResult ApplyListValue(IMajorRecord record, string fieldPath, JsonElement newList)
    {
        if (TryParseNestedFieldPath(fieldPath, out var arrayProp, out var arrayIndex, out var nestedField))
            return ApplyNestedListValue(record, arrayProp, arrayIndex, nestedField, newList);

        return record.GetType().GetProperty(fieldPath)?.GetValue(record) is IList<Condition> conditions
            ? ApplyListValue(conditions, newList)
            : ConditionApplyResult.NotFound;
    }

    // Walks into the enclosing array (arrayProp) at arrayIndex, then the nested condition list
    // (nestedField) on that element, before delegating to the same list-level ApplyListValue every
    // flat/nested restage uses. Mirrors ApplyNestedFieldValue's resolution exactly, just landing on
    // the whole-list applier instead of the single-condition one.
    private static ConditionApplyResult ApplyNestedListValue(
        IMajorRecord record, string arrayProp, int arrayIndex, string nestedField, JsonElement newList)
    {
        if (record.GetType().GetProperty(arrayProp)?.GetValue(record) is not System.Collections.IList array)
            return ConditionApplyResult.NotFound;
        if (arrayIndex < 0 || arrayIndex >= array.Count) return ConditionApplyResult.NotFound;
        if (array[arrayIndex] is not { } element) return ConditionApplyResult.NotFound;
        if (element.GetType().GetProperty(nestedField)?.GetValue(element) is not IList<Condition> conditions)
            return ConditionApplyResult.NotFound;

        return ApplyListValue(conditions, newList);
    }

    // newList is a JSON array of ParsedCondition-shaped objects (camelCase field names) — the same
    // shape ConditionDiff.PerPlugin already sends the frontend, so this and Parse are inverses.
    // Fails atomically: a malformed element leaves the original list untouched rather than landing
    // a partially-materialized list (same "never silently do less than asked" rule as elsewhere).
    public static ConditionApplyResult ApplyListValue(IList<Condition> conditions, JsonElement newList)
    {
        if (newList.ValueKind != JsonValueKind.Array) return ConditionApplyResult.NotFound;

        var materialized = new List<Condition>();
        foreach (var el in newList.EnumerateArray())
        {
            if (MaterializeCondition(el) is not { } condition) return ConditionApplyResult.NotFound;
            materialized.Add(condition);
        }

        conditions.Clear();
        foreach (var c in materialized) conditions.Add(c);
        return ConditionApplyResult.Applied;
    }

    // Builds one fresh Condition from a ParsedCondition-shaped JSON object. Null means the element
    // is malformed (unknown function/operator name, or not an object).
    private static Condition? MaterializeCondition(JsonElement el)
    {
        if (el.ValueKind != JsonValueKind.Object) return null;
        if (!el.TryGetProperty("function", out var fnEl) || fnEl.GetString() is not { } fnStr
            || !Enum.TryParse<Condition.Function>(fnStr, out var fn))
        {
            return null;
        }
        if (!el.TryGetProperty("operator", out var opEl) || opEl.GetString() is not { } opStr
            || !Enum.TryParse<ConditionOperator>(opStr, out var neutralOp))
        {
            return null;
        }

        var or = el.TryGetProperty("or", out var orEl) && orEl.ValueKind == JsonValueKind.True;
        var useGlobal = el.TryGetProperty("useGlobal", out var ugEl) && ugEl.ValueKind == JsonValueKind.True;
        var runOnTarget = el.TryGetProperty("runOnTarget", out var rotEl) && rotEl.GetString() is { } rotStr
            && Enum.TryParse<Condition.RunOnType>(rotStr, out var rot) ? rot : Condition.RunOnType.Subject;

        var data = new FunctionConditionData { Function = fn, RunOnType = runOnTarget };
        if (runOnTarget == Condition.RunOnType.Reference
            && el.TryGetProperty("runOnReference", out var refEl) && refEl.ValueKind == JsonValueKind.String
            && FormKey.TryFactory(refEl.GetString()!, out var refFk))
        {
            data.Reference.SetTo(refFk);
        }

        if (el.TryGetProperty("parameters", out var paramsEl) && paramsEl.ValueKind == JsonValueKind.Array)
        {
            var index = 0;
            foreach (var p in paramsEl.EnumerateArray())
            {
                if (index > 1) break;
                MaterializeParam(data, index, p);
                index++;
            }
        }

        Condition condition = useGlobal ? new ConditionGlobal { Data = data } : new ConditionFloat { Data = data };
        condition.CompareOperator = MapOperatorBack(neutralOp);
        condition.Flags = or ? Condition.Flag.OR : 0;

        if (useGlobal && condition is ConditionGlobal g
            && el.TryGetProperty("comparisonGlobal", out var cgEl) && cgEl.ValueKind == JsonValueKind.String
            && FormKey.TryFactory(cgEl.GetString()!, out var cgFk))
        {
            g.ComparisonValue.SetTo(cgFk);
        }
        else if (!useGlobal && condition is ConditionFloat f
            && el.TryGetProperty("comparisonFloat", out var cfEl) && cfEl.ValueKind == JsonValueKind.Number)
        {
            f.ComparisonValue = cfEl.GetSingle();
        }

        return condition;
    }

    // Only slots 0 and 1 exist on FO4's FunctionConditionData — a param beyond that is ignored by
    // the caller's loop guard. Category names the slot member (Form/Text/Number), same taxonomy
    // ParsedConditionParam.Category already uses.
    private static void MaterializeParam(FunctionConditionData data, int index, JsonElement p)
    {
        if (p.ValueKind != JsonValueKind.Object) return;
        var category = p.TryGetProperty("category", out var catEl) ? catEl.GetString() : null;

        if (category == "Form" && p.TryGetProperty("formKey", out var fkEl) && fkEl.ValueKind == JsonValueKind.String
            && FormKey.TryFactory(fkEl.GetString()!, out var fk))
        {
            if (index == 0) data.ParameterOneRecord.SetTo(fk); else data.ParameterTwoRecord.SetTo(fk);
        }
        else if (category == "Text" && p.TryGetProperty("text", out var textEl))
        {
            var text = textEl.ValueKind == JsonValueKind.String ? textEl.GetString() : null;
            if (index == 0) data.ParameterOneString = text; else data.ParameterTwoString = text;
        }
        else if (category == "Number" && p.TryGetProperty("number", out var numEl) && numEl.ValueKind == JsonValueKind.Number)
        {
            if (index == 0) data.ParameterOneNumber = numEl.GetInt32(); else data.ParameterTwoNumber = numEl.GetInt32();
        }
    }

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
