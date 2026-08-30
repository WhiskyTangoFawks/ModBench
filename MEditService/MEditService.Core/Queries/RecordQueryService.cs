using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Core.Queries;

public sealed class RecordQueryService(
    ILoadOrderMirror loadOrder,
    ISchemaReflector schemaReflector,
    IConflictClassifier conflictClassifier,
    ILogger<RecordQueryService>? logger = null,
    SourceFreshness? freshness = null) : IRecordQueryService
{
    private readonly ILoadOrderMirror _mirror = loadOrder;
    private readonly ISchemaReflector _schemaReflector = schemaReflector;
    private readonly IConflictClassifier _conflictClassifier = conflictClassifier;
    private readonly ILogger _logger = (ILogger?)logger ?? NullLogger.Instance;

    // #415 / #413 D3: the two point reads below are the record editor's and compare grid's own
    // answers, so they are where source text is re-checked against what the index stored. Optional
    // only so the many read-shape tests that construct this service directly keep compiling; the
    // default is the real validator, never a no-op, so production wiring cannot silently lose it.
    private readonly SourceFreshness _freshness =
        freshness ?? new SourceFreshness(loadOrder, NullLogger<SourceFreshness>.Instance);

    public IReadOnlyList<PluginResponse> GetPlugins()
    {
        var s = RequireLoadOrder();
        // #277 / ADR-0037: one whole-load-order classification per call, not per plugin — Classify
        // is already a single pass over every plugin's Masters list.
        //
        // #274: only once the load is complete. Classify answers "is this master anywhere in the
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

        // #278 / ADR-0035 amending ADR-0018: a record filter prunes records and record types, never
        // a plugin row — every plugin is still returned, and HasMatchingRecords is the additive fact
        // a caller (the composite's chevron) decides expandability from, not row presence.
        var matchingPlugins = RequireRepository().GetPluginsWithMatchingRecords(RequireSchemas().Keys);
        return [.. s.Plugins.Select(p => ToResponse(p, matchingPlugins.Contains(p.Name)))];
    }

    // The header isn't a browsable record type (User Story 7's "expand a plugin -> record types"
    // listing, or an unscoped "all types" search) — it's reached only via "Open Header" on the
    // plugin node. It stays a real schemas.Keys entry so GetRecord/GetCompare (a direct FormKey
    // lookup) can still resolve it; only these two browse-all-types paths exclude it.
    private const string HeaderTableName = "header";

    public IReadOnlyList<string> GetRecordTypes() =>
        [.. RequireSchemas().Keys.Where(t => t != HeaderTableName).Order()];

    public PagedResult<RecordSummary> GetRecords(string? type, string? plugin, string? search, int limit, int offset, string? origin = null)
    {
        var repository = RequireRepository();
        var schemas = RequireSchemas();
        // #34: the caller states which copy when it knows (a tree row does; it was built from one).
        // Otherwise the #296 behaviour stands — resolve server-side from the load order, since a
        // bare filename is all most callers have. Null when plugin itself is null (nothing to resolve).
        origin ??= plugin == null ? null : PluginOriginResolver.Resolve(_mirror.LoadOrder, plugin);

        if (type != null && !schemas.ContainsKey(type))
            return new PagedResult<RecordSummary>([], 0);

        IReadOnlyList<string> recordTypes = type != null ? [type] : [.. schemas.Keys.Where(t => t != HeaderTableName)];
        // #421: written as an if rather than `plugin == null ? null : new PluginKey(plugin, origin)`
        // — PluginKey's implicit string conversion makes that ternary's common-type inference reach
        // for the null literal via `string`, tripping CS8625 on PluginKey.Name.
        PluginKey? pluginKey = null;
        if (plugin != null) pluginKey = new PluginKey(plugin, origin);
        var query = new RecordQuery(RecordTypes: recordTypes, Plugin: pluginKey, Search: search, Limit: limit, Offset: offset);
        return repository.Search(query);
    }

    public RecordDetail? GetRecord(string formKey)
    {
        _freshness.Validate(formKey);
        var document = RequireRepository().GetDocument(formKey);
        return document == null ? null : ToRecordDetail(document);
    }

    public CompareResult? GetCompare(string formKey)
    {
        _freshness.Validate(formKey);
        var repository = RequireRepository();
        // ADR-0031: one memoizing cache per response — a FormKey repeated across sibling
        // cells/plugins/leaves (generic fields and VMAD alike) is resolved at most once.
        var resolveFormKey = FormKeyResolutionCache.Memoize(repository.Resolve);

        var stack = repository.GetOverrideStack(formKey);
        if (stack == null) return null;

        // #421: GetOverrideStack already resolved which record type this FormKey belongs to (the
        // loop this replaced tried every schema table in turn until one had overrides) — one call
        // where this used to be a scan.
        var committedOverrides = stack.Entries.Select(e => ToRecordDetail(e.Effective)).ToList();

        var heldPlugins = RequireLoadOrder().Plugins;
        // #34 / ADR-0036: keyed by the compound column identity, like everything else here
        // since #272. These two were the last filename-keyed structures in this method, safe
        // only while a load order could hold at most one plugin per filename — with a second copy
        // loaded, a filename key is ambiguous, and ToDictionary throws outright.
        var pluginMasters = heldPlugins.ToDictionary(p => ColumnKey.Of(p.Name, p.Origin), p => p.Masters);
        // #267 / ADR-0035: a non-participating plugin's override is indexed and browsable but
        // never contributes to conflict classification.
        var pluginParticipates = heldPlugins.ToDictionary(p => ColumnKey.Of(p.Name, p.Origin), p => p.Participates);
        var (classification, conflictAll, vmad, conditions) =
            ClassifyStack(stack, committedOverrides, pluginMasters, pluginParticipates, resolveFormKey);
        // #272 / ADR-0036: two live bugs fixed together here, both invisible on the
        // pre-#272 suite because every fixture used the elided Data origin.
        // (1) o.Origin was omitted from the CompareOverride constructor call entirely, so
        //     every override silently defaulted to PluginOrigin.DataDirectory regardless of
        //     its real origin — the wire's own `overrides[].origin` field was never correct
        //     for a non-Data-origin plugin.
        // (2) classification.PluginStates is keyed by ColumnKey.Of(o.Plugin, o.Origin) since
        //     B3, but this looked it up by bare o.Plugin — a miss for any non-Data-origin
        //     column, silently defaulting ConflictThis to OnlyOne. Elision only spares
        //     Data-origin plugins, and #269 records the providing mod folder as origin for
        //     nearly every plugin in a real load order, so this was live for essentially every
        //     conflicted record, not just a hypothetical two-origin case.
        var annotated = committedOverrides
            .ConvertAll(o => new CompareOverride(
                o.FormKey, o.Plugin, o.LoadOrderIndex, o.IsWinner, o.EditorId, o.Fields,
                classification.PluginStates.GetValueOrDefault(ColumnKey.Of(o.Plugin, o.Origin), ConflictThis.OnlyOne),
                Origin: o.Origin, RecordType: o.RecordType, IsPartialForm: o.IsPartialForm,
                IsPartialFormable: o.IsPartialFormable));

        var hasVmad = RequireSchemas()[stack.RecordType].HasVmad;
        return new CompareResult(annotated, classification.Diffs, conflictAll, hasVmad, vmad, conditions);
    }

    /// <summary>#364: every contested FormKey (<see cref="IRecordReads.GetContestedFormKeys"/> —
    /// already filter-narrowed the same way <c>GetRecordTypeCounts</c>/<c>Search</c> are, #278's
    /// mechanism, not a second one) whose record-wide <see cref="Queries.ConflictAll"/> is not
    /// OnlyOne/NoConflict — the Conflicts node's own listing. Computed through the exact same
    /// <see cref="ClassifyStack"/> helper <see cref="GetCompare"/> uses, so "is this record
    /// conflicting" can never answer differently here than it does when the record is actually
    /// opened.</summary>
    public IReadOnlyList<ConflictRecord> GetConflicts()
    {
        var repository = RequireRepository();
        var contested = repository.GetContestedFormKeys();
        if (contested.Count == 0) return [];

        var resolveFormKey = FormKeyResolutionCache.Memoize(repository.Resolve);
        var heldPlugins = RequireLoadOrder().Plugins;
        var pluginMasters = heldPlugins.ToDictionary(p => ColumnKey.Of(p.Name, p.Origin), p => p.Masters);
        var pluginParticipates = heldPlugins.ToDictionary(p => ColumnKey.Of(p.Name, p.Origin), p => p.Participates);

        var results = new List<ConflictRecord>();
        foreach (var formKey in contested)
        {
            var stack = repository.GetOverrideStack(formKey);
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
    /// (#421: reconstituted here from each entry's own document body via
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
        var classification = _conflictClassifier.Classify(committedOverrides, pluginMasters, resolveFormKey, pluginParticipates);
        var conflictAll = classification.ConflictAll;

        var gameRelease = RequireLoadOrder().GameRelease;
        // VMAD is outside the generic reflection pipeline, so classify it separately and fold
        // its conflict contribution into the record-level ConflictAll (computed on demand, never stored).
        var vmadInputs = stack.Entries
            .Select(e => new VmadPluginInput(
                e.Plugin.Name, e.LoadOrderIndex, RecordDocumentCodecs.GetVmad(e.Effective, gameRelease, _logger), e.Plugin.Origin!))
            .ToList();
        VmadCompare? vmad = null;
        if (vmadInputs.Any(i => i.Vmad != null))
        {
            var vmadResult = VmadConflictClassifier.Classify(vmadInputs, resolveFormKey, pluginParticipates);
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
            var conditionResult = ConditionConflictClassifier.Classify(conditionInputs, resolveFormKey, pluginParticipates);
            conditions = conditionResult.Compare;
            conflictAll = ConflictRules.Escalate(conflictAll, conditionResult.ConflictContribution);
        }

        return (classification, conflictAll, vmad, conditions);
    }

    public IReadOnlyList<PluginRecordTypeCount> GetPluginRecordTypes(string plugin, string? origin = null)
    {
        var repository = RequireRepository();
        // #34: stated by the caller when it knows which copy it is browsing (a tree row does),
        // else resolved server-side from the load order as it has been since #296.
        origin ??= PluginOriginResolver.Resolve(_mirror.LoadOrder, plugin);
        var schemas = RequireSchemas();

        // #421: one grouped query (GetRecordTypeCounts) replaces the per-type CountRecordsForPlugin
        // loop — the header is never in `records` (D8), so it is already absent from the result
        // without an explicit exclusion.
        return [.. repository.GetRecordTypeCounts(new PluginKey(plugin, origin))
            .Where(c => schemas.ContainsKey(c.Type))
            .Select(c => new PluginRecordTypeCount(c.Type, c.Count, schemas.DisplayNameFor(c.Type)))
            .OrderBy(r => r.Type)];
    }

    public IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey) =>
        RequireRepository().GetReferencedBy(targetFormKey);

    public IReadOnlyList<string> GetConditionFunctions() =>
        ConditionCodecRegistry.For(RequireLoadOrder().GameRelease.ToCategory())?.AvailableFunctions().ToList() ?? [];

    public IReadOnlyList<string> GetConditionRunOnTargets() =>
        ConditionCodecRegistry.For(RequireLoadOrder().GameRelease.ToCategory())?.AvailableRunOnTargets().ToList() ?? [];

    private static RecordDetail ToRecordDetail(RecordDocument document) =>
        new(document.FormKey, document.Plugin.Name, document.LoadOrderIndex, document.IsWinner, document.EditorId,
            document.Fields, Origin: document.Plugin.Origin!, RecordType: document.RecordType,
            IsPartialForm: document.IsPartialForm, IsPartialFormable: document.IsPartialFormable);

    private ILoadOrder RequireLoadOrder() =>
        _mirror.LoadOrder ?? throw new InvalidOperationException("No load order has been received.");

    private IRecordReads RequireRepository() =>
        _mirror.Repository ?? throw new InvalidOperationException("No load order has been received.");

    private IReadOnlyDictionary<string, Schema.RecordTableSchema> RequireSchemas() =>
        _schemaReflector.GetSchemas(RequireLoadOrder().GameRelease);
}
