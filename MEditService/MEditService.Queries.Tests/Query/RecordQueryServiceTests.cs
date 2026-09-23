using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Queries;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Queries.Tests.Query;

public sealed class RecordQueryServiceTests
{
    private static readonly GameRelease Release = GameRelease.Fallout4;
    private const string PluginName = "TestPlugin.esp";
    private const int RecordCount = 2;

    private readonly FakeIndex _manager;
    private readonly FakeReads _reads;
    private readonly RecordQueryService _svc;
    private readonly FormKey _npc01Key;

    public RecordQueryServiceTests()
    {
        FormKey npc01Key = default;
        var fixture = new FakeFixtureBuilder(Release)
            .WithPlugin(PluginName, mod =>
            {
                var npc01 = mod.Npcs.AddNew("TestNPC01");
                npc01.Aggression = Npc.AggressionType.Aggressive; // non-default, so the column isn't skipped as absent
                npc01Key = npc01.FormKey;
                mod.Npcs.AddNew("TestNPC02");
            })
            .Build("Aggression");
        (_manager, var svc) = Build(fixture);
        _reads = (FakeReads)_manager.RequireReads();
        _svc = svc;
        _npc01Key = npc01Key;
    }

    private static (FakeIndex Manager, RecordQueryService Service) Build(FakeFixtureData fixture)
    {
        var (manager, holder) = FakeIndex.From(fixture);
        return (manager, new RecordQueryService(manager, holder, SharedSchemaReflector.Instance, new ConflictClassifier()));
    }

    // --- GET /plugins ---

    [Fact]
    public void GetPlugins_ReturnsLoadedPlugin()
    {
        var plugins = _svc.GetPlugins();

        Assert.Single(plugins);
        Assert.Equal(PluginName, plugins[0].Copy.Name);
        Assert.Equal(RecordCount, plugins[0].Content.RecordCount);
    }

    // The plugin row's "has a failure below it" comes from the Index's own set of copies holding an
    // unreadable record, so one copy carries the flag and its neighbour does not.
    [Fact]
    public void GetPlugins_MarksOnlyThePluginHoldingAnUnreadableRecord()
    {
        const string otherPlugin = "Other.esp";
        var fixture = new FakeFixtureBuilder(Release)
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("Unreadable"))
            .WithPlugin(otherPlugin, mod => mod.Npcs.AddNew("Readable"))
            .Build("Aggression");
        var (_, svc) = Build(fixture with
        {
            Rows = [.. fixture.Rows.Select(r => r.Plugin.Name == PluginName
                ? r with { Document = r.Document with { ParseDiagnosis = "could not be read" } }
                : r)],
        });

        var plugins = svc.GetPlugins();

        Assert.True(plugins.Single(p => p.Copy.Name == PluginName).HasParseFailure);
        Assert.False(plugins.Single(p => p.Copy.Name == otherPlugin).HasParseFailure);
    }

    // ADR-0007 invariant 3: a tracked plugin loads from its source, so which truth the rows came
    // from is the Index's answer. Keyed by copy, never by filename.
    [Fact]
    public void GetPlugins_MarksOnlyTheCopiesTheIndexDerivedFromASourceTree()
    {
        const string otherPlugin = "Other.esp";
        var fixture = new FakeFixtureBuilder(Release)
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("Tracked"))
            .WithPlugin(otherPlugin, mod => mod.Npcs.AddNew("Untracked"))
            .Build("Aggression");
        var (manager, svc) = Build(fixture);
        ((FakeReads)manager.RequireReads()).Tracked =
            new HashSet<PluginCopyKey>(fixture.Copies.Where(c => c.Name == PluginName).Select(c => c.Key),
                PluginCopyKey.Comparer);

        var plugins = svc.GetPlugins();

        Assert.True(plugins.Single(p => p.Copy.Name == PluginName).IsTracked);
        Assert.False(plugins.Single(p => p.Copy.Name == otherPlugin).IsTracked);
    }

    // ADR-0012: a plugin declaring a master absent from the whole load order is flagged on the
    // wire, not just detected in-memory — this is what lets the tree render it.
    [Fact]
    public void GetPlugins_PluginWithMissingMaster_ReportsItAsDirectlyMissing()
    {
        var fixture = new FakeFixtureBuilder(Release)
            .WithPlugin("Patch.esp", mod => mod.Npcs.AddNew("PatchedNpc").Race.SetTo(
                new FormKey(ModKey.FromFileName("Ghost.esm"), 0x800)))
            .Build();
        var (_, svc) = Build(fixture);

        var plugins = svc.GetPlugins();

        var patch = Assert.Single(plugins, p => p.Copy.Name == "Patch.esp");
        var issue = Assert.Single(patch.MasterIssues);
        Assert.Equal("Ghost.esm", issue.MasterName);
        Assert.Equal(MasterIssueKind.DirectlyMissing, issue.Kind);
    }

    // ADR-0012 end to end: a whole load order built via the real codec's own reference resolution,
    // where the referenced master is not part of the load order at all.
    [Fact]
    public void GetRecord_ReferenceIntoAbsentMaster_RendersUnresolvedRatherThanErroring()
    {
        FormKey npcFormKey = default;
        var fixture = new FakeFixtureBuilder(Release)
            .WithPlugin("Patch.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("PatchedNpc");
                npcFormKey = npc.FormKey;
                npc.Race.SetTo(new FormKey(ModKey.FromFileName("Ghost.esm"), 0x800));
            })
            .Build("Race");
        var (_, svc) = Build(fixture);

        var detail = svc.GetRecord(npcFormKey.ToString());

        Assert.NotNull(detail);
        var raceField = Assert.Single(detail.Fields, f => f.Metadata.Name == "Race");
        var raceValue = raceField.Value;
        Assert.NotNull(raceValue);
        Assert.Contains("Ghost.esm", raceValue.ToString());
        Assert.Contains("Could not be resolved", raceField.CheckError);
    }

    [Fact]
    public void GetPlugins_PluginWithNoMissingMasters_ReportsEmptyMasterIssues()
    {
        var plugins = _svc.GetPlugins();

        Assert.Empty(plugins[0].MasterIssues);
    }

    // Matching, sorting and paging are the real Index's own behaviour, covered at
    // Index.Tests/Query/RecordReadsTests.cs. This service's own job is building the RecordQuery,
    // resolving type and origin, and returning reads.Search's answer untouched.

    [Fact]
    public void GetRecords_KnownType_ForwardsSearchLimitOffsetUntouchedIntoTheQuery()
    {
        _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 7, offset: 3);

        var query = _reads.LastSearch;
        Assert.NotNull(query);
        Assert.Equal(["npc_"], query.RecordTypes);
        Assert.Equal("TestNPC01", query.Search);
        Assert.Equal(7, query.Limit);
        Assert.Equal(3, query.Offset);
    }

    [Fact]
    public void GetRecords_NoType_QueriesEveryNonHeaderSchemaType()
    {
        _svc.GetRecords(type: null, plugin: null, search: null, limit: 10, offset: 0);

        var query = _reads.LastSearch;
        Assert.NotNull(query);
        var recordTypes = query.RecordTypes;
        Assert.NotNull(recordTypes);
        var schemas = SharedSchemaReflector.Instance.GetSchemas(Release);
        var expected = schemas.Keys.Where(t => t != PluginHeader.RecordType).OrderBy(t => t, StringComparer.Ordinal);
        Assert.Equal(expected, recordTypes.OrderBy(t => t, StringComparer.Ordinal));
    }

    [Fact]
    public void GetRecords_WithPlugin_ResolvesOriginFromTheLoadOrder()
    {
        _svc.GetRecords(type: "npc_", plugin: PluginName, search: null, limit: 10, offset: 0);

        var query = _reads.LastSearch;
        Assert.NotNull(query);
        Assert.Equal(PluginName, query.Plugin);
        Assert.Equal("Data", query.Origin);
    }

    [Fact]
    public void GetRecords_WithExplicitOrigin_SkipsLoadOrderResolution()
    {
        _svc.GetRecords(type: "npc_", plugin: PluginName, search: null, limit: 10, offset: 0, origin: "OtherOrigin");

        var query = _reads.LastSearch;
        Assert.NotNull(query);
        Assert.Equal("OtherOrigin", query.Origin);
    }

    [Fact]
    public void GetRecords_ReturnsExactlyWhatReadsSearchProvides()
    {
        _reads.SearchResult = new PagedResult<RecordSummary>(
            [new RecordSummary("000800:Test.esp", PluginName, 0, IsWinner: true, "FromFake", "Data")], 1);

        var result = _svc.GetRecords(type: "npc_", plugin: null, search: null, limit: 10, offset: 0);

        Assert.Same(_reads.SearchResult, result);
    }

    // --- GET /records/{formKey} ---

    // GetRecord_FieldsHaveMetadata needs the record's full derived column set to mean anything;
    // that lives at Index.Tests/Query/RecordReadsTests.cs (same name), over a real Index.

    [Fact]
    public void GetRecord_ReturnsWinnerWithFields()
    {
        var detail = _svc.GetRecord(_npc01Key.ToString());

        Assert.NotNull(detail);
        Assert.Equal(_npc01Key.ToString(), detail.FormKey);
        Assert.True(detail.IsWinner);
        Assert.NotEmpty(detail.Fields);
    }

    // "Copy as New Record" needs the record's schema table name up front (CreateRecord
    // validates RecordType before it even reads TemplateFormKey), so RecordDetail must carry it.
    [Fact]
    public void GetRecord_ReturnsRecordType()
    {
        var detail = _svc.GetRecord(_npc01Key.ToString());

        Assert.NotNull(detail);
        Assert.Equal("npc_", detail.RecordType);
    }

    // --- GET /records/{formKey}/compare ---

    [Fact]
    public void GetCompare_SingleOverride_ReturnsDiffs()
    {
        var compare = _svc.GetCompare(_npc01Key.ToString());

        Assert.NotNull(compare);
        Assert.Single(compare.Overrides);
        Assert.Equal(ConflictAll.OnlyOne, compare.ConflictAll);
        Assert.NotEmpty(compare.Diffs);
    }

    // ADR-0013: a FormKey present in one enabled and one disabled plugin is not a conflict —
    // the disabled override is indexed and browsable, but excluded from conflict classification.
    [Fact]
    public void GetCompare_FormKeyInEnabledAndDisabledPlugin_ReturnsOnlyOne_NotConflict()
    {
        FormKey npcKey = default;
        var fixture = new FakeFixtureBuilder(Release)
            .WithPlugin("Base.esp", mod => npcKey = mod.Npcs.AddNew("SharedNPC").FormKey)
            .WithPlugin("Disabled.esp", (mod, prev) =>
                mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).CalcMinLevel = 5, enabled: false)
            .Build();
        var (_, svc) = Build(fixture);

        var compare = svc.GetCompare(npcKey.ToString());

        Assert.NotNull(compare);
        Assert.Equal(ConflictAll.OnlyOne, compare.ConflictAll);
    }

    // ADR-0013. A third plugin makes this a two-participant NoConflict, not the OnlyOne shortcut;
    // only the disabled last plugin differs, which an unfiltered winner pass would escalate.
    [Fact]
    public void GetCompare_VmadDiffersOnlyInDisabledPlugin_ReturnsNoConflict()
    {
        FormKey npcKey = default;
        var fixture = new FakeFixtureBuilder(Release)
            .WithPlugin("Base.esp", mod => npcKey = MakeScriptedNpc(mod, 10))
            .WithPlugin("Mid.esp", (mod, prev) =>
                mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).VirtualMachineAdapter = ScriptVmad(10))
            .WithPlugin("Disabled.esp", (mod, prev) =>
                mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).VirtualMachineAdapter = ScriptVmad(20),
                enabled: false)
            .Build(VmadField);
        var (_, svc) = Build(fixture);

        var compare = svc.GetCompare(npcKey.ToString());

        Assert.NotNull(compare);
        Assert.Equal(ConflictAll.NoConflict, compare.ConflictAll);
    }

    // The record editor renders the column read-only from this member alone, so the compare wire
    // has to carry the diagnosis the Index put on the document rather than only the tree's listings.
    [Fact]
    public void GetCompare_CarriesTheDiagnosisTheDocumentArrivedWith()
    {
        const string diagnosis = "could not be read";
        FormKey npcKey = default;
        var fixture = new FakeFixtureBuilder(Release)
            .WithPlugin(PluginName, mod => npcKey = mod.Npcs.AddNew("Unreadable").FormKey)
            .Build("Aggression");
        var (_, svc) = Build(fixture with
        {
            Rows = [.. fixture.Rows.Select(r => r with { Document = r.Document with { ParseDiagnosis = diagnosis } })],
        });

        var compare = svc.GetCompare(npcKey.ToString());

        Assert.NotNull(compare);
        Assert.Equal(diagnosis, Assert.Single(compare.Overrides).ParseDiagnosis);
    }

    [Fact]
    public void GetCompare_LeavesAReadableRecordsColumnWithoutADiagnosis()
    {
        var compare = _svc.GetCompare(_npc01Key.ToString());

        Assert.NotNull(compare);
        Assert.All(compare.Overrides, o => Assert.Null(o.ParseDiagnosis));
    }

    [Fact]
    public void GetCompare_OverridesCarryRecordType()
    {
        var compare = _svc.GetCompare(_npc01Key.ToString());

        Assert.NotNull(compare);
        Assert.All(compare.Overrides, o => Assert.Equal("npc_", o.RecordType));
    }

    [Fact]
    public void GetCompare_RecordIdenticalExceptVmad_ClassifiesAsConflict()
    {
        FormKey npcKey = default;
        var fixture = new FakeFixtureBuilder(Release)
            .WithPlugin("Base.esp", mod => npcKey = MakeScriptedNpc(mod, 10))
            .WithPlugin("Mid.esp", (mod, prev) =>
                mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).VirtualMachineAdapter = ScriptVmad(20))
            .WithPlugin("Top.esp", (mod, prev) =>
                mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).VirtualMachineAdapter = ScriptVmad(30))
            .Build(VmadField);
        var (_, svc) = Build(fixture);

        var compare = svc.GetCompare(npcKey.ToString());

        Assert.NotNull(compare);
        // Non-VMAD fields are identical overrides, so only the adapter differs — yet the record
        // is conflicted, and the diff reaches the one property that disagrees.
        Assert.Equal(ConflictAll.Conflict, compare.ConflictAll);
        Assert.Equal("Top.esp", PowerPropertyDiff(compare).WinnerColumn);
    }

    [Fact]
    public void GetCompare_NoOverrideCarriesAnAdapter_OmitsTheFieldEntirely()
    {
        var compare = _svc.GetCompare(_npc01Key.ToString());

        Assert.NotNull(compare);
        Assert.DoesNotContain(compare.Diffs, d => d.FieldName == VmadField);
    }

    [Fact]
    public void GetCompare_OnlyOverrideCarriesAnAdapter_StillDiffsTheField()
    {
        FormKey npcKey = default;
        var fixture = new FakeFixtureBuilder(Release)
            .WithPlugin("Base.esp", mod => npcKey = mod.Npcs.AddNew("PlainNpc").FormKey) // no VMAD
            .WithPlugin("Over.esp", (mod, prev) =>
                mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).VirtualMachineAdapter = ScriptVmad(5))
            .Build(VmadField);
        var (_, svc) = Build(fixture);

        var compare = svc.GetCompare(npcKey.ToString());
        Assert.NotNull(compare);
        // The master carries no adapter and the override adds one → still a diff row.
        Assert.Contains(compare.Diffs, d => d.FieldName == VmadField);
        Assert.Equal(ConflictAll.Override, compare.ConflictAll);
    }

    [Fact]
    public void GetCompare_FieldOverrideAndVmadOverride_StaysOverride()
    {
        FormKey npcKey = default;
        var fixture = new FakeFixtureBuilder(Release)
            .WithPlugin("Base.esp", mod => npcKey = MakeScriptedNpc(mod, 10))
            .WithPlugin("Over.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.Aggression = Npc.AggressionType.Frenzied; // generic field override
                o.VirtualMachineAdapter = ScriptVmad(20); // VMAD override (2 plugins)
            })
            .Build("Aggression", VmadField);
        var (_, svc) = Build(fixture);

        var compare = svc.GetCompare(npcKey.ToString());
        Assert.NotNull(compare);
        Assert.Equal(ConflictAll.Override, compare.ConflictAll);
    }

    [Fact]
    public void GetCompare_FieldOverrideAndVmadConflict_EscalatesToConflict()
    {
        FormKey npcKey = default;
        var fixture = new FakeFixtureBuilder(Release)
            .WithPlugin("Base.esp", mod => npcKey = MakeScriptedNpc(mod, 10))
            .WithPlugin("Mid.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.Aggression = Npc.AggressionType.Frenzied; // non-masters agree on the field → generic Override
                o.VirtualMachineAdapter = ScriptVmad(20);
            })
            .WithPlugin("Top.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.Aggression = Npc.AggressionType.Frenzied;
                o.VirtualMachineAdapter = ScriptVmad(30); // VMAD differs among non-masters → Conflict
            })
            .Build("Aggression", VmadField);
        var (_, svc) = Build(fixture);

        var compare = svc.GetCompare(npcKey.ToString());
        Assert.NotNull(compare);
        Assert.Equal(ConflictAll.Conflict, compare.ConflictAll);
    }

    [Fact]
    public void GetCompare_UncontestedFieldOverrideWithVmadConflict_EscalatesToConflict()
    {
        // Verifies EscalateConflict(Override, Conflict) = Conflict (not Override).
        // Both Mid and Top set aggression to the same non-master value → generic = Override (not Conflict).
        // But their VMAD values differ → vmad = Conflict.
        // So EscalateConflict(Override, Conflict) must return Conflict.
        FormKey npcKey = default;
        var fixture = new FakeFixtureBuilder(Release)
            .WithPlugin("Base.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("EscalateTest");
                npc.Aggression = Npc.AggressionType.Unaggressive;
                npcKey = npc.FormKey;
            })
            .WithPlugin("Mid.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.Aggression = Npc.AggressionType.Frenzied; // both non-masters agree on Frenzied → Override
                o.VirtualMachineAdapter = ScriptVmad(10);
            })
            .WithPlugin("Top.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.Aggression = Npc.AggressionType.Frenzied; // same as Mid → no generic conflict
                o.VirtualMachineAdapter = ScriptVmad(20); // differs from Mid → VMAD Conflict
            })
            .Build("Aggression", VmadField);
        var (_, svc) = Build(fixture);

        var compare = svc.GetCompare(npcKey.ToString());
        Assert.NotNull(compare);
        Assert.Equal(ConflictAll.Conflict, compare.ConflictAll);
    }

    [Fact]
    public void GetCompare_ConflictedFieldWithUncontestedVmad_DoesNotDowngradeFromConflict()
    {
        // Escalation must take the more severe axis even when the generic side is the severe one and VMAD
        // is milder: Mid and Top disagree on aggression, and their VMAD is identical.
        FormKey npcKey = default;
        var fixture = new FakeFixtureBuilder(Release)
            .WithPlugin("Base.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("EscalateNoDowngradeTest");
                npc.Aggression = Npc.AggressionType.Unaggressive;
                npc.VirtualMachineAdapter = ScriptVmad(10);
                npcKey = npc.FormKey;
            })
            .WithPlugin("Mid.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.Aggression = Npc.AggressionType.Frenzied; // differs from Top below → generic Conflict
            })
            .WithPlugin("Top.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.Aggression = Npc.AggressionType.Aggressive; // differs from Mid → generic Conflict
            })
            .Build("Aggression", VmadField);
        var (_, svc) = Build(fixture);

        var compare = svc.GetCompare(npcKey.ToString());
        Assert.NotNull(compare);
        Assert.Equal(ConflictAll.Conflict, compare.ConflictAll);
    }

    [Fact]
    public void GetCompare_EquivalentGenericFieldAndVmadPropertyConflictLoss_ClassifyToSameConflictThis()
    {
        // ADR-0018: a generic field and a VMAD property in the same conflict shape (Mid overridden
        // by Top) must classify to the same ConflictThis per plugin — pins parity across the two classifiers.
        FormKey npcKey = default;
        var fixture = new FakeFixtureBuilder(Release)
            .WithPlugin("Base.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("ParityTest");
                npc.Aggression = Npc.AggressionType.Unaggressive;
                npc.VirtualMachineAdapter = ScriptVmad(10);
                npcKey = npc.FormKey;
            })
            .WithPlugin("Mid.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.Aggression = Npc.AggressionType.Frenzied;
                o.VirtualMachineAdapter = ScriptVmad(20);
            })
            .WithPlugin("Top.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.Aggression = Npc.AggressionType.Aggressive;
                o.VirtualMachineAdapter = ScriptVmad(30);
            })
            .Build("Aggression", VmadField);
        var (_, svc) = Build(fixture);

        var compare = svc.GetCompare(npcKey.ToString());
        Assert.NotNull(compare);
        var fieldStates = compare.Diffs.First(d => d.FieldName == "Aggression").CellStates;
        var vmadStates = PowerPropertyDiff(compare).CellStates;

        Assert.Equal(ConflictThis.ConflictLoses, fieldStates["Mid.esp"]);
        Assert.Equal(ConflictThis.ConflictWins, fieldStates["Top.esp"]);
        Assert.Equal(fieldStates["Mid.esp"], vmadStates["Mid.esp"]);
        Assert.Equal(fieldStates["Top.esp"], vmadStates["Top.esp"]);
    }

    // A condition list is an ordinary reflected array column, so it reaches the compare grid through
    // the one ConflictClassifier: one FieldDiff per condition, its members as that diff's children.
    [Fact]
    public void GetCompare_RecordHasConditions_ClassifiesThemAsFieldDiffChildren()
    {
        FormKey cobjKey = default;
        var fixture = new FakeFixtureBuilder(Release)
            .WithPlugin("Base.esp", mod =>
            {
                var cobj = mod.ConstructibleObjects.AddNew("Recipe");
                cobjKey = cobj.FormKey;
                cobj.Conditions.Add(new ConditionFloat
                {
                    CompareOperator = CompareOperator.EqualTo,
                    ComparisonValue = 1f,
                    Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
                });
            })
            .Build("Conditions");
        var (_, svc) = Build(fixture);

        var compare = svc.GetCompare(cobjKey.ToString());

        Assert.NotNull(compare);
        var conditions = Assert.Single(compare.Diffs, d => d.FieldName == "Conditions");
        var condition = Assert.Single(Children(conditions));
        var data0 = Assert.Single(Children(condition), c => c.FieldName == "Data");
        var function = Assert.Single(Children(data0), c => c.FieldName == "Function");
        Assert.Equal("GetIsID", function.Values["Base.esp"]?.ToString());
        Assert.Equal("Base.esp", conditions.WinnerColumn);
    }

    // GetCompare's memoized resolveFormKey (ADR-0005) reaches a condition's Form parameter through
    // the same nested-leaf path every other reflected formKey leaf uses — this proves the wiring at
    // the actual call site.
    [Fact]
    public void GetCompare_ConditionFormParameter_ResolvesEditorId()
    {
        FormKey cobjKey = default;
        var fixture = new FakeFixtureBuilder(Release)
            .WithPlugin("Base.esp", mod =>
            {
                var quest = mod.Quests.AddNew("SomeQuest");

                var cobj = mod.ConstructibleObjects.AddNew("Recipe");
                cobjKey = cobj.FormKey;
                var conditionData = new FunctionConditionData { Function = Condition.Function.GetStageDone };
                conditionData.ParameterOneRecord.SetTo(quest.FormKey);
                cobj.Conditions.Add(new ConditionFloat
                {
                    CompareOperator = CompareOperator.EqualTo,
                    ComparisonValue = 1f,
                    Data = conditionData,
                });
            })
            .Build("Conditions");
        var (_, svc) = Build(fixture);

        var compare = svc.GetCompare(cobjKey.ToString());

        Assert.NotNull(compare);
        var conditions = Assert.Single(compare.Diffs, d => d.FieldName == "Conditions");
        var condition = Assert.Single(Children(conditions));
        var data0 = Assert.Single(Children(condition), c => c.FieldName == "Data");
        var param = Assert.Single(Children(data0), c => c.FieldName == "ParameterOneRecord");
        var resolutions = param.Resolutions;
        Assert.NotNull(resolutions);
        var paramResolution = resolutions["Base.esp"];
        Assert.Equal(FormKeyResolutionState.ResolvedValidType, paramResolution.State);
        Assert.Equal("SomeQuest", paramResolution.EditorId);
    }

    private static FormKey MakeScriptedNpc(IFallout4Mod mod, int power)
    {
        var npc = mod.Npcs.AddNew("ScriptedNPC");
        npc.VirtualMachineAdapter = ScriptVmad(power);
        return npc.FormKey;
    }

    private const string VmadField = "VirtualMachineAdapter";

    private static IReadOnlyList<FieldDiff> Children(FieldDiff diff) =>
        diff.Children ?? throw new InvalidOperationException($"Expected \"{diff.FieldName}\" to have children.");

    private static FieldDiff PowerPropertyDiff(CompareResult compare)
    {
        var vmad = compare.Diffs.First(d => d.FieldName == VmadField);
        var scripts = Children(vmad).First(c => c.FieldName == "Scripts");
        var script = Children(scripts).First(c => c.FieldName == "S");
        var properties = Children(script).First(c => c.FieldName == "Properties");
        return Children(properties).First(c => c.FieldName == "Power");
    }

    private static VirtualMachineAdapter ScriptVmad(int power)
    {
        var vmad = new VirtualMachineAdapter();
        var script = new ScriptEntry { Name = "S", Flags = ScriptEntry.Flag.Local };
        script.Properties.Add(new ScriptIntProperty { Name = "Power", Data = power });
        vmad.Scripts.Add(script);
        return vmad;
    }

    [Fact]
    public void GetCompare_UnknownFormKey_ReturnsNull()
    {
        var compare = _svc.GetCompare("FFFFFF:Unknown.esp");

        Assert.Null(compare);
    }

    // --- GET /plugins/{plugin}/record-types ---

    private static readonly PluginCopyKey PluginKey = new(PluginName, "Data");

    [Fact]
    public void GetPluginRecordTypes_ReturnsCountsForPlugin()
    {
        _reads.RecordTypeCountsByPlugin = new Dictionary<PluginCopyKey, IReadOnlyList<RecordTypeCount>>
        {
            [PluginKey] = [new RecordTypeCount("npc_", RecordCount, HasParseFailure: false)],
        };

        var result = _svc.GetPluginRecordTypes(PluginName);

        var npc = Assert.Single(result, r => r.Type == "npc_");
        Assert.Equal(RecordCount, npc.Count);
        Assert.All(result, r => Assert.True(r.Count > 0));
    }

    // The record-type node's "has a failure below it" is the count row's own flag, so the type
    // holding the unreadable record carries it and its sibling does not.
    [Fact]
    public void GetPluginRecordTypes_MarksOnlyTheTypeWhoseCountCarriesAFailure()
    {
        _reads.RecordTypeCountsByPlugin = new Dictionary<PluginCopyKey, IReadOnlyList<RecordTypeCount>>
        {
            [PluginKey] =
            [
                new RecordTypeCount("perk", 1, HasParseFailure: true),
                new RecordTypeCount("npc_", 1, HasParseFailure: false),
            ],
        };

        var result = _svc.GetPluginRecordTypes(PluginName);

        Assert.True(Assert.Single(result, r => r.Type == "perk").HasParseFailure);
        Assert.False(Assert.Single(result, r => r.Type == "npc_").HasParseFailure);
    }

    [Fact]
    public void GetPluginRecordTypes_DisplayName_MatchesXEdit()
    {
        // The signature ("npc_") stays the key; DisplayName is additive, sourced
        // from the same xEdit-parity lookup SchemaReflector uses.
        _reads.RecordTypeCountsByPlugin = new Dictionary<PluginCopyKey, IReadOnlyList<RecordTypeCount>>
        {
            [PluginKey] = [new RecordTypeCount("npc_", 1, HasParseFailure: false)],
        };

        var result = _svc.GetPluginRecordTypes(PluginName);

        var npc = Assert.Single(result, r => r.Type == "npc_");
        Assert.Equal("Non-Player Character", npc.DisplayName);
    }

    [Fact]
    public void GetPluginRecordTypes_ExcludesHeader()
    {
        // Every plugin indexes exactly one header row, so without the exclusion "header" would appear as a
        // browsable record-type node. The header is reached only via "Open Header" on the plugin node.
        _reads.RecordTypeCountsByPlugin = new Dictionary<PluginCopyKey, IReadOnlyList<RecordTypeCount>>
        {
            [PluginKey] =
            [
                new RecordTypeCount("npc_", 1, HasParseFailure: false),
                new RecordTypeCount(PluginHeader.RecordType, 1, HasParseFailure: false),
            ],
        };

        var result = _svc.GetPluginRecordTypes(PluginName);

        Assert.DoesNotContain(result, r => r.Type == "header");
    }

    [Fact]
    public void GetPluginRecordTypes_UnknownPlugin_ReturnsEmpty()
    {
        var result = _svc.GetPluginRecordTypes("DoesNotExist.esp");

        Assert.Empty(result);
    }

    // --- GET /records?type=unknown ---

    [Fact]
    public void GetRecords_UnknownType_ReturnsEmptyPagedResult()
    {
        var result = _svc.GetRecords(type: "xxxx", plugin: null, search: null, limit: 10, offset: 0);

        Assert.Equal(0, result.Total);
        Assert.Empty(result.Items);
    }

    // --- No-load order guard clauses ---

    [Fact]
    public void GetPlugins_NoLoadOrder_ThrowsNoLoadOrderException()
    {
        var unloaded = new RecordQueryService(_manager, new LoadOrderHolder(), SharedSchemaReflector.Instance, new ConflictClassifier());
        var ex = Assert.Throws<NoLoadOrderException>(() => unloaded.GetPlugins());
        Assert.Contains("No load order", ex.Message);
    }

    [Fact]
    public void GetRecords_NoLoadOrder_ThrowsNoLoadOrderException()
    {
        var unloaded = new RecordQueryService(_manager, new LoadOrderHolder(), SharedSchemaReflector.Instance, new ConflictClassifier());
        var ex = Assert.Throws<NoLoadOrderException>(() => unloaded.GetRecords("npc_", null, null, 10, 0));
        Assert.Contains("No load order", ex.Message);
    }

    // GetRecords_AllTypes_ReturnsSortedByEditorId dropped: the sort is the real Index's own
    // behaviour, covered at Index.Tests/Query/RecordReadsTests.GetRecords_ReturnsSortedByEditorIdAscending.

    // --- GetPlugins: HasMatchingRecords, never row pruning (plugins.md) ---

    [Fact]
    public void GetPlugins_WithFilterMatchingRecords_ReturnsPlugin()
    {
        var copy = Assert.Single(_svc.GetPlugins(), p => p.Copy.Name == PluginName).Copy.Key;
        _manager.SetFilter("SELECT form_key FROM \"NPC_\"");
        _reads.MatchingPlugins = new HashSet<PluginCopyKey>(PluginCopyKey.Comparer) { copy };

        var plugins = _svc.GetPlugins();
        var plugin = Assert.Single(plugins, p => p.Copy.Name == PluginName);
        Assert.True(plugin.HasMatchingRecords);
    }

    // plugins.md: a record filter prunes records and record types, never a plugin row, because this tree
    // is also the load order and hiding a plugin mid-filter would make it unreorderable.
    [Fact]
    public void GetPlugins_WithFilterMatchingNoRecords_KeepsPluginVisibleButFlagsNoMatch()
    {
        _manager.SetFilter("SELECT 'NoSuchFormKey:000000' AS form_key");
        _reads.MatchingPlugins = new HashSet<PluginCopyKey>(PluginCopyKey.Comparer);

        var plugins = _svc.GetPlugins();
        var plugin = Assert.Single(plugins, p => p.Copy.Name == PluginName);
        Assert.False(plugin.HasMatchingRecords);
    }

    [Fact]
    public void GetPlugins_AfterClearFilter_RestoresAllPlugins()
    {
        _manager.SetFilter("SELECT 'NoSuchFormKey:000000' AS form_key");
        _manager.ClearFilter();

        var plugins = _svc.GetPlugins();
        var plugin = Assert.Single(plugins);
        Assert.Equal(PluginName, plugin.Copy.Name);
        Assert.True(plugin.HasMatchingRecords);
    }
}
