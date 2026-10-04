using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

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
                const Npc.AggressionType nonDefaultSoTheColumnIsNotSkippedAsAbsent = Npc.AggressionType.Aggressive;
                npc01.Aggression = nonDefaultSoTheColumnIsNotSkippedAsAbsent;
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
        return (manager, new RecordQueryService(manager, holder, SharedSchemaReflector.Instance));
    }

    [Fact]
    public void GetPlugins_ReturnsLoadedPlugin()
    {
        var plugins = _svc.GetPlugins();

        Assert.Single(plugins);
        Assert.Equal(PluginName, plugins[0].Plugin.Name);
        Assert.Equal(RecordCount, plugins[0].Content.RecordCount);
    }

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

        Assert.True(plugins.Single(p => p.Plugin.Name == PluginName).HasParseFailure);
        Assert.False(plugins.Single(p => p.Plugin.Name == otherPlugin).HasParseFailure);
    }

    [Fact]
    public void GetPlugins_MarksOnlyThePluginsTheIndexDerivedFromASourceTree()
    {
        const string otherPlugin = "Other.esp";
        var fixture = new FakeFixtureBuilder(Release)
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("Tracked"))
            .WithPlugin(otherPlugin, mod => mod.Npcs.AddNew("Untracked"))
            .Build("Aggression");
        var (manager, svc) = Build(fixture);
        ((FakeReads)manager.RequireReads()).Tracked =
            new HashSet<PluginAddress>(fixture.Plugins.Where(c => c.Name == PluginName).Select(c => c.Key),
                PluginAddress.Comparer);

        var plugins = svc.GetPlugins();

        Assert.True(plugins.Single(p => p.Plugin.Name == PluginName).IsTracked);
        Assert.False(plugins.Single(p => p.Plugin.Name == otherPlugin).IsTracked);
    }

    [Fact]
    public void GetPlugins_MarksTrackedPerPlugin_NotPerFilename()
    {
        var tracked = new PluginAddress(PluginName, "TrackedMod");
        var untracked = new PluginAddress(PluginName, "UntrackedMod");
        var content = new PluginContent(IsLight: false, IsMaster: false, IsBlueprint: false, Masters: [], RecordCount: 0, IsMedium: false);
        var reads = new FakeReads(new Dictionary<PluginAddress, PluginContent> { [tracked] = content, [untracked] = content }, [])
        {
            Tracked = new HashSet<PluginAddress>([tracked], PluginAddress.Comparer),
        };
        var holder = FakeLoadOrder.Of(
            Release,
            new LoadOrderEntry(PluginName, PluginName, tracked.Origin, 0, Enabled: true, Winning: true),
            new LoadOrderEntry(PluginName, PluginName, untracked.Origin, 1, Enabled: true, Winning: false));
        var svc = new RecordQueryService(new FakeIndex(reads), holder, SharedSchemaReflector.Instance);

        var plugins = svc.GetPlugins();

        Assert.True(plugins.Single(p => p.Plugin.Origin == tracked.Origin).IsTracked);
        Assert.False(plugins.Single(p => p.Plugin.Origin == untracked.Origin).IsTracked);
    }

    [Fact]
    public void GetPlugins_PluginWithMissingMaster_ReportsItAsAMasterIssue()
    {
        var fixture = new FakeFixtureBuilder(Release)
            .WithPlugin("Patch.esp", mod => mod.Npcs.AddNew("PatchedNpc").Race.SetTo(
                new FormKey(ModKey.FromFileName("Ghost.esm"), 0x800)))
            .Build();
        var (_, svc) = Build(fixture);

        var plugins = svc.GetPlugins();

        var patch = Assert.Single(plugins, p => p.Plugin.Name == "Patch.esp");
        Assert.Equal(["Ghost.esm"], patch.MasterIssues);
    }

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

        Assert.Equal([], plugins[0].MasterIssues);
    }

    [Fact]
    public void GetRecords_KnownType_ForwardsSearchLimitOffsetUntouchedIntoTheQuery()
    {
        _svc.GetRecords(types: ["npc_"], plugin: null, search: "TestNPC01", limit: 7, offset: 3);

        var query = _reads.LastSearch;
        Assert.NotNull(query);
        Assert.Equal(["npc_"], query.RecordTypes);
        Assert.Equal("TestNPC01", query.Search);
        Assert.Equal(7, query.Limit);
        Assert.Equal(3, query.Offset);
    }

    [Theory]
    [InlineData("01000800", "Patch.esp")]
    [InlineData("0x01000800", "Patch.esp")]
    [InlineData("FE000800", "Light.esp")]
    [InlineData("00000800", "Base.esm")]
    public void GetRecords_AFormIdSearchesTheFormKeyItNames(string formId, string plugin)
    {
        var fixture = new FakeFixtureBuilder(Release)
            .WithPlugin("Base.esm", mod => mod.Npcs.AddNew("BaseNpc"))
            .WithPlugin("Light.esp", mod => mod.ModHeader.Flags = Fallout4ModHeader.HeaderFlag.Small)
            .WithPlugin("Patch.esp", mod => mod.Npcs.AddNew("PatchNpc"))
            .Build();
        var (manager, svc) = Build(fixture);

        svc.GetRecords(types: null, plugin: null, search: formId, limit: 20, offset: 0);

        var query = ((FakeReads)manager.RequireReads()).LastSearch;
        Assert.Equal($"000800:{plugin}", query?.SearchFormKey);
        Assert.Equal(formId, query?.Search);
    }

    [Theory]
    [InlineData("FE000800", "000800:L0.esp")]
    [InlineData("FE001800", "000800:L1.esp")]
    [InlineData("FE001FFF", "000FFF:L1.esp")]
    [InlineData("01000800", "000800:F1.esp")]
    public void GetRecords_ALightFormIdDecodesItsIndexAndIdSeparately(string formId, string formKey)
    {
        var (manager, svc) = Roster(("F0.esm", false, true), ("L0.esp", true, true), ("F1.esp", false, true), ("L1.esp", true, true));

        svc.GetRecords(types: null, plugin: null, search: formId, limit: 20, offset: 0);

        Assert.Equal(formKey, ((FakeReads)manager.RequireReads()).LastSearch?.SearchFormKey);
    }

    [Fact]
    public void GetRecords_AFormIdCountsOnlyActivePlugins()
    {
        var (manager, svc) = Roster(("F0.esm", false, true), ("Off.esp", false, false), ("F1.esp", false, true));

        svc.GetRecords(types: null, plugin: null, search: "01000800", limit: 20, offset: 0);

        Assert.Equal("000800:F1.esp", ((FakeReads)manager.RequireReads()).LastSearch?.SearchFormKey);
    }

    [Fact]
    public void GetRecords_FeIsAFullIndexWhereNoActivePluginIsLight()
    {
        var (manager, svc) = Roster([.. Enumerable.Range(0, 255).Select(i => ($"P{i:D3}.esp", false, true))]);

        svc.GetRecords(types: null, plugin: null, search: "FE000800", limit: 20, offset: 0);

        Assert.Equal("000800:P254.esp", ((FakeReads)manager.RequireReads()).LastSearch?.SearchFormKey);
    }

    [Fact]
    public void GetRecords_FdIsTheMediumPluginsIndex_AndItsIdIsSixteenBits()
    {
        var names = new[] { "Base.esm", "Mid.esm", "Top.esp" };
        var entries = names.Select((name, slot) => new LoadOrderEntry(name, name, "Data", slot, true, Winning: true)).ToList();
        var opened = names.ToDictionary(
            name => new PluginAddress(name, "Data"), name => new PluginContent(false, false, false, [], 0, IsMedium: name == "Mid.esm"));
        var (manager, svc) = Build(new FakeFixtureData(Release, entries, opened, []));

        svc.GetRecords(types: null, plugin: null, search: "FD001234", limit: 20, offset: 0);

        Assert.Equal("001234:Mid.esm", ((FakeReads)manager.RequireReads()).LastSearch?.SearchFormKey);
    }

    [Fact]
    public void GetRecords_AFormIdNoActivePluginHoldsSearchesAsTyped()
    {
        _svc.GetRecords(types: null, plugin: null, search: "7F000800", limit: 20, offset: 0);

        Assert.Equal("7F000800", _reads.LastSearch?.Search);
        Assert.Null(_reads.LastSearch?.SearchFormKey);
    }

    private static (FakeIndex Manager, RecordQueryService Service) Roster(params (string Name, bool Light, bool Active)[] plugins)
    {
        var entries = plugins.Select((p, slot) => new LoadOrderEntry(p.Name, p.Name, "Data", slot, p.Active, Winning: true)).ToList();
        var opened = plugins.ToDictionary(
            p => new PluginAddress(p.Name, "Data"), p => new PluginContent(p.Light, false, false, [], 0, IsMedium: false));
        return Build(new FakeFixtureData(Release, entries, opened, []));
    }

    [Fact]
    public void GetRecords_NoType_QueriesEveryNonHeaderSchemaType()
    {
        _svc.GetRecords(types: null, plugin: null, search: null, limit: 10, offset: 0);

        var query = _reads.LastSearch;
        Assert.NotNull(query);
        var recordTypes = query.RecordTypes;
        Assert.NotNull(recordTypes);
        var schemas = SharedSchemaReflector.Instance.GetSchemas(Release);
        var expected = schemas.Keys.Where(t => t != PluginHeader.RecordType).OrderBy(t => t, StringComparer.Ordinal);
        Assert.Equal(expected, recordTypes.OrderBy(t => t, StringComparer.Ordinal));
    }

    [Fact]
    public void GetRecords_PluginGivenWithoutOrigin_ThrowsArgumentException_ForAPluginFilterWithNoOriginWouldMatchEveryPluginSharingTheFilename()
    {
        Assert.Throws<ArgumentException>(
            () => _svc.GetRecords(types: ["npc_"], plugin: PluginName, search: null, limit: 10, offset: 0));
    }

    [Fact]
    public void GetRecords_OriginGivenWithoutPlugin_ThrowsArgumentException_ForAnOriginNamesHalfAnIdentityAsMuchAsABareFilenameDoes()
    {
        Assert.Throws<ArgumentException>(
            () => _svc.GetRecords(types: ["npc_"], plugin: null, search: null, limit: 10, offset: 0, origin: "Data"));
    }

    [Fact]
    public void GetRecords_EmptyPluginAndNoOrigin_BrowsesEveryPluginRatherThanThrowing_ForTheEndpointTreatsABlankPluginAsAbsent()
    {
        _svc.GetRecords(types: ["npc_"], plugin: "", search: null, limit: 10, offset: 0);

        var query = _reads.LastSearch;
        Assert.NotNull(query);
        Assert.Null(query.Plugin);
    }

    [Fact]
    public void GetRecords_WithPluginAndOrigin_ForwardsBothUntouchedIntoTheQuery()
    {
        _svc.GetRecords(types: ["npc_"], plugin: PluginName, search: null, limit: 10, offset: 0, origin: "OtherOrigin");

        var query = _reads.LastSearch;
        Assert.NotNull(query);
        Assert.Equal(PluginName, query.Plugin);
        Assert.Equal("OtherOrigin", query.Origin);
    }

    [Fact]
    public void GetRecords_ReturnsExactlyWhatReadsSearchProvides()
    {
        _reads.SearchResult = new PagedResult<RecordSummary>(
            [new RecordSummary("000800:Test.esp", PluginName, 0, IsWinner: true, "FromFake", "Data")], 1);

        var result = _svc.GetRecords(types: ["npc_"], plugin: null, search: null, limit: 10, offset: 0);

        Assert.Same(_reads.SearchResult, result);
    }

    [Fact]
    public void GetRecord_ReturnsWinnerWithFields()
    {
        var detail = _svc.GetRecord(_npc01Key.ToString());

        Assert.NotNull(detail);
        Assert.Equal(_npc01Key.ToString(), detail.FormKey);
        Assert.True(detail.IsWinner);
        Assert.NotEmpty(detail.Fields);
    }

    [Fact]
    public void GetRecord_ReturnsRecordType_ForCopyAsNewRecordNeedsTheSchemaTableNameUpFront()
    {
        var detail = _svc.GetRecord(_npc01Key.ToString());

        Assert.NotNull(detail);
        Assert.Equal("npc_", detail.RecordType);
    }

    [Fact]
    public void GetCompare_SingleOverride_ReturnsDiffs()
    {
        var compare = _svc.GetCompare(_npc01Key.ToString());

        Assert.NotNull(compare);
        Assert.Equal(ConflictThis.OnlyOne, Assert.Single(compare.Overrides).ConflictThis);
        Assert.Equal(ConflictAll.OnlyOne, compare.ConflictAll);
        Assert.NotEmpty(compare.Diffs);
    }

    [Fact]
    public void GetCompare_EachColumnCarriesXEditsHexLoadIndex_ALightPluginCountingAmongTheLightOnesAfterFE()
    {
        FormKey npcKey = default;
        var fixture = new FakeFixtureBuilder(Release)
            .WithPlugin("Base.esm", mod => npcKey = mod.Npcs.AddNew("SharedNPC").FormKey)
            .WithPlugin("Light.esp", (mod, prev) =>
            {
                mod.ModHeader.Flags = Fallout4ModHeader.HeaderFlag.Small;
                mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
            })
            .WithPlugin("Patch.esp", (mod, prev) => mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()))
            .Build();
        var (_, svc) = Build(fixture);

        var compare = svc.GetCompare(npcKey.ToString());

        Assert.Equal(["00", "FE 000", "01"], compare?.Overrides.Select(o => o.LoadIndex) ?? []);
    }

    [Fact]
    public void GetCompare_CarriesTheDiagnosisTheDocumentArrivedWith_ForTheRecordEditorRendersTheColumnReadOnlyFromItAlone()
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
    public void GetCompare_NamesTheRecordTypeAsXEditDoes()
    {
        var compare = _svc.GetCompare(_npc01Key.ToString());

        Assert.Equal("Non-Player Character", compare?.RecordTypeName);
    }

    [Fact]
    public void GetReferences_NameTheRecordTypeAsXEditDoes()
    {
        _reads.ReferencedBy = new Dictionary<string, IReadOnlyList<ReferenceRow>>
        {
            ["000001:Target.esp"] = [new("000002:TestPlugin.esp", PluginName, "Keywords[0]", "npc_", "Referrer", "Data")],
        };

        var reference = Assert.Single(_svc.GetReferences("000001:Target.esp"));

        Assert.Equal("Non-Player Character", reference.RecordTypeName);
        Assert.Equal("npc_", reference.RecordType);
    }

    [Fact]
    public void GetReferences_ListThePluginsInLoadOrder()
    {
        var fixture = new FakeFixtureBuilder(Release)
            .WithPlugin("Base.esp", mod => mod.Npcs.AddNew("A"))
            .WithPlugin("Patch.esp", mod => mod.Npcs.AddNew("B"))
            .Build("Aggression");
        var (manager, svc) = Build(fixture);
        ((FakeReads)manager.RequireReads()).ReferencedBy = new Dictionary<string, IReadOnlyList<ReferenceRow>>
        {
            ["000001:Target.esp"] =
            [
                new("000002:Base.esp", "Patch.esp", "Keywords[0]", "npc_", null, "Data"),
                new("000002:Base.esp", "Base.esp", "Keywords[0]", "npc_", null, "Data"),
            ],
        };

        var plugins = svc.GetReferences("000001:Target.esp").Select(r => r.Plugin);

        Assert.Equal(["Base.esp", "Patch.esp"], plugins);
    }

    [Fact]
    public void GetCompare_OverridesCarryRecordType()
    {
        var compare = _svc.GetCompare(_npc01Key.ToString());

        Assert.NotNull(compare);
        Assert.All(compare.Overrides, o => Assert.Equal("npc_", o.RecordType));
    }

    [Theory]
    [InlineData("overwrite")]
    [InlineData("Overwrite")]
    [InlineData("OVERWRITE")]
    public void GetCompare_OverwriteOriginColumn_CarriesIsInOverwriteTrue_IgnoringCase_ForOverwriteIsAReservedOriginNotAMod(string origin)
    {
        FormKey npcKey = default;
        var fixture = new FakeFixtureBuilder(Release)
            .WithPlugin(PluginName, mod => npcKey = mod.Npcs.AddNew("TestNPC").FormKey, origin: origin)
            .Build("Aggression");
        var (_, svc) = Build(fixture);

        var compare = svc.GetCompare(npcKey.ToString());

        Assert.NotNull(compare);
        Assert.True(Assert.Single(compare.Overrides).IsInOverwrite);
    }

    [Fact]
    public void GetCompare_ModOriginColumn_CarriesIsInOverwriteFalse()
    {
        var compare = _svc.GetCompare(_npc01Key.ToString());

        Assert.NotNull(compare);
        Assert.All(compare.Overrides, o => Assert.False(o.IsInOverwrite));
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
            .WithPlugin("Base.esp", mod => npcKey = mod.Npcs.AddNew("PlainNpc").FormKey)
            .WithPlugin("Over.esp", (mod, prev) =>
                mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).VirtualMachineAdapter = ScriptVmad(5))
            .Build(VmadField);
        var (_, svc) = Build(fixture);

        var compare = svc.GetCompare(npcKey.ToString());
        Assert.NotNull(compare);
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
                o.Aggression = Npc.AggressionType.Frenzied;
                o.VirtualMachineAdapter = ScriptVmad(20);
            })
            .Build("Aggression", VmadField);
        var (_, svc) = Build(fixture);

        var compare = svc.GetCompare(npcKey.ToString());
        Assert.NotNull(compare);
        Assert.Equal(ConflictAll.Override, compare.ConflictAll);
    }

    [Fact]
    public void GetCompare_NonMastersAgreeingOnTheFieldButDifferingOnVmad_AgainstAMasterCarryingAnAdapter_EscalateToConflict_NotOverride()
    {
        FormKey npcKey = default;
        var fixture = new FakeFixtureBuilder(Release)
            .WithPlugin("Base.esp", mod => npcKey = MakeScriptedNpc(mod, 10))
            .WithPlugin("Mid.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.Aggression = Npc.AggressionType.Frenzied;
                o.VirtualMachineAdapter = ScriptVmad(20);
            })
            .WithPlugin("Top.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.Aggression = Npc.AggressionType.Frenzied;
                o.VirtualMachineAdapter = ScriptVmad(30);
            })
            .Build("Aggression", VmadField);
        var (_, svc) = Build(fixture);

        var compare = svc.GetCompare(npcKey.ToString());
        Assert.NotNull(compare);
        Assert.Equal(ConflictAll.Conflict, compare.ConflictAll);
    }

    [Fact]
    public void GetCompare_NonMastersAgreeingOnTheFieldButDifferingOnVmad_AgainstAMasterCarryingNoAdapter_EscalateToConflict_NotOverride()
    {
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
                o.Aggression = Npc.AggressionType.Frenzied;
                o.VirtualMachineAdapter = ScriptVmad(10);
            })
            .WithPlugin("Top.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.Aggression = Npc.AggressionType.Frenzied;
                o.VirtualMachineAdapter = ScriptVmad(20);
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
                o.Aggression = Npc.AggressionType.Frenzied;
            })
            .WithPlugin("Top.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.Aggression = Npc.AggressionType.Aggressive;
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

    [Fact]
    public void GetCompare_RecordHasConditions_ClassifiesThemAsFieldDiffChildren_ThroughTheOneConflictClassifierForAConditionListIsAnOrdinaryReflectedArrayColumn()
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

    [Fact]
    public void GetCompare_ConditionFormParameter_ResolvesEditorId_AsTheConditionsParameterOneRecordResolutionInItsColumn()
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

    private static readonly PluginAddress PluginKey = new(PluginName, "Data");

    [Fact]
    public void GetPluginRecordTypes_ReturnsCountsForPlugin()
    {
        _reads.RecordTypeCountsByPlugin = new Dictionary<PluginAddress, IReadOnlyList<RecordTypeCount>>
        {
            [PluginKey] = [new RecordTypeCount("npc_", RecordCount, HasParseFailure: false)],
        };

        var result = _svc.GetPluginRecordTypes(PluginName, "Data");

        var npc = Assert.Single(result, r => r.Type == "npc_");
        Assert.Equal(RecordCount, npc.Count);
        Assert.All(result, r => Assert.True(r.Count > 0));
    }

    [Fact]
    public void GetPluginRecordTypes_MarksOnlyTheTypeWhoseCountCarriesAFailure()
    {
        _reads.RecordTypeCountsByPlugin = new Dictionary<PluginAddress, IReadOnlyList<RecordTypeCount>>
        {
            [PluginKey] =
            [
                new RecordTypeCount("perk", 1, HasParseFailure: true),
                new RecordTypeCount("npc_", 1, HasParseFailure: false),
            ],
        };

        var result = _svc.GetPluginRecordTypes(PluginName, "Data");

        Assert.True(Assert.Single(result, r => r.Type == "perk").HasParseFailure);
        Assert.False(Assert.Single(result, r => r.Type == "npc_").HasParseFailure);
    }

    [Fact]
    public void GetPluginRecordTypes_DisplayName_MatchesXEdit_WhileTheSignatureStaysTheKey()
    {
        _reads.RecordTypeCountsByPlugin = new Dictionary<PluginAddress, IReadOnlyList<RecordTypeCount>>
        {
            [PluginKey] = [new RecordTypeCount("npc_", 1, HasParseFailure: false)],
        };

        var result = _svc.GetPluginRecordTypes(PluginName, "Data");

        var npc = Assert.Single(result, r => r.Type == "npc_");
        Assert.Equal("Non-Player Character", npc.DisplayName);
    }

    [Fact]
    public void GetPluginRecordTypes_IsCreatable_AgreesWithTheCreatableEndpoint_ForTheGroupMenuReadsItInsteadOfASecondPackageJsonSideList()
    {
        _reads.RecordTypeCountsByPlugin = new Dictionary<PluginAddress, IReadOnlyList<RecordTypeCount>>
        {
            [PluginKey] =
            [
                new RecordTypeCount("npc_", 1, HasParseFailure: false),
                new RecordTypeCount("qust", 1, HasParseFailure: false),
            ],
        };

        var creatable = _svc.GetCreatableRecordTypes().Select(r => r.Type).ToHashSet(StringComparer.Ordinal);
        var result = _svc.GetPluginRecordTypes(PluginName, "Data");

        Assert.Contains("npc_", creatable);
        Assert.DoesNotContain("qust", creatable);
        foreach (var row in result) Assert.Equal(creatable.Contains(row.Type), row.IsCreatable);
    }

    [Fact]
    public void GetPluginRecordTypes_ExcludesHeader_ForItIsReachedOnlyViaOpenHeaderOnThePluginNode()
    {
        _reads.RecordTypeCountsByPlugin = new Dictionary<PluginAddress, IReadOnlyList<RecordTypeCount>>
        {
            [PluginKey] =
            [
                new RecordTypeCount("npc_", 1, HasParseFailure: false),
                new RecordTypeCount(PluginHeader.RecordType, 1, HasParseFailure: false),
            ],
        };

        var result = _svc.GetPluginRecordTypes(PluginName, "Data");

        Assert.DoesNotContain(result, r => r.Type == "header");
    }

    [Fact]
    public void GetPluginRecordTypes_UnknownPlugin_ReturnsEmpty()
    {
        var result = _svc.GetPluginRecordTypes("DoesNotExist.esp", "Data");

        Assert.Empty(result);
    }

    [Fact]
    public void GetCreatableRecordTypes_NamesAFlatTypeAsXEditDoes()
    {
        var result = _svc.GetCreatableRecordTypes();

        Assert.Equal("Non-Player Character", Assert.Single(result, r => r.Type == "npc_").DisplayName);
    }

    [Theory]
    [InlineData(PluginHeader.RecordType)]
    [InlineData("cell")]
    [InlineData("wrld")]
    [InlineData("refr")]
    [InlineData("dial")]
    [InlineData("info")]
    [InlineData("qust")]
    public void GetCreatableRecordTypes_LeavesOutTheHeaderAndEveryContainerOrHeldType(string recordType)
    {
        var result = _svc.GetCreatableRecordTypes();

        Assert.DoesNotContain(result, r => r.Type == recordType);
    }

    [Fact]
    public void GetCreatableRecordTypes_IsInNameOrder()
    {
        var names = _svc.GetCreatableRecordTypes().Select(r => r.DisplayName).ToList();

        Assert.Equal(names.Order(StringComparer.OrdinalIgnoreCase), names);
    }

    [Fact]
    public void GetCreatableRecordTypes_NoLoadOrder_ThrowsNoLoadOrderException()
    {
        var unloaded = new RecordQueryService(_manager, new LoadOrderHolder(), SharedSchemaReflector.Instance);

        Assert.Throws<NoLoadOrderException>(() => unloaded.GetCreatableRecordTypes());
    }

    private static RecordQueryService ServiceIn(GameRelease release) => new(
        new FakeIndex(new FakeReads(new Dictionary<PluginAddress, PluginContent>(), [])),
        FakeLoadOrder.Of(release), SharedSchemaReflector.Instance);

    [Fact]
    public void GetLightPluginsSupported_AReleaseWithLightPlugins_IsTrue()
    {
        Assert.True(ServiceIn(GameRelease.Fallout4).GetLightPluginsSupported());
    }

    [Theory]
    [InlineData(GameRelease.Oblivion)]
    [InlineData(GameRelease.OblivionRE)]
    public void GetLightPluginsSupported_AReleaseWithoutLightPlugins_IsFalse(GameRelease release)
    {
        Assert.False(ServiceIn(release).GetLightPluginsSupported());
    }

    [Fact]
    public void GetLightPluginsSupported_NoLoadOrder_ThrowsNoLoadOrderException()
    {
        var unloaded = new RecordQueryService(_manager, new LoadOrderHolder(), SharedSchemaReflector.Instance);

        Assert.Throws<NoLoadOrderException>(() => unloaded.GetLightPluginsSupported());
    }

    [Fact]
    public void GetRecords_SeveralTypes_SearchesExactlyThose()
    {
        _svc.GetRecords(types: ["npc_", "kywd"], plugin: null, search: "x", limit: 10, offset: 0);

        Assert.Equal(["npc_", "kywd"], _reads.LastSearch?.RecordTypes);
    }

    [Fact]
    public void GetRecords_AnUnknownTypeAmongKnownOnes_IsDropped()
    {
        _svc.GetRecords(types: ["npc_", "xxxx"], plugin: null, search: "x", limit: 10, offset: 0);

        Assert.Equal(["npc_"], _reads.LastSearch?.RecordTypes);
    }

    [Fact]
    public void GetRecords_UnknownType_ReturnsEmptyPagedResult()
    {
        var result = _svc.GetRecords(types: ["xxxx"], plugin: null, search: null, limit: 10, offset: 0);

        Assert.Equal(0, result.Total);
        Assert.Empty(result.Items);
    }

    [Fact]
    public void GetPlugins_NoLoadOrder_ThrowsNoLoadOrderException()
    {
        var unloaded = new RecordQueryService(_manager, new LoadOrderHolder(), SharedSchemaReflector.Instance);
        var ex = Assert.Throws<NoLoadOrderException>(() => unloaded.GetPlugins());
        Assert.Contains("No load order", ex.Message);
    }

    [Fact]
    public void GetRecords_NoLoadOrder_ThrowsNoLoadOrderException()
    {
        var unloaded = new RecordQueryService(_manager, new LoadOrderHolder(), SharedSchemaReflector.Instance);
        var ex = Assert.Throws<NoLoadOrderException>(() => unloaded.GetRecords(["npc_"], null, null, 10, 0));
        Assert.Contains("No load order", ex.Message);
    }

    [Fact]
    public void GetPlugins_WithFilterMatchingRecords_ReturnsPlugin()
    {
        var address = Assert.Single(_svc.GetPlugins(), p => p.Plugin.Name == PluginName).Plugin.Key;
        _manager.SetFilter("SELECT form_key FROM \"NPC_\"", "npcs.sql");
        _reads.MatchingPlugins = new HashSet<PluginAddress>(PluginAddress.Comparer) { address };

        var plugins = _svc.GetPlugins();
        var plugin = Assert.Single(plugins, p => p.Plugin.Name == PluginName);
        Assert.True(plugin.HasMatchingRecords);
    }

    [Fact]
    public void GetPlugins_WithFilterMatchingNoRecords_KeepsPluginVisibleButFlagsNoMatch_ForTheTreeIsAlsoTheLoadOrderAndAHiddenPluginWouldBeUnreorderable()
    {
        _manager.SetFilter("SELECT 'NoSuchFormKey:000000' AS form_key", "nothing.sql");
        _reads.MatchingPlugins = new HashSet<PluginAddress>(PluginAddress.Comparer);

        var plugins = _svc.GetPlugins();
        var plugin = Assert.Single(plugins, p => p.Plugin.Name == PluginName);
        Assert.False(plugin.HasMatchingRecords);
    }

    [Fact]
    public void GetPlugins_AfterClearFilter_RestoresAllPlugins()
    {
        _manager.SetFilter("SELECT 'NoSuchFormKey:000000' AS form_key", "nothing.sql");
        _manager.ClearFilter();

        var plugins = _svc.GetPlugins();
        var plugin = Assert.Single(plugins);
        Assert.Equal(PluginName, plugin.Plugin.Name);
        Assert.True(plugin.HasMatchingRecords);
    }

    [Fact]
    public void SetFilter_ForwardsSqlAndSourceToTheIndex()
    {
        _svc.SetFilter("SELECT form_key FROM \"NPC_\"", "npcs.sql");

        Assert.Equal(("SELECT form_key FROM \"NPC_\"", "npcs.sql"), _manager.ActiveFilter);
    }

    [Fact]
    public void ClearFilter_ForwardsToTheIndex()
    {
        _manager.SetFilter("SELECT form_key FROM \"NPC_\"", "npcs.sql");

        _svc.ClearFilter();

        Assert.Null(_manager.ActiveFilter);
    }

    [Fact]
    public void GetFilter_IsTheFilterInForce_WithItsSource()
    {
        _manager.SetFilter("SELECT form_key FROM \"NPC_\"", "npcs.sql");

        Assert.Equal(("SELECT form_key FROM \"NPC_\"", "npcs.sql"), _svc.GetFilter());
    }

    [Fact]
    public void GetFilter_WithNoLoadOrder_RefusesRatherThanAnsweringUnfiltered()
    {
        var svc = new RecordQueryService(
            new StubIndex(reads: null), new LoadOrderHolder(), SharedSchemaReflector.Instance);

        Assert.Throws<NoLoadOrderException>(() => svc.GetFilter());
    }

    [Fact]
    public void GetStatus_IsTheIndexsStatus()
    {
        var reconciling = new LoadOrderStatus(LoadOrderState.Reconciling, 3, 3, [], false, []);
        _manager.Status = reconciling;

        Assert.Equal(reconciling, _svc.GetStatus());
    }

    [Fact]
    public void GetSequence_IsTheIndexsSequence()
    {
        _manager.Sequence = 7;

        Assert.Equal(7, _svc.GetSequence());
    }

    [Fact]
    public async Task AwaitSequence_Reached_AnswersTheSequenceObserved_NotTheBound()
    {
        _manager.Sequence = 7;

        Assert.Equal(new SequenceAwaitResponse(true, 7), await _svc.AwaitSequence(5, TimeSpan.FromSeconds(1)));
    }

    [Fact]
    public async Task AwaitSequence_NotReached_AnswersFalseAndTheSequenceObserved()
    {
        _manager.Sequence = 3;

        Assert.Equal(new SequenceAwaitResponse(false, 3), await _svc.AwaitSequence(5, TimeSpan.FromSeconds(1)));
    }

    [Fact]
    public async Task RebuildStore_ForwardsGameReleaseAndInstanceRootToTheIndex()
    {
        await _svc.RebuildStore(Release, @"C:\Instance");

        Assert.Equal(Release, _manager.LastRebuildRelease);
        Assert.Equal(@"C:\Instance", _manager.LastRebuildInstanceRoot);
    }
}
