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

        try
        {
            owners.AddRange(ExtractNested(record));
        }
        catch (Exception ex)
        {
            // ExtractNested's own array-path/index detail (from WalkNestedArrayProperty) says
            // *where* in the record the malformed data is; this adds *which record*, since that's
            // reported per-plugin (SessionManager.IndexAndStore), not per-record — without it, a
            // user can't find the offending entry in xEdit.
            var editorId = record.EditorID is { } eid ? $" ('{eid}')" : "";
            throw new InvalidOperationException(
                $"{record.GetType().Name} {record.FormKey}{editorId}: {ex.Message}", ex);
        }

        return owners;
    }

    // Per-array-item nested condition lists, an arbitrary number of array levels below the record
    // (#181 introduced one level; #184 generalizes to N) — e.g. an Ingestible's Effects[i].
    // Conditions (one level), or a Perk's Effects[i].Conditions[j].Conditions (two levels: Effects
    // is APerkEffect, whose own Conditions is a list of PerkCondition wrappers — not itself a
    // condition list — each of which in turn declares the real terminal Conditions list). Same shape
    // test as the flat pass above (IsConditionListProperty) and the array-shape test below
    // (IsArrayOfNestableStructsProperty), just applied recursively to each element of every
    // array-of-struct property reachable from the record, so a new nesting shape or depth needs no
    // new hardcoded property/array name or depth constant anywhere. Keyed by an indexed path
    // composing every enclosing array's own property name and index with the terminal list's own
    // name (e.g. "Effects[2].Conditions[1].Conditions") — the same CTDA\<FieldPath>\<Index>\
    // <SubField> wire path just treats that whole composed string as one opaque FieldPath segment
    // (#169).
    private static IEnumerable<ConditionOwner> ExtractNested(IMajorRecordGetter record) =>
        WalkNestedArrays(record, "", depth: 0);

    // The recursion bound #184's AC requires: a defensive circuit breaker, not a limit expected to
    // ever bind on a real Mutagen type. The only way this walk could genuinely cycle is through a
    // shared major-record reference, and IsArrayOfNestableStructsProperty's IMajorRecordGetter
    // exclusion already rules that out before recursing (child records are enumerated as their own
    // top-level rows, never walked into here) — every other Loqui-generated struct/list type FO4's
    // real nesting map reaches is acyclic by construction. FO4's real maximum is two levels; this cap
    // is generous well past that on purpose, so it only ever fires on a pathological type graph a
    // future game's Mutagen package might introduce.
    internal const int MaxNestedDepth = 8;

    // Recursively walks every array-of-nestable-structs property reachable from `container` — the
    // record itself at depth 0, then each array element in turn — composing the indexed path prefix
    // as it descends, and yields one ConditionOwner per condition-list property found on any element
    // at any depth. `container` is `object`, not IMajorRecordGetter, past depth 0: an array element
    // (e.g. an APerkEffect or a PerkCondition) is a plain Loqui struct with no shared base beyond
    // object, the same way ExtractElementOwners below has always taken one. internal (rather than
    // private) solely so a test can exercise the depth cap directly with a self-referential
    // plain-object fixture — the one scenario this cap defends against can't be expressed through a
    // real IMajorRecordGetter, since no real Mutagen type is cyclic (see above).
    internal static IEnumerable<ConditionOwner> WalkNestedArrays(object container, string pathPrefix, int depth)
    {
        if (depth >= MaxNestedDepth) yield break;

        foreach (var prop in container.GetType().GetProperties())
        {
            if (!IsArrayOfNestableStructsProperty(prop)) continue;
            if (prop.GetValue(container) is not IEnumerable items) continue;

            foreach (var owner in WalkNestedArrayProperty(items, prop.Name, pathPrefix, depth))
                yield return owner;
        }
    }

    // One array property's elements: each non-null element contributes its own direct condition-list
    // owners (ExtractElementOwners) and is itself a candidate container for a further nesting level
    // (the recursive WalkNestedArrays call) — split out from WalkNestedArrays purely to keep each
    // method's branching shallow enough to read at a glance.
    //
    // Enumeration is manual (not a plain foreach) so a MoveNext() failure — a malformed binary
    // plugin's lazy Mutagen overlay throwing while parsing one array entry — can be rethrown with
    // the property path and index that failed; a plain foreach would lose both once the exception
    // left this frame. yield return must stay outside the try/catch MoveNextOrThrow wraps (C# bars
    // yield inside a try with a catch clause), so disposal only needs a try/finally here.
    private static IEnumerable<ConditionOwner> WalkNestedArrayProperty(
        IEnumerable items, string propName, string pathPrefix, int depth)
    {
        var enumerator = items.GetEnumerator();
        try
        {
            for (var index = 0; MoveNextOrThrow(enumerator, pathPrefix, propName, index); index++)
            {
                if (enumerator.Current is not { } item) continue;

                var elementPrefix = $"{pathPrefix}{propName}[{index}].";
                foreach (var owner in ExtractElementOwners(item, elementPrefix))
                    yield return owner;
                foreach (var owner in WalkNestedArrays(item, elementPrefix, depth + 1))
                    yield return owner;
            }
        }
        finally
        {
            (enumerator as IDisposable)?.Dispose();
        }
    }

    private static bool MoveNextOrThrow(IEnumerator enumerator, string pathPrefix, string propName, int index)
    {
        try
        {
            return enumerator.MoveNext();
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException($"{pathPrefix}{propName}[{index}]: {ex.Message}", ex);
        }
    }

    // One array element's own direct condition-owning properties (there's normally at most one, but
    // the shape test makes no such assumption), keyed by the composed "<pathPrefix><NestedProp>"
    // path — pathPrefix already ends in a trailing '.', e.g. "Effects[2].Conditions[1].".
    private static IEnumerable<ConditionOwner> ExtractElementOwners(object item, string pathPrefix)
    {
        foreach (var nested in item.GetType().GetProperties())
        {
            if (!IsConditionListProperty(nested)) continue;
            if (nested.GetValue(item) is not IEnumerable<IConditionGetter> conditions) continue;

            var parsed = conditions.Select(Parse).ToList();
            if (parsed.Count > 0)
                yield return new ConditionOwner($"{pathPrefix}{nested.Name}", parsed);
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

    // #182/#184: the Type-only twin of ExtractNested's per-instance discovery — walks recordType
    // through the composed path's array segments in order (e.g. "Effects[2].Conditions[1]." for
    // "Effects[2].Conditions[1].Conditions"), then checks the type reached at the end (or, when
    // abstract/interface and bare, any concrete subtype in the same assembly) for a condition-list
    // property named nestedField. recordType is either the record's getter interface
    // (PluginWriter.IsReadOnly, via schema.RecordType) or its concrete setter class
    // (EditOrchestrator's record.GetType() dispatch) — both resolve the same way, since
    // GetEnumerableElementType works on either shape. Takes the raw composed path directly (#184) —
    // parsing it (arbitrary depth, no upfront caller-side split) is entirely this method's job now.
    public bool IsNestedConditionListField(Type recordType, string composedFieldPath)
    {
        if (!TryParseNestedFieldPath(composedFieldPath, out var segments, out var nestedField)) return false;

        var currentType = recordType;
        foreach (var segment in segments)
        {
            if (ResolveArrayElementType(currentType, segment.ArrayProp) is not { } elementType) return false;
            currentType = elementType;
        }

        return HasConditionListProperty(currentType, nestedField);
    }

    // Resolves arrayProp's array-of-struct element type on currentType directly, or — when
    // currentType is abstract/interface and declares nothing itself — any concrete subtype's
    // declared element type. The same permissive fallback #182 established at a single hop, now
    // applied uniformly at every intermediate hop of an arbitrary-depth composed path (#184).
    private static Type? ResolveArrayElementType(Type currentType, string arrayProp)
    {
        if (currentType.GetProperty(arrayProp) is { } directProp
            && GetEnumerableElementType(directProp.PropertyType) is { } elementType)
        {
            return elementType;
        }

        if (!currentType.IsAbstract && !currentType.IsInterface) return null;

        return currentType.Assembly.GetTypes()
            .Where(t => !t.IsAbstract && !t.IsInterface && currentType.IsAssignableFrom(t))
            .Select(t => t.GetProperty(arrayProp))
            .OfType<PropertyInfo>()
            .Select(p => GetEnumerableElementType(p.PropertyType))
            .FirstOrDefault(e => e != null);
    }

    // The terminal check: currentType (or, if abstract/interface and bare, any concrete subtype)
    // declares nestedField as a condition list. Quest.Aliases's IAQuestAliasGetter is a marker
    // interface with zero data properties — a concrete alias subtype (e.g. QuestReferenceAlias)
    // declares Conditions instead, so a bare abstract/interface type falls through to the same
    // concrete-subtype fallback ResolveArrayElementType uses at intermediate hops.
    private static bool HasConditionListProperty(Type currentType, string nestedField)
    {
        if (currentType.GetProperty(nestedField) is { } directProp && IsConditionListProperty(directProp))
            return true;

        if (!currentType.IsAbstract && !currentType.IsInterface) return false;

        return currentType.Assembly.GetTypes()
            .Where(t => !t.IsAbstract && !t.IsInterface && currentType.IsAssignableFrom(t))
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

    // #167: the Run On target catalog, same rationale as AvailableFunctions above.
    public IEnumerable<string> AvailableRunOnTargets() => Enum.GetNames<Condition.RunOnType>();

    // #165: member-name tables for the Number-category ParameterTypes that have a real static enum
    // in xEdit (references/TES5Edit/Core/wbDefinitionsCommon.pas + wbDefinitionsFO4.pas) and are
    // actually used by an FO4 Condition.Function. Scoped to these seven deliberately — FormType
    // (~120 members) and MiscStat (hash-keyed, ~100+ members) are real Number-category enums too but
    // far larger/lower-value; out of scope for #165, left for a follow-up if ever needed. Every other
    // Number-category ParameterType (Integer, Float, VariableName, QuestStage, VATSValueFunction/
    // Param, AdvanceAction, Alias, Packdata, FurnitureAnim/Entry, Event) is either genuinely free-form
    // or resolved relative to another parameter's value (context mEdit's neutral model doesn't carry)
    // — not a static catalog, so it's never in this table and DecodeParamValue correctly falls
    // through to null for it.
    private static readonly Dictionary<string, IReadOnlyDictionary<int, string>> EnumTables =
        new Dictionary<string, IReadOnlyDictionary<int, string>>
        {
            ["Sex"] = new Dictionary<int, string> { [0] = "Male", [1] = "Female" },
            ["Axis"] = new Dictionary<int, string> { [88] = "X", [89] = "Y", [90] = "Z" },
            ["CrimeType"] = new Dictionary<int, string>
            {
                [0] = "Steal",
                [1] = "Pickpocket",
                [2] = "Trespass",
                [3] = "Attack",
                [4] = "Murder",
                [-1] = "None",
            },
            ["CriticalStage"] = new Dictionary<int, string>
            {
                [0] = "None",
                [1] = "Goo Start",
                [2] = "Goo End",
                [3] = "Disintegrate Start",
                [4] = "Disintegrate End",
                [5] = "Freeze Start",
                [6] = "Freeze End",
            },
            ["Alignment"] = new Dictionary<int, string>
            {
                [0] = "Good",
                [1] = "Neutral",
                [2] = "Evil",
                [3] = "Very Good",
                [4] = "Very Evil",
            },
            ["CastingSource"] = new Dictionary<int, string>
            {
                [0] = "Left",
                [1] = "Right",
                [2] = "Voice",
                [3] = "Instant",
            },
            ["WardState"] = new Dictionary<int, string> { [0] = "None", [1] = "Absorb", [2] = "Break" },
        };

    public string? DecodeParamValue(string typeName, int number) =>
        EnumTables.TryGetValue(typeName, out var table) && table.TryGetValue(number, out var name) ? name : null;

    // ---- ApplyFieldValue: write-back (#152) ----

    // Record-level entry point PluginWriter calls: finds the mutable condition list via the same
    // reflection Extract uses to discover it, then delegates to the directly-testable list-level
    // overload below. A composed fieldPath (#182/#184: "Effects[2].Conditions" one level deep, or
    // "Effects[2].Conditions[1].Conditions" two levels deep) routes through the nested resolver
    // instead — record is always a concrete instance here (never the abstract getter-interface/
    // setter-base Type that IsNestedConditionListField has to allow for), so walking every
    // arrayProp -> element hop down to nestedField never needs the validation-time permissive fallback:
    // the live element's own GetType() is always concrete at every hop.
    public ConditionApplyResult ApplyFieldValue(
        IMajorRecord record, string fieldPath, int index, string subField, JsonElement value)
    {
        if (TryParseNestedFieldPath(fieldPath, out var segments, out var nestedField))
        {
            return ResolveNestedConditionList(record, segments, nestedField) is { } conditions
                ? ApplyFieldValue(conditions, index, subField, value)
                : ConditionApplyResult.NotFound;
        }

        return record.GetType().GetProperty(fieldPath)?.GetValue(record) is IList<Condition> flatConditions
            ? ApplyFieldValue(flatConditions, index, subField, value)
            : ConditionApplyResult.NotFound;
    }

    // Walks each (arrayProp, index) hop on the live instance in order — e.g. Effects[2] then
    // Conditions[1] — before landing on nestedField's condition list. record is always concrete
    // here, so every hop's element GetType() is concrete too; no permissive abstract-type fallback
    // is ever needed on this write path (that's IsNestedConditionListField's validation-time job, not
    // this one's). Any resolution failure at any hop (unknown array property, out-of-range index —
    // #169's AC: caught here since only a live instance can know the real length, not the validation-time
    // shape check — a null element, or the terminal property not actually being a condition list on
    // this concrete element) returns null before any mutation, so a bad nested path can never
    // produce a partial write.
    private static IList<Condition>? ResolveNestedConditionList(
        object container, IReadOnlyList<(string ArrayProp, int Index)> segments, string nestedField)
    {
        var current = container;
        foreach (var (arrayProp, arrayIndex) in segments)
        {
            if (current.GetType().GetProperty(arrayProp)?.GetValue(current) is not System.Collections.IList array)
                return null;
            if (arrayIndex < 0 || arrayIndex >= array.Count) return null;
            if (array[arrayIndex] is not { } element) return null;
            current = element;
        }

        return current.GetType().GetProperty(nestedField)?.GetValue(current) as IList<Condition>;
    }

    // The one parser for this composed-path shape in the codebase (#184): ConditionPath (Edits/) no
    // longer keeps its own copy, since no production caller ever needed the parsed pieces themselves
    // — every caller only ever wanted this codec's yes/no answer (IsNestedConditionListField) or its
    // resolved write target (ResolveNestedConditionList above), both of which live here regardless.
    // Parses "Effects[2].Conditions" (one array hop) or "Effects[2].Conditions[1].Conditions" (two
    // hops), or any deeper composition, into its ordered array segments (property name + index, one
    // per enclosing array) and the terminal condition-list property name. False for anything that
    // doesn't match "(<name>[<nonneg-int>].)+<name>" — an empty path, a bracket with an empty
    // preceding name, an unbalanced bracket, a non-numeric or negative index, or nothing left after
    // the last segment — so a malformed path fails closed wherever it's checked. Always terminates:
    // each successful iteration strictly shortens the remaining string, so no separate depth guard is
    // needed here the way WalkNestedArrays needs one for live object-graph recursion above.
    private static bool TryParseNestedFieldPath(
        string conditionFieldPath, out IReadOnlyList<(string ArrayProp, int Index)> segments, out string nestedField)
    {
        var parsed = new List<(string, int)>();
        var rest = conditionFieldPath;

        while (true)
        {
            var openBracket = rest.IndexOf('[');
            if (openBracket < 0) break;
            if (openBracket == 0 || !TryParseSegment(rest, openBracket, out var segment, out var remainder))
            {
                segments = [];
                nestedField = "";
                return false;
            }

            parsed.Add(segment);
            rest = remainder;
        }

        if (parsed.Count == 0 || rest.Length == 0)
        {
            segments = [];
            nestedField = "";
            return false;
        }

        segments = parsed;
        nestedField = rest;
        return true;
    }

    // Parses one "<name>[<nonneg-int>]." segment starting at openBracket, returning the segment and
    // whatever text follows the segment's trailing dot (which may itself start a further segment, or
    // be the terminal nestedField — TryParseNestedFieldPath's loop decides which).
    private static bool TryParseSegment(
        string rest, int openBracket, out (string ArrayProp, int Index) segment, out string remainder)
    {
        segment = default;
        remainder = "";

        var closeBracket = rest.IndexOf(']', openBracket);
        if (closeBracket < 0) return false;

        var afterBracket = closeBracket + 1;
        if (afterBracket >= rest.Length || rest[afterBracket] != '.') return false;

        var indexStr = rest[(openBracket + 1)..closeBracket];
        if (!int.TryParse(indexStr, out var parsedIndex) || parsedIndex < 0) return false;

        segment = (rest[..openBracket], parsedIndex);
        remainder = rest[(afterBracket + 1)..];
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
    // ApplyFieldValue's record-level/list-level split. #183/#184: a composed fieldPath ("Effects[2].
    // Conditions" one level deep, or "Effects[2].Conditions[1].Conditions" two levels deep — a
    // nested list's own restage) routes through the same ResolveNestedConditionList walk
    // ApplyFieldValue's nested branch already uses, landing on the list-level ApplyListValue instead
    // of the scalar one.
    public ConditionApplyResult ApplyListValue(IMajorRecord record, string fieldPath, JsonElement newList)
    {
        if (TryParseNestedFieldPath(fieldPath, out var segments, out var nestedField))
        {
            return ResolveNestedConditionList(record, segments, nestedField) is { } conditions
                ? ApplyListValue(conditions, newList)
                : ConditionApplyResult.NotFound;
        }

        return record.GetType().GetProperty(fieldPath)?.GetValue(record) is IList<Condition> flatConditions
            ? ApplyListValue(flatConditions, newList)
            : ConditionApplyResult.NotFound;
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
