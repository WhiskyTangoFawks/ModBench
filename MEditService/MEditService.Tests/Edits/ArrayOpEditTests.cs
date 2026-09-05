using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Tests.TestSupport.Envelopes;

namespace MEditService.Tests.Edits;

/// <summary>An array op is computed server-side from the record's current value, never
/// round-tripped as a client-computed whole array; the envelope is <c>value</c> itself, told apart
/// by shape.</summary>
public sealed class ArrayOpEditTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private RecordEditService Service() =>
        new(_mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private string NpcBody() => _mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.Body!;

    private string SecondKeyword()
    {
        var result = Service().CreateRecord(_mod.Plugin, "kywd", "SecondKeyword");
        Assert.True(result.Applied, result.Message);
        return result.NewFormKey!;
    }

    [Fact]
    public void ArrayRemove_TopLevelArray_RemovesTheNamedElementAndKeepsTheOthers()
    {
        var second = SecondKeyword();
        var seed = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "Keywords",
            Json($"[\"{_mod.Keyword}\", \"{second}\"]"));
        Assert.True(seed.Applied, seed.Message);

        var result = Service().Edit(_mod.Plugin, _mod.Npc.ToString(), RemoveAt(Member("Keywords"), At(0)));

        Assert.True(result.Applied, result.Message);
        var body = NpcBody();
        Assert.DoesNotContain(_mod.Keyword.ToString(), body, StringComparison.Ordinal);
        Assert.Contains(second, body, StringComparison.Ordinal);
    }

    // A real git status is the only honest no-op check: falling through to an ordinary write
    // reserializes the whole document, and reserialization is not guaranteed byte-stable.
    [Fact]
    public void ArrayRemove_IndexPastTheEnd_IsANoOpThatCommitsNothing()
    {
        var result = Service().Edit(_mod.Plugin, _mod.Npc.ToString(), RemoveAt(Member("Keywords"), At(0)));

        Assert.True(result.Applied, result.Message);
        Assert.Empty(_mod.GitStatus());
    }

    // The non-empty array names a rival the empty case cannot rule out: an implementation that
    // clamps an out-of-range index to the nearest valid one and removes that element instead.
    [Fact]
    public void ArrayRemove_IndexPastTheEndOfANonEmptyArray_IsANoOpThatKeepsEveryElement()
    {
        var second = SecondKeyword();
        var seed = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "Keywords",
            Json($"[\"{_mod.Keyword}\", \"{second}\"]"));
        Assert.True(seed.Applied, seed.Message);

        var result = Service().Edit(_mod.Plugin, _mod.Npc.ToString(), RemoveAt(Member("Keywords"), At(5)));

        Assert.True(result.Applied, result.Message);
        var body = NpcBody();
        Assert.Contains(_mod.Keyword.ToString(), body, StringComparison.Ordinal);
        Assert.Contains(second, body, StringComparison.Ordinal);
    }

    // ── array_move_up / array_move_down ────────────────────────────────────────

    [Fact]
    public void ArrayMoveDown_TopLevelArray_SwapsWithTheNextElement()
    {
        var second = SecondKeyword();
        var seed = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "Keywords",
            Json($"[\"{_mod.Keyword}\", \"{second}\"]"));
        Assert.True(seed.Applied, seed.Message);

        var result = Service().Edit(_mod.Plugin, _mod.Npc.ToString(), MoveTo(1, Member("Keywords"), At(0)));

        Assert.True(result.Applied, result.Message);
        var body = NpcBody();
        var secondIdx = body.IndexOf(second, StringComparison.Ordinal);
        var firstIdx = body.IndexOf(_mod.Keyword.ToString(), StringComparison.Ordinal);
        Assert.True(secondIdx >= 0 && firstIdx >= 0, body);
        Assert.True(secondIdx < firstIdx, $"'{second}' should now precede '{_mod.Keyword}' in:\n{body}");
    }

    [Fact]
    public void ArrayMoveUp_TopLevelArray_SwapsWithThePreviousElement()
    {
        var second = SecondKeyword();
        var seed = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "Keywords",
            Json($"[\"{_mod.Keyword}\", \"{second}\"]"));
        Assert.True(seed.Applied, seed.Message);

        var result = Service().Edit(_mod.Plugin, _mod.Npc.ToString(), MoveTo(0, Member("Keywords"), At(1)));

        Assert.True(result.Applied, result.Message);
        var body = NpcBody();
        var secondIdx = body.IndexOf(second, StringComparison.Ordinal);
        var firstIdx = body.IndexOf(_mod.Keyword.ToString(), StringComparison.Ordinal);
        Assert.True(secondIdx >= 0 && firstIdx >= 0, body);
        Assert.True(secondIdx < firstIdx, $"'{second}' should now precede '{_mod.Keyword}' in:\n{body}");
    }

    [Fact]
    public void ArrayMoveUp_FirstElement_IsANoOpThatCommitsNothing()
    {
        var second = SecondKeyword();
        var seed = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "Keywords",
            Json($"[\"{_mod.Keyword}\", \"{second}\"]"));
        Assert.True(seed.Applied, seed.Message);

        var result = Service().Edit(_mod.Plugin, _mod.Npc.ToString(), MoveTo(-1, Member("Keywords"), At(0)));

        Assert.True(result.Applied, result.Message);
        var body = NpcBody();
        var firstIdx = body.IndexOf(_mod.Keyword.ToString(), StringComparison.Ordinal);
        var secondIdx = body.IndexOf(second, StringComparison.Ordinal);
        Assert.True(firstIdx < secondIdx, $"order should be unchanged in:\n{body}");
    }

    [Fact]
    public void ArrayMoveDown_LastElement_IsANoOpThatCommitsNothing()
    {
        var second = SecondKeyword();
        var seed = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "Keywords",
            Json($"[\"{_mod.Keyword}\", \"{second}\"]"));
        Assert.True(seed.Applied, seed.Message);

        var result = Service().Edit(_mod.Plugin, _mod.Npc.ToString(), MoveTo(2, Member("Keywords"), At(1)));

        Assert.True(result.Applied, result.Message);
        var body = NpcBody();
        var firstIdx = body.IndexOf(_mod.Keyword.ToString(), StringComparison.Ordinal);
        var secondIdx = body.IndexOf(second, StringComparison.Ordinal);
        Assert.True(firstIdx < secondIdx, $"order should be unchanged in:\n{body}");
    }

    // ── array_add ────────────────────────────────────────────────────────────

    // A struct-element array, not keywords: BuildListElement returns null for an unresolvable bare
    // FormLink element, so that shape is silently dropped rather than refused.
    [Fact]
    public void ArrayAdd_StructElementArray_AppendsADefaultElement()
    {
        using var fixture = new ContainerFixture();
        var seed = fixture.Service().Set(fixture.Plugin, fixture.Container.ToString(), "Destructible",
            Json("""{"Stages": [{"HealthPercent": 50}]}"""));
        Assert.True(seed.Applied, seed.Message);

        var result = fixture.Service().Edit(fixture.Plugin, fixture.Container.ToString(), AddAt(Member("Destructible"), Member("Stages")));

        Assert.True(result.Applied, result.Message);
        var stages = fixture.ExtractStages();
        // stages[1]'s HealthPercent is at its CLR default and Mutagen's serializer omits any field equal
        // to its default, so the new element's key is genuinely absent rather than present-and-zero.
        Assert.Equal(2, stages.GetArrayLength());
        Assert.Equal(50, stages[0].GetProperty("HealthPercent").GetByte());
    }

    [Fact]
    public void ArrayAdd_NestedArrayInAStruct_LandsAtTheArraysOwnPath()
    {
        using var fixture = new ContainerFixture();

        var result = fixture.Service().Edit(fixture.Plugin, fixture.Container.ToString(), AddAt(Member("Destructible"), Member("Stages")));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(1, fixture.ExtractStages().GetArrayLength());
    }

    [Fact]
    public void ArrayRemove_NestedArrayElement_RemovesAtTheRealPath()
    {
        using var fixture = new ContainerFixture();
        var seed = fixture.Service().Set(fixture.Plugin, fixture.Container.ToString(), "Destructible",
            Json("""{"Stages": [{"HealthPercent": 10}, {"HealthPercent": 20}]}"""));
        Assert.True(seed.Applied, seed.Message);

        var result = fixture.Service().Edit(fixture.Plugin, fixture.Container.ToString(), RemoveAt(Member("Destructible"), Member("Stages"), At(0)));

        Assert.True(result.Applied, result.Message);
        var stages = fixture.ExtractStages();
        Assert.Equal(1, stages.GetArrayLength());
        Assert.Equal(20, stages[0].GetProperty("HealthPercent").GetByte());
    }

    [Fact]
    public void ArrayMoveDown_NestedArrayElement_MovesAtTheRealPath()
    {
        using var fixture = new ContainerFixture();
        var seed = fixture.Service().Set(fixture.Plugin, fixture.Container.ToString(), "Destructible",
            Json("""{"Stages": [{"HealthPercent": 10}, {"HealthPercent": 20}]}"""));
        Assert.True(seed.Applied, seed.Message);

        var result = fixture.Service().Edit(fixture.Plugin, fixture.Container.ToString(), MoveTo(1, Member("Destructible"), Member("Stages"), At(0)));

        Assert.True(result.Applied, result.Message);
        var stages = fixture.ExtractStages();
        Assert.Equal(2, stages.GetArrayLength());
        Assert.Equal(20, stages[0].GetProperty("HealthPercent").GetByte());
        Assert.Equal(10, stages[1].GetProperty("HealthPercent").GetByte());
    }

    // ── An array op reuses ColumnSpec.Apply unchanged, so it inherits
    // the nested write path exactly as any other whole-value write does ────────────────────────

    [Fact]
    public void ArrayMoveDown_ArrayContainsElementWithUnsetReadOnlyNestedField_StillApplies()
    {
        using var fixture = new QuestFixture(); // seeds [QuestLocationAlias, QuestReferenceAlias(Location: null)]

        var result = fixture.Service().Edit(fixture.Plugin, fixture.Quest.ToString(), MoveTo(1, Member("Aliases"), At(0)));

        Assert.True(result.Applied, result.Message);
        var body = fixture.Body();
        var refIdx = body.IndexOf("QuestReferenceAlias", StringComparison.Ordinal);
        var locIdx = body.IndexOf("QuestLocationAlias", StringComparison.Ordinal);
        Assert.True(refIdx >= 0 && locIdx >= 0, body);
        Assert.True(refIdx < locIdx, $"QuestReferenceAlias should now precede QuestLocationAlias in:\n{body}");
    }

    [Fact]
    public void ArrayMoveDown_ArrayContainsElementWithSetNestedStructField_AppliesAndPreservesIt()
    {
        using var fixture = new QuestFixture(withLocation: true); // Location: { AliasID: 9 }

        var result = fixture.Service().Edit(fixture.Plugin, fixture.Quest.ToString(), MoveTo(1, Member("Aliases"), At(0)));

        Assert.True(result.Applied, result.Message);
        var body = fixture.Body();
        var refIdx = body.IndexOf("QuestReferenceAlias", StringComparison.Ordinal);
        var locIdx = body.IndexOf("QuestLocationAlias", StringComparison.Ordinal);
        Assert.True(refIdx >= 0 && locIdx >= 0, body);
        Assert.True(refIdx < locIdx, $"QuestReferenceAlias should now precede QuestLocationAlias in:\n{body}");
        Assert.Contains("\"AliasID\": 9", body, StringComparison.Ordinal);
    }

    private sealed class QuestFixture : IDisposable
    {
        private const string PluginName = "Quest630.esp";
        private const string Origin = "Quest630Mod";

        private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-630-mod-").FullName;
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-630-game-").FullName;
        private readonly LoadOrderMirror _mirror = new(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));

        public PluginKey Plugin { get; } = new(PluginName, Origin);
        public FormKey Quest { get; }

        public QuestFixture(bool withLocation = false)
        {
            var pluginPath = Path.Combine(_modFolder, PluginName);
            var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
            var quest = new Mutagen.Bethesda.Fallout4.Quest(mod.GetNextFormKey("Quest630"), Fallout4Release.Fallout4)
            {
                EditorID = "Quest630",
                Aliases =
                [
                    new QuestLocationAlias { Name = "LocAlias" },
                    new QuestReferenceAlias
                    {
                        Name = "RefAlias",
                        Location = withLocation ? new LocationAliasReference { AliasID = 9 } : null,
                    },
                ],
            };
            mod.Quests.Add(quest);
            mod.WriteToBinary(pluginPath);
            Quest = quest.FormKey;

            ((ILoadOrderMirror)_mirror).Reconcile(
                _gameDirectory, [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);
            new TrackService(NullLogger<TrackService>.Instance)
                .TrackAsync(_mirror.LoadOrder!, Origin, SourcePreset.Edits)
                .GetAwaiter().GetResult();
        }

        public RecordEditService Service() =>
            new(_mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

        public string Body() => _mirror.Index!.At(RecordRef.Effective).GetDocument(Quest.ToString(), Plugin)!.Body!;

        public void Dispose()
        {
            _mirror.Dispose();
            TryDelete(_modFolder);
            TryDelete(_gameDirectory);
        }

        private static void TryDelete(string path)
        {
            try { Directory.Delete(path, recursive: true); }
            catch (IOException) { /* scratch directory, best effort */ }
            catch (UnauthorizedAccessException) { /* ditto */ }
        }
    }

    private sealed class ContainerFixture : IDisposable
    {
        private const string PluginName = "Container630.esp";
        private const string Origin = "Container630Mod";

        private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-630-mod-").FullName;
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-630-game-").FullName;
        private readonly LoadOrderMirror _mirror;

        public PluginKey Plugin { get; } = new(PluginName, Origin);
        public FormKey Container { get; }

        public ContainerFixture()
        {
            var pluginPath = Path.Combine(_modFolder, PluginName);
            var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
            var container = new Mutagen.Bethesda.Fallout4.Container(mod.GetNextFormKey("Container630"), Fallout4Release.Fallout4)
            {
                EditorID = "Container630",
            };
            mod.Containers.Add(container);
            mod.WriteToBinary(pluginPath);
            Container = container.FormKey;

            _mirror = new LoadOrderMirror(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ILoadOrderMirror)_mirror).Reconcile(
                _gameDirectory, [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);
            new TrackService(NullLogger<TrackService>.Instance)
                .TrackAsync(_mirror.LoadOrder!, Origin, SourcePreset.Edits)
                .GetAwaiter().GetResult();
        }

        public RecordEditService Service() =>
            new(_mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

        public string Body() => _mirror.Index!.At(RecordRef.Effective).GetDocument(Container.ToString(), Plugin)!.Body!;

        public JsonElement ExtractStages()
        {
            using var doc = JsonDocument.Parse(Body());
            return doc.RootElement.GetProperty("Destructible").GetProperty("Stages").Clone();
        }

        public void Dispose()
        {
            _mirror.Dispose();
            TryDelete(_modFolder);
            TryDelete(_gameDirectory);
        }

        private static void TryDelete(string path)
        {
            try { Directory.Delete(path, recursive: true); }
            catch (IOException) { /* scratch directory, best effort */ }
            catch (UnauthorizedAccessException) { /* ditto */ }
        }
    }
}
