using System.Collections.Concurrent;
using System.Reflection;
using Loqui;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Source;

/// <summary>
/// ADR-0042 decision 2's 2026-08 amendment: the round-trip verdict is <b>model identity</b>, not
/// byte identity. Every record in <c>parse(original)</c> must have a counterpart in
/// <c>parse(recompiled)</c> and vice versa, and Mutagen's own generated equality mask
/// (<c>&lt;Type&gt;MixIn.GetEqualsMask(rhs, EqualsMaskHelper.Include.OnlyFailures)</c>) must report
/// no failing field outside <see cref="GroupHeaderDerivedFields"/> — the one documented exclusion,
/// derived GRUP-header bytes Mutagen's own model backs onto a handful of record types, never a
/// record's own subrecord content.
///
/// <para><b>Why the mask, not bare <c>Equals</c>.</b> A survey over 684 real LitR plugins found
/// bare <c>Equals</c> false-negatives on byte-identical parses for whole record families (Armor,
/// ArmorAddon, Race, Package, …) — the generated mask is the one Mutagen API proven not to have that
/// defect.</para>
///
/// <para><b>Reached generically, by reflection, over the mask's own object graph — not its
/// <c>ToString()</c>.</b> The mask method is generated as a static extension on a per-type
/// <c>&lt;Type&gt;MixIn</c> class, not through a shared interface — there is no other way to call it
/// once for every Fallout4 record type without a per-type switch. Its result is a per-type generated
/// <c>&lt;Type&gt;.Mask&lt;bool&gt;</c> object, walked field-by-field/property-by-property
/// (<see cref="CollectFailingFields"/>) rather than through its printed text: parsing
/// <c>Mask&lt;TItem&gt;.ToString()</c> has two real, observed defects — its <c>Print</c> only
/// emits the type's <i>own</i> declared members, not inherited ones (so a corrupted <c>EditorID</c>,
/// declared on the base <c>MajorRecord.Mask</c>, never appeared at all), and a nested embedded record
/// (a <c>Worldspace</c>'s own <c>TopCell</c>) prints its inner <c>Cell.Mask</c>'s field names with no
/// qualifying prefix, so a <c>Cell.Timestamp</c> divergence reached through <c>TopCell</c> read back as
/// a bare "Timestamp" with no way to tell it apart from a genuine <c>Worldspace</c>-level field of the
/// same name for the exclusion list below. Reflecting on the mask object itself sidesteps both: .NET
/// member reflection already flattens inherited fields by default, and a nested <c>MaskItem&lt;bool,
/// TSub&gt;</c>'s own <c>Specific</c> carries its real declaring type (<c>TSub</c>), so the exclusion
/// check for a field reached through an embedded record is scoped to that record's own type, not its
/// container's.</para>
/// </summary>
public static class ModelIdentity
{
    /// <summary>
    /// The only exclusion ADR-0042 decision 2 allows: <c>(RecordType, FieldName)</c> pairs Mutagen's
    /// own generated model backs from an enclosing GRUP's own header bytes (a group timestamp/unknown
    /// word), never from the record's own subrecord stream. Scoped per record type, not a bare field
    /// name — <c>Unknown</c>/<c>Timestamp</c>-shaped names collide with genuine content elsewhere
    /// (<c>FaceFxPhonemes.Unknowns</c>, <c>PlacedObject.Unknown</c>, <c>ConditionData.Unknown3</c> are
    /// ordinary subrecord data on their own declaring types), so excluding by name alone would
    /// silently hide real divergence on those types. Confirmed against Mutagen source, not guessed:
    /// each entry's populating code assigns from the parse-time group header, not a subrecord reader.
    /// <c>RecordType</c> is the type that actually declares the field — for a field reached through an
    /// embedded record (a <c>Worldspace</c>'s own <c>TopCell</c>), that is the embedded record's own
    /// type (<c>Cell</c>), not the containing one.
    /// </summary>
    private static readonly HashSet<(string RecordType, string Field)> GroupHeaderDerivedFields =
    [
        ("Cell", "Timestamp"), ("Cell", "UnknownGroupData"),
        ("Cell", "PersistentTimestamp"), ("Cell", "PersistentUnknownGroupData"),
        ("Cell", "TemporaryTimestamp"), ("Cell", "TemporaryUnknownGroupData"),
        ("Worldspace", "SubCellsTimestamp"), ("Worldspace", "SubCellsUnknown"),
        // Found live against the LitR corpus:
        // the top-level SubCellsTimestamp/SubCellsUnknown pair above covers the group
        // wrapping every exterior block, but each individual block/sub-block is its own nested GRUP
        // with the same shape one level deeper (WorldspaceBlock_Generated.cs/WorldspaceSubBlock_Generated.cs:
        // "public Int32 LastModified"/"public Int32 Unknown", populated from that block's own group
        // header, confirmed by reading both files) — reached through Worldspace.SubCells's own indexed
        // list, which is exactly what CollectFailingFields's list-recursion exists to name correctly.
        ("WorldspaceBlock", "LastModified"), ("WorldspaceBlock", "Unknown"),
        ("WorldspaceSubBlock", "LastModified"), ("WorldspaceSubBlock", "Unknown"),
        ("Quest", "Timestamp"), ("Quest", "Unknown"),
        ("DialogTopic", "Timestamp"), ("DialogTopic", "Unknown"),
    ];

    /// <summary>One record that failed the model-identity verdict, or the whole-mod fallback when
    /// every individual record matched (header/container-only divergence).</summary>
    public sealed record Divergence(string RecordType, FormKey FormKey, string? EditorId, string Description);

    /// <summary>
    /// The verdict itself, in <paramref name="original"/>'s own GRUP order: the first record that does
    /// not survive a round trip, naming the record and (when the cause is a content difference rather
    /// than presence/absence) the specific field the mask disagrees on. <see langword="null"/> means
    /// every record — and, per decision 3, every excluded field aside — is model-identical.
    /// </summary>
    public static Divergence? FindFirst(IMod original, IFallout4Mod recompiled)
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

            var field = FirstNonExcludedFailingField(originalRecord, recompiledRecord);
            if (field != null)
            {
                return new Divergence(originalRecord.GetType().Name, originalRecord.FormKey, originalRecord.EditorID,
                    $"differs after being recompiled from its own tracked source — field '{field}' changed.");
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

    /// <summary>
    /// The allow-list: the <c>Fallout4ModHeader.Mask</c> fields Mutagen's own model treats as
    /// opaque or otherwise never normalizes on write — carried through purely as data, so a content
    /// corruption on any of them is a real defect, never an encoding artifact. A corruption on any of
    /// these would otherwise round-trip silently, because <see cref="FindFirst"/> only ever walks
    /// <c>original.EnumerateMajorRecords()</c>, and a <c>ModHeader</c> is not an
    /// <c>IMajorRecordGetter</c> — no per-record mask check ever reaches it. (That is also why the
    /// header needs its own indexing and read path, <c>Records.HeaderDocument</c>, even now that it
    /// is an ordinary <c>records</c> row: Mutagen's own enumeration cannot reach it either.)
    ///
    /// <para><b>Every one of these 7 has a test that corrupts that field alone and asserts the
    /// resulting refusal names it</b> (<c>ModelIdentityTests</c>' own
    /// <c>FindFirstHeaderFieldDivergence_ForEveryAllowListedField_...</c> theory, plus
    /// <c>TrackServiceTests</c>' end-to-end companion) — an allow-list entry with no such test does not
    /// belong here. <c>Author</c>/<c>Description</c> were checked empirically before joining this list,
    /// not assumed: <c>OpaqueHeaderFieldsRoundTripTests</c> proves they survive the whole-mod JSON door
    /// with distinguishable values, and Mutagen's own <c>ModHeaderWriteLogic</c> (the shared write path
    /// every header write goes through) never touches either — confirmed by reading it, not inferred.
    /// </para>
    ///
    /// <para><b>Deliberately an allow-list, not every <c>Mask</c> field, and the allow-list plus the
    /// exclusion table below together account for all 16 <c>Fallout4ModHeader.Mask</c> fields — ADR-0042's
    /// amendment carries the full partition and the excluded-field reasoning, not repeated here.
    /// </b> In short: <c>Flags</c>, <c>FormID</c>, <c>Version</c>, <c>FormVersion</c>, <c>Version2</c>
    /// are well-typed, semantically interpreted fields outside the "opaque data" scope;
    /// <c>Stats</c>' own <c>NoNextFormIDProcessing</c>/<c>RecordCountOption.NoCheck</c>
    /// (<see cref="Source.TrackService"/>'s own <c>VerifyRoundTrip</c>) skip Mutagen's recompute rather
    /// than compare it, so whatever the codec parsed survives this write untouched by construction;
    /// <c>MasterReferences</c> and <c>OverriddenForms</c> both have their own confirmed,
    /// currently-tested legitimate divergence paths (ADR-0038's content-derived master pruning — real
    /// fixtures in <c>MasterPruningRoundTripGateTests</c> — and <c>OverriddenFormsOption</c>
    /// respectively). A blanket mask sweep over every field would refuse those already-accepted cases;
    /// this list only ever fires on a field nothing else already explains.</para>
    ///
    /// <para><b><c>TransientTypes</c> is deliberately not on this list, despite being exactly the kind
    /// of opaque data this check exists for — a real, confirmed gap in what this mechanism can detect,
    /// not a legitimate-divergence exclusion.</b> <c>Fallout4ModHeader.Mask.TransientTypes</c> is a
    /// nested indexed-list mask (<c>MaskItem&lt;bool, IEnumerable&lt;MaskItemIndexed&lt;bool,
    /// TransientType.Mask&lt;bool&gt;?&gt;&gt;?&gt;</c>): <see cref="CollectFailingFields"/> recurses
    /// into a failing element and reports it against its own declaring type
    /// (<c>("TransientType", "FormType")</c>), never against the outer <c>TransientTypes</c> field name
    /// — by design, the same recursion that correctly scopes <see cref="GroupHeaderDerivedFields"/> to a
    /// nested record's own true owner. Matching <c>OpaqueHeaderFields</c> against raw
    /// <see cref="FailingFields"/> output therefore can never see a <c>TransientTypes</c> divergence,
    /// confirmed live: a per-item <c>FormType</c> corruption yields <c>[("TransientType", "FormType")]</c>,
    /// no allow-list match. Reattributing a nested leaf back to its outer field would require carrying
    /// the recursion path through <see cref="CollectFailingFields"/>, which is shared with the
    /// per-record check above and whose current per-leaf-type scoping is load-bearing there — not
    /// attempted here. Worse, a genuine list-<i>count</i> divergence (one side has an entry the other
    /// lacks) is invisible even in principle: confirmed live that <c>FailingFields</c> returns empty for
    /// a 1-item-vs-0-item <c>TransientTypes</c> list — Mutagen's own generated mask does not flag that
    /// shape as unequal at all. This mechanism cannot cover TNAM; a corrupted or dropped
    /// <c>TransientTypes</c> entry round-trips silently today — a known gap, owned
    /// separately.</para>
    /// </summary>
    internal static readonly HashSet<string> OpaqueHeaderFields =
        ["TypeOffsets", "Deleted", "Screenshot", "INTV", "INCC", "Author", "Description"];

    /// <summary>
    /// The header counterpart to <see cref="FindFirst"/>'s per-record mask check: the first
    /// <see cref="OpaqueHeaderFields"/> member Mutagen's own generated equality mask disagrees on
    /// between <paramref name="original"/>'s and <paramref name="recompiled"/>'s <c>ModHeader</c>, or
    /// <see langword="null"/> when every allow-listed field matches (every other mask failure is a
    /// known legitimate divergence per <see cref="OpaqueHeaderFields"/>'s own doc comment, and is
    /// deliberately not reported here).
    ///
    /// <para><b>FO4-shaped today.</b> Both the parameter type and <see cref="OpaqueHeaderFields"/>'
    /// own field names are <c>Fallout4ModHeader.Mask</c>'s — root <c>CLAUDE.md</c>'s "generalize across
    /// Bethesda games" rule is not answered here. <see cref="Source.TrackService.VerifyRoundTrip"/>,
    /// this method's one caller, is already FO4-narrowed the same way (its own
    /// <c>Fallout4Mod.CreateFromBinary(..., Fallout4Release.Fallout4)</c> call), so this does not add a
    /// new lock — but a future round-trip gate generalized to Skyrim/Starfield will need its own
    /// per-game header type and allow-list here, not a reuse of this one.</para>
    /// </summary>
    public static string? FindFirstHeaderFieldDivergence(IFallout4ModHeaderGetter original, IFallout4ModHeaderGetter recompiled)
    {
        foreach (var (_, field) in FailingFields(original, recompiled))
        {
            if (OpaqueHeaderFields.Contains(field))
                return field;
        }
        return null;
    }

    private static string? FirstNonExcludedFailingField(IMajorRecordGetter original, IMajorRecordGetter recompiled)
    {
        foreach (var (recordType, field) in FailingFields(original, recompiled))
        {
            if (!GroupHeaderDerivedFields.Contains((recordType, field)))
                return field;
        }
        return null;
    }

    /// <summary>
    /// Every <c>(RecordType, FieldName)</c> pair Mutagen's own generated equality mask disagrees on
    /// between <paramref name="original"/> and <paramref name="recompiled"/>, unfiltered by the
    /// exclusion list — <see cref="FindFirst"/>'s own building block, exposed so a test can assert
    /// against the raw mask directly rather than only through a whole-mod comparison.
    ///
    /// <para>Typed <see cref="ILoquiObjectGetter"/>, not <see cref="IMajorRecordGetter"/> —
    /// widened from a record-only seam to also serve <see cref="FindFirstHeaderFieldDivergence"/>'s
    /// <c>IFallout4ModHeaderGetter</c> comparison. <c>ILoquiObjectGetter</c> is the narrowest type both
    /// interfaces actually share (confirmed by reflecting on both interfaces' own
    /// <c>GetInterfaces()</c>), so a caller passing something with no Loqui-generated equality mask at
    /// all still fails to compile — <see cref="FindGetEqualsMaskMethod"/> resolves the real mask method
    /// off <c>original.GetType()</c>'s own concrete runtime type regardless, so this widen changes
    /// nothing about what reflection actually finds, only what the compiler lets a caller pass.</para>
    /// </summary>
    internal static IReadOnlyList<(string RecordType, string Field)> FailingFields(
        ILoquiObjectGetter original, ILoquiObjectGetter recompiled)
    {
        var method = FindGetEqualsMaskMethod(original.GetType());
        if (method == null) return [];

        var include = MaskHelperOnlyFailures(method);
        var mask = method.Invoke(null, [original, recompiled, include]);
        if (mask == null) return [];

        var results = new List<(string, string)>();
        CollectFailingFields(mask, original.GetType().Name, results);
        return results;
    }

    /// <summary>
    /// Walks one generated <c>Mask&lt;bool&gt;</c> object's own public members (fields and properties
    /// alike — Mutagen's generator uses both shapes across different record types) and, for each:
    /// a plain <c>bool</c> that is <see langword="false"/> is a failing scalar field, reported against
    /// <paramref name="recordTypeName"/>; a <c>Loqui.MaskItem&lt;bool, TSub&gt;</c> whose own
    /// <c>Overall</c> is <see langword="false"/> is a failing embedded record or collection:
    /// <list type="bullet">
    /// <item>a single embedded record (<c>Worldspace.TopCell</c>) recurses into its own
    /// <c>Specific</c> detail, scoped to <i>its own</i> declaring type — so the exclusion list sees the
    /// field's true owner, not its container's;</item>
    /// <item>an indexed list of embedded records (<c>Worldspace.SubCells</c>, each a
    /// <c>Loqui.MaskItemIndexed&lt;bool, TSub&gt;</c> — found live in the round-trip survey: a
    /// <c>WorldspaceBlock</c>'s <c>LastModified</c>/<c>Unknown</c> are exactly the same class of
    /// GRUP-header-derived field as <c>Cell.Timestamp</c>, just one list level deeper) recurses into
    /// every failing element the same way;</item>
    /// <item>anything else with no single typed detail to drill into (a list compared element-by-value
    /// rather than by nested mask, e.g. <c>Cell.Regions</c>) is reported at the current level, coarse
    /// but not misattributed.</item>
    /// </list>
    /// </summary>
    private static void CollectFailingFields(object mask, string recordTypeName, List<(string RecordType, string Field)> results)
    {
        foreach (var (name, value) in ReadableMembers(mask))
        {
            switch (value)
            {
                case null:
                    continue;
                case bool isEqual:
                    if (!isEqual) results.Add((recordTypeName, name));
                    continue;
            }

            var valueType = value.GetType();
            if (!valueType.IsGenericType || valueType.Name != "MaskItem`2") continue;

            // Loqui.MaskItem<T1, T2> declares Overall/Specific as plain public fields, not properties —
            // GetMemberValue below finds either shape, since the two Mutagen record types this class
            // has inspected agree on fields but nothing guarantees every Loqui version does.
            var overall = (bool)GetMemberValue(value, valueType, "Overall")!;
            if (overall) continue;

            var specific = GetMemberValue(value, valueType, "Specific");
            if (specific is System.Collections.IEnumerable items and not string)
            {
                CollectFailingIndexedItems(items, recordTypeName, name, results);
            }
            else if (specific != null && specific.GetType().DeclaringType is { } owningType)
            {
                CollectFailingFields(specific, owningType.Name, results);
            }
            else
            {
                results.Add((recordTypeName, name));
            }
        }
    }

    /// <summary>
    /// The indexed-list half of <see cref="CollectFailingFields"/>: each element is either a
    /// <c>Loqui.MaskItemIndexed&lt;bool, TSub&gt;</c> (recurse into <c>Specific</c>, same as a single
    /// nested record) or some other per-item shape a plain-value comparison produced (<c>Cell.Regions</c>'s
    /// <c>(int Index, bool Value)</c> tuples) — reported once, coarse, against
    /// <paramref name="fallbackField"/> at <paramref name="fallbackRecordType"/>, exactly as an
    /// undrillable single <c>Specific</c> would be.
    /// </summary>
    private static void CollectFailingIndexedItems(
        System.Collections.IEnumerable items, string fallbackRecordType, string fallbackField,
        List<(string RecordType, string Field)> results)
    {
        foreach (var item in items)
        {
            var itemType = item.GetType();
            if (itemType.Name != "MaskItemIndexed`2")
            {
                results.Add((fallbackRecordType, fallbackField));
                return;
            }

            var itemOverall = (bool)GetMemberValue(item, itemType, "Overall")!;
            if (itemOverall) continue;

            var itemSpecific = GetMemberValue(item, itemType, "Specific");
            if (itemSpecific != null && itemSpecific.GetType().DeclaringType is { } owningType)
                CollectFailingFields(itemSpecific, owningType.Name, results);
            else
                results.Add((fallbackRecordType, fallbackField));
        }
    }

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

    // One real plugin's worth of records can run to five figures, and Track's own gate calls
    // FailingFields once per record on the accept path (every record, not just a failing one) — the
    // underlying search walks every type in an assembly, so caching per record type is not an
    // optimization detail, it is the difference between this gate costing the measured
    // +40% on Track and costing minutes per mega-plugin. Keyed by the exact concrete record
    // type (Cell, Npc, …), never invalidated: the set of generated MixIn classes in a loaded Mutagen
    // assembly cannot change during a process's lifetime.
    private static readonly ConcurrentDictionary<Type, MethodInfo?> MethodByRecordType = new();

    /// <summary>
    /// The generated <c>&lt;Type&gt;MixIn.GetEqualsMask(this I&lt;Type&gt;Getter, I&lt;Type&gt;Getter,
    /// EqualsMaskHelper.Include)</c> extension for <paramref name="recordType"/>'s own most-derived
    /// interface — found once per type by reflection on its assembly's sealed <c>MixIn</c> classes.
    /// Only the most-derived overload is needed: unlike its own printed text (see this class's own doc
    /// comment), reflecting on the returned mask object's fields already reaches every inherited
    /// member, so there is no separate base-level call left to make.
    /// </summary>
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
