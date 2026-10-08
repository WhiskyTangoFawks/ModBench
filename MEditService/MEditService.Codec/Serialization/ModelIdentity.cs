using System.Collections.Concurrent;
using System.Reflection;
using Loqui;
using MEditService.Codec.Schema;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Codec.Serialization;

/// <summary>ADR-0006's round-trip verdict. Mutagen's equality mask is walked by
/// reflection rather than its ToString(), which omits inherited members; bare Equals has false
/// negatives.</summary>
public static class ModelIdentity
{
    /// <summary>One record that failed the model-identity verdict, or the whole-mod fallback when
    /// every individual record matched (header/container-only divergence).</summary>
    public sealed record Divergence(string RecordType, FormKey FormKey, string? EditorId, string Description)
    {
        /// <summary>The sentence a refusal quotes. A divergence at no FormKey is the mod header's, and
        /// its description already names the field.</summary>
        public string Describe() =>
            FormKey == FormKey.Null
                ? Description
                : $"{RecordType} {FormKey} (EditorID '{EditorId}') {Description}";
    }

    /// <summary>The whole verdict: the first record that does not survive a round trip, else the mod
    /// header field that does not. Null when the recompiled plugin is model-identical.</summary>
    public static Divergence? FindFirstDivergence(IModGetter original, IModGetter recompiled)
    {
        if (FindFirst(original, recompiled) is { } record) return record;

        // FindFirst never reaches ModHeader (not an IMajorRecordGetter); this is the header's own check,
        // scoped to OpaqueHeaderFields' allow-list — a blanket sweep would refuse legitimate divergence.
        return HeaderOf(original) is { } originalHeader && HeaderOf(recompiled) is { } recompiledHeader
               && FindFirstHeaderFieldDivergence(originalHeader, recompiledHeader) is { } field
            ? new Divergence(
                PluginHeader.RecordType, FormKey.Null, null,
                $"TES4 header field '{field}' changed after being recompiled from its own tracked source.")
            : null;
    }

    // Every game's mod type declares its own header class under this one member name; IModGetter
    // itself has none to bind to.
    private static ILoquiObjectGetter? HeaderOf(IModGetter mod) =>
        mod.GetType().GetProperty("ModHeader")?.GetValue(mod) as ILoquiObjectGetter;

    /// <summary>The first record, in <paramref name="original"/>'s GRUP order, that does not survive a
    /// round trip, naming the field the mask disagrees on, else the codec document path that differs;
    /// null when every record is model-identical.</summary>
    internal static Divergence? FindFirst(IModGetter original, IModGetter recompiled)
    {
        var recompiledByFormKey = recompiled.EnumerateMajorRecords().ToDictionary(r => r.FormKey);
        var originalFormKeys = new HashSet<FormKey>();
        foreach (var originalRecord in original.EnumerateMajorRecords())
        {
            originalFormKeys.Add(originalRecord.FormKey);
            if (!recompiledByFormKey.TryGetValue(originalRecord.FormKey, out var recompiledRecord))
            {
                return new Divergence(originalRecord.GetType().Name, originalRecord.FormKey, originalRecord.EditorID,
                    "is missing from the recompiled plugin.");
            }

            var normalizedOriginal = NormalizeEncoding(originalRecord);
            var normalizedRecompiled = NormalizeEncoding(recompiledRecord);

            // The mask lies by omission (a polymorphic hierarchy's derived-only fields bind through the
            // base overload and are never compared), so a mask-equal pair is never the verdict; the codec
            // document is.
            var changed = FailingFields(normalizedOriginal, normalizedRecompiled).FirstOrDefault()
                ?? FirstCodecDocumentDifference(normalizedOriginal, normalizedRecompiled, original.GameRelease);
            if (changed != null)
            {
                return new Divergence(originalRecord.GetType().Name, originalRecord.FormKey, originalRecord.EditorID,
                    $"differs after being recompiled from its own tracked source — field '{changed}' changed.");
            }
        }

        // The other direction — a record the recompile produced that the original never had.
        foreach (var recompiledRecord in recompiled.EnumerateMajorRecords())
        {
            if (!originalFormKeys.Contains(recompiledRecord.FormKey))
            {
                return new Divergence(recompiledRecord.GetType().Name, recompiledRecord.FormKey, recompiledRecord.EditorID,
                    "is present in the recompiled plugin but not present in the original.");
            }
        }

        return null;
    }

    /// <summary>The <c>Fallout4ModHeader.Mask</c> fields Mutagen carries as opaque data, so a corruption is
    /// a real defect. An allow-list, not every field: masters, stats and overridden forms have
    /// legitimate divergence paths (ADR-0006).</summary>
    internal static readonly HashSet<string> OpaqueHeaderFields =
        ["TypeOffsets", "Deleted", "Screenshot", "INTV", "INCC", "Author", "Description"];

    /// <summary>The first <see cref="OpaqueHeaderFields"/> member the mask disagrees on, or null. The
    /// allow-list is shared across games; only the TransientTypes check below is FO4-shaped.</summary>
    internal static string? FindFirstHeaderFieldDivergence(ILoquiObjectGetter original, ILoquiObjectGetter recompiled)
    {
        if (FailingFields(original, recompiled).FirstOrDefault(OpaqueHeaderFields.Contains) is { } field)
            return field;

        // The mask reports a TransientTypes item against the nested leaf's type and ignores a count
        // difference, so it is compared by plain values here.
        if (original is IFallout4ModHeaderGetter fromOriginal && recompiled is IFallout4ModHeaderGetter fromRecompiled
            && !TransientTypesMatch(fromOriginal, fromRecompiled))
        {
            return "TransientTypes";
        }
        return null;
    }

    private static bool TransientTypesMatch(IFallout4ModHeaderGetter original, IFallout4ModHeaderGetter recompiled)
    {
        var a = original.TransientTypes;
        var b = recompiled.TransientTypes;
        if (a.Count != b.Count) return false;
        for (var i = 0; i < a.Count; i++)
        {
            if (a[i].FormType != b[i].FormType) return false;
            if (!a[i].Links.Select(l => l.FormKey).SequenceEqual(b[i].Links.Select(l => l.FormKey)))
                return false;
        }
        return true;
    }

    // Both records through the codec, byte-compared.
    private static string? FirstCodecDocumentDifference(
        IMajorRecordGetter original, IMajorRecordGetter recompiled, Mutagen.Bethesda.GameRelease release)
    {
        var originalBytes = RecordTextCodec.SerializeToBytes(original, release);
        var recompiledBytes = RecordTextCodec.SerializeToBytes(recompiled, release);
        if (originalBytes.AsSpan().SequenceEqual(recompiledBytes)) return null;

        // Not byte-identical: decide structurally, honouring only the two model-equal respellings a rewrite
        // is entitled to — negative zero and a dictionary field's enumeration order.
        using var originalDoc = System.Text.Json.JsonDocument.Parse(originalBytes);
        using var recompiledDoc = System.Text.Json.JsonDocument.Parse(recompiledBytes);
        return FirstModelDifference(originalDoc.RootElement, recompiledDoc.RootElement, path: "", propertyName: null);
    }

    private static string? FirstModelDifference(
        System.Text.Json.JsonElement a, System.Text.Json.JsonElement b, string path, string? propertyName)
    {
        if (a.ValueKind != b.ValueKind) return path;
        switch (a.ValueKind)
        {
            case System.Text.Json.JsonValueKind.Object:
                var aProps = a.EnumerateObject().ToDictionary(p => p.Name, p => p.Value, StringComparer.Ordinal);
                var bProps = b.EnumerateObject().ToDictionary(p => p.Name, p => p.Value, StringComparer.Ordinal);
                foreach (var name in aProps.Keys.Union(bProps.Keys))
                {
                    var namePath = path.Length == 0 ? name : $"{path}.{name}";
                    if (!aProps.TryGetValue(name, out var aValue) || !bProps.TryGetValue(name, out var bValue))
                        return namePath;
                    if (FirstModelDifference(aValue, bValue, namePath, name) is { } difference) return difference;
                }
                return null;
            case System.Text.Json.JsonValueKind.Array:
                var aItems = a.EnumerateArray().ToList();
                var bItems = b.EnumerateArray().ToList();
                if (aItems.Count != bItems.Count) return path;
                // Keyed comparison needs BOTH the {Key, Value} shape and a reflected dictionary property name:
                // NpcMorph is an ordered list whose elements are also exactly {Key, Value}.
                if (aItems.Count > 0 && propertyName != null && DictionaryPropertyNames.Value.Contains(propertyName)
                    && aItems.All(IsKeyValueEntry) && bItems.All(IsKeyValueEntry))
                {
                    // A duplicated key on either side is not a dictionary any more — unequal
                    // rather than a thrown error or a guessed pairing.
                    var byKey = new Dictionary<string, System.Text.Json.JsonElement>(StringComparer.Ordinal);
                    foreach (var entry in bItems)
                    {
                        if (!byKey.TryAdd(entry.GetProperty("Key").GetRawText(), entry)) return path;
                    }
                    var seenKeys = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var entry in aItems)
                    {
                        var key = entry.GetProperty("Key").GetRawText();
                        var keyPath = $"{path}[{key}]";
                        if (!seenKeys.Add(key) || !byKey.TryGetValue(key, out var match)) return keyPath;
                        if (FirstModelDifference(entry.GetProperty("Value"), match.GetProperty("Value"), keyPath, propertyName)
                            is { } difference)
                            return difference;
                    }
                    return null;
                }
                return aItems.Zip(bItems)
                    .Select((pair, i) => FirstModelDifference(pair.First, pair.Second, $"{path}[{i}]", propertyName))
                    .FirstOrDefault(difference => difference != null);
            case System.Text.Json.JsonValueKind.String:
                return NormalizeNegativeZeros(DocumentNodes.StringValueOf(a)) == NormalizeNegativeZeros(DocumentNodes.StringValueOf(b))
                    ? null
                    : path;
            case System.Text.Json.JsonValueKind.Number:
                // Only zero's spellings are tolerated (-0 vs 0) — a general numeric comparison
                // would silently forgive genuinely different large integers that collapse to one
                // double. Text-shaped on purpose: no float arithmetic decides identity here.
                return a.GetRawText() == b.GetRawText() || (IsZeroSpelling(a.GetRawText()) && IsZeroSpelling(b.GetRawText()))
                    ? null
                    : path;
            default:
                return null; // kinds already matched: true/false/null carry no further content
        }
    }

    private static bool IsZeroSpelling(string rawNumber) => rawNumber is "0" or "-0" or "0.0" or "-0.0";

    // Reflected once, never hand-listed; gates the keyed comparison so a merely dictionary-shaped list
    // never compares order-insensitively.
    private static readonly Lazy<HashSet<string>> DictionaryPropertyNames = new(() =>
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var type in typeof(Fallout4Mod).Assembly.GetTypes())
        {
            if (!type.IsClass || type.IsAbstract) continue;
            foreach (var property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                var candidates = property.PropertyType.GetInterfaces().Append(property.PropertyType);
                if (candidates.Any(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IReadOnlyDictionary<,>)))
                    names.Add(property.Name);
            }
        }
        return names;
    });

    private static bool IsKeyValueEntry(System.Text.Json.JsonElement element)
    {
        if (element.ValueKind != System.Text.Json.JsonValueKind.Object) return false;
        var names = element.EnumerateObject().Select(p => p.Name).ToList();
        return names.Count == 2 && names.Contains("Key") && names.Contains("Value");
    }

    // A standalone -0 token becomes 0; the lookbehind keeps a -0 inside an identifier ("Mk-0") untouched.
    private static string NormalizeNegativeZeros(string text) =>
        System.Text.RegularExpressions.Regex.Replace(text, @"(?<![\w.])-0(?=$|[,\s""\]}])", "0");


    // Deep copies without the encoding a rewrite is entitled to change: group-header-derived fields
    // zeroed, and a worldspace's block levels in one canonical order (ADR-0006).
    private static IMajorRecordGetter NormalizeEncoding(IMajorRecordGetter record)
    {
        switch (record)
        {
            case ICellGetter cell:
                var cellCopy = cell.DeepCopy();
                ZeroCellGroupFields(cellCopy);
                return cellCopy;
            case IWorldspaceGetter worldspace:
                var worldspaceCopy = worldspace.DeepCopy();
                worldspaceCopy.SubCellsTimestamp = 0;
                worldspaceCopy.SubCellsUnknown = 0;
                foreach (var block in worldspaceCopy.SubCells)
                {
                    block.LastModified = 0;
                    block.Unknown = 0;
                    foreach (var subBlock in block.Items)
                    {
                        subBlock.LastModified = 0;
                        subBlock.Unknown = 0;
                        foreach (var nestedCell in subBlock.Items) ZeroCellGroupFields(nestedCell);
                        subBlock.Items.SetTo(subBlock.Items.OrderBy(c => c.FormKey.ToString(), StringComparer.Ordinal).ToList());
                    }
                    block.Items.SetTo(block.Items.OrderBy(s => s.BlockNumberX).ThenBy(s => s.BlockNumberY).ToList());
                }
                worldspaceCopy.SubCells.SetTo(worldspaceCopy.SubCells.OrderBy(b => b.BlockNumberX).ThenBy(b => b.BlockNumberY).ToList());
                if (worldspaceCopy.TopCell is { } topCell) ZeroCellGroupFields(topCell);
                return worldspaceCopy;
            case IQuestGetter quest:
                var questCopy = quest.DeepCopy();
                questCopy.Timestamp = 0;
                questCopy.Unknown = 0;
                foreach (var nestedTopic in questCopy.DialogTopics) ZeroTopicGroupFields(nestedTopic);
                return questCopy;
            case IDialogTopicGetter topic:
                var topicCopy = topic.DeepCopy();
                ZeroTopicGroupFields(topicCopy);
                return topicCopy;
            default:
                return record;
        }
    }

    private static void ZeroTopicGroupFields(DialogTopic topic)
    {
        topic.Timestamp = 0;
        topic.Unknown = 0;
    }

    private static void ZeroCellGroupFields(Cell cell)
    {
        cell.Timestamp = 0;
        cell.UnknownGroupData = 0;
        cell.PersistentTimestamp = 0;
        cell.PersistentUnknownGroupData = 0;
        cell.TemporaryTimestamp = 0;
        cell.TemporaryUnknownGroupData = 0;
    }

    /// <summary>Every field name the generated mask disagrees on.
    /// Typed <see cref="ILoquiObjectGetter"/>, the narrowest type records and the mod header share, so
    /// a caller with no generated mask fails to compile.</summary>
    internal static IEnumerable<string> FailingFields(
        ILoquiObjectGetter original, ILoquiObjectGetter recompiled)
    {
        var method = FindGetEqualsMaskMethod(original.GetType());
        if (method == null) return [];

        var include = MaskHelperOnlyFailures(method);
        var mask = method.Invoke(null, [original, recompiled, include]);
        if (mask == null) return [];

        var results = new List<string>();
        CollectFailingFields(mask, results);
        return results;
    }

    // A false bool is a failing scalar; a MaskItem whose Overall is false recurses into its Specific
    // mask, or into each failing indexed item.
    private static void CollectFailingFields(object mask, List<string> results)
    {
        foreach (var (name, value) in ReadableMembers(mask))
        {
            switch (value)
            {
                case null:
                    continue;
                case bool isEqual:
                    if (!isEqual) results.Add(name);
                    continue;
            }

            var valueType = value.GetType();
            if (!valueType.IsGenericType || valueType.Name != "MaskItem`2") continue;

            // Loqui.MaskItem declares Overall/Specific as public fields; GetMemberValue finds either shape.
            var overall = (bool)(GetMemberValue(value, valueType, "Overall")
                ?? throw new InvalidOperationException($"Expected '{valueType.Name}' to declare 'Overall'."));
            if (overall) continue;

            var specific = GetMemberValue(value, valueType, "Specific");
            if (specific is System.Collections.IEnumerable items and not string)
            {
                CollectFailingIndexedItems(items, name, results);
            }
            else if (IsGeneratedMask(specific))
            {
                CollectFailingFields(specific, results);
            }
            else
            {
                results.Add(name);
            }
        }
    }

    // A non-MaskItemIndexed item (Cell.Regions' tuples) is reported once, coarse, against the fallback
    // field.
    private static void CollectFailingIndexedItems(
        System.Collections.IEnumerable items, string fallbackField, List<string> results)
    {
        foreach (var item in items)
        {
            var itemType = item.GetType();
            if (itemType.Name != "MaskItemIndexed`2")
            {
                results.Add(fallbackField);
                return;
            }

            var itemOverall = (bool)(GetMemberValue(item, itemType, "Overall")
                ?? throw new InvalidOperationException($"Expected '{itemType.Name}' to declare 'Overall'."));
            if (itemOverall) continue;

            var itemSpecific = GetMemberValue(item, itemType, "Specific");
            if (IsGeneratedMask(itemSpecific))
                CollectFailingFields(itemSpecific, results);
            else
                results.Add(fallbackField);
        }
    }

    // Loqui generates each mask as a type nested in the class it masks.
    private static bool IsGeneratedMask([System.Diagnostics.CodeAnalysis.NotNullWhen(true)] object? candidate) =>
        candidate?.GetType().DeclaringType != null;

    private static object? GetMemberValue(object instance, Type type, string memberName) =>
        type.GetField(memberName, BindingFlags.Public | BindingFlags.Instance) is { } field
            ? field.GetValue(instance)
            : type.GetProperty(memberName, BindingFlags.Public | BindingFlags.Instance)?.GetValue(instance);

    private static IEnumerable<(string Name, object? Value)> ReadableMembers(object mask)
    {
        var type = mask.GetType();
        foreach (var field in type.GetFields(BindingFlags.Public | BindingFlags.Instance))
            yield return (field.Name, field.GetValue(mask));
        foreach (var prop in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (!prop.CanRead || prop.GetIndexParameters().Length > 0) continue;
            yield return (prop.Name, prop.GetValue(mask));
        }
    }

    private static object MaskHelperOnlyFailures(MethodInfo method) =>
        Enum.Parse(method.GetParameters()[2].ParameterType, "OnlyFailures");

    // FailingFields runs once per record on the accept path and the search walks every type in an
    // assembly; caching per record type is the difference between +40% on Track and minutes per
    // mega-plugin.
    private static readonly ConcurrentDictionary<Type, MethodInfo?> MethodByRecordType = new();

    // Only the most-derived GetEqualsMask overload: reflecting on the mask object already reaches every
    // inherited member.
    private static MethodInfo? FindGetEqualsMaskMethod(Type recordType) =>
        MethodByRecordType.GetOrAdd(recordType, static recordType =>
            recordType.Assembly.GetTypes()
                .Where(t => t.IsAbstract && t.IsSealed && t.Name.EndsWith("MixIn", StringComparison.Ordinal))
                .SelectMany(t => t.GetMethods(BindingFlags.Public | BindingFlags.Static))
                .Where(mi => mi.Name == "GetEqualsMask"
                    && mi.GetParameters().Length == 3
                    && mi.GetParameters()[0].ParameterType.IsAssignableFrom(recordType))
                .OrderByDescending(mi => mi.GetParameters()[0].ParameterType.GetInterfaces().Length)
                .FirstOrDefault());
}
