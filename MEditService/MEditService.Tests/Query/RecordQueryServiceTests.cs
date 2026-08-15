using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Query;

[Collection(TestPluginFixtureCollection.Name)]
public sealed class RecordQueryServiceTests : IDisposable
{
    private readonly SessionManager _manager;
    private readonly RecordQueryService _svc;

    public RecordQueryServiceTests(TestPluginFixture fixture)
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        _manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
        _manager.Load(fixture.DataFolder, fixture.PluginsTxtPath, GameRelease.Fallout4);
        _svc = new RecordQueryService(_manager, DuckDbTestFactory.MakePendingChangeService(), reflector, new ConflictClassifier());
    }

    public void Dispose() => _manager.Dispose();

    // --- GET /plugins ---

    [Fact]
    public void GetPlugins_ReturnsLoadedPlugin()
    {
        var plugins = _svc.GetPlugins();

        Assert.Single(plugins);
        Assert.Equal(TestPluginFixture.PluginName, plugins[0].Name);
        Assert.Equal(TestPluginFixture.RecordCount, plugins[0].RecordCount);
    }

    // #277 / ADR-0037: a plugin whose master is absent from the whole session is flagged on the
    // wire, not just detected in-memory — this is what lets the tree render it.
    [Fact]
    public void GetPlugins_PluginWithMissingMaster_ReportsItAsDirectlyMissing()
    {
        // ADR-0038: masters are lifecycle-derived from the live object graph, never
        // user-declared — a bare ModHeader.MasterReferences.Add is discarded on write. A genuine
        // reference into the (never-built) master is what makes Mutagen record it for real.
        using var fx = new PluginFixtureBuilder("rqs-missing-master")
            .WithPlugin("Patch.esp", mod => mod.Npcs.AddNew("PatchedNpc").Race.SetTo(
                new FormKey(ModKey.FromFileName("Ghost.esm"), 0x800)))
            .Build();
        using var manager = new SessionManager(
            new DuckDbRecordRepositoryFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)),
            new PluginWriter(SharedSchemaReflector.Instance, NullLogger<PluginWriter>.Instance));
        manager.Load(fx.DataFolder, fx.PluginsTxtPath, GameRelease.Fallout4);
        var svc = new RecordQueryService(manager, DuckDbTestFactory.MakePendingChangeService(), SharedSchemaReflector.Instance, new ConflictClassifier());

        var plugins = svc.GetPlugins();

        var patch = Assert.Single(plugins, p => p.Name == "Patch.esp");
        var issue = Assert.Single(patch.MasterIssues);
        Assert.Equal("Ghost.esm", issue.MasterName);
        Assert.Equal(MasterIssueKind.DirectlyMissing, issue.Kind);
    }

    // #277 / ADR-0037 AC6: pinning, not new behavior — ADR-0037 states this already works
    // (Mutagen builds FormKeys from a plugin's own header, so reading never requires a master to
    // exist, and a FormLink into an absent one already resolves to nothing and already falls back
    // to the raw FormKey). This is the true end-to-end version of that claim: a whole session
    // built via GameSession/SessionManager (not a hand-fed DuckDbRecordRepository), where the
    // referenced master is never part of the load order at all — no plugins.txt line, no file.
    [Fact]
    public void GetRecord_ReferenceIntoAbsentMaster_RendersUnresolvedRatherThanErroring()
    {
        FormKey npcFormKey = default;
        using var fx = new PluginFixtureBuilder("rqs-absent-master-ref")
            .WithPlugin("Patch.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("PatchedNpc");
                npcFormKey = npc.FormKey;
                npc.Race.SetTo(new FormKey(ModKey.FromFileName("Ghost.esm"), 0x800));
            })
            .Build();
        using var manager = new SessionManager(
            new DuckDbRecordRepositoryFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)),
            new PluginWriter(SharedSchemaReflector.Instance, NullLogger<PluginWriter>.Instance));
        manager.Load(fx.DataFolder, fx.PluginsTxtPath, GameRelease.Fallout4);
        var svc = new RecordQueryService(manager, DuckDbTestFactory.MakePendingChangeService(), SharedSchemaReflector.Instance, new ConflictClassifier());

        var detail = svc.GetRecord(npcFormKey.ToString());

        Assert.NotNull(detail);
        var raceField = Assert.Single(detail.Fields, f => f.Metadata.Name == "race");
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

    // --- GET /record-types ---

    [Fact]
    public void GetRecordTypes_ReturnsKnownTypes()
    {
        var types = _svc.GetRecordTypes();

        Assert.Contains("npc_", types);
        Assert.Contains("weap", types);
        Assert.True(types.Count >= 20);
    }

    [Fact]
    public void GetRecordTypes_ReturnsTypesInAscendingOrder()
    {
        var types = _svc.GetRecordTypes();
        Assert.Equal([.. types.Order()], types);
    }

    [Fact]
    public void GetRecordTypes_ExcludesHeader()
    {
        // The header isn't a browsable record type in the "expand a plugin -> record types"
        // sense (User Story 7) — it's reached only via "Open Header" on the plugin node itself.
        var types = _svc.GetRecordTypes();
        Assert.DoesNotContain("header", types);
    }

    // --- GET /condition-functions ---

    [Fact]
    public void GetConditionFunctions_Fallout4Session_ReturnsMutagenResolvedFunctionNames()
    {
        // Filtered to what Mutagen actually resolves for the loaded session's game (#152) — not a
        // hardcoded list. GetIsID and GetDistance are ordinary FO4 condition functions; a name from
        // a different game's Function enum (e.g. Skyrim-only) must not appear.
        var functions = _svc.GetConditionFunctions();

        Assert.Contains("GetIsID", functions);
        Assert.Contains("GetDistance", functions);
        Assert.True(functions.Count > 400);
    }

    // --- GET /condition-run-on-targets ---

    [Fact]
    public void GetConditionRunOnTargets_Fallout4Session_ReturnsMutagenResolvedRunOnTypeNames()
    {
        // Filtered to what Mutagen actually resolves for the loaded session's game (#167) — not a
        // hardcoded frontend array. PlayerShip is a Starfield-only RunOnType member; it must not
        // appear for an FO4 session, proving this isn't a hand-maintained cross-game list.
        var targets = _svc.GetConditionRunOnTargets();

        Assert.Contains("Subject", targets);
        Assert.Contains("Reference", targets);
        Assert.Contains("CombatTarget", targets);
        Assert.DoesNotContain("PlayerShip", targets);
        Assert.Equal(11, targets.Count);
    }

    // --- GET /records ---

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

    // Issue #210: the FormKey picker seeds its QuickPick with the record's own FormKey, which
    // is only coherent if searching by that FormKey resolves it — the backend previously matched
    // `search` against EditorID only, so a seeded FormKey (or a pasted one, #201) matched nothing.
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
    // the picker seeds from whatever casing a resolved link displays, and #201's "paste a FormKey"
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
            Assert.Contains(f.Metadata.Type, new[] { "string", "int", "float", "bool", "enum", "formKey", "array", "struct" });
        });
    }

    [Fact]
    public void GetRecord_UnknownFormKey_ReturnsNull()
    {
        var detail = _svc.GetRecord("FFFFFF:Unknown.esp");

        Assert.Null(detail);
    }

    // Issue #3: "Copy as New Record" needs the record's schema table name up front (CreateRecord
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

    // #267 / ADR-0035: a FormKey present in one enabled and one disabled plugin is not a conflict —
    // the disabled override is indexed and browsable, but excluded from conflict classification.
    [Fact]
    public void GetCompare_FormKeyInEnabledAndDisabledPlugin_ReturnsOnlyOne_NotConflict()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-participation")
            .WithPlugin("Base.esp", mod => npcKey = mod.Npcs.AddNew("SharedNPC").FormKey)
            .WithPlugin("Disabled.esp", (mod, prev) =>
                mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).CalcMinLevel = 5, enabled: false)
            .Build();
        using (data)
        {
            var reflector = SharedSchemaReflector.Instance;
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var svc = new RecordQueryService(manager, DuckDbTestFactory.MakePendingChangeService(), reflector, new ConflictClassifier());

            var compare = svc.GetCompare(npcKey.ToString());

            Assert.NotNull(compare);
            Assert.Equal(ConflictAll.OnlyOne, compare.ConflictAll);
        }
    }

    // #267 / ADR-0035: VMAD's own conflict contribution (folded into ConflictAll alongside the
    // generic field path) must be participation-aware too. Base and Mid agree on everything
    // (generic fields + VMAD) so the record-level classification isn't the OnlyOne shortcut — Mid
    // makes it a real 2-participant NoConflict — and only the disabled, last-in-order plugin
    // differs on VMAD. Pre-fix, VMAD's own unfiltered winner/cell-state pass would pick the
    // disabled plugin as winner and escalate this to Override.
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
    public void GetCompare_NpcRecord_HasVmadIsTrue()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var compare = _svc.GetCompare(all.Items[0].FormKey);

        Assert.NotNull(compare);
        Assert.True(compare!.HasVmad);
    }

    [Fact]
    public void GetCompare_CmpoRecord_HasVmadIsFalse()
    {
        // Issue #179: CMPO ("Component") categorically cannot carry VMAD — the capability flag
        // must be false even though this specific record obviously has no VMAD data either way,
        // distinguishing "this type can never have scripts" from "this record has none yet".
        FormKey componentKey = default;
        var data = new PluginFixtureBuilder("rqs-vmad-cmpo")
            .WithPlugin("Base.esp", mod => componentKey = mod.Components.AddNew("SomeComponent").FormKey)
            .Build();
        using (data)
            WithCompareService(data, svc =>
            {
                var compare = svc.GetCompare(componentKey.ToString());
                Assert.NotNull(compare);
                Assert.False(compare!.HasVmad);
            });
    }

    [Fact]
    public void GetCompare_RecordIdenticalExceptVmad_ClassifiesAsConflict()
    {
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
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var svc = new RecordQueryService(manager, DuckDbTestFactory.MakePendingChangeService(), reflector, new ConflictClassifier());

            var compare = svc.GetCompare(npcKey.ToString());

            Assert.NotNull(compare);
            // Non-VMAD fields are identical overrides, so only VMAD differs — yet the record is conflicted.
            Assert.Equal(ConflictAll.Conflict, compare!.ConflictAll);
            Assert.NotNull(compare.Vmad);
            var script = Assert.Single(compare.Vmad!.Scripts);
            var prop = script.Properties.First(p => p.Name == "Power");
            Assert.Equal("Top.esp", prop.WinnerColumn);
        }
    }

    [Fact]
    public void GetCompare_NoOverrideHasVmad_VmadIsNull()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var compare = _svc.GetCompare(all.Items[0].FormKey);

        Assert.NotNull(compare);
        Assert.Null(compare!.Vmad);
    }

    [Fact]
    public void GetCompare_OnlyOverrideHasVmad_PopulatesVmad()
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
                Assert.NotNull(compare!.Vmad); // master lacks VMAD, override adds it → still present
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
        // Verifies Escalate(Conflict, NoConflict) = Conflict (not NoConflict) — escalation must take
        // the more severe axis even when the *generic* side is the more severe one and VMAD is milder.
        // Both Mid and Top disagree on aggression → generic = Conflict. Their VMAD is identical → vmad = NoConflict.
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
        // ADR-0016: a generic field and a VMAD property in the same conflict shape (Mid overridden
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
                var fieldStates = compare.Diffs.First(d => d.FieldName == "aggression").CellStates;
                var vmadStates = compare.Vmad!.Scripts[0].Properties.First(p => p.Name == "Power").CellStates;

                Assert.Equal(ConflictThis.ConflictLoses, fieldStates["Mid.esp"]);
                Assert.Equal(ConflictThis.ConflictWins, fieldStates["Top.esp"]);
                Assert.Equal(fieldStates["Mid.esp"], vmadStates["Mid.esp"]);
                Assert.Equal(fieldStates["Top.esp"], vmadStates["Top.esp"]);
            });
    }

    [Fact]
    public void GetCompare_RecordHasConditions_PopulatesConditionCompareShape()
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
                Assert.NotNull(compare!.Conditions);
                var group = Assert.Single(compare.Conditions!.Groups);
                Assert.Equal("Conditions", group.FieldPath);
                var diff = Assert.Single(group.Conditions);
                Assert.Equal("GetIsID", diff.PerPlugin["Base.esp"]!.Function);
                Assert.Equal("Base.esp", diff.WinnerColumn);
            });
    }

    // #166: GetCompare built its own memoized resolveFormKey (ADR-0031) for generic fields and VMAD
    // but never threaded it into the condition path — this proves the wiring at the actual call
    // site, not just that the classifier accepts a resolver (ConditionConflictClassifierTests
    // already covers the classifier's own behavior in isolation).
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

                var diff = Assert.Single(Assert.Single(compare!.Conditions!.Groups).Conditions);
                Assert.NotNull(diff.FieldResolutions);
                var paramResolution = diff.FieldResolutions!["param:0"]["Base.esp"];
                Assert.Equal(FormKeyResolutionState.ResolvedValidType, paramResolution.State);
                Assert.Equal("SomeQuest", paramResolution.EditorId);
            });
    }

    private static void WithCompareService(PluginFixtureData data, Action<RecordQueryService> test)
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
        manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
        test(new RecordQueryService(manager, DuckDbTestFactory.MakePendingChangeService(), reflector, new ConflictClassifier()));
    }

    private static FormKey MakeScriptedNpc(IFallout4Mod mod, int power)
    {
        var npc = mod.Npcs.AddNew("ScriptedNPC");
        npc.VirtualMachineAdapter = ScriptVmad(power);
        return npc.FormKey;
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
        // Issue #110: the signature ("npc_") stays the key; DisplayName is additive, sourced
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
        // Every plugin indexes exactly one header row, so without the exclusion "header" would
        // appear as a browsable record-type node (count 1) in the "expand a plugin" tree — the
        // header is reached only via "Open Header" on the plugin node itself (User Story 7/38).
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

    // --- GET /records/{formKey}/plugin/{plugin} ---

    [Fact]
    public void GetRecordForPlugin_KnownFormKey_ReturnsRecord()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;

        var detail = _svc.GetRecordForPlugin(fk, TestPluginFixture.PluginName, "Data");

        Assert.NotNull(detail);
        Assert.Equal(fk, detail.FormKey);
        Assert.Equal(TestPluginFixture.PluginName, detail.Plugin);
    }

    [Fact]
    public void GetRecordForPlugin_UnknownFormKey_ReturnsNull()
    {
        var detail = _svc.GetRecordForPlugin("FFFFFF:Unknown.esp", TestPluginFixture.PluginName, "Data");

        Assert.Null(detail);
    }

    [Fact]
    public void GetRecordForPlugin_UnknownPlugin_ReturnsNull()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;

        var detail = _svc.GetRecordForPlugin(fk, "NonExistent.esp", "Data");

        Assert.Null(detail);
    }

    // --- GET /records/{formKey}/type ---

    [Fact]
    public void GetRecordType_KnownFormKey_ReturnsType()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;

        var type = _svc.GetRecordType(fk);

        Assert.Equal("npc_", type);
    }

    [Fact]
    public void GetRecordType_UnknownFormKey_ReturnsNull()
    {
        var type = _svc.GetRecordType("FFFFFF:Unknown.esp");

        Assert.Null(type);
    }

    // --- GET /records/{formKey}/compare — with pending changes ---

    [Fact]
    public void GetCompare_WithPendingChanges_IncludesPendingFieldsInOverride()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;

        // Stage a pending change for this record
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var newVal = System.Text.Json.JsonDocument.Parse("\"Frenzied\"").RootElement;
        changes.Upsert(new PendingChangeUpsert(fk, TestPluginFixture.PluginName, "npc_",
            new Dictionary<string, System.Text.Json.JsonElement> { ["aggression"] = newVal },
            "test", null,
            [], FormRefs: null, ChangeType: PendingChangeConstants.FieldEditChangeType, ParentCell: null, PlacementGroup: null, Origin: "Data"));

        var svcWithChanges = new RecordQueryService(_manager, changes, SharedSchemaReflector.Instance, new ConflictClassifier());
        var compare = svcWithChanges.GetCompare(fk);

        Assert.NotNull(compare);
        var override_ = compare.Overrides.Single(o => o.Plugin == TestPluginFixture.PluginName);
        Assert.NotNull(override_.PendingFields);
        Assert.True(override_.PendingFields!.ContainsKey("aggression"));
    }

    // --- No-session guard clauses ---

    [Fact]
    public void GetPlugins_NoSession_ThrowsInvalidOperationException()
    {
        var unloaded = MakeUnloadedService();
        var ex = Assert.Throws<InvalidOperationException>(() => unloaded.GetPlugins());
        Assert.Contains("No session loaded", ex.Message);
    }

    [Fact]
    public void GetRecords_NoSession_ThrowsInvalidOperationException()
    {
        var unloaded = MakeUnloadedService();
        var ex = Assert.Throws<InvalidOperationException>(() => unloaded.GetRecords("npc_", null, null, 10, 0));
        Assert.Contains("No session loaded", ex.Message);
    }

    [Fact]
    public void GetRecords_AllTypes_ReturnsSortedByEditorId()
    {
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
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var svc = new RecordQueryService(manager, DuckDbTestFactory.MakePendingChangeService(), reflector, new ConflictClassifier());

            var result = svc.GetRecords(type: null, plugin: null, search: null, limit: 10, offset: 0);

            var editorIds = result.Items.Select(r => r.EditorId).ToList();
            Assert.Equal(2, editorIds.Count);
            Assert.Equal([.. editorIds.OrderBy(e => e, StringComparer.OrdinalIgnoreCase)], editorIds);
        }
    }

    // --- Issue #1 slice A1: plugin header reachable through the existing generic FormKey
    // lookup/compare path, with no new endpoint. These are expected to pass with zero new
    // production code beyond slices 1-3 — a red result here would signal a gap in the
    // schema/indexer design, not a missing endpoint.

    [Fact]
    public void GetRecord_PluginHeaderFormKey_ReturnsAuthorFlagsMasters()
    {
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
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var svc = new RecordQueryService(manager, DuckDbTestFactory.MakePendingChangeService(), reflector, new ConflictClassifier());

            var detail = svc.GetRecord("000000:HeaderQuery.esp");

            Assert.NotNull(detail);
            var author = detail.Fields.Single(f => f.Metadata.Name == "author");
            Assert.Equal("Test Author", author.Value);

            var flags = detail.Fields.Single(f => f.Metadata.Name == "flags");
            Assert.Equal(((long)Fallout4ModHeader.HeaderFlag.Small).ToString(System.Globalization.CultureInfo.InvariantCulture), flags.Value);

            var masters = detail.Fields.Single(f => f.Metadata.Name == "masters");
            Assert.Contains("Fallout4.esm", masters.Value!.ToString());
        }
    }

    [Fact]
    public void GetCompare_PluginHeaderFormKey_ReturnsSingleOverride()
    {
        var data = new PluginFixtureBuilder("rqs-header-compare")
            .WithPlugin("CompareA.esp")
            .WithPlugin("CompareB.esp")
            .Build();
        using (data)
        {
            var reflector = SharedSchemaReflector.Instance;
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var svc = new RecordQueryService(manager, DuckDbTestFactory.MakePendingChangeService(), reflector, new ConflictClassifier());

            var compare = svc.GetCompare("000000:CompareA.esp");

            Assert.NotNull(compare);
            var overrides = Assert.Single(compare.Overrides);
            Assert.Equal("CompareA.esp", overrides.Plugin);
        }
    }

    [Fact]
    public void GetPluginRecordTypes_WithMultipleTypes_ReturnsInAscendingOrder()
    {
        var data = new PluginFixtureBuilder("rqs-sort-types")
            .WithPlugin("MultiType.esp", mod =>
            {
                mod.Npcs.AddNew("TestNPC");
                mod.Weapons.AddNew("TestWeapon");
            })
            .Build();
        using (data)
        {
            var reflector = SharedSchemaReflector.Instance;
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var svc = new RecordQueryService(manager, DuckDbTestFactory.MakePendingChangeService(), reflector, new ConflictClassifier());

            var result = svc.GetPluginRecordTypes("MultiType.esp");
            var types = result.Select(r => r.Type).ToList();

            Assert.True(types.Count >= 2, "Expected at least 2 record types");
            Assert.Equal([.. types.OrderBy(t => t, StringComparer.OrdinalIgnoreCase)], types);
        }
    }

    private static RecordQueryService MakeUnloadedService()
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
        return new RecordQueryService(manager, DuckDbTestFactory.MakePendingChangeService(), reflector, new ConflictClassifier());
    }

    // --- GetRecord / GetRecordForPlugin use FindRecordType, not table scan ---

    private (RecordQueryService Svc, SpyRecordReader Spy, IDisposable Mod) MakeSpySvc()
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var inner = factory.Create(GameRelease.Fallout4);
        var mod = Mutagen.Bethesda.Fallout4.Fallout4Mod.CreateFromBinaryOverlay(
            new Mutagen.Bethesda.Plugins.ModPath(
                Mutagen.Bethesda.Plugins.ModKey.FromFileName(TestPluginFixture.PluginName),
                Path.Combine(_manager.Session!.DataFolderPath, TestPluginFixture.PluginName)),
            Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4);
        inner.Index(mod, 0, participates: true, origin: "Data");
        inner.UpdateWinners();
        var spy = new SpyRecordReader(inner);
        var stubSession = new StubSessionManager(spy, GameRelease.Fallout4);
        var svc = new RecordQueryService(stubSession, DuckDbTestFactory.MakePendingChangeService(), reflector, new ConflictClassifier());
        return (svc, spy, new CompositeDisposable(mod, inner));
    }

    private sealed class CompositeDisposable(params IDisposable[] items) : IDisposable
    {
        public void Dispose()
        {
            foreach (var item in items) item.Dispose();
        }
    }

    [Fact]
    public void GetRecord_UsesFindRecordTypeNotTableScan()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;
        var (svc, spy, mod) = MakeSpySvc();
        using (mod)
        {
            spy.Reset();
            var detail = svc.GetRecord(fk);
            Assert.NotNull(detail);
            Assert.Equal(1, spy.FindRecordTypeCalls);
            Assert.Equal(1, spy.GetRecordCalls);
        }
    }

    [Fact]
    public void GetRecordForPlugin_UsesFindRecordTypeNotTableScan()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;
        var (svc, spy, mod) = MakeSpySvc();
        using (mod)
        {
            spy.Reset();
            var detail = svc.GetRecordForPlugin(fk, TestPluginFixture.PluginName, "Data");
            Assert.NotNull(detail);
            Assert.Equal(1, spy.FindRecordTypeCalls);
            Assert.Equal(1, spy.GetRecordCalls);
        }
    }

    [Fact]
    public void GetRecord_PassesWinnerOnlyTrue()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;
        var (svc, spy, mod) = MakeSpySvc();
        using (mod)
        {
            svc.GetRecord(fk);
            Assert.True(spy.LastWinnerOnly);
        }
    }

    [Fact]
    public void GetRecordForPlugin_PassesWinnerOnlyFalse()
    {
        var all = _svc.GetRecords(type: "npc_", plugin: null, search: "TestNPC01", limit: 1, offset: 0);
        var fk = all.Items[0].FormKey;
        var (svc, spy, mod) = MakeSpySvc();
        using (mod)
        {
            svc.GetRecordForPlugin(fk, TestPluginFixture.PluginName, "Data");
            Assert.False(spy.LastWinnerOnly);
        }
    }

    // --- GetPluginRecordTypes — staged records ---

    [Fact]
    public void GetPluginRecordTypes_IncludesStagedRecordsNotInIndex()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-staged-types")
            .WithPlugin("Source.esp", mod => npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .WithPlugin("Override.esp")
            .Build();
        using (data)
        {
            var reflector = SharedSchemaReflector.Instance;
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var changes = DuckDbTestFactory.MakePendingChangeService();
            changes.Upsert(new PendingChangeUpsert(npcKey.ToString(), "Override.esp", "npc_",
                new Dictionary<string, System.Text.Json.JsonElement> { ["aggression"] = System.Text.Json.JsonDocument.Parse("\"Frenzied\"").RootElement },
                "user", null, [], FormRefs: null, ChangeType: PendingChangeConstants.FieldEditChangeType, ParentCell: null, PlacementGroup: null, Origin: "Data"));
            var svc = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());

            var result = svc.GetPluginRecordTypes("Override.esp");

            var npc = Assert.Single(result, r => r.Type == "npc_");
            Assert.Equal(1, npc.Count);
        }
    }

    [Fact]
    public void GetPluginRecordTypes_StagedCountAddedToCommittedCount()
    {
        FormKey npcKey1 = default;
        FormKey npcKey2 = default;
        var data = new PluginFixtureBuilder("rqs-staged-types-merge")
            .WithPlugin("Source.esp", mod =>
            {
                npcKey1 = mod.Npcs.AddNew("NPC1").FormKey;
                npcKey2 = mod.Npcs.AddNew("NPC2").FormKey;
            })
            .WithPlugin("Override.esp", mod => mod.Npcs.AddNew("NPC1") /* commits one override */)
            .Build();
        using (data)
        {
            // Override.esp has 1 committed record; stage a 2nd one
            var reflector = SharedSchemaReflector.Instance;
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var changes = DuckDbTestFactory.MakePendingChangeService();
            // stage npcKey2 into Override.esp (not yet committed)
            changes.Upsert(new PendingChangeUpsert(npcKey2.ToString(), "Override.esp", "npc_",
                new Dictionary<string, System.Text.Json.JsonElement> { ["aggression"] = System.Text.Json.JsonDocument.Parse("\"Frenzied\"").RootElement },
                "user", null, [], FormRefs: null, ChangeType: PendingChangeConstants.FieldEditChangeType, ParentCell: null, PlacementGroup: null, Origin: "Data"));
            var svc = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());

            var result = svc.GetPluginRecordTypes("Override.esp");

            var npc = Assert.Single(result, r => r.Type == "npc_");
            Assert.Equal(2, npc.Count);
        }
    }

    // #296 review: GetPluginRecordTypes' committed-side CountRecordsForPlugin call is correctly
    // scoped to the resolved origin, but its staged-side GetStagedFormKeys call originally omitted
    // origin entirely — every other staged-record fixture in this file (including the three above)
    // stages at Origin: "Data", which is exactly the elided default the issue warns about, so none
    // of them could tell a working filter from a missing one. This fixture stages a *second*,
    // distinct FormKey under a real non-Data origin ("ModA") for the same plugin filename; the
    // session's own resolved origin for "Override.esp" is "Data" (manager.Load's implicit path), so
    // only the Data-origin staged record should count.
    [Fact]
    public void GetPluginRecordTypes_StagedRecord_ScopesToResolvedOrigin()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-staged-types-origin")
            .WithPlugin("Source.esp", mod => npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .WithPlugin("Override.esp")
            .Build();
        using (data)
        {
            var reflector = SharedSchemaReflector.Instance;
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var changes = DuckDbTestFactory.MakePendingChangeService();
            changes.Upsert(new PendingChangeUpsert(npcKey.ToString(), "Override.esp", "npc_",
                new Dictionary<string, System.Text.Json.JsonElement> { ["aggression"] = System.Text.Json.JsonDocument.Parse("\"Frenzied\"").RootElement },
                "user", null, [], FormRefs: null, ChangeType: PendingChangeConstants.FieldEditChangeType, ParentCell: null, PlacementGroup: null, Origin: "Data"));
            changes.Upsert(new PendingChangeUpsert("001234:Override.esp", "Override.esp", "npc_",
                new Dictionary<string, System.Text.Json.JsonElement> { ["aggression"] = System.Text.Json.JsonDocument.Parse("\"Frenzied\"").RootElement },
                "user", null, [], FormRefs: null, ChangeType: PendingChangeConstants.FieldEditChangeType, ParentCell: null, PlacementGroup: null, Origin: "ModA"));
            var svc = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());

            var result = svc.GetPluginRecordTypes("Override.esp");

            var npc = Assert.Single(result, r => r.Type == "npc_");
            Assert.Equal(1, npc.Count);
        }
    }

    [Fact]
    public void GetPluginRecordTypes_StagedAlreadyCommittedRecordIsNotCounted()
    {
        // Override.esp has a committed NPC override that is NOT the winner (Winner.esp comes later).
        // Staging a pending edit to that committed key must not double-count it.
        FormKey baseNpcKey = default;
        var data = new PluginFixtureBuilder("rqs-staged-types-dedup")
            .WithPlugin("Base.esp", mod => baseNpcKey = mod.Npcs.AddNew("BaseNPC").FormKey)
            .WithPlugin("Override.esp", (mod, prev) => mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).EditorID = "OverrideNPC")
            .WithPlugin("Winner.esp", (mod, prev) => mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).EditorID = "WinnerNPC")
            .Build();
        using (data)
        {
            var reflector = SharedSchemaReflector.Instance;
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var changes = DuckDbTestFactory.MakePendingChangeService();
            changes.Upsert(new PendingChangeUpsert(baseNpcKey.ToString(), "Override.esp", "npc_",
                new Dictionary<string, System.Text.Json.JsonElement> { ["aggression"] = System.Text.Json.JsonDocument.Parse("\"Frenzied\"").RootElement },
                "user", null, [], FormRefs: null, ChangeType: PendingChangeConstants.FieldEditChangeType, ParentCell: null, PlacementGroup: null, Origin: "Data"));
            var svc = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());

            var result = svc.GetPluginRecordTypes("Override.esp");

            var npc = Assert.Single(result, r => r.Type == "npc_");
            Assert.Equal(1, npc.Count);
        }
    }

    // --- GetRecords — staged records ---

    [Fact]
    public void GetRecords_ByPlugin_IncludesStagedOnlyRecords()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-staged-records")
            .WithPlugin("Source.esp", mod => npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .WithPlugin("Override.esp")
            .Build();
        using (data)
        {
            var reflector = SharedSchemaReflector.Instance;
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var changes = DuckDbTestFactory.MakePendingChangeService();
            changes.Upsert(new PendingChangeUpsert(npcKey.ToString(), "Override.esp", "npc_",
                new Dictionary<string, System.Text.Json.JsonElement> { ["aggression"] = System.Text.Json.JsonDocument.Parse("\"Frenzied\"").RootElement },
                "user", null, [], FormRefs: null, ChangeType: PendingChangeConstants.FieldEditChangeType, ParentCell: null, PlacementGroup: null, Origin: "Data"));
            var svc = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());

            var result = svc.GetRecords(type: "npc_", plugin: "Override.esp", search: null, limit: 100, offset: 0);

            Assert.Equal(1, result.Total);
            Assert.Single(result.Items);
            Assert.Equal(npcKey.ToString(), result.Items[0].FormKey);
            Assert.Equal("Override.esp", result.Items[0].Plugin);
            Assert.False(result.Items[0].IsWinner);
            Assert.Equal(1, result.Items[0].LoadOrderIndex); // Override.esp is second plugin (index 1)
        }
    }

    // #296 review: GetRecords' committed-side repository call is correctly scoped to the resolved
    // origin, but its staged-side GetStagedFormKeys call originally omitted origin entirely — every
    // other staged-record fixture in this file (including the one above) stages at Origin: "Data",
    // exactly the elided default the issue warns about, so none of them could tell a working filter
    // from a missing one. This fixture stages a *second*, distinct FormKey under a real non-Data
    // origin ("ModA") for the same plugin filename; the session's own resolved origin for
    // "Override.esp" is "Data" (manager.Load's implicit path), so only the Data-origin staged record
    // should surface.
    [Fact]
    public void GetRecords_ByPlugin_StagedRecord_ScopesToResolvedOrigin()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-staged-records-origin")
            .WithPlugin("Source.esp", mod => npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .WithPlugin("Override.esp")
            .Build();
        using (data)
        {
            var reflector = SharedSchemaReflector.Instance;
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var changes = DuckDbTestFactory.MakePendingChangeService();
            changes.Upsert(new PendingChangeUpsert(npcKey.ToString(), "Override.esp", "npc_",
                new Dictionary<string, System.Text.Json.JsonElement> { ["aggression"] = System.Text.Json.JsonDocument.Parse("\"Frenzied\"").RootElement },
                "user", null, [], FormRefs: null, ChangeType: PendingChangeConstants.FieldEditChangeType, ParentCell: null, PlacementGroup: null, Origin: "Data"));
            changes.Upsert(new PendingChangeUpsert("001234:Override.esp", "Override.esp", "npc_",
                new Dictionary<string, System.Text.Json.JsonElement> { ["aggression"] = System.Text.Json.JsonDocument.Parse("\"Frenzied\"").RootElement },
                "user", null, [], FormRefs: null, ChangeType: PendingChangeConstants.FieldEditChangeType, ParentCell: null, PlacementGroup: null, Origin: "ModA"));
            var svc = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());

            var result = svc.GetRecords(type: "npc_", plugin: "Override.esp", search: null, limit: 100, offset: 0);

            Assert.Equal(1, result.Total);
            Assert.Single(result.Items);
            Assert.Equal(npcKey.ToString(), result.Items[0].FormKey);
        }
    }

    [Fact]
    public void GetRecords_ByPlugin_NonZeroOffset_DoesNotAppendStagedRecords()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-staged-paging")
            .WithPlugin("Source.esp", mod => npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .WithPlugin("Override.esp")
            .Build();
        using (data)
        {
            var reflector = SharedSchemaReflector.Instance;
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
            var changes = DuckDbTestFactory.MakePendingChangeService();
            changes.Upsert(new PendingChangeUpsert(npcKey.ToString(), "Override.esp", "npc_",
                new Dictionary<string, System.Text.Json.JsonElement> { ["aggression"] = System.Text.Json.JsonDocument.Parse("\"Frenzied\"").RootElement },
                "user", null, [], FormRefs: null, ChangeType: PendingChangeConstants.FieldEditChangeType, ParentCell: null, PlacementGroup: null, Origin: "Data"));
            var svc = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());

            var result = svc.GetRecords(type: "npc_", plugin: "Override.esp", search: null, limit: 100, offset: 1);

            Assert.Empty(result.Items);
        }
    }

    [Fact]
    public void GetRecords_ByPlugin_StagedOnlyRecords_UnknownPlugin_HasNegativeOneLoadOrderIndex()
    {
        // "Unknown.esp" is not in _manager's Plugins list → FirstOrDefault returns null → ?? -1 fires.
        var fk = FormKey.Factory("000001:Fallout4.esm");
        var changes = DuckDbTestFactory.MakePendingChangeService();
        changes.Upsert(new PendingChangeUpsert(fk.ToString(), "Unknown.esp", "npc_",
            new Dictionary<string, System.Text.Json.JsonElement> { ["aggression"] = System.Text.Json.JsonDocument.Parse("\"Frenzied\"").RootElement },
            "user", null, [], FormRefs: null, ChangeType: PendingChangeConstants.FieldEditChangeType, ParentCell: null, PlacementGroup: null, Origin: "Data"));
        var svc = new RecordQueryService(_manager, changes, SharedSchemaReflector.Instance, new ConflictClassifier());

        var result = svc.GetRecords(type: "npc_", plugin: "Unknown.esp", search: null, limit: 100, offset: 0);

        Assert.Single(result.Items);
        Assert.Equal(-1, result.Items[0].LoadOrderIndex);
    }

    [Fact]
    public void GetRecords_ByPlugin_StagedAlreadyCommittedRecordIsNotDuplicated()
    {
        // Pick an already-committed record from the loaded fixture, stage a pending change on it,
        // and verify it appears exactly once (no duplication between committed + staged sources).
        var committed = _svc.GetRecords(type: "npc_", plugin: TestPluginFixture.PluginName, search: "TestNPC01", limit: 1, offset: 0);
        var fk = committed.Items[0].FormKey;

        var changes = DuckDbTestFactory.MakePendingChangeService();
        changes.Upsert(new PendingChangeUpsert(fk, TestPluginFixture.PluginName, "npc_",
            new Dictionary<string, System.Text.Json.JsonElement> { ["aggression"] = System.Text.Json.JsonDocument.Parse("\"Frenzied\"").RootElement },
            "user", null, [], FormRefs: null, ChangeType: PendingChangeConstants.FieldEditChangeType, ParentCell: null, PlacementGroup: null, Origin: "Data"));
        var svc = new RecordQueryService(_manager, changes, SharedSchemaReflector.Instance, new ConflictClassifier());

        var result = svc.GetRecords(type: "npc_", plugin: TestPluginFixture.PluginName, search: null, limit: 100, offset: 0);

        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.Equal(TestPluginFixture.RecordCount, result.Items.Count);
    }

    // --- GetPlugins: filter pruning (A4) ---

    [Fact]
    public void GetPlugins_WithFilterMatchingRecords_ReturnsPlugin()
    {
        _manager.SetFilter($"SELECT form_key FROM \"NPC_\"");
        try
        {
            var plugins = _svc.GetPlugins();
            Assert.Contains(plugins, p => p.Name == TestPluginFixture.PluginName);
        }
        finally { _manager.ClearFilter(); }
    }

    [Fact]
    public void GetPlugins_WithFilterMatchingNoRecords_HidesPlugin()
    {
        _manager.SetFilter("SELECT 'NoSuchFormKey:000000' AS form_key");
        try
        {
            var plugins = _svc.GetPlugins();
            Assert.Empty(plugins);
        }
        finally { _manager.ClearFilter(); }
    }

    [Fact]
    public void GetPlugins_AfterClearFilter_RestoresAllPlugins()
    {
        _manager.SetFilter("SELECT 'NoSuchFormKey:000000' AS form_key");
        _manager.ClearFilter();

        var plugins = _svc.GetPlugins();
        Assert.Single(plugins);
        Assert.Equal(TestPluginFixture.PluginName, plugins[0].Name);
    }

    private sealed class SpyRecordReader(IRecordReader inner) : IRecordReader
    {
        public int FindRecordTypeCalls { get; private set; }
        public int GetRecordCalls { get; private set; }
        public bool? LastWinnerOnly { get; private set; }

        public void Reset() { FindRecordTypeCalls = 0; GetRecordCalls = 0; LastWinnerOnly = null; }

        public string? FindRecordType(string formKey)
        {
            FindRecordTypeCalls++;
            return inner.FindRecordType(formKey);
        }

        public RecordLookupEntry? ResolveFormKey(string formKey) => inner.ResolveFormKey(formKey);

        public RecordDetail? GetRecord(string tableName, string formKey, string? plugin, string? origin, bool winnerOnly)
        {
            GetRecordCalls++;
            LastWinnerOnly = winnerOnly;
            return inner.GetRecord(tableName, formKey, plugin, origin, winnerOnly);
        }

        public PagedResult<RecordSummary> GetRecords(string tableName, string? plugin, string? search, int limit, int offset, string? origin = null) =>
            inner.GetRecords(tableName, plugin, search, limit, offset, origin);

        public IReadOnlyList<RecordDetail> GetAllOverrides(string tableName, string formKey) =>
            inner.GetAllOverrides(tableName, formKey);

        public VmadData? GetVmad(string formKey, string plugin, string origin) =>
            inner.GetVmad(formKey, plugin, origin);

        public IReadOnlyList<ConditionOwner> GetConditions(string formKey, string plugin, string origin) =>
            inner.GetConditions(formKey, plugin, origin);

        public int CountRecordsForPlugin(string tableName, string plugin, string origin) =>
            inner.CountRecordsForPlugin(tableName, plugin, origin);

        public IReadOnlyList<string> GetNativeFormKeys(string plugin, string origin) =>
            inner.GetNativeFormKeys(plugin, origin);

        public PagedResult<RecordSummary> SearchRecords(IReadOnlyList<string> tableNames, string? plugin, string? search, int limit, int offset, string? origin = null) =>
            inner.SearchRecords(tableNames, plugin, search, limit, offset, origin);

        public IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames) =>
            inner.GetPluginsWithMatchingRecords(tableNames);

        public IReadOnlyList<ReferenceResult> GetReferences(string targetFormKey) =>
            inner.GetReferences(targetFormKey);

        public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(string plugin, string worldspaceFormKey, string origin) =>
            inner.GetWorldspaceCells(plugin, worldspaceFormKey, origin);
        public PagedResult<CellSummary> GetInteriorCells(string plugin, int limit, int offset, string origin) =>
            inner.GetInteriorCells(plugin, limit, offset, origin);
        public CellReferences GetCellReferences(string plugin, string cellFormKey, string origin) =>
            inner.GetCellReferences(plugin, cellFormKey, origin);
        public PlacementRow? GetPlacement(string formKey, string plugin, string origin) =>
            inner.GetPlacement(formKey, plugin, origin);
    }

    private sealed class StubSessionManager(IRecordReader repository, GameRelease release) : ISessionManager
    {
        public IGameSession? Session { get; } = new StubGameSession(release);
        public IRecordReader? Repository => repository;
        // #274: these stubs never load, so they are always in the no-session state.
        public SessionStatus Status => SessionStatus.None;

        public void Load(string dataFolderPath, string pluginsTxtPath, GameRelease gameRelease) => throw new NotSupportedException();
        public void LoadExplicit(string gameDirectory, IReadOnlyList<ExplicitPluginInput> plugins, GameRelease gameRelease) => throw new NotSupportedException();
        public void Unload() => throw new NotSupportedException();
        public PluginResponse CreatePlugin(string name) => throw new NotSupportedException();
        public PluginResponse LoadUnlistedPlugin(string path, string origin) => throw new NotSupportedException();
        public void UnloadUnlistedPlugin(string plugin, string origin) => throw new NotSupportedException();
        public string ReserveFormKey(string plugin) => throw new NotSupportedException();
        public Task<SaveResult> SavePlugin(string plugin, IReadOnlyList<PendingChange> changes) => throw new NotSupportedException();
        public Task<PreparedPluginSave> PreparePluginSave(string plugin, IReadOnlyList<PendingChange> changes) => throw new NotSupportedException();
        public Task ReindexPlugin(string plugin) => throw new NotSupportedException();
        public Task ReindexPlugins(IReadOnlyList<string> plugins) => throw new NotSupportedException();
        public void SetFilter(string sql) => throw new NotSupportedException();
        public void ClearFilter() => throw new NotSupportedException();
    }

    private sealed class StubGameSession(GameRelease release) : IGameSession
    {
        public string DataFolderPath => "";
        public GameRelease GameRelease => release;
        public IReadOnlyList<PluginMetadata> Plugins => [];
        public IReadOnlyList<PluginLoadFailure> LoadFailures => [];
        public string? FilterSql { get; set; }
        public Mutagen.Bethesda.Plugins.Records.IModGetter? GetMod(string pluginName, string origin) => null;
        public PluginMetadata AddPlugin(string filePath) => throw new NotSupportedException();
        public PluginMetadata AddUnlistedPlugin(string filePath, string origin, int loadOrderIndex) => throw new NotSupportedException();
        public bool RemoveUnlistedPlugin(string pluginName, string origin) => throw new NotSupportedException();
        public void Dispose() { }
    }
}
