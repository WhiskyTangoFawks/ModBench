using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Core.Queries;

public sealed class RecordQueryService(
    ILoadOrderMirror loadOrder,
    SchemaReflector schemaReflector,
    ConflictClassifier conflictClassifier,
    ILogger<RecordQueryService>? logger = null,
    SourceFreshness? freshness = null) : IRecordQueryService
{
    private readonly ILoadOrderMirror _mirror = loadOrder;
    private readonly SchemaReflector _schemaReflector = schemaReflector;
    private readonly ConflictClassifier _conflictClassifier = conflictClassifier;
    private readonly ILogger _logger = (ILogger?)logger ?? NullLogger.Instance;

    // The two point reads below are the record editor's and compare grid's own
    // answers, so they are where source text is re-checked against what the index stored. Optional
    // only so the many read-shape tests that construct this service directly keep compiling; the
    // default is the real validator, never a no-op, so production wiring cannot silently lose it.
    private readonly SourceFreshness _freshness =
        freshness ?? new SourceFreshness(
            loadOrder, NullLogger<SourceFreshness>.Instance, new RecordTextCodec(NullLogger<RecordTextCodec>.Instance));

    public IReadOnlyList<PluginResponse> GetPlugins()
    {
        var s = RequireLoadOrder();
        // ADR-0037: one whole-load-order classification per call, not per plugin — Classify
        // is already a single pass over every plugin's Masters list.
        //
        // Only once the load is complete. Classify answers "is this master anywhere in the
        // load order", which a partial load order cannot answer — a master that is present on disk and
        // merely not opened yet is indistinguishable from one that is genuinely absent, and the
        // wrong answer is the alarming one. Reported as "no issues" while loading rather than as a
        // separate not-yet-computed value: the caller already knows the load is running (it is in
        // the same status), and inventing a third state here would put that knowledge in two places.
        IReadOnlyDictionary<string, IReadOnlyList<MasterIssue>> masterIssues =
            _mirror.Status.State == LoadOrderState.Ready
                ? MasterResolution.Classify(s.Plugins, s.LoadFailures)
                : new Dictionary<string, IReadOnlyList<MasterIssue>>();
        PluginResponse ToResponse(PluginMetadata p, bool hasMatchingRecords) =>
            PluginResponse.FromMetadata(p, masterIssues.GetValueOrDefault(p.Name), hasMatchingRecords);

        if (s.FilterSql is null)
            return [.. s.Plugins.Select(p => ToResponse(p, hasMatchingRecords: true))];

        // ADR-0035 amending ADR-0018: a record filter prunes records and record types, never
        // a plugin row — every plugin is still returned, and HasMatchingRecords is the additive fact
        // a caller (the composite's chevron) decides expandability from, not row presence.
        var matchingPlugins = RequireReads().GetPluginsWithMatchingRecords(RequireSchemas().Keys);
        return [.. s.Plugins.Select(p => ToResponse(p, matchingPlugins.Contains(p.Name)))];
    }

    // The header isn't a browsable record type (the "expand a plugin -> record types"
    // listing, or an unscoped "all types" search) — it's reached only via "Open Header" on the
    // plugin node. It stays a real schemas.Keys entry so GetRecord/GetCompare (a direct FormKey
    // lookup) can still resolve it; only these two browse-all-types paths exclude it.
    private const string HeaderTableName = "header";

    public IReadOnlyList<string> GetRecordTypes() =>
        [.. RequireSchemas().Keys.Where(t => t != HeaderTableName).Order()];

    public PagedResult<RecordSummary> GetRecords(string? type, string? plugin, string? search, int limit, int offset, string? origin = null)
    {
        var reads = RequireReads();
        var schemas = RequireSchemas();
        // The caller states which copy when it knows (a tree row does — it was built from one).
        // Otherwise resolve server-side from the load order, since a bare filename is all most
        // callers have. Null when plugin itself is null (nothing to resolve).
        origin ??= plugin == null ? null : PluginOriginResolver.Resolve(_mirror.LoadOrder, plugin);

        if (type != null && !schemas.ContainsKey(type))
            return new PagedResult<RecordSummary>([], 0);

        IReadOnlyList<string> recordTypes = type != null ? [type] : [.. schemas.Keys.Where(t => t != HeaderTableName)];
        // Written as an if rather than `plugin == null ? null : new PluginKey(plugin, origin)`
        // — PluginKey's implicit string conversion makes that ternary's common-type inference reach
        // for the null literal via `string`, tripping CS8625 on PluginKey.Name.
        PluginKey? pluginKey = null;
        if (plugin != null) pluginKey = new PluginKey(plugin, origin);
        var query = new RecordQuery(RecordTypes: recordTypes, Plugin: pluginKey, Search: search, Limit: limit, Offset: offset);
        return reads.Search(query);
    }

    public RecordDetail? GetRecord(string formKey)
    {
        _freshness.Validate(formKey);
        var document = RequireReads().GetDocument(formKey);
        return document == null ? null : ToRecordDetail(document);
    }

    public CompareResult? GetCompare(string formKey)
    {
        _freshness.Validate(formKey);
        var reads = RequireReads();
        // ADR-0031: one memoizing cache per response — a FormKey repeated across sibling
        // cells/plugins/leaves (generic fields and VMAD alike) is resolved at most once.
        var resolveFormKey = FormKeyResolutionCache.Memoize(reads.Resolve);

        var stack = reads.GetOverrideStack(formKey);
        if (stack == null) return null;

        var committedOverrides = stack.Entries.Select(e => ToRecordDetail(e.Effective)).ToList();

        var heldPlugins = RequireLoadOrder().Plugins;
        // ADR-0036: keyed by the compound column identity — with a second copy of one filename
        // loaded, a filename key is ambiguous, and ToDictionary throws outright.
        var pluginMasters = heldPlugins.ToDictionary(p => ColumnKey.Of(p.Name, p.Origin), p => p.Masters);
        // ADR-0035: a non-participating plugin's override is indexed and browsable but
        // never contributes to conflict classification.
        var pluginParticipates = heldPlugins.ToDictionary(p => ColumnKey.Of(p.Name, p.Origin), p => p.Participates);
        var (classification, conflictAll, vmad, conditions) =
            ClassifyStack(stack, committedOverrides, pluginMasters, pluginParticipates, resolveFormKey);
        // ADR-0036: Origin must be passed through explicitly (never left to default to
        // PluginOrigin.DataDirectory), and classification.PluginStates is keyed by
        // ColumnKey.Of(o.Plugin, o.Origin) — a bare-plugin lookup misses for any non-Data-origin
        // column, silently defaulting ConflictThis to OnlyOne.
        var annotated = committedOverrides
            .ConvertAll(o => new CompareOverride(
                o.FormKey, o.Plugin, o.LoadOrderIndex, o.IsWinner, o.EditorId, o.Fields,
                classification.PluginStates.GetValueOrDefault(ColumnKey.Of(o.Plugin, o.Origin), ConflictThis.OnlyOne),
                Origin: o.Origin, RecordType: o.RecordType, IsPartialForm: o.IsPartialForm,
                IsPartialFormable: o.IsPartialFormable));

        var hasVmad = RequireSchemas()[stack.RecordType].HasVmad;
        return new CompareResult(annotated, classification.Diffs, conflictAll, hasVmad, vmad, conditions);
    }

    /// <summary>Every contested FormKey (<see cref="IRecordReads.GetContestedFormKeys"/> —
    /// already filter-narrowed the same way <c>GetRecordTypeCounts</c>/<c>Search</c> are, one
    /// mechanism, not a second one) whose record-wide <see cref="Queries.ConflictAll"/> is not
    /// OnlyOne/NoConflict — the Conflicts node's own listing. Computed through the exact same
    /// <see cref="ClassifyStack"/> helper <see cref="GetCompare"/> uses, so "is this record
    /// conflicting" can never answer differently here than it does when the record is actually
    /// opened.</summary>
    public IReadOnlyList<ConflictRecord> GetConflicts()
    {
        var reads = RequireReads();
        var contested = reads.GetContestedFormKeys();
        if (contested.Count == 0) return [];

        var resolveFormKey = FormKeyResolutionCache.Memoize(reads.Resolve);
        var heldPlugins = RequireLoadOrder().Plugins;
        var pluginMasters = heldPlugins.ToDictionary(p => ColumnKey.Of(p.Name, p.Origin), p => p.Masters);
        var pluginParticipates = heldPlugins.ToDictionary(p => ColumnKey.Of(p.Name, p.Origin), p => p.Participates);

        var results = new List<ConflictRecord>();
        foreach (var formKey in contested)
        {
            var stack = reads.GetOverrideStack(formKey);
            // Defensive, not expected in practice: GetContestedFormKeys and this read share no
            // transaction, so a formKey it just reported could in principle be gone by the time
            // this asks for its stack. Skipped, not thrown — the same posture the rest of this
            // service takes toward a race with a concurrent write.
            if (stack == null) continue;

            var committedOverrides = stack.Entries.Select(e => ToRecordDetail(e.Effective)).ToList();
            var (_, conflictAll, _, _) =
                ClassifyStack(stack, committedOverrides, pluginMasters, pluginParticipates, resolveFormKey);
            // medit-record-editor.md's "no tint" rule: OnlyOne/NoConflict never render a badge, so
            // they never belong in this listing either — GetContestedFormKeys only proves "more
            // than one override entry exists", not that any of them actually differ from master.
            if (conflictAll is ConflictAll.OnlyOne or ConflictAll.NoConflict) continue;

            var winner = stack.Entries.FirstOrDefault(e => e.IsWinner) ?? stack.Entries[^1];
            results.Add(new ConflictRecord(
                new RecordSummary(
                    FormKey: winner.Effective.FormKey, Plugin: winner.Plugin.Name, LoadOrderIndex: winner.LoadOrderIndex,
                    IsWinner: true, EditorId: winner.Effective.EditorId, Origin: winner.Plugin.Origin ?? ""),
                conflictAll));
        }
        return results;
    }

    /// <summary>The record-wide classification both <see cref="GetCompare"/> and
    /// <see cref="GetConflicts"/> need — one definition of "what is this record's ConflictAll",
    /// so the two can never disagree. VMAD/conditions are outside the generic reflection pipeline
    /// (reconstituted here from each entry's own document body via
    /// <c>RecordDocumentCodecs</c>), so each is classified separately and its contribution folded
    /// into the generic result via <see cref="ConflictRules.Escalate"/> — mirroring the pattern for
    /// both. [ADR-0032]</summary>
    private (ClassifyResult Classification, ConflictAll ConflictAll, VmadCompare? Vmad, ConditionCompare? Conditions) ClassifyStack(
        RecordOverrides stack,
        IReadOnlyList<RecordDetail> committedOverrides,
        IReadOnlyDictionary<string, IReadOnlyList<string>> pluginMasters,
        IReadOnlyDictionary<string, bool> pluginParticipates,
        Func<string, RecordLookupEntry?> resolveFormKey)
    {
        var gameRelease = RequireLoadOrder().GameRelease;
        var classification = _conflictClassifier.Classify(committedOverrides, pluginMasters, gameRelease, resolveFormKey, pluginParticipates);
        var conflictAll = classification.ConflictAll;

        // VMAD is outside the generic reflection pipeline, so classify it separately and fold
        // its conflict contribution into the record-level ConflictAll (computed on demand, never stored).
        var vmadInputs = stack.Entries
            .Select(e => new VmadPluginInput(
                e.Plugin.Name, e.LoadOrderIndex, RecordDocumentCodecs.GetVmad(e.Effective, gameRelease, _logger), e.Plugin.Origin!))
            .ToList();
        VmadCompare? vmad = null;
        if (vmadInputs.Any(i => i.Vmad != null))
        {
            var vmadResult = VmadConflictClassifier.Classify(vmadInputs, gameRelease, resolveFormKey, pluginParticipates);
            vmad = vmadResult.Compare;
            conflictAll = ConflictRules.Escalate(conflictAll, vmadResult.ConflictContribution);
        }

        // Conditions (CTDA) are outside the reflection pipeline too — classify separately and
        // fold their contribution into the record-level ConflictAll, mirroring VMAD.
        var conditionCodec = ConditionCodecRegistry.For(gameRelease.ToCategory());
        var conditionInputs = stack.Entries
            .Select(e => new ConditionPluginInput(
                e.Plugin.Name, e.LoadOrderIndex, RecordDocumentCodecs.GetConditions(e.Effective, gameRelease, conditionCodec), e.Plugin.Origin!))
            .ToList();
        ConditionCompare? conditions = null;
        if (conditionInputs.Any(i => i.Owners.Count > 0))
        {
            var conditionResult = ConditionConflictClassifier.Classify(conditionInputs, gameRelease, resolveFormKey, pluginParticipates);
            conditions = conditionResult.Compare;
            conflictAll = ConflictRules.Escalate(conflictAll, conditionResult.ConflictContribution);
        }

        return (classification, conflictAll, vmad, conditions);
    }

    public IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(string plugin, string? origin = null)
    {
        var reads = RequireReads();
        // Stated by the caller when it knows which copy it is browsing (a tree row does),
        // else resolved server-side from the load order.
        origin ??= PluginOriginResolver.Resolve(_mirror.LoadOrder, plugin);
        var schemas = RequireSchemas();

        // The header is never in `records`, so it is already absent from the result without an
        // explicit exclusion.
        return [.. reads.GetRecordTypeCounts(new PluginKey(plugin, origin))
            .Where(c => schemas.ContainsKey(c.Type))
            .Select(c => new PluginRecordTypeCount(c.Type, c.Count, schemas.DisplayNameFor(c.Type)))
            .OrderBy(r => r.Type)];
    }

    public IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey) =>
        RequireReads().GetReferencedBy(targetFormKey);

    public IReadOnlyList<string> GetConditionFunctions() =>
        ConditionCodecRegistry.For(RequireLoadOrder().GameRelease.ToCategory())?.AvailableFunctions().ToList() ?? [];

    public IReadOnlyList<string> GetConditionRunOnTargets() =>
        ConditionCodecRegistry.For(RequireLoadOrder().GameRelease.ToCategory())?.AvailableRunOnTargets().ToList() ?? [];

    private static RecordDetail ToRecordDetail(RecordDocument document) =>
        new(document.FormKey, document.Plugin.Name, document.LoadOrderIndex, document.IsWinner, document.EditorId,
            document.Fields, Origin: document.Plugin.Origin!, RecordType: document.RecordType,
            IsPartialForm: document.IsPartialForm, IsPartialFormable: document.IsPartialFormable);

    private ILoadOrder RequireLoadOrder() => _mirror.RequireScope().LoadOrder;

    private IRecordReads RequireReads() => _mirror.RequireScope().Reads;

    private IReadOnlyDictionary<string, Schema.RecordTableSchema> RequireSchemas() =>
        _schemaReflector.GetSchemas(RequireLoadOrder().GameRelease);
}
