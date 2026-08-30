using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Query;

[Collection(TestPluginFixtureCollection.Name)]
public sealed class RecordQueryServiceTests : IDisposable
{
    private readonly LoadOrderMirror _manager;
    private readonly RecordQueryService _svc;

    public RecordQueryServiceTests(TestPluginFixture fixture)
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        _manager = new LoadOrderMirror(factory);
        _manager.Reconcile(fixture.DataFolder, fixture.Plugins, GameRelease.Fallout4);
        _svc = new RecordQueryService(_manager, reflector, new ConflictClassifier());
    }

    public void Dispose() => _manager.Dispose();

    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    // --- GET /plugins ---

    [Fact]
    public void GetPlugins_ReturnsLoadedPlugin()
    {
        var plugins = _svc.GetPlugins();

        Assert.Single(plugins);
        Assert.Equal(TestPluginFixture.PluginName, plugins[0].Name);
        Assert.Equal(TestPluginFixture.RecordCount, plugins[0].RecordCount);
    }

    // #277 / ADR-0037: a plugin whose master is absent from the whole load order is flagged on the
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
        using var manager = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        manager.Reconcile(fx.DataFolder, fx.Plugins, GameRelease.Fallout4);
        var svc = new RecordQueryService(manager, SharedSchemaReflector.Instance, new ConflictClassifier());

        var plugins = svc.GetPlugins();

        var patch = Assert.Single(plugins, p => p.Name == "Patch.esp");
        var issue = Assert.Single(patch.MasterIssues);
        Assert.Equal("Ghost.esm", issue.MasterName);
        Assert.Equal(MasterIssueKind.DirectlyMissing, issue.Kind);
    }

    // #277 / ADR-0037 AC6: pinning, not new behavior — ADR-0037 states this already works
    // (Mutagen builds FormKeys from a plugin's own header, so reading never requires a master to
    // exist, and a FormLink into an absent one already resolves to nothing and already falls back
    // to the raw FormKey). This is the true end-to-end version of that claim: a whole load order
    // built via LoadOrder/LoadOrderMirror (not a hand-fed DuckDbRecordIndex), where the
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
        using var manager = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        manager.Reconcile(fx.DataFolder, fx.Plugins, GameRelease.Fallout4);
        var svc = new RecordQueryService(manager, SharedSchemaReflector.Instance, new ConflictClassifier());

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
    public void GetConditionFunctions_Fallout4LoadOrder_ReturnsMutagenResolvedFunctionNames()
    {
        // Filtered to what Mutagen actually resolves for the loaded load order's game (#152) — not a
        // hardcoded list. GetIsID and GetDistance are ordinary FO4 condition functions; a name from
        // a different game's Function enum (e.g. Skyrim-only) must not appear.
        var functions = _svc.GetConditionFunctions();

        Assert.Contains("GetIsID", functions);
        Assert.Contains("GetDistance", functions);
        Assert.True(functions.Count > 400);
    }

    // --- GET /condition-run-on-targets ---

    [Fact]
    public void GetConditionRunOnTargets_Fallout4LoadOrder_ReturnsMutagenResolvedRunOnTypeNames()
    {
        // Filtered to what Mutagen actually resolves for the loaded load order's game (#167) — not a
        // hardcoded frontend array. PlayerShip is a Starfield-only RunOnType member; it must not
        // appear for an FO4 load order, proving this isn't a hand-maintained cross-game list.
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
            var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new LoadOrderMirror(factory);
            manager.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var svc = new RecordQueryService(manager, reflector, new ConflictClassifier());

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
            var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new LoadOrderMirror(factory);
            manager.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var svc = new RecordQueryService(manager, reflector, new ConflictClassifier());

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

    // --- GetConflicts (#364: the Conflicts node's own listing) ---

    [Fact]
    public void GetConflicts_SinglePluginLoadOrder_ReturnsEmpty()
    {
        // TestPluginFixture's default load order has exactly one plugin — nothing is contested, so
        // there is nothing for GetContestedFormKeys to hand GetConflicts in the first place.
        var conflicts = _svc.GetConflicts();

        Assert.Empty(conflicts);
    }

    [Fact]
    public void GetConflicts_TwoPluginsIdenticalOverride_ExcludesRecord()
    {
        // Rival this pins wrong: "return every contested FormKey, unfiltered by ConflictAll" would
        // still include this record (it has two override entries), but its ConflictAll is
        // NoConflict — the override changes nothing — so the real implementation must exclude it.
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-conflicts-noconflict")
            .WithPlugin("Base.esp", mod => npcKey = mod.Npcs.AddNew("SharedNpc").FormKey)
            .WithPlugin("Over.esp", (mod, prev) => mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()))
            .Build();
        using (data)
            WithCompareService(data, svc =>
            {
                Assert.Equal(ConflictAll.NoConflict, svc.GetCompare(npcKey.ToString())!.ConflictAll);
                Assert.DoesNotContain(svc.GetConflicts(), c => c.Record.FormKey == npcKey.ToString());
            });
    }

    [Fact]
    public void GetConflicts_UncontestedFieldOverride_IncludesRecordWithOverrideState()
    {
        // Aggression (a real schema-reflected field), not EditorID — EditorID is compiler-only
        // metadata, excluded from ConflictClassifier's own field comparison entirely, so setting
        // only it would leave the record NoConflict, not Override (learned the hard way: this test
        // originally used EditorID and failed empty until switched to a field the classifier
        // actually looks at).
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-conflicts-override")
            .WithPlugin("Base.esp", mod => npcKey = mod.Npcs.AddNew("SharedNpc").FormKey)
            .WithPlugin("Over.esp", (mod, prev) =>
                mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).Aggression = Npc.AggressionType.Frenzied)
            .Build();
        using (data)
            WithCompareService(data, svc =>
            {
                var conflicts = svc.GetConflicts();
                var entry = Assert.Single(conflicts, c => c.Record.FormKey == npcKey.ToString());
                Assert.Equal(ConflictAll.Override, entry.ConflictAll);
                Assert.Equal("Over.esp", entry.Record.Plugin);
            });
    }

    [Fact]
    public void GetConflicts_ConflictingOverrides_IncludesRecordWithConflictState()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-conflicts-conflict")
            .WithPlugin("Base.esp", mod => npcKey = mod.Npcs.AddNew("SharedNpc").FormKey)
            .WithPlugin("Mid.esp", (mod, prev) =>
                mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).Aggression = Npc.AggressionType.Frenzied)
            .WithPlugin("Top.esp", (mod, prev) =>
                mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).Aggression = Npc.AggressionType.Aggressive)
            .Build();
        using (data)
            WithCompareService(data, svc =>
            {
                var conflicts = svc.GetConflicts();
                var entry = Assert.Single(conflicts, c => c.Record.FormKey == npcKey.ToString());
                Assert.Equal(ConflictAll.Conflict, entry.ConflictAll);
            });
    }

    [Fact]
    public void GetConflicts_WithActiveFilter_ExcludesUnmatchedConflict()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("rqs-conflicts-filter")
            .WithPlugin("Base.esp", mod => npcKey = mod.Npcs.AddNew("SharedNpc").FormKey)
            .WithPlugin("Over.esp", (mod, prev) =>
                mod.Npcs.GetOrAddAsOverride(prev[0].Npcs.First()).Aggression = Npc.AggressionType.Frenzied)
            .Build();
        using (data)
        {
            var reflector = SharedSchemaReflector.Instance;
            var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new LoadOrderMirror(factory);
            manager.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var svc = new RecordQueryService(manager, reflector, new ConflictClassifier());
            Assert.Contains(svc.GetConflicts(), c => c.Record.FormKey == npcKey.ToString());

            manager.SetFilter("SELECT 'NoSuchFormKey:000000' AS form_key");

            Assert.DoesNotContain(svc.GetConflicts(), c => c.Record.FormKey == npcKey.ToString());
        }
    }

    private static void WithCompareService(PluginFixtureData data, Action<RecordQueryService> test)
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        using var manager = new LoadOrderMirror(factory);
        manager.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4);
        test(new RecordQueryService(manager, reflector, new ConflictClassifier()));
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

    // #421: GetRecordForPlugin and GetRecordType are gone — endpoint-orphaned pass-throughs, dead
    // with the absorption (see IRecordQueryService's own note). GetRecordForPlugin's reader-level
    // capability survives as IRecordReads.GetDocument(formKey, PluginKey), covered in
    // DuckDbRecordIndexTests; GetRecordType's FindRecordType is rejected from the seam outright
    // (explicitly, not relocated) — its resolution behaviour is exercised indirectly by every
    // GetDocument/GetOverrideStack test that resolves a FormKey without a stated type.

    // --- No-load order guard clauses ---

    [Fact]
    public void GetPlugins_NoLoadOrder_ThrowsInvalidOperationException()
    {
        var unloaded = MakeUnloadedService();
        var ex = Assert.Throws<InvalidOperationException>(() => unloaded.GetPlugins());
        Assert.Contains("No load order", ex.Message);
    }

    [Fact]
    public void GetRecords_NoLoadOrder_ThrowsInvalidOperationException()
    {
        var unloaded = MakeUnloadedService();
        var ex = Assert.Throws<InvalidOperationException>(() => unloaded.GetRecords("npc_", null, null, 10, 0));
        Assert.Contains("No load order", ex.Message);
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
            var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new LoadOrderMirror(factory);
            manager.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var svc = new RecordQueryService(manager, reflector, new ConflictClassifier());

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
            var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new LoadOrderMirror(factory);
            manager.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var svc = new RecordQueryService(manager, reflector, new ConflictClassifier());

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
            var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
            using var manager = new LoadOrderMirror(factory);
            manager.Reconcile(data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var svc = new RecordQueryService(manager, reflector, new ConflictClassifier());

            var compare = svc.GetCompare("000000:CompareA.esp");

            Assert.NotNull(compare);
            var overrides = Assert.Single(compare.Overrides);
            Assert.Equal("CompareA.esp", overrides.Plugin);
        }
    }

    private static RecordQueryService MakeUnloadedService()
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        var manager = new LoadOrderMirror(factory);
        return new RecordQueryService(manager, reflector, new ConflictClassifier());
    }

    // #421: the SpyRecordReader-based "uses FindRecordType, not a table scan" / "passes
    // winnerOnly" tests that used to live here are gone with the mechanism they asserted on —
    // GetRecord/GetRecordForPlugin used to be two calls (FindRecordType, then GetRecord with a
    // winnerOnly flag) a decorator could count; IRecordReads.GetDocument(formKey) /
    // GetDocument(formKey, PluginKey) collapse both into one call apiece, so there is no longer a
    // table-scan path or a runtime winnerOnly flag to assert on — which overload is called *is* the
    // winner/specific-plugin choice, checked by DuckDbRecordIndexTests' own GetDocument coverage.

    // --- GetPlugins: HasMatchingRecords, never row pruning (#278 / ADR-0035 amending ADR-0018) ---

    [Fact]
    public void GetPlugins_WithFilterMatchingRecords_ReturnsPlugin()
    {
        _manager.SetFilter($"SELECT form_key FROM \"NPC_\"");
        try
        {
            var plugins = _svc.GetPlugins();
            var plugin = Assert.Single(plugins, p => p.Name == TestPluginFixture.PluginName);
            Assert.True(plugin.HasMatchingRecords);
        }
        finally { _manager.ClearFilter(); }
    }

    // Renamed from GetPlugins_WithFilterMatchingNoRecords_HidesPlugin (#278 / ADR-0035 amending
    // ADR-0018): that name pinned the old rule this issue exists to overturn — a plugin the active
    // filter matched none of this plugin's records used to be dropped from the list entirely
    // (Assert.Empty(plugins)). The rule changes: a record filter prunes records and record types,
    // never a plugin row, because this tree is also the load order and hiding a plugin mid-filter
    // would make it unreorderable. The plugin now stays in the list; HasMatchingRecords is the
    // additive fact a caller (the tree's chevron) reads instead.
    [Fact]
    public void GetPlugins_WithFilterMatchingNoRecords_KeepsPluginVisibleButFlagsNoMatch()
    {
        _manager.SetFilter("SELECT 'NoSuchFormKey:000000' AS form_key");
        try
        {
            var plugins = _svc.GetPlugins();
            var plugin = Assert.Single(plugins, p => p.Name == TestPluginFixture.PluginName);
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
        Assert.Equal(TestPluginFixture.PluginName, plugin.Name);
        Assert.True(plugin.HasMatchingRecords);
    }

}
