using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Queries;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Query;

[Collection(TestPluginFixtureCollection.Name)]
public sealed class RecordQueryServiceTests : IDisposable
{
    private readonly IndexProjector _manager;
    private readonly RecordQueryService _svc;

    public RecordQueryServiceTests(TestPluginFixture fixture)
    {
        var holder = new LoadOrderHolder();
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        _manager = new IndexProjector(holder, MutagenPluginAdapter.Instance, factory);
        _manager.Reconcile(holder, fixture.DataFolder, fixture.Plugins, GameRelease.Fallout4);
        _svc = new RecordQueryService(_manager, holder, reflector, new ConflictClassifier());
    }

    public void Dispose() => _manager.Dispose();

    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    // --- GET /plugins ---

    [Fact]
    public void GetPlugins_ReturnsLoadedPlugin()
    {
        var plugins = _svc.GetPlugins();

        Assert.Single(plugins);
        Assert.Equal(TestPluginFixture.PluginName, plugins[0].Copy.Name);
        Assert.Equal(TestPluginFixture.RecordCount, plugins[0].Content.RecordCount);
    }

    // ADR-0012: a plugin whose master is absent from the whole load order is flagged on the
    // wire, not just detected in-memory — this is what lets the tree render it.
    [Fact]
    public void GetPlugins_PluginWithMissingMaster_ReportsItAsDirectlyMissing()
    {
        var holder = new LoadOrderHolder();
        // ADR-0008: masters are lifecycle-derived from the live object graph, never
        // user-declared — a bare ModHeader.MasterReferences.Add is discarded on write. A genuine
        // reference into the (never-built) master is what makes Mutagen record it for real.
        using var fx = new PluginFixtureBuilder("rqs-missing-master")
            .WithPlugin("Patch.esp", mod => mod.Npcs.AddNew("PatchedNpc").Race.SetTo(
                new FormKey(ModKey.FromFileName("Ghost.esm"), 0x800)))
            .Build();
        using var manager = new IndexProjector(
            holder,
            MutagenPluginAdapter.Instance,
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        manager.Reconcile(holder, fx.DataFolder, fx.Plugins, GameRelease.Fallout4);
        var svc = new RecordQueryService(manager, holder, SharedSchemaReflector.Instance, new ConflictClassifier());

        var plugins = svc.GetPlugins();

        var patch = Assert.Single(plugins, p => p.Copy.Name == "Patch.esp");
        var issue = Assert.Single(patch.MasterIssues);
        Assert.Equal("Ghost.esm", issue.MasterName);
        Assert.Equal(MasterIssueKind.DirectlyMissing, issue.Kind);
    }

    // ADR-0012 end to end: a whole load order built via LoadOrderSnapshot/IndexProjector rather than a
    // hand-fed index, where the referenced master is not part of the load order at all, with no
    // plugins.txt line and no file.
    [Fact]
    public void GetRecord_ReferenceIntoAbsentMaster_RendersUnresolvedRatherThanErroring()
    {
        var holder = new LoadOrderHolder();
        FormKey npcFormKey = default;
        using var fx = new PluginFixtureBuilder("rqs-absent-master-ref")
            .WithPlugin("Patch.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("PatchedNpc");
                npcFormKey = npc.FormKey;
                npc.Race.SetTo(new FormKey(ModKey.FromFileName("Ghost.esm"), 0x800));
            })
            .Build();
        using var manager = new IndexProjector(
            holder,
            MutagenPluginAdapter.Instance,
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        manager.Reconcile(holder, fx.DataFolder, fx.Plugins, GameRelease.Fallout4);
        var svc = new RecordQueryService(manager, holder, SharedSchemaReflector.Instance, new ConflictClassifier());

        var detail = svc.GetRecord(npcFormKey.ToString());

        Assert.NotNull(detail);
        var raceField = Assert.Single(detail.Fields, f => f.Metadata.Name == "Race");
        Assert.NotNull(raceField.Value);
        Assert.Contains("Ghost.esm", raceField.Value!.ToString());
        Assert.Contains("Could not be resolved", raceField.CheckError);
    }

    [Fact]
    public void GetPlugins_PluginWithNoMissingMasters_ReportsEmptyMasterIssues()
    {
        var plugins = _svc.GetPlugins();

        Assert.Empty(plugins[0].MasterIssues);
    }

    [Fact]
    public void GetRecords_ByType_ReturnsPaginatedResults()
    {
        var result = _svc.GetRecords(type: "npc_", plugin: null, search: null, limit: 10, offset: 0);

        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.Equal(TestPluginFixture.RecordCount, result.Items.Count);
    }

    [Fact]
    public void GetRecords_SearchByEditorId_FiltersResults()
    {
        var result = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 10, offset: 0);

        Assert.Equal(1, result.Total);
        Assert.Equal("TestNPC01", result.Items[0].EditorId);
    }

    // The FormKey picker seeds its QuickPick with the record's own FormKey, which
    // is only coherent if searching by that FormKey resolves it — a backend that matches
    // `search` against EditorID only makes a seeded (or pasted) FormKey match nothing.
    [Fact]
    public void GetRecords_SearchByFormKey_ResolvesRecord()
    {
        var byEditorId = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 10, offset: 0);
        var formKey = byEditorId.Items[0].FormKey;

        var result = _svc.GetRecords(type: "npc_", plugin: null, search: formKey, limit: 10, offset: 0);

        Assert.Equal(1, result.Total);
        Assert.Equal(formKey, result.Items[0].FormKey);
        Assert.Equal("TestNPC01", result.Items[0].EditorId);
    }

    // A FormKey-shaped query is matched case-insensitively against the canonical stored form —
    // the picker seeds from whatever casing a resolved link displays, and the paste-a-FormKey
    // path can't assume the user typed the exact stored case.
    [Fact]
    public void GetRecords_SearchByFormKey_IsCaseInsensitive()
    {
        var byEditorId = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 10, offset: 0);
        var formKey = byEditorId.Items[0].FormKey;

        var result = _svc.GetRecords(type: "npc_", plugin: null, search: formKey.ToLowerInvariant(), limit: 10, offset: 0);

        Assert.Equal(1, result.Total);
        Assert.Equal(formKey, result.Items[0].FormKey);
    }

    // A search string that merely looks close to a FormKey but doesn't fully parse (too short,
    // bad delimiter, non-hex id) must fall back to the EditorID path, not throw or silently
    // match everything.
    [Fact]
    public void GetRecords_SearchByMalformedFormKeyLikeString_FallsBackToEditorIdMatch_NoResults()
    {
        var result = _svc.GetRecords(type: "npc_", plugin: null, search: "ZZZZZZ:NotAFormKey.esp", limit: 10, offset: 0);

        Assert.Equal(0, result.Total);
    }

    [Fact]
    public void GetRecords_ByPlugin_FiltersResults()
    {
        var result = _svc.GetRecords(type: "npc_", plugin: TestPluginFixture.PluginName, search: null, limit: 10, offset: 0);

        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.All(result.Items, r => Assert.Equal(TestPluginFixture.PluginName, r.Plugin));
    }

    [Fact]
    public void GetRecords_AllTypes_ReturnsCombinedResults()
    {
        var result = _svc.GetRecords(type: null, plugin: null, search: null, limit: 100, offset: 0);

        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.Equal(TestPluginFixture.RecordCount, result.Items.Count);
    }

    [Fact]
    public void GetRecords_Pagination_RespectsLimitAndOffset()
    {
        var page1 = _svc.GetRecords(type: "npc_", plugin: null, search: null, limit: 1, offset: 0);
        var page2 = _svc.GetRecords(type: "npc_", plugin: null, search: null, limit: 1, offset: 1);

        Assert.Single(page1.Items);
        Assert.Single(page2.Items);
        Assert.NotEqual(page1.Items[0].FormKey, page2.Items[0].FormKey);
        Assert.Equal(TestPluginFixture.RecordCount, page1.Total);
    }

    // --- GET /records/{formKey} ---

    [Fact]
    public void GetRecord_ReturnsWinnerWithFields()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;

        var detail = _svc.GetRecord(fk);

        Assert.NotNull(detail);
        Assert.Equal(fk, detail.FormKey);
        Assert.True(detail.IsWinner);
        Assert.NotEmpty(detail.Fields);
    }

    [Fact]
    public void GetRecord_FieldsHaveMetadata()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var detail = _svc.GetRecord(all.Items[0].FormKey)!;

        Assert.All(detail.Fields, f =>
        {
            Assert.NotEmpty(f.Metadata.Name);
            Assert.Contains(f.Metadata.Type, new[]
            {
                "string", "translatedString", "int", "float", "bool", "enum", "flags", "formKey", "array", "struct",
                "hex", "color", "vector",
            });
        });
    }

    [Fact]
    public void GetRecord_UnknownFormKey_ReturnsNull()
    {
        var detail = _svc.GetRecord("FFFFFF:Unknown.esp");

        Assert.Null(detail);
    }

    // ADR-0015 invariant 2: the query path never opens a file under a mod folder, so a hand edit
    // stays invisible until RefreshByKeys — the door the Source watcher calls — lands it.
    [Fact]
    public void GetRecord_NeverReadsSourceItself_AHandEditStaysInvisibleUntilTheStoreIsRefreshed()
    {
        using var mod = IndexedModFixture.Tracked();
        var reads = new RecordQueryService(mod.Index, mod.Holder, SharedSchemaReflector.Instance, new ConflictClassifier());

        var text = File.ReadAllText(mod.NpcSourceFile);
        File.WriteAllText(
            mod.NpcSourceFile, text.Replace("\"FixtureNpc\"", "\"RenamedByHand\"", StringComparison.Ordinal));

        Assert.Equal(IndexedModFixture.NpcEditorId, reads.GetRecord(mod.Npc.ToString())!.EditorId);

        mod.Index.Store!.RefreshByKeys(mod.Plugin, mod.ModFolder, [mod.Npc.ToString()]);

        Assert.Equal("RenamedByHand", reads.GetRecord(mod.Npc.ToString())!.EditorId);
    }

    // "Copy as New Record" needs the record's schema table name up front (CreateRecord
    // validates RecordType before it even reads TemplateFormKey), so RecordDetail must carry it.
    [Fact]
    public void GetRecord_ReturnsRecordType()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var detail = _svc.GetRecord(all.Items[0].FormKey);

        Assert.NotNull(detail);
        Assert.Equal("npc_", detail.RecordType);
    }

    // --- GET /records/{formKey}/compare ---

    [Fact]
    public void GetCompare_SingleOverride_ReturnsDiffs()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var compare = _svc.GetCompare(all.Items[0].FormKey);

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
        var holder = new LoadOrderHolder();
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-participation")
            .WithPlugin("Base.esp", mod => npcKey = mod.Npcs.AddNew("SharedNPC").FormKey)
            .WithPlugin("Disabled.esp", (mod, prev) =>
                mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).CalcMinLevel = 5, enabled: false)
            .Build();
        using (data)
        {
            var reflector = SharedSchemaReflector.Instance;
            var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new IndexProjector(holder, MutagenPluginAdapter.Instance, factory);
            manager.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var svc = new RecordQueryService(manager, holder, reflector, new ConflictClassifier());

            var compare = svc.GetCompare(npcKey.ToString());

            Assert.NotNull(compare);
            Assert.Equal(ConflictAll.OnlyOne, compare.ConflictAll);
        }
    }

    // ADR-0013. A third plugin makes this a two-participant NoConflict, not the OnlyOne shortcut;
    // only the disabled last plugin differs, which an unfiltered winner pass would escalate.
    [Fact]
    public void GetCompare_VmadDiffersOnlyInDisabledPlugin_ReturnsNoConflict()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-vmad-participation")
            .WithPlugin("Base.esp", mod => npcKey = MakeScriptedNpc(mod, 10))
            .WithPlugin("Mid.esp", (mod, prev) =>
                mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).VirtualMachineAdapter = ScriptVmad(10))
            .WithPlugin("Disabled.esp", (mod, prev) =>
                mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).VirtualMachineAdapter = ScriptVmad(20),
                enabled: false)
            .Build();
        using (data)
        {
            WithCompareService(data, svc =>
            {
                var compare = svc.GetCompare(npcKey.ToString());

                Assert.NotNull(compare);
                Assert.Equal(ConflictAll.NoConflict, compare.ConflictAll);
            });
        }
    }

    [Fact]
    public void GetCompare_OverridesCarryRecordType()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var compare = _svc.GetCompare(all.Items[0].FormKey);

        Assert.NotNull(compare);
        Assert.All(compare.Overrides, o => Assert.Equal("npc_", o.RecordType));
    }

    [Fact]
    public void GetCompare_RecordIdenticalExceptVmad_ClassifiesAsConflict()
    {
        var holder = new LoadOrderHolder();
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-vmad-conflict")
            .WithPlugin("Base.esp", mod => npcKey = MakeScriptedNpc(mod, 10))
            .WithPlugin("Mid.esp", (mod, prev) =>
                mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).VirtualMachineAdapter = ScriptVmad(20))
            .WithPlugin("Top.esp", (mod, prev) =>
                mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).VirtualMachineAdapter = ScriptVmad(30))
            .Build();
        using (data)
        {
            var reflector = SharedSchemaReflector.Instance;
            var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new IndexProjector(holder, MutagenPluginAdapter.Instance, factory);
            manager.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var svc = new RecordQueryService(manager, holder, reflector, new ConflictClassifier());

            var compare = svc.GetCompare(npcKey.ToString());

            Assert.NotNull(compare);
            // Non-VMAD fields are identical overrides, so only the adapter differs — yet the record
            // is conflicted, and the diff reaches the one property that disagrees.
            Assert.Equal(ConflictAll.Conflict, compare!.ConflictAll);
            Assert.Equal("Top.esp", PowerPropertyDiff(compare).WinnerColumn);
        }
    }

    [Fact]
    public void GetCompare_NoOverrideCarriesAnAdapter_OmitsTheFieldEntirely()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var compare = _svc.GetCompare(all.Items[0].FormKey);

        Assert.NotNull(compare);
        Assert.DoesNotContain(compare!.Diffs, d => d.FieldName == VmadField);
    }

    [Fact]
    public void GetCompare_OnlyOverrideCarriesAnAdapter_StillDiffsTheField()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-vmad-added")
            .WithPlugin("Base.esp", mod => npcKey = mod.Npcs.AddNew("PlainNpc").FormKey) // no VMAD
            .WithPlugin("Over.esp", (mod, prev) =>
                mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).VirtualMachineAdapter = ScriptVmad(5))
            .Build();
        using (data)
            WithCompareService(data, svc =>
            {
                var compare = svc.GetCompare(npcKey.ToString());
                Assert.NotNull(compare);
                // The master carries no adapter and the override adds one → still a diff row.
                Assert.Contains(compare!.Diffs, d => d.FieldName == VmadField);
                Assert.Equal(ConflictAll.Override, compare.ConflictAll);
            });
    }

    [Fact]
    public void GetCompare_FieldOverrideAndVmadOverride_StaysOverride()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-vmad-field-override")
            .WithPlugin("Base.esp", mod => npcKey = MakeScriptedNpc(mod, 10))
            .WithPlugin("Over.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.EditorID = "Changed";           // generic field override
                o.VirtualMachineAdapter = ScriptVmad(20); // VMAD override (2 plugins)
            })
            .Build();
        using (data)
            WithCompareService(data, svc =>
                Assert.Equal(ConflictAll.Override, svc.GetCompare(npcKey.ToString())!.ConflictAll));
    }

    [Fact]
    public void GetCompare_FieldOverrideAndVmadConflict_EscalatesToConflict()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-vmad-field-conflict")
            .WithPlugin("Base.esp", mod => npcKey = MakeScriptedNpc(mod, 10))
            .WithPlugin("Mid.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.EditorID = "Same";              // non-masters agree on the field → generic Override
                o.VirtualMachineAdapter = ScriptVmad(20);
            })
            .WithPlugin("Top.esp", (mod, prev) =>
            {
                var o = mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First());
                o.EditorID = "Same";
                o.VirtualMachineAdapter = ScriptVmad(30); // VMAD differs among non-masters → Conflict
            })
            .Build();
        using (data)
            WithCompareService(data, svc =>
                Assert.Equal(ConflictAll.Conflict, svc.GetCompare(npcKey.ToString())!.ConflictAll));
    }

    [Fact]
    public void GetCompare_UncontestedFieldOverrideWithVmadConflict_EscalatesToConflict()
    {
        // Verifies EscalateConflict(Override, Conflict) = Conflict (not Override).
        // Both Mid and Top set aggression to the same non-master value → generic = Override (not Conflict).
        // But their VMAD values differ → vmad = Conflict.
        // So EscalateConflict(Override, Conflict) must return Conflict.
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-escalate-override")
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
            .Build();
        using (data)
            WithCompareService(data, svc =>
                Assert.Equal(ConflictAll.Conflict, svc.GetCompare(npcKey.ToString())!.ConflictAll));
    }

    [Fact]
    public void GetCompare_ConflictedFieldWithUncontestedVmad_DoesNotDowngradeFromConflict()
    {
        // Escalation must take the more severe axis even when the generic side is the severe one and VMAD
        // is milder: Mid and Top disagree on aggression, and their VMAD is identical.
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-escalate-no-downgrade")
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
            .Build();
        using (data)
            WithCompareService(data, svc =>
                Assert.Equal(ConflictAll.Conflict, svc.GetCompare(npcKey.ToString())!.ConflictAll));
    }

    [Fact]
    public void GetCompare_EquivalentGenericFieldAndVmadPropertyConflictLoss_ClassifyToSameConflictThis()
    {
        // ADR-0018: a generic field and a VMAD property in the same conflict shape (Mid overridden
        // by Top) must classify to the same ConflictThis per plugin — pins parity across the two classifiers.
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-parity-conflict-loses")
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
            .Build();
        using (data)
            WithCompareService(data, svc =>
            {
                var compare = svc.GetCompare(npcKey.ToString())!;
                var fieldStates = compare.Diffs.First(d => d.FieldName == "Aggression").CellStates;
                var vmadStates = PowerPropertyDiff(compare).CellStates;

                Assert.Equal(ConflictThis.ConflictLoses, fieldStates["Mid.esp"]);
                Assert.Equal(ConflictThis.ConflictWins, fieldStates["Top.esp"]);
                Assert.Equal(fieldStates["Mid.esp"], vmadStates["Mid.esp"]);
                Assert.Equal(fieldStates["Top.esp"], vmadStates["Top.esp"]);
            });
    }

    // A condition list is an ordinary reflected array column, so it reaches the compare grid through
    // the one ConflictClassifier: one FieldDiff per condition, its members as that diff's children.
    [Fact]
    public void GetCompare_RecordHasConditions_ClassifiesThemAsFieldDiffChildren()
    {
        FormKey cobjKey = default;
        var data = new PluginFixtureBuilder("rqs-conditions")
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
            .Build();
        using (data)
            WithCompareService(data, svc =>
            {
                var compare = svc.GetCompare(cobjKey.ToString());

                Assert.NotNull(compare);
                var conditions = Assert.Single(compare!.Diffs, d => d.FieldName == "Conditions");
                var condition = Assert.Single(conditions.Children!);
                var data0 = Assert.Single(condition.Children!, c => c.FieldName == "Data");
                var function = Assert.Single(data0.Children!, c => c.FieldName == "Function");
                Assert.Equal("GetIsID", function.Values["Base.esp"]?.ToString());
                Assert.Equal("Base.esp", conditions.WinnerColumn);
            });
    }

    // GetCompare's memoized resolveFormKey (ADR-0005) reaches a condition's Form parameter through
    // the same nested-leaf path every other reflected formKey leaf uses — this proves the wiring at
    // the actual call site.
    [Fact]
    public void GetCompare_ConditionFormParameter_ResolvesEditorId()
    {
        FormKey cobjKey = default;
        var data = new PluginFixtureBuilder("rqs-condition-resolution")
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
            .Build();
        using (data)
            WithCompareService(data, svc =>
            {
                var compare = svc.GetCompare(cobjKey.ToString());

                var conditions = Assert.Single(compare!.Diffs, d => d.FieldName == "Conditions");
                var condition = Assert.Single(conditions.Children!);
                var data0 = Assert.Single(condition.Children!, c => c.FieldName == "Data");
                var param = Assert.Single(data0.Children!, c => c.FieldName == "ParameterOneRecord");
                Assert.NotNull(param.Resolutions);
                var paramResolution = param.Resolutions!["Base.esp"];
                Assert.Equal(FormKeyResolutionState.ResolvedValidType, paramResolution.State);
                Assert.Equal("SomeQuest", paramResolution.EditorId);
            });
    }

    private static void WithCompareService(PluginFixtureData data, Action<RecordQueryService> test)
    {
        var holder = new LoadOrderHolder();
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        using var manager = new IndexProjector(holder, MutagenPluginAdapter.Instance, factory);
        manager.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);
        test(new RecordQueryService(manager, holder, reflector, new ConflictClassifier()));
    }

    private static FormKey MakeScriptedNpc(IFallout4Mod mod, int power)
    {
        var npc = mod.Npcs.AddNew("ScriptedNPC");
        npc.VirtualMachineAdapter = ScriptVmad(power);
        return npc.FormKey;
    }

    private const string VmadField = "VirtualMachineAdapter";

    private static FieldDiff PowerPropertyDiff(CompareResult compare) =>
        compare.Diffs.First(d => d.FieldName == VmadField)
            .Children!.First(c => c.FieldName == "Scripts")
            .Children!.First(c => c.FieldName == "S")
            .Children!.First(c => c.FieldName == "Properties")
            .Children!.First(c => c.FieldName == "Power");

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

    [Fact]
    public void GetPluginRecordTypes_ReturnsCountsForPlugin()
    {
        var result = _svc.GetPluginRecordTypes(TestPluginFixture.PluginName);

        var npc = Assert.Single(result, r => r.Type == "npc_");
        Assert.Equal(TestPluginFixture.RecordCount, npc.Count);
        Assert.All(result, r => Assert.True(r.Count > 0));
    }

    [Fact]
    public void GetPluginRecordTypes_DisplayName_MatchesXEdit()
    {
        // The signature ("npc_") stays the key; DisplayName is additive, sourced
        // from the same xEdit-parity lookup SchemaReflector uses.
        var result = _svc.GetPluginRecordTypes(TestPluginFixture.PluginName);

        var npc = Assert.Single(result, r => r.Type == "npc_");
        Assert.Equal("Non-Player Character", npc.DisplayName);
    }

    // Ascending-order guarantee is tested with >1 type in
    // GetPluginRecordTypes_WithMultipleTypes_ReturnsInAscendingOrder; the single-type
    // fixture makes a dedicated ordering test here trivially true.

    [Fact]
    public void GetPluginRecordTypes_ExcludesHeader()
    {
        // Every plugin indexes exactly one header row, so without the exclusion "header" would appear as a
        // browsable record-type node. The header is reached only via "Open Header" on the plugin node.
        var result = _svc.GetPluginRecordTypes(TestPluginFixture.PluginName);

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
    public void GetPlugins_NoLoadOrder_ThrowsInvalidOperationException()
    {
        var unloaded = MakeUnloadedService();
        var ex = Assert.Throws<NoLoadOrderException>(() => unloaded.GetPlugins());
        Assert.Contains("No load order", ex.Message);
    }

    [Fact]
    public void GetRecords_NoLoadOrder_ThrowsInvalidOperationException()
    {
        var unloaded = MakeUnloadedService();
        var ex = Assert.Throws<NoLoadOrderException>(() => unloaded.GetRecords("npc_", null, null, 10, 0));
        Assert.Contains("No load order", ex.Message);
    }

    [Fact]
    public void GetRecords_AllTypes_ReturnsSortedByEditorId()
    {
        var holder = new LoadOrderHolder();
        var data = new PluginFixtureBuilder("rqs-sort-records")
            .WithPlugin("SortTest.esp", mod =>
            {
                mod.Npcs.AddNew("Zebra");
                mod.Npcs.AddNew("Apple");
            })
            .Build();
        using (data)
        {
            var reflector = SharedSchemaReflector.Instance;
            var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new IndexProjector(holder, MutagenPluginAdapter.Instance, factory);
            manager.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var svc = new RecordQueryService(manager, holder, reflector, new ConflictClassifier());

            var result = svc.GetRecords(type: null, plugin: null, search: null, limit: 10, offset: 0);

            var editorIds = result.Items.Select(r => r.EditorId).ToList();
            Assert.Equal(2, editorIds.Count);
            Assert.Equal([.. editorIds.OrderBy(e => e, StringComparer.OrdinalIgnoreCase)], editorIds);
        }
    }

    // --- Plugin header reachable through the existing generic FormKey lookup/compare path,
    // with no new endpoint — a red result here signals a gap in the schema/indexer design,
    // not a missing endpoint.

    [Fact]
    public void GetRecord_PluginHeaderFormKey_ReturnsAuthorFlagsMasters()
    {
        var holder = new LoadOrderHolder();
        var data = new PluginFixtureBuilder("rqs-header-record")
            .WithPlugin("HeaderQuery.esp", mod =>
            {
                mod.ModHeader.Author = "Test Author";
                mod.ModHeader.Flags = Fallout4ModHeader.HeaderFlag.Small;
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Fallout4.esm") });
            },
                // WriteToBinary normally recomputes the master list from actual FormLink usage,
                // stripping a manually-added master reference with no corresponding FormLink —
                // NoCheck preserves it so this test can assert on it after the disk round-trip.
                writeParams: new Mutagen.Bethesda.Plugins.Binary.Parameters.BinaryWriteParameters
                {
                    MastersListContent = Mutagen.Bethesda.Plugins.Binary.Parameters.MastersListContentOption.NoCheck,
                })
            .Build();
        using (data)
        {
            var reflector = SharedSchemaReflector.Instance;
            var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new IndexProjector(holder, MutagenPluginAdapter.Instance, factory);
            manager.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var svc = new RecordQueryService(manager, holder, reflector, new ConflictClassifier());

            var detail = svc.GetRecord("000000:HeaderQuery.esp");

            Assert.NotNull(detail);
            var author = detail.Fields.Single(f => f.Metadata.Name == "Author");
            Assert.Equal("Test Author", Assert.IsType<JsonElement>(author.Value).GetString());

            var flags = detail.Fields.Single(f => f.Metadata.Name == "Flags");
            Assert.Equal([nameof(Fallout4ModHeader.HeaderFlag.Small)], Assert.IsType<JsonElement>(flags.Value).EnumerateArray().Select(e => e.GetString()));

            var masters = detail.Fields.Single(f => f.Metadata.Name == "MasterReferences");
            Assert.Contains("Fallout4.esm", masters.Value!.ToString());
        }
    }

    [Fact]
    public void GetCompare_PluginHeaderFormKey_ReturnsSingleOverride()
    {
        var holder = new LoadOrderHolder();
        var data = new PluginFixtureBuilder("rqs-header-compare")
            .WithPlugin("CompareA.esp")
            .WithPlugin("CompareB.esp")
            .Build();
        using (data)
        {
            var reflector = SharedSchemaReflector.Instance;
            var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new IndexProjector(holder, MutagenPluginAdapter.Instance, factory);
            manager.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var svc = new RecordQueryService(manager, holder, reflector, new ConflictClassifier());

            var compare = svc.GetCompare("000000:CompareA.esp");

            Assert.NotNull(compare);
            var overrides = Assert.Single(compare.Overrides);
            Assert.Equal("CompareA.esp", overrides.Plugin);
        }
    }

    private static RecordQueryService MakeUnloadedService()
    {
        var holder = new LoadOrderHolder();
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        var manager = new IndexProjector(holder, MutagenPluginAdapter.Instance, factory);
        return new RecordQueryService(manager, new LoadOrderHolder(), reflector, new ConflictClassifier());
    }

    // --- GetPlugins: HasMatchingRecords, never row pruning (plugins.md) ---

    [Fact]
    public void GetPlugins_WithFilterMatchingRecords_ReturnsPlugin()
    {
        _manager.SetFilter($"SELECT form_key FROM \"NPC_\"");
        try
        {
            var plugins = _svc.GetPlugins();
            var plugin = Assert.Single(plugins, p => p.Copy.Name == TestPluginFixture.PluginName);
            Assert.True(plugin.HasMatchingRecords);
        }
        finally { _manager.ClearFilter(); }
    }

    // plugins.md: a record filter prunes records and record types, never a plugin row, because this tree
    // is also the load order and hiding a plugin mid-filter would make it unreorderable.
    [Fact]
    public void GetPlugins_WithFilterMatchingNoRecords_KeepsPluginVisibleButFlagsNoMatch()
    {
        _manager.SetFilter("SELECT 'NoSuchFormKey:000000' AS form_key");
        try
        {
            var plugins = _svc.GetPlugins();
            var plugin = Assert.Single(plugins, p => p.Copy.Name == TestPluginFixture.PluginName);
            Assert.False(plugin.HasMatchingRecords);
        }
        finally { _manager.ClearFilter(); }
    }

    [Fact]
    public void GetPlugins_AfterClearFilter_RestoresAllPlugins()
    {
        _manager.SetFilter("SELECT 'NoSuchFormKey:000000' AS form_key");
        _manager.ClearFilter();

        var plugins = _svc.GetPlugins();
        var plugin = Assert.Single(plugins);
        Assert.Equal(TestPluginFixture.PluginName, plugin.Copy.Name);
        Assert.True(plugin.HasMatchingRecords);
    }

}
