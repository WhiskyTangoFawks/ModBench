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

    // --- Issue #86: masters as a validated, add-only plugin-reference array ---

    private static JsonElement MastersJson(params string[] plugins) =>
        JsonSerializer.SerializeToElement(plugins);

    // --- B2: a master naming a plugin not loaded in the session is rejected ---

    [Fact]
    public void StageEdit_MastersNamingUnloadedPlugin_ReturnsInvalidReferences()
    {
        var data = new PluginFixtureBuilder("eo-header-masters-unloaded")
            .WithPlugin("Base.esm", mod => mod.Npcs.AddNew("BaseNpc"))
            .WithPlugin("TestPlugin.esp", mod => mod.Npcs.AddNew("N"))
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["masters"] = MastersJson("NotLoaded.esp") };

                var result = orchestrator.StageEdit(HeaderKey("TestPlugin.esp"), "TestPlugin.esp", fields, "user", null);

                var invalid = Assert.IsType<StageEditResult.InvalidReferences>(result);
                var error = Assert.Single(invalid.Errors);
                Assert.Equal("masters", error.FieldPath);
                Assert.Equal("NotLoaded.esp", error.Value);
                Assert.Equal("not_in_session", error.Reason);
            }
        }
    }

    // --- masters must be a JSON array — a caller sending a non-array shape (malformed direct API/
    // agent call; the frontend never sends this) is rejected outright rather than silently coerced
    // to an empty, no-op edit (ADR-0026: never stage an edit that looks accepted but does nothing). ---

    [Fact]
    public void StageEdit_MastersNonArrayValue_ReturnsInvalidReferences()
    {
        var data = new PluginFixtureBuilder("eo-header-masters-nonarray")
            .WithPlugin("TestPlugin.esp", mod => mod.Npcs.AddNew("N"))
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["masters"] = J("\"not-an-array\"") };

                var result = orchestrator.StageEdit(HeaderKey("TestPlugin.esp"), "TestPlugin.esp", fields, "user", null);

                var invalid = Assert.IsType<StageEditResult.InvalidReferences>(result);
                Assert.Equal("not_append_only", Assert.Single(invalid.Errors).Reason);
            }
        }
    }

    // --- B1/AC1 positive: appending a loaded plugin onto an empty masters list stages ---

    [Fact]
    public void StageEdit_MastersValidAppend_Stages()
    {
        var data = new PluginFixtureBuilder("eo-header-masters-valid")
            .WithPlugin("Base.esm", mod => mod.Npcs.AddNew("BaseNpc"))
            .WithPlugin("TestPlugin.esp", mod => mod.Npcs.AddNew("N"))
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["masters"] = MastersJson("Base.esm") };

                var result = orchestrator.StageEdit(HeaderKey("TestPlugin.esp"), "TestPlugin.esp", fields, "user", null);

                var staged = Assert.IsType<StageEditResult.Staged>(result);
                Assert.Equal("masters", Assert.Single(staged.Changes).FieldPath);
            }
        }
    }

    // --- B3: add-only enforcement (AC5) — reject removal, reordering, duplication; a
    // second sequential append builds on the *pending* value, not the stale disk baseline. ---

    private static (EditOrchestrator orchestrator, SessionManager manager, PluginFixtureData data) MakeMastersFixture(string prefix)
    {
        var data = new PluginFixtureBuilder(prefix)
            .WithPlugin("Base.esm", mod => mod.Npcs.AddNew("BaseNpc"))
            .WithPlugin("Base2.esm", mod => mod.Npcs.AddNew("Base2Npc"))
            .WithPlugin("Extra.esp", mod => mod.Npcs.AddNew("ExtraNpc"))
            .WithPlugin(
                "TestPlugin.esp",
                mod =>
                {
                    mod.Npcs.AddNew("N");
                    ((Mutagen.Bethesda.Plugins.Records.IMod)mod).MasterReferences.Add(
                        new Mutagen.Bethesda.Plugins.Records.MasterReference { Master = ModKey.FromFileName("Base.esm") });
                    ((Mutagen.Bethesda.Plugins.Records.IMod)mod).MasterReferences.Add(
                        new Mutagen.Bethesda.Plugins.Records.MasterReference { Master = ModKey.FromFileName("Base2.esm") });
                },
                // Default write behavior recomputes the masters list purely from FormLink/override
                // content (MastersListContentOption.Iterate) — TestPlugin's NPC references neither
                // declared master, so without NoCheck the fixture-build write would silently drop
                // both before the session ever loads them (issue #86).
                writeParams: new Mutagen.Bethesda.Plugins.Binary.Parameters.BinaryWriteParameters
                {
                    MastersListContent = Mutagen.Bethesda.Plugins.Binary.Parameters.MastersListContentOption.NoCheck,
                })
            .Build();
        var (orchestrator, manager) = MakeOrchestrator();
        manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
        return (orchestrator, manager, data);
    }

    [Fact]
    public void StageEdit_MastersRemovingExisting_ReturnsInvalidReferences()
    {
        var (orchestrator, manager, data) = MakeMastersFixture("eo-header-masters-remove");
        using (data) using (manager)
        {
            var fields = new Dictionary<string, JsonElement> { ["masters"] = MastersJson("Base.esm") };

            var result = orchestrator.StageEdit(HeaderKey("TestPlugin.esp"), "TestPlugin.esp", fields, "user", null);

            var invalid = Assert.IsType<StageEditResult.InvalidReferences>(result);
            Assert.Equal("not_append_only", Assert.Single(invalid.Errors).Reason);
        }
    }

    [Fact]
    public void StageEdit_MastersReordering_ReturnsInvalidReferences()
    {
        var (orchestrator, manager, data) = MakeMastersFixture("eo-header-masters-reorder");
        using (data) using (manager)
        {
            var fields = new Dictionary<string, JsonElement> { ["masters"] = MastersJson("Base2.esm", "Base.esm") };

            var result = orchestrator.StageEdit(HeaderKey("TestPlugin.esp"), "TestPlugin.esp", fields, "user", null);

            var invalid = Assert.IsType<StageEditResult.InvalidReferences>(result);
            Assert.Equal("not_append_only", Assert.Single(invalid.Errors).Reason);
        }
    }

    [Fact]
    public void StageEdit_MastersDuplicatingExisting_ReturnsInvalidReferences()
    {
        var (orchestrator, manager, data) = MakeMastersFixture("eo-header-masters-dup");
        using (data) using (manager)
        {
            var fields = new Dictionary<string, JsonElement> { ["masters"] = MastersJson("Base.esm", "Base2.esm", "Base.esm") };

            var result = orchestrator.StageEdit(HeaderKey("TestPlugin.esp"), "TestPlugin.esp", fields, "user", null);

            var invalid = Assert.IsType<StageEditResult.InvalidReferences>(result);
            Assert.Equal("not_append_only", Assert.Single(invalid.Errors).Reason);
        }
    }

    [Fact]
    public void StageEdit_MastersValidAppendOntoExisting_Stages()
    {
        var (orchestrator, manager, data) = MakeMastersFixture("eo-header-masters-append-existing");
        using (data) using (manager)
        {
            var fields = new Dictionary<string, JsonElement> { ["masters"] = MastersJson("Base.esm", "Base2.esm", "Extra.esp") };

            var result = orchestrator.StageEdit(HeaderKey("TestPlugin.esp"), "TestPlugin.esp", fields, "user", null);

            var staged = Assert.IsType<StageEditResult.Staged>(result);
            Assert.Equal("masters", Assert.Single(staged.Changes).FieldPath);
        }
    }

    [Fact]
    public void StageEdit_MastersSequentialAppends_SecondBuildsOnPendingNotDisk()
    {
        var (orchestrator, manager, data) = MakeMastersFixture("eo-header-masters-sequential");
        using (data) using (manager)
        {
            var first = orchestrator.StageEdit(
                HeaderKey("TestPlugin.esp"), "TestPlugin.esp",
                new Dictionary<string, JsonElement> { ["masters"] = MastersJson("Base.esm", "Base2.esm", "Extra.esp") },
                "user", null);
            Assert.IsType<StageEditResult.Staged>(first);

            // A second append must build on the first (still-pending, unsaved) masters value —
            // if it fell back to the stale on-disk baseline (which lacks Extra.esp), this second
            // call would be rejected as a reorder/removal (dropping the first addition), not seen
            // as a valid append.
            var second = orchestrator.StageEdit(
                HeaderKey("TestPlugin.esp"), "TestPlugin.esp",
                new Dictionary<string, JsonElement> { ["masters"] = MastersJson("Base.esm", "Base2.esm", "Extra.esp") },
                "user", null);

            // Re-staging the exact same list the second time around is itself a no-op append (zero new
            // entries) — still valid, and proves the pending value (not disk) was used as the baseline.
            var staged = Assert.IsType<StageEditResult.Staged>(second);
            var change = Assert.Single(staged.Changes);
            var finalMasters = change.NewValue.EnumerateArray().Select(e => e.GetString()).ToList();
            Assert.Equal(["Base.esm", "Base2.esm", "Extra.esp"], finalMasters);
        }
    }

    // --- Issue #86 invariant B: copy-to auto-add-master ---

    private static (EditOrchestrator orchestrator, SessionManager manager, DuckDbPendingChangeService changes)
        MakeOrchestratorWithChanges()
    {
        var reflector = new SchemaReflector();
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance), changes);
        var query = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());
        var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
        var orchestrator = new EditOrchestrator(manager, query, writer, changes, reflector);
        return (orchestrator, manager, changes);
    }

    // --- B4: the copied record's own origin plugin gets auto-added, in the copy's change group ---

    [Fact]
    public void CopyRecordTo_TargetMissingSourceAsMaster_StagesMasterAddInSameGroup()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-copy-master-origin")
            .WithPlugin("Base.esm", mod => npcKey = mod.Npcs.AddNew("BaseNpc").FormKey)
            .WithPlugin("Target.esp") // no masters declared
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user");

                Assert.IsType<StageEditResult.Staged>(result);

                var headerKey = HeaderKey("Target.esp");
                var copyGroupId = changes.GetGroupIdForRecord(npcKey.ToString(), "Target.esp");
                var headerGroupId = changes.GetGroupIdForRecord(headerKey, "Target.esp");
                Assert.NotNull(copyGroupId);
                Assert.Equal(copyGroupId, headerGroupId);

                // Exactly one change_groups row, covering both members — not two adjacent groups.
                var group = Assert.Single(changes.GetChangeGroups());
                Assert.Equal(copyGroupId, group.Id);
                Assert.True(group.ChangeCount >= 2);

                var mastersChange = changes.GetChanges(plugin: "Target.esp", formKey: headerKey).Single(c => c.FieldPath == "masters");
                var newMasters = mastersChange.NewValue.EnumerateArray().Select(e => e.GetString()).ToList();
                Assert.Equal(["Base.esm"], newMasters);
                // The captured old value must be the real prior masters list (empty here), not an
                // absent/null placeholder — it drives revert and the frontend's pending-diff display.
                Assert.Equal(JsonValueKind.Array, mastersChange.OldValue.ValueKind);
                Assert.Empty(mastersChange.OldValue.EnumerateArray());

                // Atomicity: reverting the group removes the copy and the master-add together —
                // proving they're genuinely one unit, not just two changes that happen to share an id.
                Assert.True(changes.RevertGroup(copyGroupId!.Value));
                Assert.Empty(changes.GetChanges(plugin: "Target.esp", formKey: npcKey.ToString()));
                Assert.Empty(changes.GetChanges(plugin: "Target.esp", formKey: headerKey));
            }
        }
    }

    // --- B4 regression: two sequential copy-tos into the *same* target, each needing a different
    // missing master, must land in one shared group, not two — the pending-change upsert's
    // ON CONFLICT keeps the *first* group id a row is tagged with (DuckDbPendingChangeService
    // COALESCEs group_id), so a naive "always mint a fresh group id" implementation would tag the
    // second copy's own record with an id the header's masters row never actually joined. ---

    [Fact]
    public void CopyRecordTo_TwoSequentialCopiesNeedingDifferentMasters_ShareOneGroup()
    {
        FormKey npc1Key = default;
        FormKey npc2Key = default;
        var data = new PluginFixtureBuilder("eo-copy-master-sequential")
            .WithPlugin("Origin1.esm", mod => npc1Key = mod.Npcs.AddNew("Origin1Npc").FormKey)
            .WithPlugin("Origin2.esm", mod => npc2Key = mod.Npcs.AddNew("Origin2Npc").FormKey)
            .WithPlugin("Target.esp") // no masters declared
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                Assert.IsType<StageEditResult.Staged>(orchestrator.CopyRecordTo(npc1Key.ToString(), "Target.esp", "user"));
                Assert.IsType<StageEditResult.Staged>(orchestrator.CopyRecordTo(npc2Key.ToString(), "Target.esp", "user"));

                var headerKey = HeaderKey("Target.esp");
                var copy1GroupId = changes.GetGroupIdForRecord(npc1Key.ToString(), "Target.esp");
                var copy2GroupId = changes.GetGroupIdForRecord(npc2Key.ToString(), "Target.esp");
                var headerGroupId = changes.GetGroupIdForRecord(headerKey, "Target.esp");

                Assert.NotNull(copy1GroupId);
                Assert.Equal(copy1GroupId, copy2GroupId);
                Assert.Equal(copy1GroupId, headerGroupId);

                // Exactly one change_groups row overall — not two.
                var group = Assert.Single(changes.GetChangeGroups());
                Assert.Equal(copy1GroupId, group.Id);

                var mastersChange = changes.GetChanges(plugin: "Target.esp", formKey: headerKey).Single(c => c.FieldPath == "masters");
                var newMasters = mastersChange.NewValue.EnumerateArray().Select(e => e.GetString()).ToList();
                Assert.Equal(["Origin1.esm", "Origin2.esm"], newMasters);

                // Full atomicity: reverting the (single, shared) group removes both copies and the
                // masters change together.
                Assert.True(changes.RevertGroup(copy1GroupId!.Value));
                Assert.Empty(changes.GetChanges(plugin: "Target.esp", formKey: npc1Key.ToString()));
                Assert.Empty(changes.GetChanges(plugin: "Target.esp", formKey: npc2Key.ToString()));
                Assert.Empty(changes.GetChanges(plugin: "Target.esp", formKey: headerKey));
            }
        }
    }

    // --- B5: a FormLink inside the copied content, referencing a third plugin, gets auto-added too —
    // independent of the record's own origin (already mastered here), same group. ---

    [Fact]
    public void CopyRecordTo_ContentReferencesUnmasteredPlugin_StagesMasterAddInSameGroup()
    {
        FormKey npcKey = default;
        FormKey raceKey = default;
        var data = new PluginFixtureBuilder("eo-copy-master-formref")
            .WithPlugin("RaceProvider.esm", mod => raceKey = mod.Races.AddNew("ImportedRace").FormKey)
            .WithPlugin("Origin.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("OriginNpc");
                npc.Race.SetTo(raceKey);
                npcKey = npc.FormKey;
            })
            .WithPlugin(
                "Target.esp",
                mod => ((Mutagen.Bethesda.Plugins.Records.IMod)mod).MasterReferences.Add(
                    new Mutagen.Bethesda.Plugins.Records.MasterReference { Master = ModKey.FromFileName("Origin.esp") }),
                // Target doesn't yet reference Origin.esp's content, so the declared master would
                // otherwise be pruned at fixture-build write time (same MastersListContentOption.Iterate
                // gap as MakeMastersFixture) — NoCheck preserves it so this test isolates the
                // FormLink-referenced-plugin gap (RaceProvider.esm) from the origin-plugin gap (B4).
                writeParams: new Mutagen.Bethesda.Plugins.Binary.Parameters.BinaryWriteParameters
                {
                    MastersListContent = Mutagen.Bethesda.Plugins.Binary.Parameters.MastersListContentOption.NoCheck,
                })
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user");

                Assert.IsType<StageEditResult.Staged>(result);

                var headerKey = HeaderKey("Target.esp");
                var copyGroupId = changes.GetGroupIdForRecord(npcKey.ToString(), "Target.esp");
                var headerGroupId = changes.GetGroupIdForRecord(headerKey, "Target.esp");
                Assert.NotNull(copyGroupId);
                Assert.Equal(copyGroupId, headerGroupId);

                var mastersChange = changes.GetChanges(plugin: "Target.esp", formKey: headerKey).Single(c => c.FieldPath == "masters");
                var newMasters = mastersChange.NewValue.EnumerateArray().Select(e => e.GetString()).ToList();
                // Origin.esp was already a master (excluded from the append); only the FormLink's
                // origin (RaceProvider.esm) is new.
                Assert.Equal(["Origin.esp", "RaceProvider.esm"], newMasters);
            }
        }
    }

    // --- B6: a copy into a target that already masters everything referenced stays ungrouped —
    // regression guard against always wrapping copy-to in a spurious group. ---

    [Fact]
    public void CopyRecordTo_TargetAlreadyMastersSource_NoMastersChangeStaged()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-copy-master-already")
            .WithPlugin("Base.esm", mod => npcKey = mod.Npcs.AddNew("BaseNpc").FormKey)
            .WithPlugin(
                "Target.esp",
                mod => ((Mutagen.Bethesda.Plugins.Records.IMod)mod).MasterReferences.Add(
                    new Mutagen.Bethesda.Plugins.Records.MasterReference { Master = ModKey.FromFileName("Base.esm") }),
                writeParams: new Mutagen.Bethesda.Plugins.Binary.Parameters.BinaryWriteParameters
                {
                    MastersListContent = Mutagen.Bethesda.Plugins.Binary.Parameters.MastersListContentOption.NoCheck,
                })
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user");

                Assert.IsType<StageEditResult.Staged>(result);

                var headerKey = HeaderKey("Target.esp");
                Assert.Null(changes.GetGroupIdForRecord(npcKey.ToString(), "Target.esp"));
                Assert.Empty(changes.GetChanges(plugin: "Target.esp", formKey: headerKey));
                Assert.Empty(changes.GetChangeGroups());
            }
        }
    }
}
