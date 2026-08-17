using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Tests.Edits;

public sealed class EditOrchestratorTests
{
    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static (EditOrchestrator orchestrator, SessionManager manager) MakeOrchestrator()
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var query = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());
        var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
        var orchestrator = new EditOrchestrator(manager, query, writer, changes, reflector);
        return (orchestrator, manager);
    }

    // --- StageEdit ---

    [Fact]
    public void StageEdit_ValidEdit_StagesChange()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-valid-edit")
            .WithPlugin("TestPlugin.esp", mod =>
                npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") };

                var result = orchestrator.StageEdit(npcKey.ToString(), "TestPlugin.esp", fields, "user", null);

                var staged = Assert.IsType<StageEditResult.Staged>(result);
                Assert.Single(staged.Changes);
                Assert.Equal("aggression", staged.Changes[0].FieldPath);
                // Verify old value was captured (kills mutants on null-check and ContainsKey)
                Assert.NotEqual(System.Text.Json.JsonValueKind.Null, staged.Changes[0].OldValue.ValueKind);
            }
        }
    }

    [Fact]
    public void StageEdit_PluginHasNoOverride_OldValueIsNull()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-no-override")
            .WithPlugin("Source.esp", mod =>
                npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .WithPlugin("Target.esp")  // empty — no override of npcKey
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") };

                // Target.esp has no existing record for npcKey → currentRecord will be null → OldValue stored as null
                var result = orchestrator.StageEdit(npcKey.ToString(), "Target.esp", fields, "user", null);

                var staged = Assert.IsType<StageEditResult.Staged>(result);
                Assert.Equal(System.Text.Json.JsonValueKind.Null, staged.Changes[0].OldValue.ValueKind);
            }
        }
    }

    [Fact]
    public void StageEdit_RecordNotFound_ReturnsRecordNotFound()
    {
        var data = new PluginFixtureBuilder("eo-not-found")
            .WithPlugin("TestPlugin.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") };

                var result = orchestrator.StageEdit("FFFFFF:NoSuch.esp", "TestPlugin.esp", fields, "user", null);

                Assert.IsType<StageEditResult.RecordNotFound>(result);
            }
        }
    }

    [Fact]
    public void StageEdit_ImmutablePlugin_ReturnsPluginImmutable()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-immutable")
            .WithPlugin("TestPlugin.esp", mod =>
                npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .Build();
        using (data)
        {
            // Use a stub session that marks the plugin as immutable
            var sessionStub = new StubSessionManagerWithImmutablePlugin(
                data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4, "TestPlugin.esp");

            var reflector = SharedSchemaReflector.Instance;
            var changes = DuckDbTestFactory.MakePendingChangeService();
            var query = new RecordQueryService(sessionStub, changes, reflector, new ConflictClassifier());
            var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
            var orchestrator = new EditOrchestrator(sessionStub, query, writer, changes, reflector);

            var fields = new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") };

            var result = orchestrator.StageEdit(npcKey.ToString(), "TestPlugin.esp", fields, "user", null);

            var immutable = Assert.IsType<StageEditResult.PluginImmutable>(result);
            Assert.Equal("TestPlugin.esp", immutable.Plugin);
        }
    }

    [Fact]
    public void StageEdit_HeaderOnImmutablePlugin_ReturnsPluginImmutable()
    {
        // Issue #85 slice 6: an immutable plugin's header exposes no working edit.
        var data = new PluginFixtureBuilder("eo-header-immutable")
            .WithPlugin("TestPlugin.esp", mod => mod.Npcs.AddNew("N"))
            .Build();
        using (data)
        {
            var sessionStub = new StubSessionManagerWithImmutablePlugin(
                data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4, "TestPlugin.esp");
            var reflector = SharedSchemaReflector.Instance;
            var changes = DuckDbTestFactory.MakePendingChangeService();
            var query = new RecordQueryService(sessionStub, changes, reflector, new ConflictClassifier());
            var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
            var orchestrator = new EditOrchestrator(sessionStub, query, writer, changes, reflector);

            var fields = new Dictionary<string, JsonElement> { ["author"] = J("\"Jane Modder\"") };
            var result = orchestrator.StageEdit("000000:TestPlugin.esp", "TestPlugin.esp", fields, "user", null);

            var immutable = Assert.IsType<StageEditResult.PluginImmutable>(result);
            Assert.Equal("TestPlugin.esp", immutable.Plugin);
        }
    }

    [Fact]
    public void StageEdit_ReadOnlyField_ReturnsReadOnlyFields()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-readonly")
            .WithPlugin("TestPlugin.esp", mod =>
                npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["form_key"] = J("\"anything\"") };

                var result = orchestrator.StageEdit(npcKey.ToString(), "TestPlugin.esp", fields, "user", null);

                var readOnly = Assert.IsType<StageEditResult.ReadOnlyFields>(result);
                Assert.Contains("form_key", readOnly.Fields);
            }
        }
    }

    // #306 AC2: a target plugin with no load-order member at all is not a legitimate write target
    // — proceeding used to stage an edit that could only fail later, at save time, inside
    // SessionManager.RequirePlugin's KeyNotFoundException. Refusing it up front, named, is what
    // this ticket changes; this test used to assert the opposite (DoesNotThrow / Staged).
    [Fact]
    public void StageEdit_PluginNotInSession_ReturnsPluginImmutable()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-unknown-plugin")
            .WithPlugin("Source.esp", mod => npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") };

                var result = orchestrator.StageEdit(npcKey.ToString(), "NotLoaded.esp", fields, "user", null);

                var immutable = Assert.IsType<StageEditResult.PluginImmutable>(result);
                Assert.Equal("NotLoaded.esp", immutable.Plugin);
            }
        }
    }

    // #306 AC3 — the ticket's own named scenario: load an unlisted copy, then stage an edit against
    // the load-order copy of the same filename, and it succeeds. The mis-hit this ticket removes —
    // an unscoped FirstOrDefault landing on the always-immutable unlisted copy by list order —
    // would refuse it instead. Not reachable through the real GameSession/SessionManager: unlisted
    // copies are only ever appended to Plugins after a completed, blocking session load, so a
    // first-match happens to be correct there today. UnlistedCopyFirstSession constructs the
    // reversed order directly, the only way to pin the scoping down as an invariant rather than an
    // accident of append order.
    [Fact]
    public void StageEdit_UnlistedCopyListedFirst_StillStagesAgainstTheLoadOrderCopy()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-shadowed-first")
            .WithPlugin("Shared.esp", mod => npcKey = mod.Npcs.AddNew("TestNPC_EoShadowedFirst").FormKey)
            .Build();
        using (data)
        {
            var sessionStub = new StubUnlistedCopyFirstSessionManager(
                data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4, "Shared.esp");
            using (sessionStub)
            {
                var reflector = SharedSchemaReflector.Instance;
                var changes = DuckDbTestFactory.MakePendingChangeService();
                var query = new RecordQueryService(sessionStub, changes, reflector, new ConflictClassifier());
                var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
                var orchestrator = new EditOrchestrator(sessionStub, query, writer, changes, reflector);
                var fields = new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") };

                var result = orchestrator.StageEdit(npcKey.ToString(), "Shared.esp", fields, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
            }
        }
    }

    [Fact]
    public void StageEdit_KeywordsArrayReferencingCommittedRecord_Passes()
    {
        // Verifies LookupRecordType checks the committed store first.
        // keywords is a writable array-of-formKey field — ValidateReferences walks it and calls
        // LookupRecordType for each element. With the mutation (committed != null → committed == null),
        // LookupRecordType skips the committed store and returns null → InvalidReferences.
        FormKey kwKey = default;
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-kw-ref-committed")
            .WithPlugin("Source.esp", mod =>
            {
                kwKey = mod.Keywords.AddNew("TestKw_EoFkRef").FormKey;
                npcKey = mod.Npcs.AddNew("TestNPC_EoFkRef").FormKey;
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
                    ["keywords"] = J($"[\"{kwKey}\"]")
                };

                var result = orchestrator.StageEdit(npcKey.ToString(), "Source.esp", fields, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
            }
        }
    }

    [Fact]
    public void StageEdit_NoSession_ReturnsNoSession()
    {
        var (orchestrator, manager) = MakeOrchestrator();
        using (manager)
        {
            var fields = new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") };

            var result = orchestrator.StageEdit("ABC:000001:X.esp", "X.esp", fields, "user", null);

            Assert.IsType<StageEditResult.NoSession>(result);
        }
    }

    // --- Phase 16.2.2: placed create / copy ---

    // Builds a worldspace cell holding one persistent placed object in the named plugin,
    // capturing the cell + placed FormKeys.
    private static PluginFixtureData PlacedFixture(
        string prefix, string plugin, out string cellFk, out string placedFk)
    {
        string cell = "", placed = "";
        var data = new PluginFixtureBuilder(prefix)
            .WithPlugin(plugin, mod =>
            {
                var wrld = mod.Worldspaces.AddNew("TestWorld");
                var c = new Cell(mod) { EditorID = "TestCell", Grid = new CellGrid { Point = new P2Int(0, 0) } };
                var po = new PlacedObject(mod) { EditorID = "placedRef", Position = new P3Float(1f, 2f, 3f) };
                c.Persistent.Add(po);
                var sub = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
                sub.Items.Add(c);
                var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
                block.Items.Add(sub);
                wrld.SubCells.Add(block);
                cell = c.FormKey.ToString();
                placed = po.FormKey.ToString();
            })
            .WithPlugin("Target.esp")
            .Build();
        cellFk = cell;
        placedFk = placed;
        return data;
    }

    [Fact]
    public void CreatePlacedRecord_StagesCreateChangeCarryingPlacement()
    {
        var data = new PluginFixtureBuilder("eo-create-placed")
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreatePlacedRecord(
                        "Target.esp", "refr", "001234:Fallout4.esm", "temporary", null, "user"));

                var createChange = changes.GetChanges(formKey: result.FormKey).Single(c => c.FieldPath == "$create");
                Assert.Equal("001234:Fallout4.esm", createChange.ParentCell);
                Assert.Equal("temporary", createChange.PlacementGroup);
            }
        }
    }

    [Fact]
    public void CopyRecordTo_PlacedWinner_StagesChangesCarryingPlacement()
    {
        var data = PlacedFixture("eo-copy-placed", "Source.esp", out var cellFk, out var placedFk);
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CopyRecordTo(placedFk, "Target.esp", "user");

                Assert.IsType<StageEditResult.Staged>(result);
                var staged = changes.GetChanges(formKey: placedFk, plugin: "Target.esp");
                Assert.NotEmpty(staged);
                Assert.All(staged, c => Assert.Equal(cellFk, c.ParentCell));
                Assert.All(staged, c => Assert.Equal("persistent", c.PlacementGroup));
            }
        }
    }

    [Fact]
    public void CopyRecordTo_NonPlacedWinner_StagesNullPlacement()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-copy-nonplaced")
            .WithPlugin("Source.esp", mod => npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user");

                var staged = changes.GetChanges(formKey: npcKey.ToString(), plugin: "Target.esp");
                Assert.NotEmpty(staged);
                Assert.All(staged, c => Assert.Null(c.ParentCell));
                Assert.All(staged, c => Assert.Null(c.PlacementGroup));
            }
        }
    }

    // --- CopyRecordTo ---

    [Fact]
    public void CopyRecordTo_ValidCopy_StagesAllWinnerFields()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-copy-to")
            .WithPlugin("Source.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("TestNPC");
                npc.Aggression = Npc.AggressionType.Frenzied;
                npcKey = npc.FormKey;
            })
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user");

                var staged = Assert.IsType<StageEditResult.Staged>(result);
                Assert.NotEmpty(staged.Changes);
                Assert.All(staged.Changes, c => Assert.Equal("Target.esp", c.Plugin));
            }
        }
    }

    [Fact]
    public void CopyRecordTo_RecordNotFound_ReturnsRecordNotFound()
    {
        var data = new PluginFixtureBuilder("eo-copy-notfound")
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CopyRecordTo("FFFFFF:NoSuch.esp", "Target.esp", "user");

                Assert.IsType<StageEditResult.RecordNotFound>(result);
            }
        }
    }

    [Fact]
    public void CopyRecordTo_ImmutableTarget_ReturnsPluginImmutable()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-copy-immutable")
            .WithPlugin("Source.esp", mod =>
                npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .Build();
        using (data)
        {
            var sessionStub = new StubSessionManagerWithImmutablePlugin(
                data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4, "Source.esp");

            var reflector = SharedSchemaReflector.Instance;
            var changes = DuckDbTestFactory.MakePendingChangeService();
            var query = new RecordQueryService(sessionStub, changes, reflector, new ConflictClassifier());
            var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
            var orchestrator = new EditOrchestrator(sessionStub, query, writer, changes, reflector);

            var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Source.esp", "user");

            var immutable = Assert.IsType<StageEditResult.PluginImmutable>(result);
            Assert.Equal("Source.esp", immutable.Plugin);
        }
    }

    [Fact]
    public void CopyRecordTo_TargetAlreadyHasOverride_OldValueIsPopulated()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-copy-override")
            .WithPlugin("Source.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("SourceNPC");
                npc.Aggression = Mutagen.Bethesda.Fallout4.Npc.AggressionType.Frenzied;
                npcKey = npc.FormKey;
            })
            .WithPlugin("Target.esp", mod =>
            {
                // Create override: same FormKey, different aggression value
                var overrideNpc = new Mutagen.Bethesda.Fallout4.Npc(npcKey, Mutagen.Bethesda.Fallout4.Fallout4Release.Fallout4)
                {
                    Aggression = Mutagen.Bethesda.Fallout4.Npc.AggressionType.Unaggressive
                };
                mod.Npcs.Add(overrideNpc);
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user");

                var staged = Assert.IsType<StageEditResult.Staged>(result);
                Assert.NotEmpty(staged.Changes);
                // Target had an existing override → old values should be populated (not all null)
                Assert.Contains(staged.Changes, c =>
                    c.OldValue.ValueKind != System.Text.Json.JsonValueKind.Null);
            }
        }
    }

    // Issue #202: Copy as Override must copy the right-clicked column's version of the record, not
    // necessarily the overall winner — Source.esp is loaded first (loses conflicts to Middle.esp's
    // override), so an explicit `sourcePlugin: "Source.esp"` proves the copy reads off that plugin's
    // own value rather than falling through to the default winner-only path.
    [Fact]
    public void CopyRecordTo_ExplicitSourcePlugin_CopiesThatPluginsFields_NotWinner()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-copy-explicit-source")
            .WithPlugin("Source.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("TestNPC");
                npc.Aggression = Npc.AggressionType.Frenzied;
                npcKey = npc.FormKey;
            })
            .WithPlugin("Middle.esp", mod =>
            {
                var overrideNpc = new Npc(npcKey, Fallout4Release.Fallout4)
                {
                    Aggression = Npc.AggressionType.Unaggressive
                };
                mod.Npcs.Add(overrideNpc);
            })
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                // Sanity: Middle.esp is the winner, so an un-sourced copy would carry its value.
                var winnerCheck = orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user");
                var winnerStaged = Assert.IsType<StageEditResult.Staged>(winnerCheck);
                Assert.Contains(winnerStaged.Changes, c =>
                    c.FieldPath == "aggression" && c.NewValue.GetString() == "Unaggressive");

                var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user", sourcePlugin: "Source.esp");

                var staged = Assert.IsType<StageEditResult.Staged>(result);
                Assert.Contains(staged.Changes, c =>
                    c.FieldPath == "aggression" && c.NewValue.GetString() == "Frenzied");
            }
        }
    }

    [Fact]
    public void CopyRecordTo_ExplicitSourcePluginNotOverridden_ReturnsRecordNotFound()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-copy-explicit-source-missing")
            .WithPlugin("Source.esp", mod => npcKey = mod.Npcs.AddNew("TestNPC").FormKey)
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user", sourcePlugin: "NoOverride.esp");

                Assert.IsType<StageEditResult.RecordNotFound>(result);
            }
        }
    }

    [Fact]
    public void CopyRecordTo_NoSession_ReturnsNoSession()
    {
        var (orchestrator, manager) = MakeOrchestrator();
        using (manager)
        {
            var result = orchestrator.CopyRecordTo("FFFFFF:NoSuch.esp", "Target.esp", "user");

            Assert.IsType<StageEditResult.NoSession>(result);
        }
    }


    // #134: copy-to blocks only when the target record is pending delete/renumber — not merely
    // because it "has a group." Here the target is pending renumber, so overwriting it by copy is
    // incoherent. (A target with only pending field edits is copyable — that block was the old
    // conflation ADR-0028 removes.)
    [Fact]
    public void CopyRecordTo_TargetPendingRenumber_Blocked()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-copy-target-renum")
            .WithPlugin("Source.esp", mod =>
                npcKey = mod.Npcs.AddNew("TestNPC_CopyTargetRenum").FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager, _) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                Assert.IsType<RenumberResult.Staged>(
                    orchestrator.Renumber(npcKey.ToString(), 0xABC, "Source.esp", "user"));

                var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Source.esp", "user");

                var blocked = Assert.IsType<StageEditResult.RecordPendingDeleteOrRenumber>(result);
                Assert.Equal("renumber", blocked.ChangeType);
            }
        }
    }

    // --- StageEdit form-ref tests ---

    private static (EditOrchestrator orchestrator, SessionManager manager, DuckDbPendingChangeService changes)
        MakeOrchestratorWithChanges()
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var changes = DuckDbTestFactory.MakePendingChangeService();
        // Pass changes so SessionManager.Load() calls OnSessionLoaded, sharing the DuckDB connection —
        // required for GetReferences, which queries pending_changes on the shared connection.
        var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance), changes);
        var query = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());
        var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
        var orchestrator = new EditOrchestrator(manager, query, writer, changes, reflector);
        return (orchestrator, manager, changes);
    }

    // #312: DuckDbPendingChangeService's connection is swapped to the session's own
    // (repository.Connection) inside manager.Load() — a connection captured before Load() is stale
    // once it runs. Read pending_form_references off manager.Repository's connection instead,
    // fetched after Load(), the same live connection changes itself is writing through.
    private static DuckDBConnection RequireConnection(SessionManager manager) =>
        ((IRecordRepository)manager.Repository!).Connection;

    [Fact]
    public void CopyRecordTo_ScalarFormKeyField_StagesFormReference()
    {
        FormKey npcKey = default;
        FormKey raceKey = default;
        var data = new PluginFixtureBuilder("eo-copy-scalar-fk")
            .WithPlugin("Source.esp", mod =>
            {
                var race = mod.Races.AddNew("TestRace_ScalarFk");
                raceKey = race.FormKey;
                var npc = mod.Npcs.AddNew("TestNPC_ScalarFk");
                npc.Race.SetTo(race.FormKey);
                npcKey = npc.FormKey;
            })
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, _) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user");

                Assert.IsType<StageEditResult.Staged>(result);
                var formRefs = DuckDbTestFactory.ReadFormRefs(RequireConnection(manager), "Target.esp");
                var raceRef = formRefs[npcKey.ToString()]
                    .FirstOrDefault(r => r.FieldPath == "race");
                Assert.NotNull(raceRef);
                Assert.Equal(raceKey.ToString(), raceRef.TargetFormKey);
            }
        }
    }

    [Fact]
    public void CopyRecordTo_ArrayFormKeyField_StagesFormReferencesWithIndices()
    {
        FormKey npcKey = default;
        FormKey kw1Key = default;
        FormKey kw2Key = default;
        var data = new PluginFixtureBuilder("eo-copy-array-fk")
            .WithPlugin("Source.esp", mod =>
            {
                var kw1 = mod.Keywords.AddNew();
                kw1.EditorID = "TestKw1_ArrayFk";
                kw1Key = kw1.FormKey;
                var kw2 = mod.Keywords.AddNew();
                kw2.EditorID = "TestKw2_ArrayFk";
                kw2Key = kw2.FormKey;
                var npc = mod.Npcs.AddNew("TestNPC_ArrayFk");
                npc.Keywords = [new FormLink<IKeywordGetter>(kw1Key), new FormLink<IKeywordGetter>(kw2Key)];
                npcKey = npc.FormKey;
            })
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, _) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user");

                Assert.IsType<StageEditResult.Staged>(result);
                var formRefs = DuckDbTestFactory.ReadFormRefs(RequireConnection(manager), "Target.esp");
                var refs = formRefs[npcKey.ToString()]
                    .Where(r => r.FieldPath.StartsWith("keywords", StringComparison.Ordinal))
                    .OrderBy(r => r.FieldPath).ToList();
                Assert.Equal(2, refs.Count);
                Assert.Equal("keywords[0]", refs[0].FieldPath);
                Assert.Equal("keywords", refs[0].StagedField);
                Assert.Equal(kw1Key.ToString(), refs[0].TargetFormKey);
                Assert.Equal("keywords[1]", refs[1].FieldPath);
                Assert.Equal("keywords", refs[1].StagedField);
                Assert.Equal(kw2Key.ToString(), refs[1].TargetFormKey);
            }
        }
    }

    [Fact]
    public void CopyRecordTo_ArrayOfStructFormKeyField_StagesFormReference()
    {
        FormKey npcKey = default;
        FormKey factionKey = default;
        var data = new PluginFixtureBuilder("eo-copy-struct-fk")
            .WithPlugin("Source.esp", mod =>
            {
                factionKey = mod.Factions.AddNew("TestFaction_StructFk").FormKey;
                var npc = mod.Npcs.AddNew("TestNPC_StructFk");
                npc.Factions.Add(new RankPlacement { Faction = new FormLink<IFactionGetter>(factionKey) });
                npcKey = npc.FormKey;
            })
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, _) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CopyRecordTo(npcKey.ToString(), "Target.esp", "user");

                Assert.IsType<StageEditResult.Staged>(result);
                var formRefs = DuckDbTestFactory.ReadFormRefs(RequireConnection(manager), "Target.esp");
                var factionRef = formRefs[npcKey.ToString()]
                    .FirstOrDefault(r => r.FieldPath == "factions[0].faction");
                Assert.NotNull(factionRef);
                Assert.Equal(factionKey.ToString(), factionRef.TargetFormKey);
            }
        }
    }

    // #337 review: CopyRecordTo skips ValidateReferences (it stages the source record's fields
    // verbatim), so a copy can carry a FormLink to a plugin that only the *source* plugin ever
    // declares as a master — never a session member itself. Proves SessionManager.
    // MastersWritingOrder's completeness argument holds through this real bypass, not just the
    // schema-validated StageEdit path: the save must not throw MissingModException. Placed-record
    // copy (PluginWriter is the only copy-as-override shape it currently materializes onto disk —
    // ApplyFieldChanges falls through to NotFound for a non-placed override with no create change)
    // — and it doubles as the "2+ masters" fixture for free: the cell-override pull-in needs
    // Master.esm itself as a master, and the copied ref's own Base needs OrphanMaster.esm, so the
    // sort genuinely compares two real entries, not a 1-element list.
    [Fact]
    public async Task CopyRecordTo_ThenSave_MasterOnlyDeclaredBySourcePlugin_SavesWithoutThrowing()
    {
        FormKey cellFk = default, refAFk = default;
        var data = new PluginFixtureBuilder("eo-copy-orphan-master")
            .WithPlugin("Master.esm", mod =>
            {
                var wrld = mod.Worldspaces.AddNew("PlacedWorld");
                var cell = new Cell(mod) { EditorID = "ExtCell", Grid = new CellGrid { Point = new P2Int(1, 2) } };
                cellFk = cell.FormKey;
                var refA = new PlacedObject(mod)
                {
                    EditorID = "refA",
                    // "OrphanMaster.esm" is never built or loaded anywhere in this session —
                    // Master.esm is the only plugin that ever declares it, via this one FormLink.
                    Base = new FormLinkNullable<IPlaceableObjectGetter>(FormKey.Factory("000001:OrphanMaster.esm")),
                };
                refAFk = refA.FormKey;
                cell.Persistent.Add(refA);
                var sub = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
                sub.Items.Add(cell);
                var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
                block.Items.Add(sub);
                wrld.SubCells.Add(block);
            })
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                Assert.IsType<StageEditResult.Staged>(orchestrator.CopyRecordTo(refAFk.ToString(), "Target.esp", "user"));

                var staged = changes.GetChanges(plugin: "Target.esp", origin: "Data");

                await manager.SavePlugin("Target.esp", staged);

                var targetPath = Path.Combine(data.DataFolder, "Target.esp");
                using var saved = Fallout4Mod.CreateFromBinaryOverlay(
                    new ModPath(ModKey.FromFileName("Target.esp"), targetPath), Fallout4Release.Fallout4);
                Assert.Equal(
                    new[] { "Master.esm", "OrphanMaster.esm" },
                    saved.MasterReferences.Select(r => r.Master.FileName.ToString()).OrderBy(n => n, StringComparer.Ordinal));
            }
        }
    }

    [Fact]
    public void StageEdit_KeywordsField_NullStringElement_YieldsNoRef()
    {
        FormKey npcKey = default;
        FormKey kwKey = default;
        var data = new PluginFixtureBuilder("eo-stage-kw-null")
            .WithPlugin("Source.esp", mod =>
            {
                kwKey = mod.Keywords.AddNew().FormKey;
                npcKey = mod.Npcs.AddNew("TestNPC_KwNull").FormKey;
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager, _) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var keywordsJson = J($"[\"Null\",\"{kwKey}\"]");
                var fields = new Dictionary<string, JsonElement> { ["keywords"] = keywordsJson };

                var result = orchestrator.StageEdit(npcKey.ToString(), "Source.esp", fields, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
                var formRefs = DuckDbTestFactory.ReadFormRefs(RequireConnection(manager), "Source.esp");
                var kwRefs = formRefs[npcKey.ToString()]
                    .Where(r => r.FieldPath.StartsWith("keywords", StringComparison.Ordinal))
                    .ToList();
                Assert.Single(kwRefs);
                Assert.Equal("keywords[1]", kwRefs[0].FieldPath);
                Assert.Equal(kwKey.ToString(), kwRefs[0].TargetFormKey);
            }
        }
    }

    [Fact]
    public void StageEdit_FactionsField_ExtractsStructSubFieldFormRefsWithCorrectIndices()
    {
        FormKey npcKey = default;
        FormKey faction1Key = default;
        FormKey faction2Key = default;
        var data = new PluginFixtureBuilder("eo-stage-struct-fk-idx")
            .WithPlugin("Source.esp", mod =>
            {
                faction1Key = mod.Factions.AddNew("TestFaction1_StageIdx").FormKey;
                faction2Key = mod.Factions.AddNew("TestFaction2_StageIdx").FormKey;
                npcKey = mod.Npcs.AddNew("TestNPC_StageIdx").FormKey;
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager, _) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var factionsJson = J($"[{{\"faction\":\"{faction1Key}\",\"rank\":0}},{{\"faction\":\"{faction2Key}\",\"rank\":1}}]");
                var fields = new Dictionary<string, JsonElement> { ["factions"] = factionsJson };

                var result = orchestrator.StageEdit(npcKey.ToString(), "Source.esp", fields, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
                var formRefs = DuckDbTestFactory.ReadFormRefs(RequireConnection(manager), "Source.esp");
                var refs = formRefs[npcKey.ToString()]
                    .Where(r => r.FieldPath.StartsWith("factions", StringComparison.Ordinal))
                    .OrderBy(r => r.FieldPath).ToList();
                Assert.Equal(2, refs.Count);
                Assert.Equal("factions[0].faction", refs[0].FieldPath);
                Assert.Equal(faction1Key.ToString(), refs[0].TargetFormKey);
                Assert.Equal("factions[1].faction", refs[1].FieldPath);
                Assert.Equal(faction2Key.ToString(), refs[1].TargetFormKey);
            }
        }
    }

    [Theory]
    [InlineData("[{\"faction\":\"Null\",\"rank\":0}]")]
    [InlineData("[{\"faction\":42,\"rank\":0}]")]
    public void StageEdit_FactionsField_InvalidFactionValue_ReturnsInvalidReferences(string factionsRaw)
    {
        // RankPlacement.Faction is a non-nullable FormLink<IFactionGetter> — a null/malformed
        // value is now rejected at stage time instead of silently staging with no ref.
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-stage-struct-fk-invalid")
            .WithPlugin("Source.esp", mod =>
                npcKey = mod.Npcs.AddNew("TestNPC_StageInvalid").FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["factions"] = J(factionsRaw) };

                var result = orchestrator.StageEdit(npcKey.ToString(), "Source.esp", fields, "user", null);

                var invalid = Assert.IsType<StageEditResult.InvalidReferences>(result);
                Assert.Single(invalid.Errors);
                Assert.Equal("factions[0].faction", invalid.Errors[0].FieldPath);
                Assert.Equal("null_not_allowed", invalid.Errors[0].Reason);
            }
        }
    }

    [Fact]
    public void StageEdit_FormLink_TargetNotInSession_ReturnsInvalidReferences()
    {
        // RankPlacement.Faction is a non-nullable FormLink<IFactionGetter>; pointing it at a
        // well-formed FormKey that doesn't resolve to any record in the session is a data error.
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-stage-faction-missing")
            .WithPlugin("Source.esp", mod =>
                npcKey = mod.Npcs.AddNew("TestNPC_FactionMissing").FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["factions"] = J("[{\"faction\":\"0000FF:Source.esp\",\"rank\":0}]") };

                var result = orchestrator.StageEdit(npcKey.ToString(), "Source.esp", fields, "user", null);

                var invalid = Assert.IsType<StageEditResult.InvalidReferences>(result);
                Assert.Single(invalid.Errors);
                Assert.Equal("factions[0].faction", invalid.Errors[0].FieldPath);
                Assert.Equal("not_in_session", invalid.Errors[0].Reason);
            }
        }
    }

    [Fact]
    public void StageEdit_FormLink_TypeMismatch_ReturnsInvalidReferences()
    {
        FormKey npcKey = default;
        FormKey otherNpcKey = default;
        var data = new PluginFixtureBuilder("eo-stage-faction-mismatch")
            .WithPlugin("Source.esp", mod =>
            {
                otherNpcKey = mod.Npcs.AddNew("TestNPC_WrongType").FormKey;
                npcKey = mod.Npcs.AddNew("TestNPC_FactionMismatch").FormKey;
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["factions"] = J($"[{{\"faction\":\"{otherNpcKey}\",\"rank\":0}}]") };

                var result = orchestrator.StageEdit(npcKey.ToString(), "Source.esp", fields, "user", null);

                var invalid = Assert.IsType<StageEditResult.InvalidReferences>(result);
                Assert.Single(invalid.Errors);
                Assert.Equal("factions[0].faction", invalid.Errors[0].FieldPath);
                Assert.Equal("type_mismatch", invalid.Errors[0].Reason);
            }
        }
    }

    [Fact]
    public void StageEdit_FormLink_ValidReference_Stages()
    {
        FormKey npcKey = default;
        FormKey factionKey = default;
        var data = new PluginFixtureBuilder("eo-stage-faction-valid")
            .WithPlugin("Source.esp", mod =>
            {
                factionKey = mod.Factions.AddNew("TestFaction_Valid").FormKey;
                npcKey = mod.Npcs.AddNew("TestNPC_FactionValid").FormKey;
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["factions"] = J($"[{{\"faction\":\"{factionKey}\",\"rank\":0}}]") };

                var result = orchestrator.StageEdit(npcKey.ToString(), "Source.esp", fields, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
            }
        }
    }

    [Fact]
    public void StageEdit_NullableFormLinkArrayElement_SetToNull_Stages()
    {
        // Keywords elements are declared as the ambiguous base IFormLinkGetter<IKeywordGetter>
        // (neither IFormLink<T> nor IFormLinkNullable<T>) — treated as nullable since nothing
        // in the type forbids it. Covered structurally by StageEdit_KeywordsField_NullStringElement_YieldsNoRef;
        // this asserts the same input is still accepted now that reference validation runs.
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("eo-stage-keyword-null")
            .WithPlugin("Source.esp", mod =>
                npcKey = mod.Npcs.AddNew("TestNPC_KeywordNull").FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);
                var fields = new Dictionary<string, JsonElement> { ["keywords"] = J("[\"Null\"]") };

                var result = orchestrator.StageEdit(npcKey.ToString(), "Source.esp", fields, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
            }
        }
    }

    // --- CreateRecord ---

    [Fact]
    public void CreateRecord_NoTemplate_StagedWithCorrectShapeAndGroup()
    {
        var data = new PluginFixtureBuilder("cr-shape")
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Target.esp", "npc_", null, "user"));

                var staged = changes.GetChanges(formKey: result.FormKey);
                Assert.Single(staged);
                Assert.Equal("$create", staged[0].FieldPath);
                Assert.Equal("create", staged[0].ChangeType);
                Assert.Equal(JsonValueKind.Null, staged[0].NewValue.ValueKind);
                Assert.Equal(result.FormKey, staged[0].FormKey);

                // The create hands back a member change id — here the $create change's own id —
                // rather than a stored group id (ADR-0028).
                Assert.Equal(result.GroupId, staged[0].Id);

                var groups = changes.GetChangeGroups();
                Assert.Single(groups);
                Assert.Equal(result.GroupId, groups[0].Id);
            }
        }
    }

    [Fact]
    public void CreateRecord_WithTemplate_StagesSeparateFieldEditChanges()
    {
        FormKey templateKey = default;
        var data = new PluginFixtureBuilder("cr-template")
            .WithPlugin("Source.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("TemplateNPC");
                npc.Aggression = Npc.AggressionType.Frenzied;
                templateKey = npc.FormKey;
            })
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Target.esp", "npc_", templateKey.ToString(), "user"));

                var staged = changes.GetChanges(formKey: result.FormKey);
                // $create sentinel + N field_edit changes from template
                Assert.True(staged.Count > 1, "Expected $create plus at least one field_edit from template");
                var createChange = staged.Single(c => c.FieldPath == "$create");
                Assert.Equal(JsonValueKind.Null, createChange.NewValue.ValueKind);
                Assert.Equal(result.GroupId, createChange.Id);
                var fieldEdits = staged.Where(c => c.FieldPath != "$create").ToList();
                Assert.All(fieldEdits, c => Assert.Equal("field_edit", c.ChangeType));

                // The template's field edits are all edits on a record the $create brings into
                // existence, so they share its group by edge rule 2 rather than by a shared label —
                // saving a field of a record that does not exist yet would be incoherent.
                Assert.Equal(
                    staged.Select(c => c.Id).Order(),
                    changes.GetChanges(memberChangeId: result.GroupId).Select(c => c.Id).Order());
            }
        }
    }

    // #281: Copy as New Record names its source copy — the template must be read off that
    // plugin's own version of the record, not the overall winner (the same #202 rule
    // CopyRecordTo's explicit sourcePlugin enforces for Copy as Override). Source.esp loses
    // the conflict to Middle.esp, so winning-template behaviour would stage "Unaggressive".
    [Fact]
    public void CreateRecord_ExplicitTemplateSource_CopiesThatPluginsFields_NotWinner()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("cr-template-source")
            .WithPlugin("Source.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("TestNPC");
                npc.Aggression = Npc.AggressionType.Frenzied;
                npcKey = npc.FormKey;
            })
            .WithPlugin("Middle.esp", mod =>
            {
                var overrideNpc = new Npc(npcKey, Fallout4Release.Fallout4)
                {
                    Aggression = Npc.AggressionType.Unaggressive
                };
                mod.Npcs.Add(overrideNpc);
            })
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Target.esp", "npc_", npcKey.ToString(), "user",
                        templateSourcePlugin: "Source.esp"));

                var staged = changes.GetChanges(formKey: result.FormKey);
                Assert.Contains(staged, c =>
                    c.FieldPath == "aggression" && c.NewValue.GetString() == "Frenzied");
            }
        }
    }

    // #281: the Plugins tree's record row knows only its FormKey — the record type is derivable
    // from the template record, so a caller with a template may omit it.
    [Fact]
    public void CreateRecord_NullRecordTypeWithTemplate_DerivesTypeFromTemplate()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("cr-derive-type")
            .WithPlugin("Source.esp", mod => npcKey = mod.Npcs.AddNew("TemplateNPC").FormKey)
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Target.esp", null, npcKey.ToString(), "user"));

                var createChange = changes.GetChanges(formKey: result.FormKey).Single(c => c.FieldPath == "$create");
                Assert.Equal("npc_", createChange.RecordType);
            }
        }
    }

    // #281: Copy as New Record of a placed record lands the new ref under the template's own cell
    // and Persistent/Temporary GRUP (xEdit keeps a copied ref in its cell; an unparented REFR is
    // an orphan) — same placement CopyRecordTo already carries for a staged override copy.
    [Fact]
    public void CreateRecord_TemplateIsPlaced_StampsTemplatePlacementOnCreate()
    {
        var data = PlacedFixture("cr-template-placed", "Source.esp", out var cellFk, out var placedFk);
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Target.esp", null, placedFk, "user",
                        templateSourcePlugin: "Source.esp"));

                var createChange = changes.GetChanges(formKey: result.FormKey).Single(c => c.FieldPath == "$create");
                Assert.Equal(cellFk, createChange.ParentCell);
                Assert.Equal("persistent", createChange.PlacementGroup);
            }
        }
    }

    [Fact]
    public void CreateRecord_NullRecordTypeWithoutTemplate_ThrowsArgumentException()
    {
        var data = new PluginFixtureBuilder("cr-null-type-no-template")
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                Assert.Throws<ArgumentException>(() =>
                    orchestrator.CreateRecord("Target.esp", null, null, "user"));
            }
        }
    }

    [Fact]
    public void CreateRecord_UnknownRecordType_ThrowsArgumentException()
    {
        var data = new PluginFixtureBuilder("cr-unknown-type")
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                Assert.Throws<ArgumentException>(() =>
                    orchestrator.CreateRecord("Target.esp", "not_a_real_type", null, "user"));
            }
        }
    }

    [Fact]
    public void CreateRecord_WithTemplate_TemplateNotFound_ThrowsArgumentException()
    {
        var data = new PluginFixtureBuilder("cr-template-missing")
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager) = MakeOrchestrator();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                Assert.Throws<ArgumentException>(() =>
                    orchestrator.CreateRecord("Target.esp", "npc_", "FFFFFF:NotReal.esp", "user"));
            }
        }
    }

    // --- Issue #98 slice 3: creating a record with an out-of-range native FormID on an
    // already-ESL-flagged plugin is rejected at stage time — not just an ESL toggle. ---

    [Fact]
    public void CreateRecord_OnEslFlaggedPlugin_FormIdOutOfRange_ReturnsEslIneligible()
    {
        var data = new PluginFixtureBuilder("cr-esl-out-of-range")
            .WithPlugin(
                "Light.esp",
                mod =>
                {
                    mod.ModHeader.Flags = Fallout4ModHeader.HeaderFlag.Small; // already ESL-flagged
                    ((Mutagen.Bethesda.Plugins.Records.IMod)mod).NextFormID = 0x1000; // out-of-range reservation
                },
                writeParams: new Mutagen.Bethesda.Plugins.Binary.Parameters.BinaryWriteParameters
                {
                    NextFormID = Mutagen.Bethesda.Plugins.Binary.Parameters.NextFormIDOption.NoCheck,
                })
            .Build();
        using (data)
        {
            var (orchestrator, manager, _) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.CreateRecord("Light.esp", "npc_", null, "user");

                var esl = Assert.IsType<CreateRecordOutcome.EslIneligible>(result);
                Assert.Equal("Light.esp", esl.Plugin);
                Assert.Contains("001000:Light.esp", esl.FormKeys);
            }
        }
    }

    // --- Issue #98 mutation-triage follow-up: IsPluginEslFlagged's pending branch — a plugin that
    // is only *pending*-flagged ESL (a staged-but-unsaved header toggle, not yet committed) still
    // triggers the reverse guard, and a pending header edit that leaves ESL off does not. ---

    [Fact]
    public void CreateRecord_OnPendingEslFlaggedPlugin_FormIdOutOfRange_ReturnsEslIneligible()
    {
        var data = new PluginFixtureBuilder("cr-esl-pending-flagged")
            .WithPlugin(
                "Pending.esp",
                mod => ((Mutagen.Bethesda.Plugins.Records.IMod)mod).NextFormID = 0x1000, // out-of-range reservation
                writeParams: new Mutagen.Bethesda.Plugins.Binary.Parameters.BinaryWriteParameters
                {
                    NextFormID = Mutagen.Bethesda.Plugins.Binary.Parameters.NextFormIDOption.NoCheck,
                })
            .Build();
        using (data)
        {
            var (orchestrator, manager, _) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                // Stage (don't save) an ESL toggle — the plugin has no native records yet, so the
                // toggle itself stages cleanly.
                var eslBits = ((long)Fallout4ModHeader.HeaderFlag.Small).ToString(System.Globalization.CultureInfo.InvariantCulture);
                var toggleFields = new Dictionary<string, JsonElement> { ["flags"] = J($"\"{eslBits}\"") };
                Assert.IsType<StageEditResult.Staged>(
                    orchestrator.StageEdit("000000:Pending.esp", "Pending.esp", toggleFields, "user", null));

                var result = orchestrator.CreateRecord("Pending.esp", "npc_", null, "user");

                var esl = Assert.IsType<CreateRecordOutcome.EslIneligible>(result);
                Assert.Equal("Pending.esp", esl.Plugin);
                Assert.Contains("001000:Pending.esp", esl.FormKeys);
            }
        }
    }

    [Fact]
    public void CreateRecord_PendingNonEslHeaderEdit_FormIdOutOfRange_Succeeds()
    {
        var data = new PluginFixtureBuilder("cr-esl-pending-non-esl")
            .WithPlugin(
                "Pending2.esp",
                mod => ((Mutagen.Bethesda.Plugins.Records.IMod)mod).NextFormID = 0x1000, // out-of-range reservation
                writeParams: new Mutagen.Bethesda.Plugins.Binary.Parameters.BinaryWriteParameters
                {
                    NextFormID = Mutagen.Bethesda.Plugins.Binary.Parameters.NextFormIDOption.NoCheck,
                })
            .Build();
        using (data)
        {
            var (orchestrator, manager, _) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                // Stage a header edit that does NOT touch the ESL bit (Master only) — the plugin
                // must not be treated as pending-flagged ESL.
                var masterBits = ((long)Fallout4ModHeader.HeaderFlag.Master).ToString(System.Globalization.CultureInfo.InvariantCulture);
                var toggleFields = new Dictionary<string, JsonElement> { ["flags"] = J($"\"{masterBits}\"") };
                Assert.IsType<StageEditResult.Staged>(
                    orchestrator.StageEdit("000000:Pending2.esp", "Pending2.esp", toggleFields, "user", null));

                var result = orchestrator.CreateRecord("Pending2.esp", "npc_", null, "user");

                Assert.IsType<CreateRecordOutcome.Success>(result);
            }
        }
    }

    // --- Dependent change grouping ---

    [Fact]
    public void StageEdit_ReferencesCreatedFormKey_JoinsCreationGroup()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("dep-group-join")
            .WithPlugin("Source.esp", mod => npcKey = mod.Npcs.AddNew("SourceNPC").FormKey)
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                // Create a new Faction in Target.esp (factions[].faction requires a Faction-typed reference)
                var createResult = Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Target.esp", "fact", null, "user"));
                var newFormKey = createResult.FormKey;

                // Stage an edit on SourceNPC that references the newly-created FormKey via factions
                var factionList = JsonSerializer.SerializeToElement(
                    new[] { new { faction = newFormKey, rank = 0 } });
                var fields = new Dictionary<string, JsonElement> { ["factions"] = factionList };

                orchestrator.StageEdit(npcKey.ToString(), "Source.esp", fields, "user", null);

                var allChanges = changes.GetChanges();
                var dependentChange = allChanges.FirstOrDefault(c =>
                    c.FormKey == npcKey.ToString() && c.FieldPath == "factions");
                Assert.NotNull(dependentChange);

                // The edit holds a FormLink to a record that only the pending $create brings into
                // existence, so the two travel together (ADR-0028 edge rule 1) — saving the edit
                // without the create would leave a dangling reference. Observed as one group rather
                // than as a shared group_id: grouping is derived now, not labelled.
                var group = Assert.Single(changes.GetChangeGroups());
                Assert.Equal(2, group.ChangeCount);
                Assert.Equal("create", group.Operation);
                Assert.Equal(
                    new[] { createResult.FormKey, npcKey.ToString() }.Order(),
                    changes.GetChanges(memberChangeId: group.Id).Select(c => c.FormKey).Order());
            }
        }
    }

    // --- Stage-edit guard: blocked only when the subject is pending delete/renumber (#134) ---
    // ADR-0028: every change has a group now, so a guard keyed on "has a group" would make every
    // record read-only after one edit. The guard keys on the semantic reason a field edit is
    // incoherent — the record is being deleted or renumbered — not on group membership.

    [Fact]
    public void StageEdit_SubjectPendingDelete_Blocked()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("guard-edit-del")
            .WithPlugin("Target.esp", mod => npcKey = mod.Npcs.AddNew("TestNPC_GuardDel").FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager, _) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                Assert.IsType<DeleteRecordsResult.Staged>(
                    orchestrator.DeleteRecords([(npcKey.ToString(), "Target.esp")], "user"));

                var result = orchestrator.StageEdit(npcKey.ToString(), "Target.esp",
                    new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") }, "user", null);

                var blocked = Assert.IsType<StageEditResult.RecordPendingDeleteOrRenumber>(result);
                Assert.Equal("delete", blocked.ChangeType);
            }
        }
    }

    [Fact]
    public void StageEdit_SubjectPendingRenumber_Blocked()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("guard-edit-renum")
            .WithPlugin("Target.esp", mod => npcKey = mod.Npcs.AddNew("TestNPC_GuardRenum").FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager, _) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                Assert.IsType<RenumberResult.Staged>(
                    orchestrator.Renumber(npcKey.ToString(), 0xABC, "Target.esp", "user"));

                var result = orchestrator.StageEdit(npcKey.ToString(), "Target.esp",
                    new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") }, "user", null);

                var blocked = Assert.IsType<StageEditResult.RecordPendingDeleteOrRenumber>(result);
                Assert.Equal("renumber", blocked.ChangeType);
            }
        }
    }

    // #275 / ADR-0036: the guard's own lookup (PendingLifecycleChangeType) must scope by the
    // plugin's real origin, not just its filename — otherwise a pending delete staged against one
    // origin's copy of a filename would incorrectly block an edit on a *different* origin's copy of
    // the same filename. Two same-filename plugins can't be loaded simultaneously via GameSession
    // yet (#34), so the "different origin" side is constructed directly at the IPendingChangeService
    // seam (AC3-style, mirroring CompoundPluginIdentityTests) rather than through a real dual load.
    [Fact]
    public void StageEdit_PendingDeleteOnDifferentOrigin_SameFilename_DoesNotBlockEdit()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("guard-edit-origin")
            .WithPlugin("Shared.esp", mod => npcKey = mod.Npcs.AddNew("TestNPC_GuardOrigin").FormKey)
            .BuildScattered();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();

            using (manager)
            {
                var withOrigin = data.Plugins.Select(p => p with { Origin = "ModB" }).ToList();
                manager.LoadExplicit(data.GameDirectory, withOrigin, GameRelease.Fallout4);

                // Phantom pending delete against "Shared.esp" but a *different* origin ("ModA")
                // than the one just loaded ("ModB") — same filename, different physical plugin.
                changes.Upsert(new PendingChangeUpsert(npcKey.ToString(), "Shared.esp", "npc_",
                    new() { [PendingChangeConstants.DeleteFieldPath] = PendingChangeConstants.NullElement },
                    "user", null, [],
                    ChangeType: PendingChangeConstants.DeleteChangeType,
                    Origin: "ModA", FormRefs: null, ParentCell: null, PlacementGroup: null));

                var result = orchestrator.StageEdit(npcKey.ToString(), "Shared.esp",
                    new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") }, "user", null);

                // Today PendingLifecycleChangeType ignores origin and finds "ModA"'s delete anyway,
                // wrongly blocking an edit against the unrelated "ModB" copy.
                Assert.IsType<StageEditResult.Staged>(result);
            }
        }
    }

    // Genuinely red against the old guard: SourceNPC's factions edit references a pending-created
    // Faction, so under the stored model it carried a non-null group_id — and the old guard blocked
    // any further edit on it. A field edit is not a delete or renumber, so it must not block.
    [Fact]
    public void StageEdit_SubjectHasPendingFieldEditWithGroup_NotBlocked()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("guard-edit-fieldgroup")
            .WithPlugin("Source.esp", mod => npcKey = mod.Npcs.AddNew("SourceNPC_GuardFieldGroup").FormKey)
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var createResult = Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Target.esp", "fact", null, "user"));
                var factionList = JsonSerializer.SerializeToElement(
                    new[] { new { faction = createResult.FormKey, rank = 0 } });
                Assert.IsType<StageEditResult.Staged>(orchestrator.StageEdit(npcKey.ToString(), "Source.esp",
                    new Dictionary<string, JsonElement> { ["factions"] = factionList }, "user", null));

                // A further edit on the same record — it has a pending field edit (grouped), not a
                // pending delete/renumber, so it must stage.
                var result = orchestrator.StageEdit(npcKey.ToString(), "Source.esp",
                    new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") }, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
            }
        }
    }

    // Genuinely red against the old guard: deleting the referenced record nullifies SourceNPC's ref,
    // so SourceNPC picks up a field_edit change with a group_id — but SourceNPC is a *referrer* in
    // the delete cascade, not its subject. Editing another of its fields must not block.
    [Fact]
    public void StageEdit_SubjectReferencedByDeleteCascade_NotBlocked()
    {
        FormKey npcKey = default;
        FormKey raceKey = default;
        var data = new PluginFixtureBuilder("guard-edit-cascade")
            .WithPlugin("Target.esp", mod =>
            {
                var race = mod.Races.AddNew("TestRace_GuardCascade");
                raceKey = race.FormKey;
                var npc = mod.Npcs.AddNew("TestNPC_GuardCascade");
                npc.Race.SetTo(race.FormKey);
                npcKey = npc.FormKey;
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager, _) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                Assert.IsType<DeleteRecordsResult.Staged>(
                    orchestrator.DeleteRecords([(raceKey.ToString(), "Target.esp")], "user"));

                var result = orchestrator.StageEdit(npcKey.ToString(), "Target.esp",
                    new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") }, "user", null);

                Assert.IsType<StageEditResult.Staged>(result);
            }
        }
    }

    // --- Delete on pending-create targets reverts instead of staging (#143) ---
    // A pending-create record has no on-disk existence for a $delete to act on, so deleting it must
    // revert the create's whole dependency component (reusing RevertGroup) rather than staging a
    // $delete change that would coexist incoherently with the $create.

    [Fact]
    public void DeleteRecords_TargetPendingCreate_RevertsInsteadOfStaging()
    {
        var data = new PluginFixtureBuilder("del-create-revert")
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var createResult = Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Target.esp", "npc_", null, "user"));

                var result = orchestrator.DeleteRecords(
                    [(createResult.FormKey, "Target.esp")], "user");

                var reverted = Assert.IsType<DeleteRecordsResult.Reverted>(result);
                Assert.Equal([createResult.FormKey], reverted.FormKeys);
                Assert.Empty(changes.GetChanges(formKey: createResult.FormKey));
            }
        }
    }

    [Fact]
    public void DeleteRecords_TargetPendingCreateWithDependentEdit_RevertsWholeComponent()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("del-create-revert-cascade")
            .WithPlugin("Source.esp", mod => npcKey = mod.Npcs.AddNew("SourceNPC").FormKey)
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var createResult = Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Target.esp", "fact", null, "user"));
                var factionList = JsonSerializer.SerializeToElement(
                    new[] { new { faction = createResult.FormKey, rank = 0 } });
                Assert.IsType<StageEditResult.Staged>(orchestrator.StageEdit(npcKey.ToString(), "Source.esp",
                    new Dictionary<string, JsonElement> { ["factions"] = factionList }, "user", null));

                // SourceNPC's factions edit and the Faction's $create are one component (ADR-0028 edge
                // rule 2): deleting the Faction target must revert both, not just the $create row.
                var result = orchestrator.DeleteRecords(
                    [(createResult.FormKey, "Target.esp")], "user");

                var reverted = Assert.IsType<DeleteRecordsResult.Reverted>(result);
                Assert.Equal([createResult.FormKey], reverted.FormKeys);
                Assert.Empty(changes.GetChangeGroups());
            }
        }
    }

    [Fact]
    public void DeleteRecords_MixedPendingCreateAndCommittedTargets_RevertsAndStagesDistinctly()
    {
        FormKey committedNpcKey = default;
        var data = new PluginFixtureBuilder("del-create-mixed")
            .WithPlugin("Target.esp", mod => committedNpcKey = mod.Npcs.AddNew("CommittedNPC").FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var createResult = Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Target.esp", "npc_", null, "user"));

                var result = orchestrator.DeleteRecords(
                    [(createResult.FormKey, "Target.esp"), (committedNpcKey.ToString(), "Target.esp")], "user");

                var mixed = Assert.IsType<DeleteRecordsResult.Mixed>(result);
                Assert.Equal([createResult.FormKey], mixed.RevertedFormKeys);
                Assert.Equal(1, mixed.StagedGroup.ChangeCount);

                Assert.Empty(changes.GetChanges(formKey: createResult.FormKey));
                var committedChanges = changes.GetChanges(formKey: committedNpcKey.ToString());
                Assert.Contains(committedChanges, c => c.ChangeType == "delete");
            }
        }
    }

    // Genuinely red before the fix: RevertPendingCreateTargets used to run unconditionally, ahead of
    // the plainTargets reference-block check. A mixed batch that fails with BlockedByReferences must
    // not have already reverted a sibling pending-create — that's an unreported mutation on a call
    // whose result says nothing was done.
    [Fact]
    public void DeleteRecords_MixedBatchBlockedByReferences_DoesNotRevertPendingCreate()
    {
        FormKey keywordKey = default;
        var data = new PluginFixtureBuilder("del-create-mixed-blocked")
            .WithPlugin("Target.esp", mod => keywordKey = mod.Keywords.AddNew("BlockedKw").FormKey)
            // Fallout4.esm (implicit/immutable) NPC references the keyword — blocks its deletion.
            .WithPlugin("Fallout4.esm", (mod, _) =>
            {
                var npc = mod.Npcs.AddNew("BlockingNPC");
                npc.Keywords = [new FormLink<IKeywordGetter>(keywordKey)];
            }, listed: false)
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var createResult = Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Target.esp", "npc_", null, "user"));

                var result = orchestrator.DeleteRecords(
                    [(keywordKey.ToString(), "Target.esp"), (createResult.FormKey, "Target.esp")], "user");

                Assert.IsType<DeleteRecordsResult.BlockedByReferences>(result);
                // The pending-create must survive untouched — the call reported nothing succeeded.
                Assert.NotEmpty(changes.GetChanges(formKey: createResult.FormKey));
            }
        }
    }

    [Fact]
    public void RevertGroup_RemovesCreateAndDependentEdits()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("dep-group-revert")
            .WithPlugin("Source.esp", mod => npcKey = mod.Npcs.AddNew("SourceNPC").FormKey)
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var createResult = Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Target.esp", "npc_", null, "user"));
                var factionList = JsonSerializer.SerializeToElement(
                    new[] { new { faction = createResult.FormKey, rank = 0 } });
                var fields = new Dictionary<string, JsonElement> { ["factions"] = factionList };
                orchestrator.StageEdit(npcKey.ToString(), "Source.esp", fields, "user", null);

                changes.RevertGroup(createResult.GroupId);

                Assert.Empty(changes.GetChanges());
            }
        }
    }

    [Fact]
    public void CreateRecord_NoSession_ThrowsInvalidOperationException()
    {
        var (orchestrator, manager) = MakeOrchestrator();
        using (manager)
        {
            Assert.Throws<InvalidOperationException>(() =>
                orchestrator.CreateRecord("Target.esp", "npc_", null, "user"));
        }
    }

    [Fact]
    public void CreateRecord_WithTemplate_InvalidArrayReference_ReturnsInvalidReferences_WithoutStagingAnything()
    {
        // Set factions[0].faction to another NPC's FormKey (type_mismatch): factions is an array
        // of structs with a non-nullable FormLink<IFactionGetter>, so pointing it at an NPC
        // triggers a type_mismatch validation error. Array fields ARE copied from the template
        // (they have an Apply lambda), so this exercises the validation gap.
        FormKey templateKey = default;
        FormKey wrongTypeKey = default;
        var data = new PluginFixtureBuilder("cr-template-invalid-array-ref")
            .WithPlugin("Source.esp", mod =>
            {
                wrongTypeKey = mod.Npcs.AddNew("OtherNPC_NotAFaction").FormKey;
                var npc = mod.Npcs.AddNew("TemplateNPC_InvalidArrayRef");
                npc.Factions.Add(new RankPlacement { Faction = new FormLink<IFactionGetter>(wrongTypeKey) });
                templateKey = npc.FormKey;
            })
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var outcome = orchestrator.CreateRecord("Target.esp", "npc_", templateKey.ToString(), "user");

                var inv = Assert.IsType<CreateRecordOutcome.InvalidReferences>(outcome);
                Assert.Contains(inv.Errors, e => e.FieldPath == "factions[0].faction" && e.Reason == "type_mismatch");
                // Nothing should have been staged — not even the $create sentinel
                Assert.Empty(changes.GetChanges());
            }
        }
    }

    [Fact]
    public void CreateRecord_WithTemplate_ExcludesReadOnlyFields()
    {
        FormKey templateKey = default;
        var data = new PluginFixtureBuilder("cr-template-ro")
            .WithPlugin("Source.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("TemplateNPC_RO");
                npc.Aggression = Npc.AggressionType.Frenzied;
                templateKey = npc.FormKey;
            })
            .WithPlugin("Target.esp")
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = Assert.IsType<CreateRecordOutcome.Success>(
                    orchestrator.CreateRecord("Target.esp", "npc_", templateKey.ToString(), "user"));

                var staged = changes.GetChanges(formKey: result.FormKey);
                var fieldEdits = staged.Where(c => c.FieldPath != "$create").ToList();
                IPluginWriter writer = new PluginWriter(SharedSchemaReflector.Instance, NullLogger<PluginWriter>.Instance);
                Assert.DoesNotContain(fieldEdits, c => writer.IsReadOnly(GameRelease.Fallout4, "npc_", c.FieldPath));
                Assert.Contains(fieldEdits, c => c.FieldPath == "aggression");
            }
        }
    }

    // --- helpers ---

    /// <summary>
    /// Wraps a real SessionManager but overrides one plugin's IsImmutable to true.
    /// Used to test immutability enforcement without needing actual base-game files.
    /// </summary>
    private sealed class StubSessionManagerWithImmutablePlugin : ISessionManager, IDisposable
    {
        private readonly SessionManager _inner;

        public StubSessionManagerWithImmutablePlugin(
            string dataFolder, string pluginsTxtPath, GameRelease gameRelease, string immutablePlugin)
        {
            var reflector = SharedSchemaReflector.Instance;
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            _inner = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            _inner.Load(dataFolder, pluginsTxtPath, gameRelease);
            Session = new ImmutableOverrideSession(_inner.Session!, immutablePlugin);
        }

        public IGameSession? Session { get; }
        public IRecordReader? Repository => _inner.Repository;
        // #274: these stubs never load, so they are always in the no-session state.
        public SessionStatus Status => SessionStatus.None;

        public void Load(string dataFolderPath, string pluginsTxtPath, GameRelease gameRelease) =>
            throw new NotSupportedException();
        public void LoadExplicit(string gameDirectory, IReadOnlyList<ExplicitPluginInput> plugins, GameRelease gameRelease) =>
            throw new NotSupportedException();
        public void Unload() => throw new NotSupportedException();
        public PluginResponse CreatePlugin(string name) => throw new NotSupportedException();
        public PluginResponse LoadUnlistedPlugin(string path, string origin) => throw new NotSupportedException();
        public void UnloadUnlistedPlugin(string plugin, string origin) => throw new NotSupportedException();
        public string ReserveFormKey(string plugin) => throw new NotSupportedException();
        public Task<SaveResult> SavePlugin(string plugin, IReadOnlyList<PendingChange> changes) =>
            throw new NotSupportedException();
        public Task<PreparedPluginSave> PreparePluginSave(string plugin, IReadOnlyList<PendingChange> changes) =>
            throw new NotSupportedException();
        public Task ReindexPlugin(string plugin) => throw new NotSupportedException();
        public Task ReindexPlugins(IReadOnlyList<string> plugins) => throw new NotSupportedException();
        public void SetFilter(string sql) => _inner.SetFilter(sql);
        public void ClearFilter() => _inner.ClearFilter();

        public void Dispose() => _inner.Dispose();
    }

    private sealed class ImmutableOverrideSession : IGameSession
    {
        private readonly IGameSession _inner;

        public ImmutableOverrideSession(IGameSession inner, string immutablePlugin)
        {
            _inner = inner;
            Plugins = inner.Plugins
                .Select(p => p.Name.Equals(immutablePlugin, StringComparison.OrdinalIgnoreCase)
                    ? p with { IsImmutable = true }
                    : p)
                .ToList();
        }

        public string DataFolderPath => _inner.DataFolderPath;
        public GameRelease GameRelease => _inner.GameRelease;
        public IReadOnlyList<PluginMetadata> Plugins { get; }
        public IReadOnlyList<PluginLoadFailure> LoadFailures => [];
        public string? FilterSql { get => _inner.FilterSql; set => _inner.FilterSql = value; }
        public IModGetter? GetMod(string pluginName, string origin) => _inner.GetMod(pluginName, origin);
        public PluginMetadata AddPlugin(string filePath) => _inner.AddPlugin(filePath);
        public PluginMetadata AddUnlistedPlugin(string filePath, string origin, int loadOrderIndex) => _inner.AddUnlistedPlugin(filePath, origin, loadOrderIndex);
        public bool RemoveUnlistedPlugin(string pluginName, string origin) => _inner.RemoveUnlistedPlugin(pluginName, origin);
        public void Dispose() { } // inner managed by StubSessionManagerWithImmutablePlugin
    }

    /// <summary>
    /// Wraps a real, loaded SessionManager for #306 AC3's mis-hit test: real chronological loading
    /// can never place an unlisted copy ahead of its load-order sibling (unlisted copies are only
    /// ever appended to Plugins after a completed, blocking session load), so the reversed order
    /// has to be constructed directly to prove the guard is scoped rather than first-match.
    /// </summary>
    private sealed class StubUnlistedCopyFirstSessionManager : ISessionManager, IDisposable
    {
        private readonly SessionManager _inner;

        public StubUnlistedCopyFirstSessionManager(
            string dataFolder, string pluginsTxtPath, GameRelease gameRelease, string sharedPluginName)
        {
            var reflector = SharedSchemaReflector.Instance;
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            _inner = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
            _inner.Load(dataFolder, pluginsTxtPath, gameRelease);
            Session = new UnlistedCopyFirstSession(_inner.Session!, sharedPluginName);
        }

        public IGameSession? Session { get; }
        public IRecordReader? Repository => _inner.Repository;
        public SessionStatus Status => SessionStatus.None;

        public void Load(string dataFolderPath, string pluginsTxtPath, GameRelease gameRelease) =>
            throw new NotSupportedException();
        public void LoadExplicit(string gameDirectory, IReadOnlyList<ExplicitPluginInput> plugins, GameRelease gameRelease) =>
            throw new NotSupportedException();
        public void Unload() => throw new NotSupportedException();
        public PluginResponse CreatePlugin(string name) => throw new NotSupportedException();
        public PluginResponse LoadUnlistedPlugin(string path, string origin) => throw new NotSupportedException();
        public void UnloadUnlistedPlugin(string plugin, string origin) => throw new NotSupportedException();
        public string ReserveFormKey(string plugin) => throw new NotSupportedException();
        public Task<SaveResult> SavePlugin(string plugin, IReadOnlyList<PendingChange> changes) =>
            throw new NotSupportedException();
        public Task<PreparedPluginSave> PreparePluginSave(string plugin, IReadOnlyList<PendingChange> changes) =>
            throw new NotSupportedException();
        public Task ReindexPlugin(string plugin) => throw new NotSupportedException();
        public Task ReindexPlugins(IReadOnlyList<string> plugins) => throw new NotSupportedException();
        public void SetFilter(string sql) => _inner.SetFilter(sql);
        public void ClearFilter() => _inner.ClearFilter();
        public void Dispose() => _inner.Dispose();
    }

    /// <summary>
    /// Prepends a synthetic unlisted (always-immutable, out-of-load-order) copy of
    /// <paramref name="sharedPluginName"/> ahead of the inner session's real entries — the ordering
    /// no real load can produce, per the type doc above.
    /// </summary>
    private sealed class UnlistedCopyFirstSession : IGameSession
    {
        private readonly IGameSession _inner;

        public UnlistedCopyFirstSession(IGameSession inner, string sharedPluginName)
        {
            _inner = inner;
            var shadow = new PluginMetadata(
                sharedPluginName, string.Empty, 0, false, true, [], 0,
                IsImmutable: true, Origin: "ShadowMod", Participates: false, InLoadOrder: false);
            Plugins = new[] { shadow }.Concat(inner.Plugins).ToList();
        }

        public string DataFolderPath => _inner.DataFolderPath;
        public GameRelease GameRelease => _inner.GameRelease;
        public IReadOnlyList<PluginMetadata> Plugins { get; }
        public IReadOnlyList<PluginLoadFailure> LoadFailures => [];
        public string? FilterSql { get => _inner.FilterSql; set => _inner.FilterSql = value; }
        public IModGetter? GetMod(string pluginName, string origin) => _inner.GetMod(pluginName, origin);
        public PluginMetadata AddPlugin(string filePath) => _inner.AddPlugin(filePath);
        public PluginMetadata AddUnlistedPlugin(string filePath, string origin, int loadOrderIndex) => _inner.AddUnlistedPlugin(filePath, origin, loadOrderIndex);
        public bool RemoveUnlistedPlugin(string pluginName, string origin) => _inner.RemoveUnlistedPlugin(pluginName, origin);
        public void Dispose() { } // inner managed by StubUnlistedCopyFirstSessionManager
    }
}
