using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>
/// #630: the four array arity/order op envelopes (<c>array_remove</c>/<c>array_move_up</c>/
/// <c>array_move_down</c>/<c>array_add</c>), computed server-side from the record's own current
/// value and schema rather than round-tripped as a client-computed whole array. Each op arrives
/// through the exact same <c>EditField</c> door every other edit does — the envelope is <c>value</c>
/// itself, distinguished from an ordinary whole-array write by shape (a JSON object carrying an
/// <c>"op"</c> string member), the same convention <c>VmadCodec</c>'s own structural ops already use
/// (<c>RecordFieldWriter.TryGetOpName</c>).
///
/// <para>Same fixture/posture as <see cref="ComplexFieldElementEditTests"/> — a real tracked mod
/// folder, the write landing as a real git working-tree change, verified against the source
/// document's own text.</para>
/// </summary>
public sealed class ArrayOpEditTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private RecordEditService Service() =>
        new(_mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private string NpcBody() => _mod.Mirror.Index!.GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.Body!;

    /// <summary>A second, distinct Keyword FormKey — <see cref="TrackedModFixture.Keyword"/> alone
    /// isn't enough to prove "removed the named element, kept the others" against a one-element
    /// array.</summary>
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
        var seed = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "keywords",
            Json($"[\"{_mod.Keyword}\", \"{second}\"]"));
        Assert.True(seed.Applied, seed.Message);

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "keywords",
            Json("""{"op": "array_remove", "path": [{"kind": "index", "index": 0}]}"""));

        Assert.True(result.Applied, result.Message);
        var body = NpcBody();
        Assert.DoesNotContain(_mod.Keyword.ToString(), body, StringComparison.Ordinal);
        Assert.Contains(second, body, StringComparison.Ordinal);
    }

    /// <summary>
    /// The boundary case: an index past the array's own end (here, any index at all — the fixture
    /// NPC's own <c>keywords</c> starts empty) has nothing to remove. Answering "no-op" cheaply means
    /// committing nothing — no rename, no re-serialize, no working-tree write — which is what
    /// <see cref="TrackedModFixture.GitStatus"/> (a real <c>git status --porcelain</c>) is the one
    /// honest way to check: a rival that lets this fall through to an ordinary write (even one that
    /// reconstructs byte-identical array content) still re-serializes the whole source document, and
    /// that reserialization is not guaranteed byte-stable, so it would show up here as real
    /// git-visible dirt for an op that changed nothing. The tracked fixture's own working tree is
    /// clean immediately after <c>Track</c> (every other <c>RecordEditServiceTests</c> fact relies on
    /// the same baseline), so no seed edit is needed to make this assertion meaningful.
    /// </summary>
    [Fact]
    public void ArrayRemove_IndexPastTheEnd_IsANoOpThatCommitsNothing()
    {
        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "keywords",
            Json("""{"op": "array_remove", "path": [{"kind": "index", "index": 0}]}"""));

        Assert.True(result.Applied, result.Message);
        Assert.Empty(_mod.GitStatus());
    }

    /// <summary>
    /// The same boundary case against a <i>non-empty</i> array, naming a second rival the first
    /// fact above can't rule out on its own: an implementation that "helpfully" clamps an
    /// out-of-range index to the nearest valid one and removes <i>that</i> element instead of
    /// answering no-op. Against an empty array both rivals agree (there is no valid index to clamp
    /// to either) — this needs a real element in the way to tell them apart.
    /// </summary>
    [Fact]
    public void ArrayRemove_IndexPastTheEndOfANonEmptyArray_IsANoOpThatKeepsEveryElement()
    {
        var second = SecondKeyword();
        var seed = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "keywords",
            Json($"[\"{_mod.Keyword}\", \"{second}\"]"));
        Assert.True(seed.Applied, seed.Message);

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "keywords",
            Json("""{"op": "array_remove", "path": [{"kind": "index", "index": 5}]}"""));

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
        var seed = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "keywords",
            Json($"[\"{_mod.Keyword}\", \"{second}\"]"));
        Assert.True(seed.Applied, seed.Message);

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "keywords",
            Json("""{"op": "array_move_down", "path": [{"kind": "index", "index": 0}]}"""));

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
        var seed = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "keywords",
            Json($"[\"{_mod.Keyword}\", \"{second}\"]"));
        Assert.True(seed.Applied, seed.Message);

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "keywords",
            Json("""{"op": "array_move_up", "path": [{"kind": "index", "index": 1}]}"""));

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
        var seed = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "keywords",
            Json($"[\"{_mod.Keyword}\", \"{second}\"]"));
        Assert.True(seed.Applied, seed.Message);

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "keywords",
            Json("""{"op": "array_move_up", "path": [{"kind": "index", "index": 0}]}"""));

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
        var seed = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "keywords",
            Json($"[\"{_mod.Keyword}\", \"{second}\"]"));
        Assert.True(seed.Applied, seed.Message);

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "keywords",
            Json("""{"op": "array_move_down", "path": [{"kind": "index", "index": 1}]}"""));

        Assert.True(result.Applied, result.Message);
        var body = NpcBody();
        var firstIdx = body.IndexOf(_mod.Keyword.ToString(), StringComparison.Ordinal);
        var secondIdx = body.IndexOf(second, StringComparison.Ordinal);
        Assert.True(firstIdx < secondIdx, $"order should be unchanged in:\n{body}");
    }

    // ── array_add ────────────────────────────────────────────────────────────

    /// <summary>
    /// A struct-element array (<c>Container.destructible.stages</c>, <c>DestructionStage[]</c>) —
    /// deliberately not <c>keywords</c> (a bare FormLink array): a bare-FormLink list element with an
    /// unresolvable FormKey string is silently dropped rather than refused
    /// (<c>SchemaReflector.BuildListElement</c>'s own <c>isFl</c> branch returns <c>null</c>, and its
    /// caller only adds non-null items) — a genuine, pre-existing gap in that one shape, unrelated to
    /// this ticket and not something a "default" value can route around (recordUtils.ts's own
    /// <c>defaultElementValue</c> inherits the identical gap once the client stops computing). Every
    /// <c>DestructionStage</c> member is a plain scalar, so its own default always applies cleanly —
    /// the same reason the deleted client-side test this one replaces
    /// (<c>ArrayDiffRows.test.tsx</c>'s "Insert…appends a default element (0)") used a plain int array.
    /// </summary>
    [Fact]
    public void ArrayAdd_StructElementArray_AppendsADefaultElement()
    {
        using var fixture = new ContainerFixture();
        var seed = fixture.Service().EditField(fixture.Plugin, fixture.Container.ToString(), "destructible",
            Json("""{"stages": [{"health_percent": 50}]}"""));
        Assert.True(seed.Applied, seed.Message);

        var result = fixture.Service().EditField(fixture.Plugin, fixture.Container.ToString(), "destructible",
            Json("""{"op": "array_add", "path": [{"kind": "member", "name": "stages"}]}"""));

        Assert.True(result.Applied, result.Message);
        var stages = fixture.ExtractStages();
        // stages[1]'s own HealthPercent is at its CLR default (0) — Mutagen's serializer omits any
        // field equal to its default (ColumnSpec.ViewDefaultLiteral's own doc comment), so the new
        // element's own HealthPercent key is genuinely absent rather than present-and-zero; only the
        // untouched survivor's non-default value is asserted directly.
        Assert.Equal(2, stages.GetArrayLength());
        Assert.Equal(50, stages[0].GetProperty("HealthPercent").GetByte());
    }

    /// <summary>The boundary-agnostic op ('array_add' is never a no-op) landing at a real nested
    /// path — a struct field's own array member, not a bare top-level array — proves
    /// <see cref="ArrayOpWriter"/>'s path walk reaches one hop in, the same shape #630's own scope
    /// note ("the record's current value and the schema") describes.</summary>
    [Fact]
    public void ArrayAdd_NestedArrayInAStruct_LandsAtTheArraysOwnPath()
    {
        using var fixture = new ContainerFixture();

        var result = fixture.Service().EditField(fixture.Plugin, fixture.Container.ToString(), "destructible",
            Json("""{"op": "array_add", "path": [{"kind": "member", "name": "stages"}]}"""));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(1, fixture.ExtractStages().GetArrayLength());
    }

    /// <summary>The same nested path, for <c>array_remove</c> — proves the path walk generalizes
    /// across ops, not just the one 'array_add' happens to already need for its own boundary-free
    /// case.</summary>
    [Fact]
    public void ArrayRemove_NestedArrayElement_RemovesAtTheRealPath()
    {
        using var fixture = new ContainerFixture();
        var seed = fixture.Service().EditField(fixture.Plugin, fixture.Container.ToString(), "destructible",
            Json("""{"stages": [{"health_percent": 10}, {"health_percent": 20}]}"""));
        Assert.True(seed.Applied, seed.Message);

        var result = fixture.Service().EditField(fixture.Plugin, fixture.Container.ToString(), "destructible",
            Json("""{"op": "array_remove", "path": [{"kind": "member", "name": "stages"}, {"kind": "index", "index": 0}]}"""));

        Assert.True(result.Applied, result.Message);
        var stages = fixture.ExtractStages();
        Assert.Equal(1, stages.GetArrayLength());
        Assert.Equal(20, stages[0].GetProperty("HealthPercent").GetByte());
    }

    /// <summary>
    /// The same nested path, for <c>array_move_down</c> — closes a real coverage gap review
    /// found: the deleted client-side tests (<c>ArrayDiffRows.test.tsx</c>'s own #535 block)
    /// included a nested move case, and nothing server-side replaced it — every <c>ArrayMove*</c>
    /// fact above targets a top-level array only. The shared path walk is already exercised by the
    /// nested remove/add facts above; this one proves the *move* mutation itself lands at the same
    /// real (non-top-level) path rather than assuming it does by extension.
    /// </summary>
    [Fact]
    public void ArrayMoveDown_NestedArrayElement_MovesAtTheRealPath()
    {
        using var fixture = new ContainerFixture();
        var seed = fixture.Service().EditField(fixture.Plugin, fixture.Container.ToString(), "destructible",
            Json("""{"stages": [{"health_percent": 10}, {"health_percent": 20}]}"""));
        Assert.True(seed.Applied, seed.Message);

        var result = fixture.Service().EditField(fixture.Plugin, fixture.Container.ToString(), "destructible",
            Json("""{"op": "array_move_down", "path": [{"kind": "member", "name": "stages"}, {"kind": "index", "index": 0}]}"""));

        Assert.True(result.Applied, result.Message);
        var stages = fixture.ExtractStages();
        Assert.Equal(2, stages.GetArrayLength());
        Assert.Equal(20, stages[0].GetProperty("HealthPercent").GetByte());
        Assert.Equal(10, stages[1].GetProperty("HealthPercent").GetByte());
    }

    // ── #642 interaction: an array op reuses ColumnSpec.Apply unchanged, so it inherits
    // NestedFieldReadOnly exactly as any other whole-value write does ──────────────────────────

    /// <summary>
    /// An array op that never touches the element carrying an unwritable nested Loqui struct
    /// (<c>QuestReferenceAlias.Location</c>, #642) still succeeds when that member is unset —
    /// <see cref="ArrayOpWriter"/>'s own null-stripping restores "absence is not targeting" for the
    /// common case, the same guarantee <see cref="ComplexFieldElementEditTests"/>'s ordinary edits
    /// already rely on.
    /// </summary>
    [Fact]
    public void ArrayMoveDown_ArrayContainsElementWithUnsetReadOnlyNestedField_StillApplies()
    {
        using var fixture = new QuestFixture(); // seeds [QuestLocationAlias, QuestReferenceAlias(Location: null)]

        var result = fixture.Service().EditField(fixture.Plugin, fixture.Quest.ToString(), "aliases",
            Json("""{"op": "array_move_down", "path": [{"kind": "index", "index": 0}]}"""));

        Assert.True(result.Applied, result.Message);
        var body = fixture.Body();
        var refIdx = body.IndexOf("QuestReferenceAlias", StringComparison.Ordinal);
        var locIdx = body.IndexOf("QuestLocationAlias", StringComparison.Ordinal);
        Assert.True(refIdx >= 0 && locIdx >= 0, body);
        Assert.True(refIdx < locIdx, $"QuestReferenceAlias should now precede QuestLocationAlias in:\n{body}");
    }

    /// <summary>
    /// The other half of the same guarantee: when that nested member genuinely carries a value, the
    /// array op still refuses exactly as an ordinary whole-array edit would
    /// (<see cref="AbstractUnionEditTests.Aliases_WholeArrayWrite_QuestReferenceAliasElement_LocationNamedInPayload_IsRefused"/>)
    /// — the op is a thin wrapper around the same <c>ColumnSpec.Apply</c>, so it inherits the refusal
    /// rather than bypassing it. Not this ticket's own defect to route around: a real, non-null
    /// value that would otherwise be silently dropped is exactly what #642 exists to catch.
    /// </summary>
    [Fact]
    public void ArrayMoveDown_ArrayContainsElementWithSetReadOnlyNestedField_StillRefuses()
    {
        using var fixture = new QuestFixture(withLocation: true); // Location: { AliasID: 9 }
        var before = fixture.Body();

        var result = fixture.Service().EditField(fixture.Plugin, fixture.Quest.ToString(), "aliases",
            Json("""{"op": "array_move_down", "path": [{"kind": "index", "index": 0}]}"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.NestedFieldReadOnly, result.Refusal);
        Assert.Contains("aliases", result.Message, StringComparison.Ordinal);
        Assert.Contains("not yet editable", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, fixture.Body());
    }

    /// <summary>A real mod folder holding one <c>Quest</c> with two aliases — same
    /// self-contained-fixture-per-file convention as <see cref="AbstractUnionEditTests"/>'s own
    /// <c>AbstractUnionFixture</c>.</summary>
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

        public string Body() => _mirror.Index!.GetDocument(Quest.ToString(), Plugin)!.Body!;

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

    /// <summary>A real mod folder holding one <c>Container</c> — same self-contained-fixture-per-file
    /// convention as <see cref="ComplexFieldElementEditTests.OmodFixture"/>.</summary>
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

        public string Body() => _mirror.Index!.GetDocument(Container.ToString(), Plugin)!.Body!;

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
