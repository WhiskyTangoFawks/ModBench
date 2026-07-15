using System.Globalization;
using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>
/// Header editing via pending changes (issue #85): author + ESL/ESM flag edits stage like any
/// record edit, with stage-time ESL-eligibility validation.
/// </summary>
public sealed class EditOrchestratorHeaderTests
{
    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static string FlagBits(Fallout4ModHeader.HeaderFlag flags) =>
        ((long)flags).ToString(CultureInfo.InvariantCulture);

    private static (EditOrchestrator orchestrator, SessionManager manager) MakeOrchestrator()
    {
        var reflector = new SchemaReflector();
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var changes = DuckDbTestFactory.MakePendingChangeService();
        // Wire `changes` into the SessionManager (not just the orchestrator) so it receives the
        // session's own DuckDB connection via IPendingChangeLifecycle — required for any orchestrator
        // path (e.g. Renumber) that queries pending_changes through IRecordRepository.GetReferences.
        var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance), changes);
        var query = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());
        var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
        var orchestrator = new EditOrchestrator(manager, query, writer, changes, reflector);
        return (orchestrator, manager);
    }

    private static string HeaderKey(string plugin) => $"000000:{plugin}";

    // --- Slice 5: author on an editable header stages ---

    [Fact]
    public void StageEdit_HeaderAuthor_StagesChange()
    {
        var data = new PluginFixtureBuilder("eo-header-author")
            .WithPlugin("TestPlugin.esp", mod => mod.Npcs.AddNew("N"))
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["author"] = J("\"Jane Modder\"") };

                var result = orchestrator.StageEdit(HeaderKey("TestPlugin.esp"), "TestPlugin.esp", fields, "user", null);

                var staged = Assert.IsType<StageEditResult.Staged>(result);
                Assert.Equal("author", Assert.Single(staged.Changes).FieldPath);
                Assert.Equal("header", staged.Changes[0].RecordType);
            }
        }
    }

    // Slice 6 (header on immutable plugin → PluginImmutable) lives in EditOrchestratorTests, next to
    // the shared StubSessionManagerWithImmutablePlugin it needs.

    // --- Slice 7: ESL toggle on an eligible plugin stages ---

    [Fact]
    public void StageEdit_ToggleEsl_AllFormIdsInRange_Stages()
    {
        // Records native to the plugin land in the compact range (< 0x1000).
        var data = new PluginFixtureBuilder("eo-header-esl-ok")
            .WithPlugin("Light.esp", mod => mod.Npcs.AddNew("EslOkNpc"))
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement>
                {
                    ["flags"] = J($"\"{FlagBits(Fallout4ModHeader.HeaderFlag.Small)}\""),
                };

                var result = orchestrator.StageEdit(HeaderKey("Light.esp"), "Light.esp", fields, "user", null);

                var staged = Assert.IsType<StageEditResult.Staged>(result);
                Assert.Equal("flags", staged.Changes[0].FieldPath);
            }
        }
    }

    // --- Slice 7b: a record at the exact upper ESL boundary (0xFFF) stays eligible ---

    [Fact]
    public void StageEdit_ToggleEsl_FormIdAtUpperBoundary_Stages()
    {
        var data = new PluginFixtureBuilder("eo-header-esl-boundary")
            .WithPlugin("Edge.esp", mod =>
                mod.Npcs.Add(new Npc(FormKey.Factory("000FFF:Edge.esp"), Fallout4Release.Fallout4) { EditorID = "HighBound" }))
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement>
                {
                    ["flags"] = J($"\"{FlagBits(Fallout4ModHeader.HeaderFlag.Small)}\""),
                };

                var result = orchestrator.StageEdit(HeaderKey("Edge.esp"), "Edge.esp", fields, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
            }
        }
    }

    // --- Slice 7c: an override of a master's out-of-range record does not count against ESL
    // eligibility — only records native to the plugin (ModKey == plugin) are considered. ---

    [Fact]
    public void StageEdit_ToggleEsl_OverrideOfHighIdMaster_Stages()
    {
        var masterNpc = FormKey.Factory("005000:Base.esm"); // 0x5000 > 0xFFF, but native to Base.esm
        var data = new PluginFixtureBuilder("eo-header-esl-override")
            .WithPlugin("Base.esm", mod =>
                mod.Npcs.Add(new Npc(masterNpc, Fallout4Release.Fallout4) { EditorID = "BaseNpc" }))
            .WithPlugin("Patch.esp", mod =>
            {
                mod.Npcs.AddNew("PatchNativeNpc"); // native (~0x800), within ESL range
                mod.Npcs.Add(new Npc(masterNpc, Fallout4Release.Fallout4) { EditorID = "BaseNpcOverride" });
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement>
                {
                    ["flags"] = J($"\"{FlagBits(Fallout4ModHeader.HeaderFlag.Small)}\""),
                };

                var result = orchestrator.StageEdit(HeaderKey("Patch.esp"), "Patch.esp", fields, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
            }
        }
    }

    // --- Slice 8: ESL toggle on an ineligible plugin is rejected, naming the offenders ---

    [Fact]
    public void StageEdit_ToggleEsl_FormIdOutOfRange_ReturnsEslIneligible()
    {
        var outOfRange = FormKey.Factory("001000:Heavy.esp"); // 0x1000 > 0xFFF → outside ESL range
        var data = new PluginFixtureBuilder("eo-header-esl-bad")
            .WithPlugin("Heavy.esp", mod =>
                mod.Npcs.Add(new Npc(outOfRange, Fallout4Release.Fallout4) { EditorID = "HeavyNpc" }))
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement>
                {
                    ["flags"] = J($"\"{FlagBits(Fallout4ModHeader.HeaderFlag.Small)}\""),
                };

                var result = orchestrator.StageEdit(HeaderKey("Heavy.esp"), "Heavy.esp", fields, "user", null);

                var esl = Assert.IsType<StageEditResult.EslIneligible>(result);
                Assert.Equal("Heavy.esp", esl.Plugin);
                Assert.Contains(outOfRange.ToString(), esl.FormKeys);
            }
        }
    }

    // --- Issue #98 slice 1: a pending create with an out-of-range native FormID blocks the ESL
    // toggle, even though every *committed* native record is in range. ---

    [Fact]
    public void StageEdit_ToggleEsl_PendingCreateFormIdOutOfRange_ReturnsEslIneligible()
    {
        var data = new PluginFixtureBuilder("eo-header-esl-pending-create")
            .WithPlugin(
                "Pending.esp",
                mod =>
                {
                    mod.Npcs.AddNew("InRangeNpc"); // native, within ESL range
                    ((Mutagen.Bethesda.Plugins.Records.IMod)mod).NextFormID = 0x1000; // force the next reservation out of range
                },
                // Default write behavior recalculates NextFormID from the max FormID actually present
                // (NextFormIDOption.Iterate) — NoCheck preserves our manual override above.
                writeParams: new Mutagen.Bethesda.Plugins.Binary.Parameters.BinaryWriteParameters
                {
                    NextFormID = Mutagen.Bethesda.Plugins.Binary.Parameters.NextFormIDOption.NoCheck,
                })
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var created = Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Pending.esp", "npc_", null, "user"));

                var fields = new Dictionary<string, JsonElement>
                {
                    ["flags"] = J($"\"{FlagBits(Fallout4ModHeader.HeaderFlag.Small)}\""),
                };

                var result = orchestrator.StageEdit(HeaderKey("Pending.esp"), "Pending.esp", fields, "user", null);

                var esl = Assert.IsType<StageEditResult.EslIneligible>(result);
                Assert.Equal("Pending.esp", esl.Plugin);
                Assert.Contains(created.FormKey, esl.FormKeys);
            }
        }
    }

    // --- Issue #98 slice 1b: a pending renumber TO an out-of-range native FormID blocks the ESL
    // toggle, even though the record's *committed* FormID is in range. ---

    [Fact]
    public void StageEdit_ToggleEsl_PendingRenumberToFormIdOutOfRange_ReturnsEslIneligible()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-header-esl-pending-renumber")
            .WithPlugin("Renum.esp", mod => npcKey = mod.Npcs.AddNew("N").FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                Assert.IsType<RenumberResult.Staged>(
                    orchestrator.Renumber(npcKey.ToString(), 0x1000, "Renum.esp", "user"));

                var fields = new Dictionary<string, JsonElement>
                {
                    ["flags"] = J($"\"{FlagBits(Fallout4ModHeader.HeaderFlag.Small)}\""),
                };

                var result = orchestrator.StageEdit(HeaderKey("Renum.esp"), "Renum.esp", fields, "user", null);

                var esl = Assert.IsType<StageEditResult.EslIneligible>(result);
                Assert.Equal("Renum.esp", esl.Plugin);
                Assert.Contains("001000:Renum.esp", esl.FormKeys);
            }
        }
    }

    // --- Issue #98 slice 1c: a pending renumber FROM an out-of-range committed native FormID TO an
    // in-range one lets the ESL toggle stage — the stale high FormID must not still count against
    // eligibility once the renumber has moved it out of the way. ---

    [Fact]
    public void StageEdit_ToggleEsl_PendingRenumberFixesOutOfRangeFormId_Stages()
    {
        var outOfRange = FormKey.Factory("001500:Fix.esp"); // 0x1500 > 0xFFF
        var data = new PluginFixtureBuilder("eo-header-esl-pending-renumber-fix")
            .WithPlugin("Fix.esp", mod =>
                mod.Npcs.Add(new Npc(outOfRange, Fallout4Release.Fallout4) { EditorID = "OutOfRangeNpc" }))
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                Assert.IsType<RenumberResult.Staged>(
                    orchestrator.Renumber(outOfRange.ToString(), 0x0500, "Fix.esp", "user"));

                var fields = new Dictionary<string, JsonElement>
                {
                    ["flags"] = J($"\"{FlagBits(Fallout4ModHeader.HeaderFlag.Small)}\""),
                };

                var result = orchestrator.StageEdit(HeaderKey("Fix.esp"), "Fix.esp", fields, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
            }
        }
    }

    // --- Issue #98 slice 2: committed + pending native FormIDs all in range still stages —
    // regression guard confirming the union doesn't introduce false positives. ---

    [Fact]
    public void StageEdit_ToggleEsl_CommittedAndPendingAllInRange_Stages()
    {
        var data = new PluginFixtureBuilder("eo-header-esl-pending-ok")
            .WithPlugin("Ok.esp", mod => mod.Npcs.AddNew("InRangeNpc")) // native, within ESL range
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                // The plugin's default NextFormID reservation counter is already in-range for a
                // freshly-built fixture, so this pending create's FormKey is in-range too.
                Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Ok.esp", "npc_", null, "user"));

                var fields = new Dictionary<string, JsonElement>
                {
                    ["flags"] = J($"\"{FlagBits(Fallout4ModHeader.HeaderFlag.Small)}\""),
                };

                var result = orchestrator.StageEdit(HeaderKey("Ok.esp"), "Ok.esp", fields, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
            }
        }
    }

    // --- Issue #98 slice 5: an out-of-range record native to a *master* never counts against the
    // target plugin's ESL eligibility — even when combined with the target's own in-range pending
    // create and an override of the master's out-of-range record. Regression guard on the pending
    // union (Slice 1) reusing the same native-ModKey filter as the committed read (Slice 7c). ---

    [Fact]
    public void StageEdit_ToggleEsl_OverrideOfHighIdMasterPlusPendingCreate_Stages()
    {
        var masterNpc = FormKey.Factory("005000:Base.esm"); // 0x5000 > 0xFFF, but native to Base.esm
        var data = new PluginFixtureBuilder("eo-header-esl-override-pending")
            .WithPlugin("Base.esm", mod =>
                mod.Npcs.Add(new Npc(masterNpc, Fallout4Release.Fallout4) { EditorID = "BaseNpc" }))
            .WithPlugin("Patch.esp", mod =>
            {
                mod.Npcs.AddNew("PatchNativeNpc"); // native, within ESL range
                mod.Npcs.Add(new Npc(masterNpc, Fallout4Release.Fallout4) { EditorID = "BaseNpcOverride" });
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                // The plugin's default NextFormID counter is in-range for a freshly-built fixture.
                Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Patch.esp", "npc_", null, "user"));

                var fields = new Dictionary<string, JsonElement>
                {
                    ["flags"] = J($"\"{FlagBits(Fallout4ModHeader.HeaderFlag.Small)}\""),
                };

                var result = orchestrator.StageEdit(HeaderKey("Patch.esp"), "Patch.esp", fields, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
            }
        }
    }

    // --- Slice 9: ESM toggle is never ESL-validated, even on an ineligible plugin ---

    [Fact]
    public void StageEdit_ToggleEsmOnly_IneligiblePlugin_Stages()
    {
        // Ineligible plugin (a native FormID above the ESL range) — an ESM-only toggle must still
        // stage, proving ESL eligibility is not consulted unless the ESL bit is being turned on.
        var data = new PluginFixtureBuilder("eo-header-esm-only")
            .WithPlugin("Heavy.esp", mod =>
                mod.Npcs.Add(new Npc(FormKey.Factory("001000:Heavy.esp"), Fallout4Release.Fallout4) { EditorID = "HeavyNpc" }))
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement>
                {
                    ["flags"] = J($"\"{FlagBits(Fallout4ModHeader.HeaderFlag.Master)}\""),
                };

                var result = orchestrator.StageEdit(HeaderKey("Heavy.esp"), "Heavy.esp", fields, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
            }
        }
    }
}
