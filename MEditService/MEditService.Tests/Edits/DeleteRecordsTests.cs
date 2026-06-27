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
using Noggog;

namespace MEditService.Tests.Edits;

public sealed class DeleteRecordsTests
{
    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static (EditOrchestrator orchestrator, SessionManager manager, DuckDbPendingChangeService changes)
        MakeOrchestratorWithChanges()
    {
        var reflector = new SchemaReflector();
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        var changes = DuckDbTestFactory.MakePendingChangeService();
        // Pass changes so SessionManager.Load() calls OnSessionLoaded, sharing the DuckDB connection
        // (required for GetReferences, which queries pending_changes on the shared connection)
        var manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance), changes);
        var query = new RecordQueryService(manager, changes, reflector, new ConflictClassifier());
        var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
        var orchestrator = new EditOrchestrator(manager, query, writer, changes, reflector);
        return (orchestrator, manager, changes);
    }

    private static (EditOrchestrator orchestrator, StubImmutableSessionManager manager, DuckDbPendingChangeService changes)
        MakeOrchestratorWithImmutablePlugin(string dataFolder, string pluginsTxtPath, string immutablePlugin)
    {
        var reflector = new SchemaReflector();
        var changes = DuckDbTestFactory.MakePendingChangeService();
        var stubManager = new StubImmutableSessionManager(
            dataFolder, pluginsTxtPath, GameRelease.Fallout4, immutablePlugin, reflector, changes);
        var query = new RecordQueryService(stubManager, changes, reflector, new ConflictClassifier());
        var writer = new PluginWriter(reflector, NullLogger<PluginWriter>.Instance);
        var orchestrator = new EditOrchestrator(stubManager, query, writer, changes, reflector);
        return (orchestrator, stubManager, changes);
    }

    // --- NoSession ---

    [Fact]
    public void DeleteRecords_NoSession_ReturnsNoSession()
    {
        var (orchestrator, manager, _) = MakeOrchestratorWithChanges();
        using (manager)
        {
            var result = orchestrator.DeleteRecords([("000001:Test.esp", "Test.esp")], "user");
            Assert.IsType<DeleteRecordsResult.NoSession>(result);
        }
    }

    // --- Phase 16.2.2: placed delete carries placement ---

    [Fact]
    public void DeleteRecords_PlacedTarget_StagesDeleteCarryingPlacement()
    {
        string cellFk = "", placedFk = "";
        var data = new PluginFixtureBuilder("dr-placed")
            .WithPlugin("Target.esp", mod =>
            {
                var wrld = mod.Worldspaces.AddNew("TestWorld");
                var cell = new Cell(mod) { EditorID = "TestCell", Grid = new CellGrid { Point = new P2Int(0, 0) } };
                var po = new PlacedObject(mod) { EditorID = "placedRef", Position = new P3Float(1f, 2f, 3f) };
                cell.Persistent.Add(po);
                var sub = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
                sub.Items.Add(cell);
                var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
                block.Items.Add(sub);
                wrld.SubCells.Add(block);
                cellFk = cell.FormKey.ToString();
                placedFk = po.FormKey.ToString();
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.DeleteRecords([(placedFk, "Target.esp")], "user");

                Assert.IsType<DeleteRecordsResult.Staged>(result);
                var deleteChange = changes.GetChanges().Single(c => c.ChangeType == "delete");
                Assert.Equal(placedFk, deleteChange.FormKey);
                Assert.Equal(cellFk, deleteChange.ParentCell);
                Assert.Equal("persistent", deleteChange.PlacementGroup);
            }
        }
    }

    // --- Happy path ---

    [Fact]
    public void DeleteRecords_SingleRecord_StagedWithCorrectShape()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("dr-single")
            .WithPlugin("Target.esp", mod => npcKey = mod.Npcs.AddNew("TestNPC_DrSingle").FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.DeleteRecords([(npcKey.ToString(), "Target.esp")], "user");

                var staged = Assert.IsType<DeleteRecordsResult.Staged>(result);
                var deleteChange = changes.GetChanges().Single(c => c.ChangeType == "delete");
                Assert.Equal(npcKey.ToString(), deleteChange.FormKey);
                Assert.Equal("Target.esp", deleteChange.Plugin);
                Assert.Equal("$delete", deleteChange.FieldPath);
                Assert.Equal("npc_", deleteChange.RecordType);
                Assert.Equal(staged.Group.Id, deleteChange.GroupId);
                var groups = changes.GetChangeGroups();
                Assert.Single(groups);
                Assert.Equal("delete", groups[0].Operation);
            }
        }
    }

    [Fact]
    public void DeleteRecords_BatchTwoRecords_AllInOneChangeGroup()
    {
        FormKey npc1Key = default;
        FormKey npc2Key = default;
        var data = new PluginFixtureBuilder("dr-batch")
            .WithPlugin("Target.esp", mod =>
            {
                npc1Key = mod.Npcs.AddNew("TestNPC_DrBatch1").FormKey;
                npc2Key = mod.Npcs.AddNew("TestNPC_DrBatch2").FormKey;
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.DeleteRecords(
                    [(npc1Key.ToString(), "Target.esp"), (npc2Key.ToString(), "Target.esp")], "user");

                Assert.IsType<DeleteRecordsResult.Staged>(result);
                var deleteChanges = changes.GetChanges().Where(c => c.ChangeType == "delete").ToList();
                Assert.Equal(2, deleteChanges.Count);
                var groupId = deleteChanges[0].GroupId;
                Assert.All(deleteChanges, c => Assert.Equal(groupId, c.GroupId));
                Assert.Single(changes.GetChangeGroups());
            }
        }
    }

    // --- BlockedByPendingGroup ---

    [Fact]
    public void DeleteRecords_RecordHasPendingGroup_ReturnsBlockedByPendingGroup()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("dr-pending-group")
            .WithPlugin("Target.esp", mod => npcKey = mod.Npcs.AddNew("TestNPC_DrPendingGroup").FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                // Stage a group containing npcKey first
                var members = new[] { new GroupMember(npcKey.ToString(), "Target.esp", "npc_", "create", "$create", J("null"), J("null")) };
                changes.StageGroup("create", null, members);

                var result = orchestrator.DeleteRecords([(npcKey.ToString(), "Target.esp")], "user");

                var blocked = Assert.IsType<DeleteRecordsResult.BlockedByPendingGroup>(result);
                Assert.Contains(npcKey.ToString(), blocked.FormKeys);
            }
        }
    }

    // --- BlockedByReferences (immutable) ---

    [Fact]
    public void DeleteRecords_ImmutablePluginRef_ReturnsBlockedByReferences()
    {
        FormKey kwKey = default;
        // Source.esp (editable) owns the keyword; Immutable.esp (marked immutable) references it.
        var data = new PluginFixtureBuilder("dr-immutable-ref")
            .WithPlugin("Source.esp", mod => kwKey = mod.Keywords.AddNew().FormKey)
            .WithPlugin("Immutable.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("ReferencingNPC_DrImmutable");
                npc.Keywords = [new FormLink<IKeywordGetter>(kwKey)];
            })
            .Build();
        using (data)
        {
            var (orchestrator, stubManager, _) =
                MakeOrchestratorWithImmutablePlugin(data.DataFolder, data.PluginsTxtPath, "Immutable.esp");
            using (stubManager)
            {
                var result = orchestrator.DeleteRecords([(kwKey.ToString(), "Source.esp")], "user");

                var blocked = Assert.IsType<DeleteRecordsResult.BlockedByReferences>(result);
                Assert.NotEmpty(blocked.BlockedBy);
                var blockedRef = blocked.BlockedBy[0];
                Assert.Equal(kwKey.ToString(), blockedRef.TargetFormKey);
                Assert.Equal("Immutable.esp", blockedRef.SourcePlugin);
            }
        }
    }

    [Fact]
    public void DeleteRecords_MultipleImmutableRefs_AllAppearsInBlockedBy()
    {
        FormKey kwKey = default;
        var data = new PluginFixtureBuilder("dr-multi-immutable")
            .WithPlugin("Source.esp", mod => kwKey = mod.Keywords.AddNew().FormKey)
            .WithPlugin("Immutable.esp", mod =>
            {
                var npc1 = mod.Npcs.AddNew("NPC1_DrMultiImmutable");
                npc1.Keywords = [new FormLink<IKeywordGetter>(kwKey)];
                var npc2 = mod.Npcs.AddNew("NPC2_DrMultiImmutable");
                npc2.Keywords = [new FormLink<IKeywordGetter>(kwKey)];
            })
            .Build();
        using (data)
        {
            var (orchestrator, stubManager, _) =
                MakeOrchestratorWithImmutablePlugin(data.DataFolder, data.PluginsTxtPath, "Immutable.esp");
            using (stubManager)
            {
                var result = orchestrator.DeleteRecords([(kwKey.ToString(), "Source.esp")], "user");

                var blocked = Assert.IsType<DeleteRecordsResult.BlockedByReferences>(result);
                Assert.Equal(2, blocked.BlockedBy.Count);
                Assert.All(blocked.BlockedBy, b => Assert.Equal(kwKey.ToString(), b.TargetFormKey));
            }
        }
    }

    // --- Nullification (editable plugin refs) ---

    [Fact]
    public void DeleteRecords_EditableRef_NullificationStagedWithCorrectShape()
    {
        FormKey kwKey = default;
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("dr-editable-ref")
            .WithPlugin("Source.esp", mod => kwKey = mod.Keywords.AddNew().FormKey)
            .WithPlugin("Referencing.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("ReferencingNPC_DrEditableRef");
                npc.Keywords = [new FormLink<IKeywordGetter>(kwKey)];
                npcKey = npc.FormKey;
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.DeleteRecords([(kwKey.ToString(), "Source.esp")], "user");

                var staged = Assert.IsType<DeleteRecordsResult.Staged>(result);
                var nullifyChange = changes.GetChanges()
                    .Single(c => c.ChangeType == "field_edit" && c.FormKey == npcKey.ToString());
                // TD-001: the referencing element is removed from the array, leaving it empty
                // (not the whole field nullified) — the only element was the deleted reference.
                Assert.Equal(JsonValueKind.Array, nullifyChange.NewValue.ValueKind);
                Assert.Empty(nullifyChange.NewValue.EnumerateArray());
                // Field path should be top-level column (e.g. "keywords"), not "keywords[0]"
                Assert.Equal("keywords", nullifyChange.FieldPath);
                // Old value must be the actual keywords array, not a different field's value
                Assert.Equal(JsonValueKind.Array, nullifyChange.OldValue.ValueKind);
                Assert.Equal(staged.Group.Id, nullifyChange.GroupId);
            }
        }
    }

    [Fact]
    public void DeleteRecords_EditableRefInArray_RemovesOnlyThatElement_NotWholeArray()
    {
        // TD-001: deleting a record referenced by one element of an array should remove that
        // element, leaving the other elements of the array intact — not wipe the whole field.
        FormKey kwKey = default;
        FormKey otherKwKey = default;
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("dr-array-element")
            .WithPlugin("Source.esp", mod =>
            {
                kwKey = mod.Keywords.AddNew("DeletedKeyword").FormKey;
                otherKwKey = mod.Keywords.AddNew("KeptKeyword").FormKey;
            })
            .WithPlugin("Referencing.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("ReferencingNPC_DrArrayElement");
                npc.Keywords =
                [
                    new FormLink<IKeywordGetter>(otherKwKey),
                    new FormLink<IKeywordGetter>(kwKey),
                ];
                npcKey = npc.FormKey;
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.DeleteRecords([(kwKey.ToString(), "Source.esp")], "user");

                Assert.IsType<DeleteRecordsResult.Staged>(result);
                var editChange = changes.GetChanges()
                    .Single(c => c.ChangeType == "field_edit" && c.FormKey == npcKey.ToString());
                Assert.Equal("keywords", editChange.FieldPath);
                Assert.Equal(JsonValueKind.Array, editChange.NewValue.ValueKind);
                var remaining = editChange.NewValue.EnumerateArray().Select(e => e.GetString()).ToList();
                Assert.Equal([otherKwKey.ToString()], remaining);
            }
        }
    }

    [Fact]
    public void DeleteRecords_EditableRefViaScalarField_NullificationUsesTopLevelFieldPath()
    {
        FormKey raceKey = default;
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("dr-scalar-ref")
            .WithPlugin("Source.esp", mod => raceKey = mod.Races.AddNew("TestRace_DrScalar").FormKey)
            .WithPlugin("Referencing.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("RefNPC_DrScalar");
                npc.Race.SetTo(raceKey);
                npcKey = npc.FormKey;
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.DeleteRecords([(raceKey.ToString(), "Source.esp")], "user");

                Assert.IsType<DeleteRecordsResult.Staged>(result);
                var nullifyChange = changes.GetChanges()
                    .Single(c => c.ChangeType == "field_edit" && c.FormKey == npcKey.ToString());
                Assert.Equal("race", nullifyChange.FieldPath);
            }
        }
    }

    // --- Mixed editable + immutable refs ---

    [Fact]
    public void DeleteRecords_EditableAndImmutableMixed_OnlyImmutableBlocks()
    {
        FormKey kwKey = default;
        var data = new PluginFixtureBuilder("dr-mixed-refs")
            .WithPlugin("Source.esp", mod => kwKey = mod.Keywords.AddNew().FormKey)
            .WithPlugin("Immutable.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("ImmutableNPC_DrMixed");
                npc.Keywords = [new FormLink<IKeywordGetter>(kwKey)];
            })
            .WithPlugin("Editable.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("EditableNPC_DrMixed");
                npc.Keywords = [new FormLink<IKeywordGetter>(kwKey)];
            })
            .Build();
        using (data)
        {
            var (orchestrator, stubManager, _) =
                MakeOrchestratorWithImmutablePlugin(data.DataFolder, data.PluginsTxtPath, "Immutable.esp");
            using (stubManager)
            {
                var result = orchestrator.DeleteRecords([(kwKey.ToString(), "Source.esp")], "user");

                // Should be blocked due to the immutable plugin reference (even though Editable.esp ref would be nullifiable)
                Assert.IsType<DeleteRecordsResult.BlockedByReferences>(result);
            }
        }
    }

    // --- Self-reference in batch ---

    [Fact]
    public void DeleteRecords_BatchWithSelfReference_SelfRefNotBlocking()
    {
        FormKey kwKey = default;
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("dr-self-ref")
            .WithPlugin("Target.esp", mod =>
            {
                kwKey = mod.Keywords.AddNew().FormKey;
                var npc = mod.Npcs.AddNew("SelfRefNPC_DrSelfRef");
                npc.Keywords = [new FormLink<IKeywordGetter>(kwKey)];
                npcKey = npc.FormKey;
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                // Both the keyword and the NPC that references it are in the delete batch
                var result = orchestrator.DeleteRecords(
                    [(kwKey.ToString(), "Target.esp"), (npcKey.ToString(), "Target.esp")], "user");

                Assert.IsType<DeleteRecordsResult.Staged>(result);
                // Self-references within the batch must not generate nullification changes
                Assert.DoesNotContain(changes.GetChanges(), c => c.ChangeType == "field_edit");
            }
        }
    }

    [Fact]
    public void DeleteRecords_TwoDeletedRecordsInSameArray_RemovesBothIndicesHighestFirst()
    {
        // OrderByDescending on indices is required: removing lower index first shifts remaining
        // indices, so the higher-index removal would target the wrong element.
        // Setup: [kw0, kw1, kw2]. Delete kw0 (index 0) and kw2 (index 2). kw1 must survive.
        FormKey kw0Key = default;
        FormKey kw1Key = default;
        FormKey kw2Key = default;
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("dr-two-indices")
            .WithPlugin("Source.esp", mod =>
            {
                kw0Key = mod.Keywords.AddNew("Kw0_DrTwoIndices").FormKey;
                kw1Key = mod.Keywords.AddNew("Kw1_DrTwoIndices").FormKey;
                kw2Key = mod.Keywords.AddNew("Kw2_DrTwoIndices").FormKey;
            })
            .WithPlugin("Referencing.esp", mod =>
            {
                var npc = mod.Npcs.AddNew("RefNPC_DrTwoIndices");
                npc.Keywords =
                [
                    new FormLink<IKeywordGetter>(kw0Key),
                    new FormLink<IKeywordGetter>(kw1Key),
                    new FormLink<IKeywordGetter>(kw2Key),
                ];
                npcKey = npc.FormKey;
            })
            .Build();
        using (data)
        {
            var (orchestrator, manager, changes) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                // Delete both kw0 and kw2 in one batch — their references sit at indices [0] and [2].
                var result = orchestrator.DeleteRecords(
                    [(kw0Key.ToString(), "Source.esp"), (kw2Key.ToString(), "Source.esp")], "user");

                Assert.IsType<DeleteRecordsResult.Staged>(result);
                var editChange = changes.GetChanges()
                    .Single(c => c.ChangeType == "field_edit" && c.FormKey == npcKey.ToString());
                var remaining = editChange.NewValue.EnumerateArray().Select(e => e.GetString()).ToList();
                Assert.Equal([kw1Key.ToString()], remaining);
            }
        }
    }

    // --- PluginImmutable (target plugin is immutable) ---

    [Fact]
    public void DeleteRecords_TargetPluginNotInSession_ProceedsWithoutThrowing()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("dr-plugin-not-in-session")
            .WithPlugin("Source.esp", mod => npcKey = mod.Npcs.AddNew("TestNPC_DrNotInSession").FormKey)
            .Build();
        using (data)
        {
            var (orchestrator, manager, _) = MakeOrchestratorWithChanges();
            using (manager)
            {
                manager.Load(data.DataFolder, data.PluginsTxtPath, GameRelease.Fallout4);

                var result = orchestrator.DeleteRecords([(npcKey.ToString(), "NotLoaded.esp")], "user");

                Assert.IsNotType<DeleteRecordsResult.PluginImmutable>(result);
            }
        }
    }

    [Fact]
    public void DeleteRecords_ImmutableTargetPlugin_ReturnsPluginImmutable()
    {
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("dr-immutable-target")
            .WithPlugin("Base.esm", mod => npcKey = mod.Npcs.AddNew("ImmutableNPC_DrTarget").FormKey)
            .WithPlugin("Editable.esp")
            .Build();
        using (data)
        {
            var (orchestrator, stubManager, _) =
                MakeOrchestratorWithImmutablePlugin(data.DataFolder, data.PluginsTxtPath, "Base.esm");
            using (stubManager)
            {
                var result = orchestrator.DeleteRecords([(npcKey.ToString(), "Base.esm")], "user");
                var immutable = Assert.IsType<DeleteRecordsResult.PluginImmutable>(result);
                Assert.Equal("Base.esm", immutable.Plugin);
            }
        }
    }

    // --- helpers ---

    /// <summary>
    /// Wraps a real SessionManager but marks one plugin as immutable.
    /// </summary>
    private sealed class StubImmutableSessionManager : ISessionManager, IDisposable
    {
        private readonly SessionManager _inner;
        private readonly IGameSession? _stubSession;

        public StubImmutableSessionManager(
            string dataFolder, string pluginsTxtPath, GameRelease gameRelease,
            string immutablePlugin, SchemaReflector reflector, DuckDbPendingChangeService changes)
        {
            var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
            _inner = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance), changes);
            _inner.Load(dataFolder, pluginsTxtPath, gameRelease);
            _stubSession = new ImmutableOverrideSession(_inner.Session!, immutablePlugin);
        }

        public IGameSession? Session => _stubSession;
        public IRecordReader? Repository => _inner.Repository;

        public void Load(string dataFolderPath, string pluginsTxtPath, GameRelease gameRelease) =>
            throw new NotSupportedException();
        public void Unload() => throw new NotSupportedException();
        public PluginResponse CreatePlugin(string name) => throw new NotSupportedException();
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
        private readonly IReadOnlyList<PluginMetadata> _plugins;

        public ImmutableOverrideSession(IGameSession inner, string immutablePlugin)
        {
            _inner = inner;
            _plugins = inner.Plugins
                .Select(p => p.Name.Equals(immutablePlugin, StringComparison.OrdinalIgnoreCase)
                    ? p with { IsImmutable = true }
                    : p)
                .ToList();
        }

        public string DataFolderPath => _inner.DataFolderPath;
        public GameRelease GameRelease => _inner.GameRelease;
        public IReadOnlyList<PluginMetadata> Plugins => _plugins;
        public Mutagen.Bethesda.Plugins.Cache.ILinkCache LinkCache => _inner.LinkCache;
        public string? FilterSql { get => _inner.FilterSql; set => _inner.FilterSql = value; }
        public Mutagen.Bethesda.Plugins.Records.IModGetter? GetMod(string pluginName) => _inner.GetMod(pluginName);
        public PluginMetadata AddPlugin(string filePath) => _inner.AddPlugin(filePath);
        public void Dispose() { }
    }
}
